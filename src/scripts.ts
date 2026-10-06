import { existsSync, readdirSync, statSync } from "node:fs"
import { extname, join } from "node:path"

// waspscripts.com always runs the main file of a script as "script.simba".
export const MAIN_FILE = "script.simba"

const MAX_FILE_SIZE = 5 * 1024 * 1024
// The same file types waspscripts.com accepts on script uploads.
const ALLOWED_EXTENSIONS = [
	".simba",
	".png",
	".bmp",
	".txt",
	".ini",
	".json",
	".zip",
	".bin",
	".graph",
	".obj",
	".mtl"
]
// The website's banner and cover images, other banner/cover files can be used by the script.
const IGNORED_FILES = /^(banner|cover)\.webp$/i
const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export interface ManifestEntry {
	id?: string
	main?: string
}

export type Manifest = Record<string, ManifestEntry>

export interface ScriptFile {
	// Name the file is uploaded and compiled as.
	name: string
	source: string
}

export interface Script {
	folder: string
	id: string | null
	main: string
	files: ScriptFile[]
	skipped: string[]
}

export function parseManifest(text: string, origin: string): Manifest {
	let json: unknown
	try {
		json = JSON.parse(text)
	} catch (err) {
		throw new Error(`${origin} is not valid JSON: ${(err as Error).message}`, { cause: err })
	}

	if (json == null || typeof json !== "object" || Array.isArray(json)) {
		throw new Error(`${origin} must be an object of "folder": { "id": "..." } entries`)
	}

	const manifest: Manifest = {}
	for (const [folder, entry] of Object.entries(json)) {
		if (folder.startsWith("$")) continue // allows "$schema" and similar keys
		if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`${origin}: "${folder}" must be an object like { "id": "..." }`)
		}

		const { id, main } = entry as Record<string, unknown>
		if (id != null && (typeof id !== "string" || (id !== "" && !UUID_REGEX.test(id)))) {
			throw new Error(`${origin}: "${folder}" has an invalid script id: ${JSON.stringify(id)}`)
		}
		if (main != null && (typeof main !== "string" || !main.endsWith(".simba"))) {
			throw new Error(`${origin}: "${folder}" main must be a .simba file name`)
		}

		manifest[folder] = { id: id || undefined, main: main || undefined }
	}

	return manifest
}

// Every top level folder with a .simba file in it is a script.
export function discoverFolders(root: string) {
	return readdirSync(root, { withFileTypes: true })
		.filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith("."))
		.map((dirent) => dirent.name)
		.filter((folder) => readdirSync(join(root, folder)).some((file) => file.endsWith(".simba")))
		.sort()
}

export function loadScript(root: string, folder: string, entry: ManifestEntry | undefined): Script {
	const dir = join(root, folder)
	if (!existsSync(dir)) throw new Error(`Script folder "${folder}" doesn't exist`)

	const files: ScriptFile[] = []
	const skipped: string[] = []

	for (const dirent of readdirSync(dir, { withFileTypes: true })) {
		const source = join(dir, dirent.name)
		if (!dirent.isFile() || IGNORED_FILES.test(dirent.name)) {
			skipped.push(dirent.name)
			continue
		}
		if (!ALLOWED_EXTENSIONS.includes(extname(dirent.name).toLowerCase())) {
			skipped.push(dirent.name)
			continue
		}
		if (statSync(source).size > MAX_FILE_SIZE) {
			throw new Error(`${folder}/${dirent.name} is bigger than the 5MB limit`)
		}
		files.push({ name: dirent.name, source })
	}

	const simbaFiles = files.filter((file) => file.name.endsWith(".simba")).map((file) => file.name)

	let main = entry?.main
	if (!main) {
		if (simbaFiles.includes(folder + ".simba")) main = folder + ".simba"
		else if (simbaFiles.length === 1) main = simbaFiles[0]
		else {
			throw new Error(
				`Can't tell which file is the main file of "${folder}", ` +
					`name it "${folder}.simba" or set "main" in the manifest`
			)
		}
	}

	if (!simbaFiles.includes(main)) throw new Error(`Main file "${folder}/${main}" doesn't exist`)
	if (main !== MAIN_FILE && simbaFiles.includes(MAIN_FILE)) {
		throw new Error(`"${folder}/${MAIN_FILE}" is reserved for the main file, rename it`)
	}

	for (const file of files) {
		if (file.name === main) file.name = MAIN_FILE
	}

	return { folder, id: entry?.id ?? null, main, files, skipped }
}
