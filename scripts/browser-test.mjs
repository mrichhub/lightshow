import "dotenv/config"
import { readFileSync } from "node:fs"
import { connect } from "node:tls"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"

const host = process.env.LIGHTSHOW_HOST ?? "lightshow.home.arpa"

const pin = await new Promise((resolve, reject) => {
	const socket = connect(
		{
			host: "127.0.0.1",
			port: Number(process.env.HTTPS_PORT ?? 443),
			servername: host,
			ca: readFileSync(".secrets/trust/https-ca.crt"),
			rejectUnauthorized: true,
		},
		() => {
			const cert = socket.getPeerX509Certificate()

			if (!cert) {
				reject(new Error("No TLS peer certificate"))
				socket.end()

				return
			}

			resolve(
				createHash("sha256")
					.update(cert.publicKey.export({ type: "spki", format: "der" }))
					.digest("base64"),
			)

			socket.end()
		},
	)

	socket.on("error", reject)
})

const result = spawnSync("node_modules/.bin/playwright", ["test"], {
	stdio: "inherit",
	env: { ...process.env, LIGHTSHOW_TEST_SPKI: String(pin) },
})

process.exit(result.status ?? 1)
