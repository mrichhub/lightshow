#!/usr/bin/env bash
set -euo pipefail

if [[ "$EUID" -ne 0 || "$#" -ne 2 ]]; then
	echo "Usage: sudo bash scripts/prepare-pi.sh <SSH username> <LAN CIDR, e.g. 192.168.1.0/24>" >&2
	exit 1
fi

deploy_user="$1"
lan_cidr="$2"

if [[ ! "$deploy_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || ! id "$deploy_user" >/dev/null 2>&1; then
	echo "Choose an existing SSH user." >&2
	exit 1
fi

if [[ ! "$lan_cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]]; then
	echo "Provide the trusted lighting network's IPv4 CIDR." >&2
	exit 1
fi

IFS='./' read -r a b c d prefix <<< "$lan_cidr"

for octet in "$a" "$b" "$c" "$d"; do
	if (( 10#$octet > 255 )); then
		echo "Invalid IPv4 CIDR." >&2
		exit 1
	fi
done

. /etc/os-release

if [[ "$ID" != "debian" || ! "$VERSION_CODENAME" =~ ^(bookworm|trixie)$ || "$(dpkg --print-architecture)" != "arm64" ]]; then
	echo "This helper supports 64-bit Debian/Raspberry Pi OS Bookworm or Trixie on Pi 5." >&2
	exit 1
fi

apt-get update
apt-get install -y ca-certificates curl openssl avahi-daemon chrony

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
	for package in docker.io docker-compose docker-doc docker-buildx podman-docker containerd runc; do
		if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "install ok installed"; then
			echo "Conflicting package $package is installed. Review Docker's Debian installation guide before removing it." >&2
			exit 1
		fi
	done

	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
	chmod a+r /etc/apt/keyrings/docker.asc

	cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $VERSION_CODENAME
Components: stable
Architectures: arm64
Signed-By: /etc/apt/keyrings/docker.asc
EOF

	apt-get update
	apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

usermod -aG docker "$deploy_user"

install -d /etc/chrony/conf.d
printf 'allow %s\n' "$lan_cidr" > /etc/chrony/conf.d/lightshow.conf

if ! grep -Eq '^confdir[[:space:]]+/etc/chrony/conf.d([[:space:]]|$)' /etc/chrony/chrony.conf; then
	printf '\nconfdir /etc/chrony/conf.d\n' >> /etc/chrony/chrony.conf
fi

systemctl enable --now docker avahi-daemon chrony
systemctl restart chrony

docker compose version
chronyc tracking

echo "Pi prepared. Docker group membership grants root-level control. Reconnect SSH before deploying."
echo "Reserve the Pi's LAN IPv4 in DHCP and allow LAN TCP 22/80/443/8883, UDP 123/5353 and outbound DDP UDP 4048."
