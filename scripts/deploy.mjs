import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { deploymentFiles } from "./deploy-files.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const configFile = join(root, ".local/deploy.json")
const args = process.argv.slice(2)

if (args.includes("--help")) {
	console.log("Usage: pnpm run deploy [--check | --list-files]")
	console.log("Copy deploy.example.json to .local/deploy.json and configure SSH first.")
	process.exit(0)
}

if (args.length > 1 || args.some((arg) => !["--check", "--list-files"].includes(arg)))
	throw new Error("Usage: pnpm run deploy [--check | --list-files]")

const candidates = execFileSync(
	"git",
	["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
	{
		cwd: root,
		encoding: "utf8",
	},
)
	.split("\0")
	.filter(Boolean)

const files = deploymentFiles(root, candidates)

if (args.includes("--list-files")) {
	console.log(files.join("\n"))
	process.exit(0)
}

let config

try {
	config = JSON.parse(readFileSync(configFile, "utf8"))
} catch {
	throw new Error("Create .local/deploy.json from deploy.example.json. See docs/deployment.md.")
}

const { sshTarget, directory, hostname, projectName } = config

if (
	typeof sshTarget !== "string" ||
	!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(sshTarget) ||
	typeof directory !== "string" ||
	!directory.split("/").every((part) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(part)) ||
	typeof hostname !== "string" ||
	hostname.length > 253 ||
	!hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
	typeof projectName !== "string" ||
	!/^[a-z0-9][a-z0-9_-]*$/.test(projectName)
)
	throw new Error(
		"Invalid deployment config. Use an SSH target/alias and a directory relative to your remote home.",
	)

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
const sshArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", sshTarget]

function ssh(command, input, capture = false) {
	const result = spawnSync("ssh", [...sshArgs, command], {
		input,
		stdio: [input === undefined ? "inherit" : "pipe", capture ? "pipe" : "inherit", "inherit"],
	})

	if (result.error) throw result.error
	if (result.status !== 0)
		throw new Error("Remote command failed. See output above and docs/deployment.md.")

	return result.stdout
}

ssh(
	"bash -s",
	`set -euo pipefail
test "$(uname -m)" = aarch64 || { echo "Pi must run a 64-bit ARM OS." >&2; exit 1; }
command -v flock >/dev/null
command -v curl >/dev/null
docker info >/dev/null || { echo "Install Docker and reconnect after joining the docker group. See docs/deployment.md." >&2; exit 1; }
docker compose version
docker compose up --help | grep -q -- --wait-timeout
`,
)

if (args.includes("--check")) {
	console.log("SSH, ARM64 OS, Docker access and Compose readiness checks passed.")
	process.exit(0)
}

const release = new Date().toISOString().replaceAll(/[:.]/g, "-")
const remoteRoot = directory
const remoteRelease = `${remoteRoot}/releases/${release}`
const temp = mkdtempSync(join(tmpdir(), "lightshow-deploy-"))

try {
	const archive = join(temp, "source.tar.gz")

	execFileSync("tar", ["-czf", archive, "--null", "-T", "-"], {
		cwd: root,
		input: files.join("\0") + "\0",
	})

	console.log(`Uploading ${files.length} source files to ${sshTarget}:${remoteRelease}`)
	ssh(
		`umask 077; mkdir -p ${quote(remoteRelease)} && tar -xzf - -C ${quote(remoteRelease)}`,
		readFileSync(archive),
	)

	ssh(
		`bash ${quote(`${remoteRelease}/scripts/deploy-remote.sh`)} ${[remoteRoot, release, hostname, projectName].map(quote).join(" ")}`,
	)

	const trustDir = join(root, ".local/pi/trust")

	mkdirSync(trustDir, { recursive: true, mode: 0o700 })

	for (const file of ["https-ca.crt", "mqtt-ca.crt", "device-ca-bundle.crt"])
		writeFileSync(
			join(trustDir, file),
			ssh(`cat ${quote(`${remoteRoot}/shared/.secrets/trust/${file}`)}`, undefined, true),
			{ mode: 0o644 },
		)

	console.log(`Deployed https://${hostname}. Public CA certificates saved in .local/pi/trust/.`)
	console.log(`Administrator password stays on the Pi: ${directory}/shared/.local/admin-password`)
} finally {
	rmSync(temp, { recursive: true, force: true })
}
