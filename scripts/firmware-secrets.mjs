import { readFileSync, writeFileSync } from "node:fs"

const enrollment = process.env.FIRMWARE_PROVISIONING_TOKEN ?? ""

if (process.argv.slice(2).some((arg) => arg !== "--pi") || process.argv.length > 3)
	throw new Error("Usage: node scripts/firmware-secrets.mjs [--pi]")

if (!/^[A-Za-z0-9_-]{43}$/.test(enrollment))
	throw new Error("Set FIRMWARE_PROVISIONING_TOKEN to a hardware-bound enrollment credential")

const pi = process.argv.includes("--pi")

const env = pi
	? piEnvironment()
	: Object.fromEntries(
			readFileSync(".env", "utf8")
				.trim()
				.split("\n")
				.filter((l) => !l.startsWith("#"))
				.map((l) => {
					const i = l.indexOf("=")

					return [l.slice(0, i), l.slice(i + 1).replace(/^'|'$/g, "")]
				}),
		)

function piEnvironment() {
	const { hostname } = JSON.parse(readFileSync(".local/deploy.json", "utf8"))

	if (typeof hostname !== "string" || !/^[a-z0-9.-]+$/.test(hostname))
		throw new Error("Invalid Pi hostname in .local/deploy.json")

	return { PUBLIC_ORIGIN: `https://${hostname}`, LIGHTSHOW_HOST: hostname }
}

const ca = readFileSync(
	pi ? ".local/pi/trust/device-ca-bundle.crt" : ".secrets/trust/device-ca-bundle.crt",
	"utf8",
)

const define = (key, value) => `#define ${key} ${JSON.stringify(value)}\n`

writeFileSync(
	"firmware/esp32/include/secrets.h",
	"#pragma once\n" +
		define("LIGHTSHOW_API_URL", env.PUBLIC_ORIGIN) +
		define("LIGHTSHOW_PROVISIONING_TOKEN", enrollment) +
		define("LIGHTSHOW_WIFI_SSID", process.env.FIRMWARE_WIFI_SSID ?? "") +
		define("LIGHTSHOW_WIFI_PASSWORD", process.env.FIRMWARE_WIFI_PASSWORD ?? "") +
		define("LIGHTSHOW_NTP_HOST", process.env.FIRMWARE_NTP_HOST ?? env.LIGHTSHOW_HOST) +
		`#define LIGHTSHOW_INITIAL_TIME ${Math.floor(Date.now() / 1000)}\nstatic const char LIGHTSHOW_CA[] = ${JSON.stringify(ca)};\n`,
	{ mode: 0o600 },
)

console.log(
	"Private firmware secrets generated. Build and flash promptly; maintain LAN NTP for certificate validation.",
)
