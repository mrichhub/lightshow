import "dotenv/config"
import { openDatabase } from "./store.js"
import { createApp } from "./app.js"
import { connectBus } from "@lightshow/messaging"

const required = (key: string) => {
	const value = process.env[key]

	if (!value) throw new Error(`${key} is required`)

	return value
}

const hours = Number(process.env.SESSION_HOURS ?? 24)

if (!Number.isFinite(hours) || hours < 1 || hours > 720)
	throw new Error("SESSION_HOURS must be 1..720")

const { client, db } = await openDatabase(required("MONGO_URL"))

const bus = await connectBus("API")

const app = await createApp(db, client, bus, {
	origin: required("PUBLIC_ORIGIN"),
	adminHash: required("ADMIN_PASSWORD_HASH"),
	sessionHours: hours,
	mqttPublicUrl: required("MQTT_PUBLIC_URL"),
	defaultDdpPort: Number(process.env.DDP_PORT ?? 4048),
	logLevel: process.env.LOG_LEVEL,
})

await app.listen({ port: Number(process.env.API_PORT ?? 3000), host: "0.0.0.0" })

for (const signal of ["SIGTERM", "SIGINT"])
	process.once(signal, () => {
		void app
			.close()
			.then(() => bus.close())
			.then(() => client.close())
			.then(() => process.exit(0))
	})
