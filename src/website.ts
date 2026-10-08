import { readFileSync } from "node:fs"
import { basename, extname } from "node:path"
import * as core from "@actions/core"
import { createServerClient } from "@supabase/ssr"
import type { SupabaseClient } from "@supabase/supabase-js"
import { parse } from "devalue"
import type { Script } from "./scripts.js"
import type { Versions } from "./simba.js"

const CONTENT_TYPES: Record<string, string> = {
	".png": "image/png",
	".bmp": "image/bmp",
	".json": "application/json",
	".txt": "text/plain",
	".zip": "application/zip"
}

export interface Session {
	supabase: SupabaseClient
	cookies: Map<string, string>
}

// The website only accepts logins through the cookies @supabase/ssr makes, so the client is
// created the same way and keeps the cookies it sets to send them along with the uploads.
export function createSession(url: string, key: string): Session {
	const cookies = new Map<string, string>()
	const supabase = createServerClient(url, key, {
		cookies: {
			getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
			setAll: (list) => {
				for (const { name, value, options } of list) {
					if (value && options.maxAge !== 0) cookies.set(name, value)
					else cookies.delete(name)
				}
			}
		}
	})
	// Same client, @supabase/ssr just resolves the CommonJS typings of supabase-js.
	return { supabase: supabase as unknown as SupabaseClient, cookies }
}

export async function login({ supabase, cookies }: Session, email: string, password: string) {
	const { data, error } = await supabase.auth.signInWithPassword({ email, password })
	if (error) {
		throw new Error(
			"Failed to log in to waspscripts.com: " +
				error.message +
				". Set a password for your account on your waspscripts.com profile page."
		)
	}
	if (cookies.size === 0) throw new Error("Logged in but no session cookies were created")
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

// Collects every message in a superforms errors object, e.g. { simba: ["Invalid"], _errors: [] }.
function collectErrors(value: unknown, path = ""): string[] {
	if (typeof value === "string") return [path ? `${path}: ${value}` : value]
	if (Array.isArray(value)) return value.flatMap((item) => collectErrors(item, path))
	if (value && typeof value === "object") {
		return Object.entries(value).flatMap(([key, item]) =>
			collectErrors(item, key === "_errors" ? path : path ? `${path}.${key}` : key)
		)
	}
	return []
}

function describeFailure(data: string) {
	try {
		const form = parse(data)?.form
		const errors = collectErrors(form?.errors)
		return errors.length > 0 ? errors.join("\n") : (form?.message ?? data)
	} catch {
		return data
	}
}

// Uploads the script through the "edit files" form of the website, exactly like a scripter does
// by hand, and returns the new revision.
export async function uploadScript(
	website: string,
	{ supabase, cookies }: Session,
	script: Script,
	versions: Versions
) {
	const id = script.id!

	// Refreshes the access token if it expired while compiling, which updates the cookies.
	const { error } = await supabase.auth.getSession()
	if (error) throw new Error("Failed to refresh the waspscripts.com session: " + error.message)

	// The website renames the main file to script.simba itself, so the original names are sent.
	const form = new FormData()
	form.append("simba", versions.simba)
	form.append("wasplib", versions.wasplib)
	form.append("main", script.main)
	for (const file of script.files) {
		const name = basename(file.source)
		core.info("Uploading " + name)
		const type = CONTENT_TYPES[extname(name).toLowerCase()] ?? ""
		form.append("script", new File([readFileSync(file.source)], name, { type }))
	}

	const url = new URL(`/scripts/${id}/edit/files`, website)
	const res = await fetch(url, {
		method: "POST",
		body: form,
		redirect: "manual",
		headers: {
			cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
			// SvelteKit refuses form posts from other origins.
			origin: url.origin,
			// Makes SvelteKit reply with the action result as JSON instead of the page.
			accept: "application/json"
		}
	})

	const text = await res.text()
	let result
	try {
		result = JSON.parse(text)
	} catch {
		throw new Error(`${url} replied with ${res.status}: ${text.slice(0, 500)}`)
	}

	switch (result.type) {
		case "success":
			return getRevision(supabase, id)
		case "failure":
			throw new Error("The website refused the upload:\n" + describeFailure(result.data))
		case "redirect":
			throw new Error(`The website redirected to ${result.location}, it didn't accept the login`)
		default:
			throw new Error(
				`The website failed to upload the script (${res.status}): ${text.slice(0, 500)}`
			)
	}
}
