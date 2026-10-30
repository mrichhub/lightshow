# Raspberry Pi deployment

`pnpm run deploy` sends application source over SSH and builds the pinned Docker images on the Pi. The first deployment creates independent credentials, MQTT certificates, Caddy storage and an empty MongoDB database on the Pi. It does not copy the Mac's database, `.env`, device identities or private certificates. Later deployments preserve the Pi's configuration, database and certificate authorities.

## Prepare a new Pi once

Use a Pi 5 with **64-bit Debian/Raspberry Pi OS Bookworm or Trixie**. Enable SSH and install your Mac's public SSH key in the Pi user's `authorized_keys`. Connect once interactively and verify its SSH host key. Keep the Pi and ESPs on the same trusted lighting LAN, without wireless client isolation. `.local` discovery needs multicast to reach between them; it generally does not cross VLANs.

Reserve the Pi's Ethernet IPv4 address in your router's DHCP settings. Prefer one active network interface for predictable discovery and DDP source addresses; if both Wi-Fi and Ethernet remain active, verify which address the Pi uses to reach the ESP. Do not change the Pi's hostname after generating deployment certificates.

From the Mac, substituting your SSH user and trusted LAN CIDR:

```sh
scp scripts/prepare-pi.sh your-user@lightshow-raspberry-pi.local:/tmp/lightshow-prepare-pi.sh
ssh -t your-user@lightshow-raspberry-pi.local \
  'sudo bash /tmp/lightshow-prepare-pi.sh your-user 192.168.1.0/24'
```

The helper installs Docker Engine, Buildx and Compose from [Docker's official Debian repository](https://docs.docker.com/engine/install/debian/). It installs Avahi for mDNS and chrony for time synchronization, with NTP access limited to the supplied LAN. It enables these services at boot and adds the SSH user to the `docker` group. That group grants root-level control of the Pi. It does not enable passwordless sudo. If conflicting Docker packages already exist, it stops and asks you to review them rather than removing them.

Disconnect and reconnect after preparation, then check:

```sh
ssh your-user@lightshow-raspberry-pi.local 'docker info >/dev/null && docker compose version && chronyc tracking'
```

If a host/router firewall is active, permit trusted LAN TCP 22, 80, 443 and 8883, UDP 123 and multicast UDP 5353. Allow Pi-to-ESP UDP 4048; this is outbound from the engine, so no Pi Docker port mapping is needed for DDP. MongoDB and API ports stay private to Docker. Do not forward these services from the internet. Docker-published ports have their own firewall behavior; use Docker's documented filtering rules if you restrict them.

The host clock must be accurate before provisioning and remain accurate during offline operation. `chronyc tracking` should report synchronization to a valid time source. The firmware's initial timestamp is only a bootstrap aid. Verify that NTP is reachable from the lighting LAN; Compose does not run an NTP server.

## Configure and deploy from the Mac

```sh
mkdir -p .local
cp deploy.example.json .local/deploy.json
# Edit sshTarget for your SSH username or ~/.ssh/config alias.
pnpm run deploy --check
pnpm run deploy --list-files
pnpm run deploy
```

`.local/deploy.json` is ignored by Git. The committed example contains placeholders, no credentials. Configure custom SSH ports and keys in `~/.ssh/config`; `sshTarget` accepts `user@hostname` or an alias. SSH authentication and host-key validation stay enabled, and the deploy command requires a working noninteractive SSH connection.

Use `pnpm run deploy`: `pnpm deploy` is pnpm's built-in workspace packaging command and does not run this package script.

`directory` is relative to the Pi user's home, default `lightshow`. `projectName` defaults to `lightshow-pi`, deliberately separate from the local Compose project. Keep both values stable. `hostname` is used for the HTTPS origin and MQTT certificate. Changing the hostname or project on an existing deployment is refused; it needs a planned certificate/configuration change, not another fresh setup.

Deployment includes current tracked and unignored source changes under the application directories, including new files. It excludes firmware, Git metadata, local state, environment files, dependencies, build output, private certificate files and symlinks. Review `--list-files` before deploying unusual local source additions. Only public CA certificates return to `.local/pi/trust/`; the administrator password and all private CA keys stay on the Pi.

The Pi needs internet for the first image pulls and dependency downloads, and updates that change them. Node.js, pnpm, Git and PlatformIO are not needed on the Pi host. The first ARM64 build can take several minutes. Upgrades recreate changed services and briefly interrupt playback. Deploy waits for Compose health checks, exports public trust and checks HTTPS with full certificate and hostname verification.

The layout on the Pi is:

```text
~/lightshow/
  shared/.env                     # Pi-only service credentials
  shared/.secrets/                 # Pi-only MQTT CA, broker state, public trust
  shared/.local/admin-password     # Pi-only initial administrator password
  shared/.deployment              # Stable hostname/project identity
  releases/<timestamp>/           # Application source; links to shared private state
  current -> releases/<timestamp> # Last deployment that passed health checks
```

MongoDB and Caddy data remain in Docker volumes under the fixed Compose project, independent of release directories. Fresh setup refuses to proceed if that project already has volumes or partial private state. An empty database means you must recreate devices, outputs, elements and scenes through the new UI. There is no database migration or automatic database reset on deploy.

## Trust HTTPS from Caddy

Open **https://lightshow-raspberry-pi.local** after the first deployment. The existing Caddy configuration uses `tls internal`, creates its own local CA, renews the HTTPS leaf certificate and redirects HTTP to HTTPS. `.local` hostnames cannot get publicly trusted certificates; every browser/OS must trust this deployment's public root. See [Caddy's local HTTPS documentation](https://caddyserver.com/docs/automatic-https#local-https).

On the Mac, import `.local/pi/trust/https-ca.crt` into Keychain Access, then explicitly trust it for SSL. Or run this yourself to install it in the System keychain:

```sh
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain .local/pi/trust/https-ca.crt
curl --cacert .local/pi/trust/https-ca.crt \
  https://lightshow-raspberry-pi.local/v1/health
```

Repeat public-root trust installation on other computers/phones that use the UI; some browsers use a separate trust store. The Pi itself does not need system-wide trust to serve HTTPS. Never copy Caddy's private root key or the MQTT CA private key to clients. Preserve the Caddy data volume across updates to keep the trusted root stable. Caddy runs only in Compose; do not install another host Caddy on ports 80/443.

Retrieve the initial administrator password privately when ready to sign in (this prints a secret; do not paste the output into chat or logs):

```sh
ssh your-user@lightshow-raspberry-pi.local 'cat ~/lightshow/shared/.local/admin-password'
```

MQTT uses a separate private CA generated on the Pi. The deployment exports a combined **public** HTTPS/MQTT bundle for firmware. A browser only needs the HTTPS root. No TLS validation is disabled.

## Move an existing ESP to the fresh Pi deployment

1. Record the ESP's board target, base-MAC hardware identity and desired physical output settings from the old installation. The Pi has no records of these. Stop the old active scene/engine before the final cutover so it cannot continue sending DDP.
2. Sign into the Pi UI. In **Access**, issue a new one-use enrollment credential bound to the exact `esp32-<base MAC in lowercase without separators>` identity. Default validity is one hour, so generate it close to flashing.
3. Generate the private firmware header on the Mac with the **Pi** origin and public trust. `--pi` reads `.local/deploy.json` and `.local/pi/trust/`, leaving the Mac's `.env` and CAs alone:

   ```sh
   # Type the enrollment credential after read, then press Enter; input is hidden.
   read -r -s FIRMWARE_PROVISIONING_TOKEN
   export FIRMWARE_PROVISIONING_TOKEN
   # For Wi-Fi hardware, also read/export FIRMWARE_WIFI_SSID and FIRMWARE_WIFI_PASSWORD.
   # Use the Pi's reserved LAN IPv4 for NTP, avoiding multicast discovery for time.
   export FIRMWARE_NTP_HOST='<Pi reserved LAN IPv4>'
   node scripts/firmware-secrets.mjs --pi
   unset FIRMWARE_PROVISIONING_TOKEN FIRMWARE_WIFI_PASSWORD
   ```

4. **Erase the ESP's old NVS before upload.** Normal flashing preserves its old REST identity, and firmware prefers that stored token over a new enrollment token. A fresh Pi database will reject the old token. Full erase also removes cached physical settings and Wi-Fi state; do this only on the intended ESP, with LEDs safely powered down. With the ESP connected to the Mac, use the matching target and serial port:

   ```sh
   pio run -d firmware/esp32 -e esp32dev -t erase --upload-port '<serial port>'
   pio run -d firmware/esp32 -e esp32dev -t upload --upload-port '<serial port>'
   # For WT32-ETH01 Ethernet, replace esp32dev with wt32-eth01 in both commands.
   pio device monitor -b 115200 -p '<serial port>'
   ```

5. In the Pi's **Devices** UI, confirm heartbeats, then set physical pins, counts and color order. Add the Pi's **LAN source IPv4** to permitted DDP sources; the default allowlist is empty. Do not enter the engine container's bridge address. If unsure which interface is used, run `ip route get <ESP IPv4>` on the Pi and use its `src` address. Recreate elements and scenes, then activate a scene and verify actual LEDs.

The supported firmware's pinned ESP32 SDK enables one-shot mDNS `.local` lookups. Multicast still must work between the ESP and Avahi on the Pi; a Mac successfully resolving the Pi is not proof that the ESP can. If segmented networks prevent this, configure a LAN DNS name such as `lightshow.home.arpa` before initial setup and ensure all clients resolve it, rather than replacing HTTPS/MQTT URLs with an uncertified IP address.

Never commit `secrets.h`, firmware binaries or `.pio` output. Flash promptly after generation so the provisioning timestamp is current. Physical Ethernet/Wi-Fi, NTP, multicast, source filtering and actual LED output require hardware checks; builds and container health alone do not establish these.

## Updates and recovery

Run `pnpm run deploy` for later updates. It reuses private state, never runs `down -v` and never prunes volumes. Source releases are retained so a failed deployment can be inspected. Repeated updates consume disk; after a successful update, review old release directories and unused images manually. Keep the current and previous known-good release until you no longer need them. Never remove `shared/` as routine cleanup.

For logs on the Pi:

```sh
cd ~/lightshow/current
docker compose --project-name lightshow-pi ps
docker compose --project-name lightshow-pi logs --tail=100 api mosquitto show-engine caddy
```

If deployment fails, its output identifies the attempted release directory. Inspect Compose logs from that release. `current` advances only after health and TLS checks pass, but a failed update may already have recreated some containers; it is not an automatic rollback. Correct the error and rerun `pnpm run deploy`. To restore a compatible previous version, run `docker compose --project-name lightshow-pi up -d --build --wait` from that release directory. Application rollback does not undo database changes.

If first-time credential generation fails, inspect the private `shared/` state before retrying. The deploy script refuses partial initialization rather than mixing credentials with existing storage. Do not delete partial secrets once volumes have been initialized; use the recovery procedures in [provisioning.md](provisioning.md).

Back up MongoDB, the Caddy volumes and the entire private `shared/` directory securely. The retained MQTT leaf certificate expires after 825 days; renew it with the Pi's retained MQTT CA before expiry as described in [provisioning.md](provisioning.md). Updating application source does not rotate credentials or certificate roots.
