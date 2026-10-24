#!/usr/bin/env bash
set -euo pipefail

mongosh --host mongo -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin --quiet --eval '
try {
	rs.status()
} catch (e) {
	if (e.code === 94) rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "mongo:27017" }] })
	else throw e
}

let primary = false

for (let n = 0; n < 60; n++) {
	if (db.hello().isWritablePrimary) {
		primary = true
		break
	}

	sleep(1000)
}

if (!primary) quit(1)

const application = db.getSiblingDB("lightshow")

if (!application.getUser("lightshow-api"))
	application.createUser({
		user: "lightshow-api",
		pwd: process.env.MONGO_API_PASSWORD,
		roles: [{ role: "readWrite", db: "lightshow" }],
	})

if (!application.getUser("lightshow-engine"))
	application.createUser({
		user: "lightshow-engine",
		pwd: process.env.MONGO_ENGINE_PASSWORD,
		roles: [{ role: "read", db: "lightshow" }],
	})
'
