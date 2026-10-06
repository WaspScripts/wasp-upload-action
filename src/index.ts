import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as core from "@actions/core"
import { createClient } from "@supabase/supabase-js"
import { getChangedFolders, getCommitMessages } from "./changes.js"
import { notifyDiscord, type Update } from "./discord.js"
import { compileScript, getVersions, installSimba } from "./simba.js"
import {
	discoverFolders,
	loadScript,
	parseManifest,
	type Manifest,
	type Script
} from "./scripts.js"
import { login, uploadScript } from "./upload.js"

interface Result {
	folder: string
	id: string | null
	compiled: string
	uploaded: string
	failed: boolean
}

function readManifest(root: string, file: string): Manifest {
	const path = join(root, file)
	if (!existsSync(path)) {
		core.warning(`${file} not found, scripts will only be compile tested.`)
		return {}
	}
	return parseManifest(readFileSync(path, "utf8"), file)
}

async function selectFolders(root: string, manifestFile: string, manifest: Manifest) {
	const input = core.getInput("SCRIPTS") || "changed"
	const folders = discoverFolders(root)

	for (const folder of Object.keys(manifest)) {
		if (!folders.includes(folder))
			core.warning(`${manifestFile} has "${folder}" but there's no such script folder.`)
	}

	if (input === "all") return folders
	if (input !== "changed") return input.split(/[\s,]+/).filter((folder) => folder !== "")

	const changed = await getChangedFolders(root, manifestFile, manifest)
	return changed ? folders.filter((folder) => changed.has(folder)) : folders
}

async function run() {
	const dryRun = core.getBooleanInput("DRY_RUN")
	const root = resolve(core.getInput("PATH") || ".")
	const manifestFile = core.getInput("MANIFEST") || "scripts.json"

	const manifest = readManifest(root, manifestFile)
	const folders = await selectFolders(root, manifestFile, manifest)

	if (folders.length === 0) {
		core.info("No scripts to process.")
		return
	}
	core.info("Scripts to process: " + folders.join(", "))

	const results: Result[] = []
	const scripts: Script[] = []

	for (const folder of folders) {
		try {
			scripts.push(loadScript(root, folder, manifest[folder]))
		} catch (err) {
			core.error((err as Error).message)
			results.push({
				folder,
				id: manifest[folder]?.id ?? null,
				compiled: "❌ Invalid",
				uploaded: "-",
				failed: true
			})
		}
	}

	if (scripts.length === 0) {
		core.setFailed("None of the scripts are valid.")
		return
	}

	const supabase = createClient(
		core.getInput("SB_URL", { required: true }),
		core.getInput("SB_ANON_KEY", { required: true }),
		{
			auth: { autoRefreshToken: false, persistSession: false }
		}
	)

	const uploading = !dryRun && scripts.some((script) => script.id)
	if (uploading) {
		await login(
			supabase,
			core.getInput("EMAIL", { required: true }),
			core.getInput("PASSWORD", { required: true })
		)
	}

	try {
		const versions = await getVersions(
			supabase,
			core.getInput("SIMBA_VERSION") || "latest",
			core.getInput("WASPLIB_VERSION") || "latest"
		)
		core.info(
			`Simba: ${versions.simba}, WaspLib: ${versions.wasplib}, wasp-plugins: ${versions.plugins}`
		)

		const simbaDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "simba-"))
		core.startGroup("Installing Simba")
		const exe = await installSimba(supabase, versions, simbaDir)
		core.endGroup()

		const updates: Update[] = []

		for (const script of scripts) {
			core.startGroup(`${script.folder} (main: ${script.main})`)
			core.info("Files: " + script.files.map((file) => file.name).join(", "))
			if (script.skipped.length > 0) core.info("Skipped: " + script.skipped.join(", "))

			const result: Result = {
				folder: script.folder,
				id: script.id,
				compiled: "",
				uploaded: "-",
				failed: false
			}
			results.push(result)

			const compile = await compileScript(simbaDir, exe, script)
			core.info(compile.output)
			result.compiled = compile.success ? "✅" : "❌ Failed"

			if (!compile.success) {
				result.failed = true
			} else if (dryRun) {
				result.uploaded = "Dry run"
			} else if (!script.id) {
				result.uploaded = "No ID"
				core.warning(`${script.folder} has no ID in ${manifestFile} so it was only compile tested.`)
			} else {
				try {
					const revision = await uploadScript(supabase, script, versions)
					result.uploaded = "✅ Revision " + revision
					const commits = await getCommitMessages(root, script.folder)
					updates.push({ id: script.id, revision, commits })
				} catch (err) {
					core.error((err as Error).message)
					result.uploaded = "❌ Failed"
					result.failed = true
				}
			}
			core.endGroup()
		}

		const webhook = core.getInput("DISCORD_WEBHOOK")
		if (webhook && updates.length > 0) await notifyDiscord(supabase, webhook, updates, versions)

		await core.summary
			.addHeading("WaspScripts", 3)
			.addRaw(
				`Simba <code>${versions.simba}</code> · WaspLib <code>${versions.wasplib}</code>`,
				true
			)
			.addTable([
				[
					{ data: "Script", header: true },
					{ data: "ID", header: true },
					{ data: "Compiled", header: true },
					{ data: "Uploaded", header: true }
				],
				...results.map((r) => [
					r.folder,
					r.id ? `<code>${r.id}</code>` : "-",
					r.compiled,
					r.uploaded
				])
			])
			.write()
	} finally {
		if (uploading) await supabase.auth.signOut()
	}

	const failed = results.filter((result) => result.failed).map((result) => result.folder)
	if (failed.length > 0) core.setFailed("Failed scripts: " + failed.join(", "))
}

run().catch((err) => core.setFailed(err instanceof Error ? err.message : String(err)))
