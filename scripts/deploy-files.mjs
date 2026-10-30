import { lstatSync } from "node:fs"
import { resolve } from "node:path"

const rootFiles = new Set([
	".dockerignore",
	"Dockerfile",
	"docker-compose.yml",
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"tsconfig.json",
])

export function sourceUploadCommand(directory) {
	const target = "'" + directory.replaceAll("'", "'\\''") + "'"

	// Archives list files, so tar creates their parent directories under the upload umask.
	// Normalize public source before Docker COPY preserves those modes. Private state
	// lives outside this release, and its symlinks are added only after upload.
	return `umask 077; mkdir -p ${target} && tar -xzf - -C ${target} && chmod -R u=rwX,go=rX ${target}`
}

export function deploymentFiles(root, candidates) {
	return [...new Set(candidates)].sort().filter((file) => {
		const parts = file.split("/")

		if (
			parts.some(
				(part) =>
					part.startsWith(".") ||
					part === "node_modules" ||
					part === "dist" ||
					part === "secrets.h" ||
					/\.(?:pem|key|crt|p12)$/.test(part) ||
					part.includes(".local."),
			) &&
			!rootFiles.has(file)
		)
			return false

		if (!rootFiles.has(file) && !/^(apps|packages|infra|scripts|tests)\//.test(file))
			return false

		// Never dereference a symlink into private local files, including ancestor directories.
		return parts.every((_, i) => {
			const stat = lstatSync(resolve(root, ...parts.slice(0, i + 1)), {
				throwIfNoEntry: false,
			})

			return stat && !stat.isSymbolicLink() && (i < parts.length - 1 || stat.isFile())
		})
	})
}
