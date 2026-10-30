import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { deploymentFiles } from "../scripts/deploy-files.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "lightshow-deploy-test-"))

	t.after(() => rmSync(dir, { recursive: true, force: true }))

	return dir
}

test("deployment archive excludes private files and symlinks, including tracked secrets", (t) => {
	const dir = fixture(t)
	const files = [
		"Dockerfile",
		".dockerignore",
		"apps/api/src/main.ts",
		"apps/api/.env",
		"apps/api/dist/index.js",
		"apps/api/node_modules/dependency.js",
		"infra/ca.key",
		"scripts/network.local.json",
		".env",
		".local/admin-password",
		".secrets/mongo-key",
		"firmware/esp32/include/secrets.h",
	]

	for (const file of files) {
		mkdirSync(dirname(join(dir, file)), { recursive: true })
		writeFileSync(join(dir, file), "private sentinel")
	}

	symlinkSync(join(dir, ".env"), join(dir, "scripts/link.mjs"))
	symlinkSync(join(dir, ".local"), join(dir, "apps/private"))

	assert.deepEqual(
		deploymentFiles(dir, [
			...files,
			"scripts/link.mjs",
			"apps/private/admin-password",
			"apps/deleted.ts",
			"../escape",
		]),
		[".dockerignore", "Dockerfile", "apps/api/src/main.ts"],
	)
})

test(
	"archive contains current source without local deployment state or firmware",
	{ skip: !existsSync(join(root, ".git")) },
	() => {
		const files = execFileSync(process.execPath, ["scripts/deploy.mjs", "--list-files"], {
			cwd: root,
			encoding: "utf8",
		})
			.trim()
			.split("\n")

		assert.ok(files.includes("docker-compose.yml"))
		assert.ok(files.includes("scripts/deploy-remote.sh"))
		assert.ok(files.includes("scripts/setup.mjs"))
		assert.ok(files.includes("tests/browser/ui.spec.ts"))
		assert.ok(
			files.every((file) => !/^(\.env|\.local|\.secrets|firmware|node_modules)\b/.test(file)),
		)
	},
)

test("Pi firmware generation uses Pi origin and public trust without replacing Mac config", (t) => {
	const dir = fixture(t)

	mkdirSync(join(dir, ".local/pi/trust"), { recursive: true })
	mkdirSync(join(dir, "firmware/esp32/include"), { recursive: true })
	writeFileSync(join(dir, ".local/deploy.json"), JSON.stringify({ hostname: "pi.local" }))
	writeFileSync(join(dir, ".local/pi/trust/device-ca-bundle.crt"), "PI PUBLIC TRUST")
	writeFileSync(join(dir, ".env"), "PUBLIC_ORIGIN='https://mac.local'\n")

	execFileSync(process.execPath, [join(root, "scripts/firmware-secrets.mjs"), "--pi"], {
		cwd: dir,
		env: { ...process.env, FIRMWARE_PROVISIONING_TOKEN: "A".repeat(43) },
	})

	const header = readFileSync(join(dir, "firmware/esp32/include/secrets.h"), "utf8")

	assert.match(header, /LIGHTSHOW_API_URL "https:\/\/pi.local"/)
	assert.match(header, /PI PUBLIC TRUST/)
	assert.equal(readFileSync(join(dir, ".env"), "utf8"), "PUBLIC_ORIGIN='https://mac.local'\n")
})

// Exercise credential/volume preservation and failure handling without a Docker daemon or SSH.
// util-linux flock and mv -T are Linux dependencies of the remote script.
test(
	"remote deploy preserves state and refuses unsafe initialization",
	{ skip: process.platform !== "linux" },
	async (t) => {
		const dir = fixture(t)
		const home = join(dir, "home")
		const bin = join(dir, "bin")
		const log = join(dir, "docker.log")

		mkdirSync(bin, { recursive: true })
		mkdirSync(home)
		writeFileSync(join(bin, "curl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
		writeFileSync(
			join(bin, "docker"),
			`#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [[ "$1" == volume ]]; then
  printf '%s' "\${EXISTING_VOLUMES:-}"
elif [[ "$1" == run ]]; then
  mkdir -p "$HOME/lightshow/shared/.secrets/broker" "$HOME/lightshow/shared/.secrets/trust" "$HOME/lightshow/shared/.local"
  printf 'sentinel' > "$HOME/lightshow/shared/.env"
  touch "$HOME/lightshow/shared/.secrets/mongo-key" "$HOME/lightshow/shared/.secrets/broker/dynamic-security.json" "$HOME/lightshow/shared/.local/admin-password"
  printf 'mqtt' > "$HOME/lightshow/shared/.secrets/trust/mqtt-ca.crt"
elif [[ " $* " == *" up "* && "\${FAIL_HEALTH:-}" == 1 ]]; then
  exit 1
elif [[ " $* " == *" exec "* ]]; then
  printf 'https'
fi
`,
			{ mode: 0o755 },
		)

		function deploy(release, overrides = {}) {
			mkdirSync(join(home, "lightshow/releases", release), { recursive: true })

			return spawnSync(
				"bash",
				[
					join(root, "scripts/deploy-remote.sh"),
					"lightshow",
					release,
					"pi.local",
					"lightshow-pi",
				],
				{
					env: {
						...process.env,
						HOME: home,
						PATH: `${bin}:${process.env.PATH}`,
						DOCKER_LOG: log,
						...overrides,
					},
					encoding: "utf8",
				},
			)
		}

		await t.test("existing project volumes prevent first initialization", () => {
			const result = deploy("rejected", { EXISTING_VOLUMES: "lightshow-pi_mongo-data" })

			assert.notEqual(result.status, 0)
			assert.match(result.stderr, /Refusing to replace credentials/)
		})

		await t.test("first deploy generates credentials exactly once", () => {
			const result = deploy("first")

			assert.equal(result.status, 0, result.stderr)
			assert.equal(readFileSync(join(home, "lightshow/shared/.env"), "utf8"), "sentinel")
		})

		await t.test("update reuses credentials and fixed project without deleting volumes", () => {
			const result = deploy("second")
			const commands = readFileSync(log, "utf8")

			assert.equal(result.status, 0, result.stderr)
			assert.equal(commands.split("\n").filter((line) => line.startsWith("run ")).length, 1)
			assert.match(commands, /compose --project-name lightshow-pi/)
			assert.doesNotMatch(commands, /\bdown\b|volume rm/)
			assert.equal(readFileSync(join(home, "lightshow/shared/.env"), "utf8"), "sentinel")
		})

		await t.test("unhealthy update does not mark the release current", () => {
			const result = deploy("broken", { FAIL_HEALTH: "1" })

			assert.notEqual(result.status, 0)
			assert.equal(
				execFileSync("readlink", [join(home, "lightshow/current")], {
					encoding: "utf8",
				}).trim(),
				"releases/second",
			)
		})

		await t.test("hostname changes cannot silently replace TLS trust", () => {
			writeFileSync(join(home, "lightshow/shared/.deployment"), "other.local lightshow-pi\n")
			const result = deploy("renamed")

			assert.notEqual(result.status, 0)
			assert.match(result.stderr, /Hostname\/project changed/)
		})
	},
)
