# Provisioning and credential recovery

## Deployment

Run `pnpm setup` once after installing dependencies. It generates private secrets in `.env`, `.secrets/` and `.local/`, all ignored by Git. A custom `LIGHTSHOW_HOST` is accepted before setup; use a DNS hostname. The default is `lightshow.home.arpa`. Update `.env` before startup to change host ports, target FPS or log level. `PUBLIC_ORIGIN` must exactly match the browser's HTTPS origin, including a nonstandard port if configured.

Start Compose and run `pnpm trust`. Caddy owns and persists the HTTPS CA in its data volume; the export script copies only its public root. Setup generates a separate MQTT CA and leaf whose SANs include the public hostname and internal `mosquitto`. Firmware receives the combined public certificate bundle. The broker certificate's matching hostname and the HTTPS certificate's matching hostname must both validate. Do not use `curl -k`, `setInsecure()` or TLS rejection overrides.

For offline systems, pre-load images and dependencies, configure local DNS, and provide accurate LAN time. ESP32 devices do not have a battery-backed RTC by default. The provisioning script embeds the current timestamp as a lower bound; point `FIRMWARE_NTP_HOST` at your LAN time server and flash promptly. Firmware never disables certificate date checks to work around clock errors.

## Device enrollment

Determine the hardware identity before issuing a credential. For ESPs use the base MAC (esptool's `read_mac` reports it), lowercase with no separators, prefixed `esp32-`. For a simulator choose a distinct `SIM_HARDWARE_ID`. In **Access**, create a credential for exactly that identity; default UI validity is one hour. The API stores its hash, expiration and authorized hardware identity.

The first boot sends `POST /v1/devices/init` with that enrollment Bearer token and `{hardwareId,board}`. One replica-set transaction consumes it, creates a unique device record and stores a newly generated REST device token hash. A concurrent/repeated claim cannot create a second device. The response returns the plaintext token exactly once, authoritative configuration and separately provisioned MQTT credentials. Devices persist credentials privately and subsequent boots authenticate using the stored REST token. No `X-DEVICE-ID` header is used.

Every authenticated boot init rotates the MQTT password through the broker's Dynamic Security plugin. This is intentionally independent of the REST token. The broker hashes it and grants only that device's specific command subscription and state/availability/telemetry publication rights. The API's dynamic-security control permission is never given to a device. Reconnect fetches and heartbeat version reconciliation handle missed configuration notifications.

### Hardware

```sh
# The shell variables below are private. Avoid entering actual secrets in shared terminal logs.
export FIRMWARE_PROVISIONING_TOKEN='<credential from Access>'
export FIRMWARE_WIFI_SSID='<development Wi-Fi SSID>'
export FIRMWARE_WIFI_PASSWORD='<private Wi-Fi password>'
export FIRMWARE_NTP_HOST='<LAN NTP server hostname or address>'
node scripts/firmware-secrets.mjs
pio run -d firmware/esp32 -e wt32-eth01 -t upload --upload-port '<serial port>'
# For Wi-Fi development hardware, use -e esp32dev.
```

This writes the ignored `firmware/esp32/include/secrets.h`, including public roots, provisioning token, network defaults and provisioning time. Ethernet ignores Wi-Fi settings. Preferences stores identity and a validated cached configuration. Keep firmware binaries private as they contain provisioning/network settings; generic example builds contain no credentials. Do not add generated `.pio` files to Git.

### Simulator

The Compose profile reads `SIM_PROVISIONING_TOKEN` from `.env` and stores identity under `/state/identity.json` in its private named volume. It publishes only the loopback inspection port. Its internal broker URL override keeps Docker traffic on `mosquitto:8883` while still validating the certificate's `mosquitto` SAN.

For additional simulators use separate service definitions/Compose overrides with distinct `SIM_HARDWARE_ID`, `SIM_PROVISIONING_TOKEN`, named identity volumes and host inspection ports. Containers can each bind UDP 4048. Do not share the first simulator's volume; doing so clones its identity. A local process can use `SIM_STATE_FILE=.local/yard-2.json`, `SIM_INSPECT_PORT=4091`, `SIM_IP=<routable host IPv4>`, appropriate CA paths and a hardware-bound enrollment credential. If multiple local processes share one network namespace, first enroll the extra device by REST and update its authoritative DDP port, then save the returned identity JSON in its private state file before starting the process. Otherwise both defaults will try to bind 4048.

## Recovery and rotation

- **Lost first enrollment response:** the consumed token cannot retrieve or replace credentials. In Devices, revoke the orphan device, remove mappings and delete the revoked record. Then issue another hardware-bound credential. This preserves idempotency without treating a MAC as a secret.
- **Lost/corrupt NVS:** follow the same administrator recovery procedure, erase the old local identity and flash a newly issued credential. Deleting a device requires prior revocation and no element references.
- **Interrupted MQTT setup:** the stored REST credential can repeat init and obtain a fresh MQTT password. If failure happened before the first response, use administrator recovery above.
- **Suspected device compromise:** revoke in Devices. Broker revocation disconnects its MQTT clients, then the API removes its REST hash. The engine excludes revoked devices from destinations. Revocation can be retried after broker outages.
- **Administrator token:** revoke its ID through Access or DELETE. Cookie sessions and device credentials remain separate.
- **Administrator password:** generate a new Argon2id hash with `argon2`, replace the quoted private `.env` value, recreate the API, and delete all documents from `sessions` using authenticated MongoDB administration if existing sessions must also be revoked. Password rotation alone does not silently revoke active sessions.
- **MQTT service credentials:** coordinate broker dynamic-security password updates with `.env` API/engine variables and restart the affected clients. Changing only `.env` does not change broker hashes.
- **MQTT leaf renewal:** generate a new key/CSR and sign it with the retained private MQTT CA, preserving the public hostname and `mosquitto` SANs. Replace files atomically and restart Mosquitto before expiry. For CA rotation install the new public root on clients first, then replace the server certificate; remove the old root after migration.
- **HTTPS root rotation:** Caddy's private CA is inside the persistent volume. Preserve that volume during routine upgrades. If it must change, export the new public root and reprovision trust on browsers, simulators and firmware. Never copy a private root key to devices.

`.env.example` is documentation, not usable credentials. Real `.env`, ignored headers, state files, broker security data and private CA material should be included only in encrypted deployment backups. Restrict host access to the repository's private directories.
