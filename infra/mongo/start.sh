#!/usr/bin/env bash
set -euo pipefail
cp /bootstrap/mongo-key /tmp/lightshow-mongo-key
chown mongodb:mongodb /tmp/lightshow-mongo-key
chmod 400 /tmp/lightshow-mongo-key
exec /usr/local/bin/docker-entrypoint.sh mongod --replSet rs0 --bind_ip_all --keyFile /tmp/lightshow-mongo-key
