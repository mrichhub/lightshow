#!/usr/bin/env bash
set -euo pipefail
umask 077

deploy_root="$HOME/$1"
release="$2"
hostname="$3"
project="$4"
release_dir="$deploy_root/releases/$release"
shared="$deploy_root/shared"

exec 9>"$deploy_root/.deploy.lock"

if ! flock -n 9; then
	echo "Another deployment is running." >&2
	exit 1
fi

cd "$release_dir"

# A fixed project keeps named volumes stable as source release directories change.
compose=(docker compose --project-name "$project" --env-file "$shared/.env" -f "$release_dir/docker-compose.yml")

mkdir -p "$shared"
expected_identity="$hostname $project"

if [[ -e "$shared/.deployment" && "$(cat "$shared/.deployment")" != "$expected_identity" ]]; then
	echo "Hostname/project changed. Refusing to rotate trust or select a different database. See docs/deployment.md." >&2
	exit 1
fi

if [[ ! -e "$shared/.env" ]]; then
	if [[ -e "$shared/.secrets" || -e "$shared/.local" ]] || [[ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]]; then
		echo "Existing or partial deployment state found. Refusing to replace credentials or reuse a database." >&2
		exit 1
	fi

	echo "Building ARM64 bootstrap image and generating fresh Pi credentials..."
	docker build --target setup --tag "$project-setup:latest" .
	docker run --rm --user "$(id -u):$(id -g)" \
		--env "LIGHTSHOW_HOST=$hostname" \
		--mount "type=bind,src=$shared,dst=/deployment" \
		--workdir /deployment "$project-setup:latest" node /app/scripts/setup.mjs
	printf '%s\n' "$expected_identity" > "$shared/.deployment"
fi

# Mosquitto takes ownership of broker/ (uid 1883, mode 0700). The SSH user
# cannot inspect its credential file after startup; Docker owns that boundary.
if [[ ! -f "$shared/.deployment" || ! -f "$shared/.secrets/mongo-key" || ! -d "$shared/.secrets/broker" || ! -f "$shared/.local/admin-password" ]]; then
	echo "Private deployment state is incomplete. Inspect shared/ before retrying; never regenerate credentials over a running database." >&2
	exit 1
fi

for path in .env .secrets .local; do
	ln -s "$shared/$path" "$release_dir/$path"
done

# Setup never runs again during an update; volumes, keys and broker state persist.
"${compose[@]}" config --quiet
"${compose[@]}" build
"${compose[@]}" up -d --wait --wait-timeout 300

# Caddy owns its private CA. Export only public trust through the shared directory.
"${compose[@]}" exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$shared/.secrets/trust/https-ca.crt.tmp"
mv "$shared/.secrets/trust/https-ca.crt.tmp" "$shared/.secrets/trust/https-ca.crt"
cat "$shared/.secrets/trust/https-ca.crt" "$shared/.secrets/trust/mqtt-ca.crt" > "$shared/.secrets/trust/device-ca-bundle.crt"
chmod 644 "$shared/.secrets/trust/"*.crt

# --resolve checks the hostname and full TLS chain without depending on host mDNS.
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 2 \
	--cacert "$shared/.secrets/trust/https-ca.crt" \
	--resolve "$hostname:443:127.0.0.1" "https://$hostname/v1/health"

ln -s "releases/$release" "$deploy_root/.current-$release"
mv -Tf "$deploy_root/.current-$release" "$deploy_root/current"

"${compose[@]}" ps
printf '\nDeployment healthy at https://%s\n' "$hostname"
