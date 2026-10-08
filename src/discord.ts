import * as core from "@actions/core"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Versions } from "./simba.js"

// Same color the website uses for its script notifications.
const COLOR = 0xf56f27
// Discord's limit of embeds per message.
const MAX_EMBEDS = 10
const MAX_COMMITS = 10

export interface Update {
	id: string
	revision: number
	commits: string[]
}

interface ScriptInfo {
	id: string
	title: string
	url: string | null
	published: boolean
	protected: { username: string; avatar: string } | null
}

function describe(commits: string[]) {
	if (commits.length === 0) return undefined
	const lines = commits.slice(0, MAX_COMMITS).map((commit) => "- " + commit)
	if (commits.length > MAX_COMMITS) lines.push(`- ...and ${commits.length - MAX_COMMITS} more`)
	return lines.join("\n").slice(0, 4000)
}

// Posts the uploaded scripts to a Discord webhook. Unpublished scripts are left out since their
// page isn't public. Failing to notify only warns, the scripts are already uploaded at this point.
export async function notifyDiscord(
	supabase: SupabaseClient,
	website: string,
	webhook: string,
	updates: Update[],
	versions: Versions
) {
	const { data, error } = await supabase
		.schema("scripts")
		.from("scripts")
		.select("id, title, url, published, protected!left (username, avatar)")
		.in(
			"id",
			updates.map((update) => update.id)
		)
		.overrideTypes<ScriptInfo[], { merge: false }>()

	if (error) return core.warning("Failed to get the scripts info for Discord: " + error.message)

	const scripts = new Map(data.map((script) => [script.id, script]))
	const embeds = []

	for (const update of updates) {
		const script = scripts.get(update.id)
		if (!script?.published || !script.url) {
			core.info(`Not posting ${update.id} to Discord since it's not published.`)
			continue
		}

		embeds.push({
			title: "Script Updated: " + script.title,
			url: `${website}/scripts/${script.url}`,
			description: describe(update.commits),
			color: COLOR,
			fields: [
				{ name: "Revision", value: update.revision.toString(), inline: true },
				{ name: "Simba", value: versions.simba, inline: true },
				{ name: "WaspLib", value: versions.wasplib, inline: true }
			],
			footer: script.protected
				? { text: "Author: " + script.protected.username, icon_url: script.protected.avatar }
				: undefined
		})
	}

	for (let i = 0; i < embeds.length; i += MAX_EMBEDS) {
		const res = await fetch(webhook, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ embeds: embeds.slice(i, i + MAX_EMBEDS) })
		})
		if (!res.ok) core.warning(`Discord webhook failed (${res.status}): ${await res.text()}`)
	}

	if (embeds.length > 0) core.info(`Posted ${embeds.length} script update(s) to Discord.`)
}
