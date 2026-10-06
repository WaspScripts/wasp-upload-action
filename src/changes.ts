import { readFileSync } from "node:fs"
import * as core from "@actions/core"
import { exec } from "./exec.js"
import { parseManifest, type Manifest } from "./scripts.js"

// Commit to diff the checked out commit against, or null when there is nothing sensible to diff
// against, like a manual run or a branch's first push.
function getBaseCommit(): string | null {
	const eventPath = process.env.GITHUB_EVENT_PATH
	if (!eventPath) return null

	const event = JSON.parse(readFileSync(eventPath, "utf8"))

	switch (process.env.GITHUB_EVENT_NAME) {
		case "push":
			return event.before && !/^0+$/.test(event.before) ? event.before : null
		case "pull_request":
		case "pull_request_target":
			return event.pull_request?.base?.sha ?? null
		default:
			return null
	}
}

async function isCommit(root: string, sha: string) {
	return (await exec("git", ["cat-file", "-e", sha + "^{commit}"], { cwd: root })).code === 0
}

// Subjects of the commits that changed a script folder, or of its last commit when there's nothing
// to compare against.
export async function getCommitMessages(root: string, folder: string) {
	const base = getBaseCommit()
	const range = base && (await isCommit(root, base)) ? `${base}..HEAD` : "-1"
	const log = await exec("git", ["log", "--format=%s", range, "--", folder], { cwd: root })
	return log.code === 0 ? log.output.split("\n").filter((line) => line.trim() !== "") : []
}

// Returns the script folders whose files or manifest entry changed, or null if changes can't be
// detected and everything should be processed instead.
export async function getChangedFolders(
	root: string,
	manifestFile: string,
	manifest: Manifest
): Promise<Set<string> | null> {
	const base = getBaseCommit()
	if (!base) {
		core.info("No base commit to compare against, processing every script.")
		return null
	}

	if (!(await isCommit(root, base))) {
		core.warning(
			`Base commit ${base} isn't available, processing every script. ` +
				"Use actions/checkout with fetch-depth: 0 so changes can be detected."
		)
		return null
	}

	const args = ["diff", "--name-only", "--no-renames", "--relative", base, "HEAD"]
	const diff = await exec("git", args, { cwd: root })
	if (diff.code !== 0) throw new Error("git diff failed:\n" + diff.output)

	const changed = new Set<string>()
	for (const file of diff.output.split("\n")) {
		const parts = file.trim().split("/")
		if (parts.length > 1) changed.add(parts[0])
	}

	core.info(`Changed files since ${base.slice(0, 7)}:\n${diff.output.trim() || "(none)"}`)

	if (diff.output.split("\n").includes(manifestFile)) {
		// "./" makes git resolve the path relative to root instead of the repository root.
		const old = await exec("git", ["show", `${base}:./${manifestFile}`], { cwd: root })
		const oldManifest = old.code === 0 ? parseManifest(old.output, `${manifestFile}@${base}`) : {}

		for (const [folder, entry] of Object.entries(manifest)) {
			if (JSON.stringify(entry) !== JSON.stringify(oldManifest[folder])) changed.add(folder)
		}
	}

	return changed
}
