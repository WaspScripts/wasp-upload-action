import { readFileSync } from "node:fs"
import { extname } from "node:path"
import * as core from "@actions/core"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Script } from "./scripts.js"
import type { Versions } from "./simba.js"

const CONTENT_TYPES: Record<string, string> = {
	".png": "image/png",
	".bmp": "image/bmp",
	".json": "application/json",
	".zip": "application/zip",
	".bin": "application/octet-stream"
}

const pad = (n: number, size: number) => n.toString().padStart(size, "0")

export async function login(supabase: SupabaseClient, email: string, password: string) {
	const { data, error } = await supabase.auth.signInWithPassword({ email, password })
	if (error) throw new Error("Failed to log in to waspscripts.com: " + error.message)
	core.info("Logged in to waspscripts.com as " + data.user.id)
}

async function getRevision(supabase: SupabaseClient, id: string) {
	const { data, error } = await supabase
		.schema("scripts")
		.from("protected")
		.select("revision")
		.eq("id", id)
		.single()

	if (error) throw new Error(`Failed to get the revision of ${id}: ${error.message}`)
	return data.revision as number
}

// Uploads a new revision of the script the same way the "edit files" page of waspscripts.com does
// and returns the new revision number.
export async function uploadScript(supabase: SupabaseClient, script: Script, versions: Versions) {
	const id = script.id!
	const revision = (await getRevision(supabase, id)) + 1
	const path = `${id}/${pad(revision, 9)}/`

	await Promise.all(
		script.files.map(async (file) => {
			core.info(`Uploading ${file.name} to scripts/${path}${file.name}`)
			const { error } = await supabase.storage
				.from("scripts")
				.upload(path + file.name, readFileSync(file.source), {
					upsert: true,
					contentType: CONTENT_TYPES[extname(file.name)] ?? "text/plain;charset=UTF-8"
				})
			if (error) throw new Error(`Failed to upload ${file.name}: ${error.message}`)
		})
	)

	const { error } = await supabase
		.schema("scripts")
		.from("versions")
		.upsert({
			id,
			revision,
			simba: versions.simba,
			wasplib: versions.wasplib,
			files: script.files.map((file) => file.name)
		})
	if (error)
		throw new Error(`Failed to add revision ${revision} to scripts.versions: ${error.message}`)

	// The database may already bump the revision on its own when a version is added.
	if ((await getRevision(supabase, id)) < revision) {
		const { data, error } = await supabase
			.schema("scripts")
			.from("protected")
			.update({ revision })
			.eq("id", id)
			.select("revision")

		if (error || data.length === 0) {
			throw new Error(
				`Revision ${revision} was uploaded but scripts.protected.revision couldn't be updated` +
					(error ? ": " + error.message : ", this account is not allowed to update it")
			)
		}
	}

	return revision
}
