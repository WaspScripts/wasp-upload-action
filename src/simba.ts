import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync
} from "node:fs"
import { writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import * as core from "@actions/core"
import type { SupabaseClient } from "@supabase/supabase-js"
import { exec, execOrThrow } from "./exec.js"
import type { Script } from "./scripts.js"

const WASPLIB_REPO = "https://github.com/WaspScripts/WaspLib.git"
const COMPILE_TIMEOUT = 5 * 60 * 1000

export interface Versions {
	simba: string
	wasplib: string
	plugins: string
}

async function getLatestVersion(supabase: SupabaseClient, table: string) {
	const { data, error } = await supabase
		.schema("scripts")
		.from(table)
		.select("version")
		.order("created_at", { ascending: false })
		.limit(1)
		.single()

	if (error) throw new Error(`Failed to get the latest ${table} version: ${error.message}`)
	return data.version as string
}

export async function getVersions(
	supabase: SupabaseClient,
	simba: string,
	wasplib: string
): Promise<Versions> {
	const [latestSimba, latestWaspLib, plugins] = await Promise.all([
		simba === "latest" ? getLatestVersion(supabase, "simba") : simba,
		wasplib === "latest" ? getLatestVersion(supabase, "wasplib") : wasplib,
		getLatestVersion(supabase, "plugins")
	])
	return { simba: latestSimba, wasplib: latestWaspLib, plugins }
}

async function downloadAndExtract(
	supabase: SupabaseClient,
	bucket: string,
	path: string,
	dest: string
) {
	core.info(`Downloading ${bucket}/${path}`)
	const { data, error } = await supabase.storage.from(bucket).download(path)
	if (error) throw new Error(`Failed to download ${bucket}/${path}: ${error.message}`)

	const zip = dest + ".zip"
	await writeFile(zip, Buffer.from(await data.arrayBuffer()))
	rmSync(dest, { recursive: true, force: true })
	await execOrThrow("unzip", ["-q", "-o", zip, "-d", dest])
	rmSync(zip)
}

// Sets up a Simba install the same way wasp-launcher does and returns the executable path.
export async function installSimba(supabase: SupabaseClient, versions: Versions, dir: string) {
	for (const folder of ["Includes", "Plugins", "Scripts"]) {
		mkdirSync(join(dir, folder), { recursive: true })
	}

	const exe = join(dir, "Simba")
	const simbaZip = join(dir, "simba-zip")
	const plugins = join(dir, "Plugins", "wasp-plugins")
	const wasplib = join(dir, "Includes", "WaspLib")

	await Promise.all([
		(async () => {
			await downloadAndExtract(supabase, "simba", `${versions.simba}/linux64.zip`, simbaZip)
			const files = readdirSync(simbaZip)
			if (files.length !== 1) {
				throw new Error(`Expected 1 file in the Simba zip, found: ${files.join(", ")}`)
			}
			renameSync(join(simbaZip, files[0]), exe)
			rmSync(simbaZip, { recursive: true })
			chmodSync(exe, 0o755)
		})(),
		(async () => {
			await downloadAndExtract(supabase, "plugins", `${versions.plugins}.zip`, plugins)
			// RemoteInput requests an executable stack which newer glibc versions refuse to load.
			const remoteInput = join(plugins, "libremoteinput", "libremoteinput64.so")
			if (existsSync(remoteInput)) {
				const result = await exec("patchelf", ["--clear-execstack", remoteInput])
				if (result.code !== 0) core.warning("patchelf failed on RemoteInput:\n" + result.output)
			}
		})(),
		(async () => {
			// Every WaspLib version is a tag. The zips on waspscripts.com are made with `git archive`
			// which leaves out the cache-reader submodule, so cloning is simpler.
			core.info(`Cloning WaspLib ${versions.wasplib}`)
			rmSync(wasplib, { recursive: true, force: true })
			await execOrThrow("git", [
				"-c",
				"advice.detachedHead=false",
				"clone",
				"--quiet",
				"--depth=1",
				"--branch",
				versions.wasplib,
				"--recurse-submodules=utils/cache-reader",
				"--shallow-submodules",
				WASPLIB_REPO,
				wasplib
			])
		})()
	])

	const ldd = await exec("ldd", [exe])
	const missing = ldd.output.split("\n").filter((line) => line.includes("not found"))
	if (missing.length > 0) core.warning("Simba is missing libraries:\n" + missing.join("\n"))

	return exe
}

export interface CompileResult {
	success: boolean
	output: string
}

// Copies the script into Simba's Scripts folder exactly as it will be uploaded and compiles it.
export async function compileScript(simbaDir: string, exe: string, script: Script) {
	const dir = join(simbaDir, "Scripts", script.folder)
	rmSync(dir, { recursive: true, force: true })
	mkdirSync(dir, { recursive: true })

	const sources = new Map<string, string>()
	for (const file of script.files) {
		const staged = join(dir, file.name)
		copyFileSync(file.source, staged)
		sources.set(staged, file.source)
	}

	const main = join(dir, "script.simba")
	// Simba is a GTK app and needs a display even to compile.
	const [command, args] = process.env.DISPLAY
		? [exe, ["--compile", main]]
		: ["xvfb-run", ["--auto-servernum", exe, "--compile", main]]

	const result = await exec(command, args, { cwd: simbaDir, timeout: COMPILE_TIMEOUT })
	const output = result.output.trim()
	const success = result.code === 0

	if (!success) annotate(output, simbaDir, sources)
	return { success, output }
}

// Turns Simba errors into GitHub annotations on the repository files.
function annotate(output: string, simbaDir: string, sources: Map<string, string>) {
	const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd()
	const lines = output.split("\n").filter((line) => line.trim() !== "")
	const message =
		lines.find((line) => line.includes(" at line ")) ?? lines.at(-1) ?? "Compiling failed"
	const match = message.match(/at line (\d+), column (\d+) in file "([^"]+)"/)
	const source = match ? sources.get(resolve(simbaDir, match[3])) : undefined

	if (match && source) {
		core.error(message, {
			title: "Compile error",
			file: relative(workspace, source),
			startLine: Number(match[1]),
			startColumn: Number(match[2])
		})
	} else {
		core.error(message, { title: "Compile error" })
	}
}
