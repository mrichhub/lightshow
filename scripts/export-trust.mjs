import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const cert = execFileSync("docker", [
	"compose",
	"exec",
	"-T",
	"caddy",
	"cat",
	"/data/caddy/pki/authorities/local/root.crt",
])

writeFileSync(".secrets/trust/https-ca.crt", cert)

writeFileSync(
	".secrets/trust/device-ca-bundle.crt",
	Buffer.concat([cert, readFileSync(".secrets/trust/mqtt-ca.crt")]),
)

console.log(
	"Public CA certificates exported to .secrets/trust. Provision device-ca-bundle.crt to firmware. Restart simulators after trust changes.",
)
