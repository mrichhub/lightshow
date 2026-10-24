import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir, networkInterfaces } from "node:os"
import { join } from "node:path"
import { lookup } from "node:dns/promises"
import dgram from "node:dgram"
import { Agent, fetch } from "undici"
import mqtt, { type MqttClient } from "mqtt"
import { MongoClient } from "mongodb"
import { Simulator } from "../../apps/esp-simulator/src/simulator.js"
import { encodeFrame } from "../../packages/ddp/src/index.js"
import { tokenHash } from "../../packages/models/src/security.js"
import type { DeviceConfig, Element, Scene } from "../../packages/models/src/index.js"

const enabled = process.env.LIGHTSHOW_INTEGRATION === "1"

async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 15000) {
	const deadline = Date.now() + timeout

	while (Date.now() < deadline) {
		if (await check()) return

		await new Promise((r) => setTimeout(r, 100))
	}

	throw new Error(message)
}

test(
	"HTTPS enrollment → TLS MQTT configuration → heartbeat/SSE → scene/DDP → overrides → revocation",
	{ skip: !enabled, timeout: 90000 },
	async (t) => {
		const origin = process.env.PUBLIC_ORIGIN!
		const httpsCA = await readFile(process.env.HTTPS_CA_FILE!, "utf8")
		const mqttCA = await readFile(process.env.MQTT_CA_FILE!, "utf8")
		const agent = new Agent({ connect: { ca: httpsCA, rejectUnauthorized: true } })
		const dir = await mkdtemp(join(tmpdir(), "lightshow-integration-"))
		let sim: Simulator | undefined
		let observer: MqttClient | undefined
		let cookie = ""
		const streamController = new AbortController()
		const mongo = new MongoClient(process.env.MONGO_URL!)

		await mongo.connect()

		const db = mongo.db()
		const suffix = Date.now().toString(36)
		const hardwareId = "test-" + suffix
		const elementId = "test-element-" + suffix
		const sceneId = "test-scene-" + suffix
		let deviceId = ""
		let adminId = ""
		let adminToken = ""

		async function request(
			path: string,
			method = "GET",
			body?: unknown,
			auth: "cookie" | string = "cookie",
			extra: Record<string, string> = {},
		) {
			const r = await fetch(origin + "/v1" + path, {
				dispatcher: agent,
				method,
				headers: {
					...(auth === "cookie"
						? { cookie, origin }
						: { authorization: "Bearer " + auth }),
					...(body === undefined ? {} : { "content-type": "application/json" }),
					...extra,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			})
			const data = (await r.json()) as Record<string, unknown>

			return { r, data }
		}

		t.after(async () => {
			streamController.abort()
			await observer?.endAsync(true)
			await sim?.close()

			await Promise.all([
				db.collection("devices").deleteMany({ hardwareId }),
				db.collection("device_status").deleteMany({ deviceId }),
				db
					.collection("credentials")
					.deleteMany({ $or: [{ deviceId }, { hardwareId }, { id: adminId }] }),
				db.collection("elements").deleteOne({ id: elementId }),
				db.collection("scenes").deleteOne({ id: sceneId }),
			])

			await db
				.collection("shows")
				.updateOne(
					{ _id: "desired" as never },
					{ $set: { sceneId: null, overrides: [] }, $inc: { version: 1 } },
				)

			if (cookie) await request("/auth/logout", "POST").catch(() => {})

			await mongo.close()
			await agent.close()
			await rm(dir, { recursive: true, force: true })
		})

		await t.test(
			"administrator sessions, origin checks and administrative tokens",
			async () => {
				assert.equal((await request("/devices", "GET", undefined, "invalid")).r.status, 401)

				assert.equal(
					(
						await request("/auth/login", "POST", { password: "wrong" }, "cookie", {
							origin: "https://untrusted.invalid",
						})
					).r.status,
					403,
				)

				assert.equal(
					(await request("/auth/login", "POST", { password: "wrong" })).r.status,
					401,
				)

				const password = (await readFile("/run/admin-password", "utf8")).trim()
				const login = await request("/auth/login", "POST", { password })

				assert.equal(login.r.status, 200)

				const setCookie = login.r.headers.get("set-cookie")!

				assert.match(setCookie, /HttpOnly/i)
				assert.match(setCookie, /Secure/i)
				assert.match(setCookie, /SameSite=Strict/i)
				assert.match(setCookie, /Path=\//)
				cookie = setCookie.split(";")[0]!
				assert.equal((await request("/auth/session")).r.status, 200)

				assert.equal(
					(
						await request(
							"/auth/tokens",
							"POST",
							{ name: "integration", days: 1 },
							"cookie",
							{
								origin: "https://bad.invalid",
							},
						)
					).r.status,
					403,
				)

				const issued = await request("/auth/tokens", "POST", {
					name: "integration",
					days: 1,
				})

				adminId = issued.data.id as string
				adminToken = issued.data.token as string

				assert.equal(
					(await request("/devices", "GET", undefined, adminToken)).r.status,
					200,
				)
			},
		)

		let provisioning = ""

		await t.test(
			"hardware-bound, single-use enrollment and stable opaque device identity",
			async () => {
				const issued = await request("/enrollments", "POST", { hardwareId, minutes: 10 })

				assert.equal(issued.r.status, 200)
				provisioning = issued.data.token as string

				assert.equal(
					(
						await request(
							"/devices/init",
							"POST",
							{ hardwareId: "different", board: "esp32dev" },
							provisioning,
						)
					).r.status,
					403,
				)

				assert.equal(
					(
						await request(
							"/devices/init",
							"POST",
							{ hardwareId, board: "esp32dev" },
							adminToken,
						)
					).r.status,
					403,
				)

				sim = new Simulator({
					apiUrl: origin,
					hardwareId,
					provisioningToken: provisioning,
					stateFile: join(dir, "identity.json"),
					httpsCA,
					mqttCA,
					inspectPort: 4091,
					mqttUrl: process.env.MQTT_URL,
				})

				await sim.start()
				deviceId = sim.identity!.deviceId
				await until(() => sim!.mqttConnected, "Simulator did not authenticate to TLS MQTT")
				assert.match(deviceId, /^[A-Z0-9]{6}$/)
				assert.equal(Buffer.from(sim.identity!.token, "base64url").length, 32)

				assert.equal(
					(
						await request(
							"/devices/init",
							"POST",
							{ hardwareId, board: "esp32dev" },
							provisioning,
						)
					).r.status,
					409,
				)

				assert.equal(
					(await request("/devices/config", "GET", undefined, sim.identity!.token)).r
						.status,
					200,
				)

				assert.equal(
					(await request("/devices", "GET", undefined, sim.identity!.token)).r.status,
					401,
				)

				const credential = await db
					.collection("credentials")
					.findOne({ _id: tokenHash(sim.identity!.token) as never })

				assert.ok(credential)
				assert.equal(credential.token, undefined)

				await until(
					async () => !!(await db.collection("device_status").findOne({ deviceId })),
					"Heartbeat never persisted",
				)
			},
		)

		let config: DeviceConfig

		await t.test("shared SSE snapshot and incremental heartbeat updates", async () => {
			const response = await fetch(origin + "/v1/events", {
				dispatcher: agent,
				headers: { cookie },
				signal: streamController.signal,
			})

			assert.equal(response.status, 200)

			const reader = response.body!.getReader()
			let text = ""
			const readUntil = async (value: string) => {
				const deadline = Date.now() + 12000

				while (!text.includes(value) && Date.now() < deadline) {
					const part = await reader.read()

					text += new TextDecoder().decode(part.value)
				}

				assert.ok(text.includes(value), "Missing SSE event " + value)
			}

			await readUntil("event: snapshot")
			assert.ok(text.includes(deviceId))
			await readUntil("event: status")
			streamController.abort()
		})

		const self = Object.values(networkInterfaces())
			.flat()
			.find((i) => i?.family === "IPv4" && !i.internal)!.address

		await t.test(
			"configuration propagates over authenticated MQTT and invalid GPIOs are rejected",
			async () => {
				config = sim!.identity!.config

				const bad = { ...config, outputs: [{ ...config.outputs[0]!, gpio: 6 }] }
				const { deviceId: _, configVersion, ...badInput } = bad

				assert.equal(
					(
						await request("/devices/" + deviceId, "PATCH", {
							config: badInput,
							expectedVersion: configVersion,
						})
					).r.status,
					400,
				)

				const engine = (await lookup("show-engine", { family: 4 })).address
				const { deviceId: __, configVersion: v, ...input } = config

				input.ddp = { ...input.ddp, allowedSources: [engine, self] }

				const saved = await request("/devices/" + deviceId, "PATCH", {
					config: input,
					expectedVersion: v,
				})

				assert.equal(saved.r.status, 200)
				config = saved.data.config as DeviceConfig

				await until(
					() => sim!.identity!.config.configVersion === config.configVersion,
					"MQTT config notification not applied",
					3000,
				)

				assert.equal(
					(
						await request("/devices/" + deviceId, "PATCH", {
							config: input,
							expectedVersion: v,
						})
					).r.status,
					409,
				)

				observer = await mqtt.connectAsync(process.env.MQTT_URL!, {
					username: deviceId,
					password: sim!.identity!.mqtt.password,
					ca: mqttCA,
					rejectUnauthorized: true,
					clientId: "acl-test-" + suffix,
					protocolVersion: 5,
					reconnectPeriod: 0,
				})

				observer.on("error", () => {})

				await assert.rejects(() =>
					observer!.subscribeAsync("lightshow/devices/OTHER1/command", { qos: 1 }),
				)
			},
		)

		await t.test(
			"scene activation renders RGB frames and element/output overrides preserve black skipped LEDs",
			async () => {
				const element: Element = {
					id: elementId,
					name: "Integration element",
					pixelCount: 96,
					segments: [
						{
							deviceId,
							outputIndex: 0,
							startPixel: 0,
							physicalPixelCount: 100,
							elementStartPixel: 0,
							skippedPixels: [4, 20, 50, 88],
						},
					],
				}

				assert.equal((await request("/elements", "POST", element)).r.status, 200)

				assert.equal(
					(await request("/elements", "POST", { ...element, id: elementId + "-overlap" }))
						.r.status,
					400,
				)

				const scene: Scene = {
					id: sceneId,
					name: "Integration scene",
					effects: [
						{ type: "solid", targets: [elementId], params: { color: "#ff6600" } },
					],
				}

				assert.equal((await request("/scenes", "POST", scene)).r.status, 200)

				assert.equal(
					(await request("/scenes/" + sceneId + "/activate", "POST")).r.status,
					200,
				)

				await until(
					() => sim!.receiver!.frames > 2 && sim!.receiver!.pixels[0] === 255,
					"No scene DDP pixels received",
				)

				assert.deepEqual([...sim!.receiver!.pixels.subarray(0, 3)], [255, 102, 0])

				for (const p of [4, 20, 50, 88])
					assert.deepEqual(
						[...sim!.receiver!.pixels.subarray(p * 3, p * 3 + 3)],
						[0, 0, 0],
					)

				await request("/show/overrides", "PUT", [
					{ elementId, color: "#00ff00", brightness: 1, pixel: 4 },
				])

				await until(() => sim!.receiver!.pixels[16] === 255, "Element override not applied")

				await request("/show/overrides", "PUT", [
					{ deviceId, outputIndex: 0, color: "#ffffff", brightness: 1 },
				])

				await until(() => sim!.receiver!.pixels[2] === 255, "Output override not applied")
				assert.deepEqual([...sim!.receiver!.pixels.subarray(12, 15)], [0, 0, 0])
				await request("/show/overrides", "PUT", [])
			},
		)

		await t.test(
			"mode changes apply without reflashing; listening times out after five seconds",
			async () => {
				const update = async (
					mode: "local" | "listening",
					sources = config.ddp.allowedSources,
				) => {
					const { deviceId: _, configVersion, ...input } = config

					input.mode = mode
					input.ddp = { ...input.ddp, allowedSources: sources }

					const result = await request("/devices/" + deviceId, "PATCH", {
						config: input,
						expectedVersion: configVersion,
					})

					assert.equal(result.r.status, 200)
					config = result.data.config as DeviceConfig

					await until(
						() => sim!.identity!.config.configVersion === config.configVersion,
						"Mode not applied",
					)
				}

				await update("local")

				await until(
					() => sim!.receiver!.pixels.some((p) => p !== 0),
					"Local renderer stayed black",
				)

				await update("listening", [self])

				const udp = dgram.createSocket("udp4")

				try {
					for (const packet of encodeFrame(Buffer.alloc(300, 123)))
						await new Promise<void>((resolve, reject) =>
							udp.send(packet, config.ddp.port, self, (e) =>
								e ? reject(e) : resolve(),
							),
						)

					await until(
						() => sim!.receiver!.pixels[0] === 123,
						"Direct DDP packet not accepted",
					)

					await until(
						() => sim!.receiver!.pixels.every((p) => p === 0),
						"Five-second DDP blackout missing",
						6500,
					)
				} finally {
					udp.close()
				}
			},
		)

		await t.test("SSE emits an offline transition without a new heartbeat", async () => {
			const controller = new AbortController()
			const timeout = setTimeout(() => controller.abort(), 10000)

			try {
				const response = await fetch(origin + "/v1/events", {
					dispatcher: agent,
					headers: { cookie },
					signal: controller.signal,
				})
				const reader = response.body!.getReader()

				await db
					.collection("device_status")
					.updateOne(
						{ deviceId },
						{ $set: { lastSeen: new Date(Date.now() - 30000).toISOString() } },
					)

				let output = ""

				while (!output.includes('"connectivity":"offline"')) {
					const data = await reader.read()

					if (data.done) break

					output += new TextDecoder().decode(data.value)
				}

				assert.ok(output.includes("event: health"))
				assert.ok(output.includes('"connectivity":"offline"'))
			} finally {
				clearTimeout(timeout)
				controller.abort()
			}
		})

		await t.test(
			"saved Bearer identity survives reboot and an offline DDP port change",
			async () => {
				const options = sim!.options

				await sim!.close()

				const { deviceId: _, configVersion, ...input } = config

				input.ddp = { ...input.ddp, port: 44048 }

				const saved = await request("/devices/" + deviceId, "PATCH", {
					config: input,
					expectedVersion: configVersion,
				})

				assert.equal(saved.r.status, 200)
				config = saved.data.config as DeviceConfig
				sim = new Simulator(options)
				await sim.start()
				await until(() => sim!.mqttConnected, "Reboot did not recover MQTT credentials")
				assert.equal(sim.identity!.deviceId, deviceId)
				assert.equal(sim.identity!.config.ddp.port, 44048)

				const udp = dgram.createSocket("udp4")

				try {
					for (const packet of encodeFrame(Buffer.alloc(300, 55)))
						await new Promise<void>((resolve, reject) =>
							udp.send(packet, 44048, self, (e) => (e ? reject(e) : resolve())),
						)

					await until(
						() => sim!.receiver!.pixels[0] === 55,
						"Restarted receiver did not bind the new port",
					)
				} finally {
					udp.close()
				}
			},
		)

		await t.test(
			"revocation rejects device, administrator token and logged-out session",
			async () => {
				assert.equal(
					(await request("/devices/" + deviceId + "/revoke", "POST")).r.status,
					200,
				)

				assert.equal(
					(await request("/devices/config", "GET", undefined, sim!.identity!.token)).r
						.status,
					401,
				)

				await request("/auth/tokens/" + adminId, "DELETE")

				assert.equal(
					(await request("/devices", "GET", undefined, adminToken)).r.status,
					401,
				)

				await request("/auth/logout", "POST")
				assert.equal((await request("/auth/session")).r.status, 401)
				cookie = ""
			},
		)
	},
)
