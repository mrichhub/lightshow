# REST and SSE

OpenAPI is generated from Fastify TypeBox request and response schemas at `/v1/docs/` (interactive UI) and `/v1/docs/json`. Authenticate through the UI cookie or use an administrative token in Swagger's Authorize dialog. All routes use `/v1`; there is no `/api` prefix.

Administrator endpoints require the Secure session cookie or an administrative Bearer token, except login/health. Device endpoints require a device Bearer token; init additionally accepts a hardware-bound enrollment token. Cookie-authenticated mutations require `Origin: <PUBLIC_ORIGIN>`. All data is JSON except the SSE response. Failures return `{error,message,statusCode}` with 400 validation, 401 authentication, 403 authorization/origin, 404 missing resource and 409 state/version conflicts.

| Method     | Route                     | Body / result                                                                 |
| ---------- | ------------------------- | ----------------------------------------------------------------------------- |
| GET        | `/v1/health`              | Database and MQTT readiness; `{ok}`                                           |
| POST       | `/v1/auth/login`          | `{password}`; sets revocable session cookie                                   |
| POST       | `/v1/auth/logout`         | Revokes current session, clears cookie                                        |
| GET        | `/v1/auth/session`        | `{authenticated:true}` or 401                                                 |
| GET        | `/v1/auth/tokens`         | Administrative token metadata, never secrets                                  |
| POST       | `/v1/auth/tokens`         | `{name,days}`; `{id,token}`, secret shown once                                |
| DELETE     | `/v1/auth/tokens/:id`     | Revokes administrative token                                                  |
| POST       | `/v1/enrollments`         | `{hardwareId,minutes}`; `{id,token,expiresAt}`                                |
| POST       | `/v1/devices/init`        | `{hardwareId,board}`; `{deviceId,token?,config,mqtt:{url,username,password}}` |
| GET        | `/v1/devices/config`      | Authenticated device's authoritative config                                   |
| POST       | `/v1/devices/heartbeat`   | Diagnostics; `{ok,configVersion}`                                             |
| GET        | `/v1/devices`             | Array of devices with config                                                  |
| GET        | `/v1/devices/:id`         | Device record                                                                 |
| PATCH      | `/v1/devices/:id`         | `{name?,config?,expectedVersion}`; updated record                             |
| POST       | `/v1/devices/:id/refresh` | Request device configuration refetch                                          |
| POST       | `/v1/devices/:id/revoke`  | Disable MQTT and revoke REST credential                                       |
| DELETE     | `/v1/devices/:id`         | Delete revoked, unmapped device for recovery                                  |
| GET        | `/v1/status`              | Current diagnostic records                                                    |
| GET / POST | `/v1/elements`            | List / create logical elements                                                |
| PATCH      | `/v1/elements/:id`        | Full replacement element definition                                           |
| DELETE     | `/v1/elements/:id`        | Requires scene/debug references removed                                       |
| GET / POST | `/v1/scenes`              | List / create scenes                                                          |
| PATCH      | `/v1/scenes/:id`          | Full replacement scene definition                                             |
| POST       | `/v1/scenes/:id/activate` | Select scene, reset scene timeline                                            |
| GET        | `/v1/show`                | Desired selection, timeline version, overrides                                |
| POST       | `/v1/show/stop`           | Stop scene and clear all overrides                                            |
| PUT        | `/v1/show/overrides`      | Replace override array; `[]` restores scene                                   |
| GET        | `/v1/events`              | Cookie-authenticated SSE only                                                 |

Device PATCH `config` is the complete editable object: `{hardware,mode,ddp,outputs}` without generated `deviceId` or `configVersion`. The API increments the version. PATCH element and scene bodies are complete resource definitions, including immutable IDs. All indexes are zero-based and `skippedPixels` is relative to the segment's start. Bounds and overlaps across all configured elements are checked transactionally.

Example override:

```json
[{ "elementId": "ghost-1", "color": "#ff6600", "brightness": 0.25, "pixel": 4 }]
```

For a physical output use `{deviceId,outputIndex,color,brightness,pixel?}` instead. Exactly one target kind is required. Omit `pixel` to test all target pixels; skipped pixels are still forced black. Scene effects accept `solid`, `pulse`, `fade`, `chase`, `rainbow`, `flicker`, a `targets` array and validated `params` including colors, duration, min/max brightness, width and seed.

SSE events:

| Event           | Data                                                                         |
| --------------- | ---------------------------------------------------------------------------- |
| `snapshot`      | `{devices,statuses,elements,scenes,show}`; initial and after stream recovery |
| `status`        | Current device diagnostics with `deviceId,lastSeen,address`                  |
| `device`        | Updated device configuration record                                          |
| `configuration` | Resource changed; refetch elements/scenes                                    |
| `show`          | Updated desired show document                                                |
| `health`        | `{deviceId,connectivity,health}` freshness transition                        |

The stream has periodic comment keepalives. Sessions are revalidated every five seconds; expiry/logout closes the stream. Browsers reconnect automatically and reconcile from a full snapshot. Slow consumers are disconnected to prevent unbounded buffers. The broadcaster caps simultaneous clients at 128 per API instance.

Heartbeat diagnostics are strongly validated in `packages/models/src/index.ts`. Firmware sends uptime seconds, heap/stack metrics, firmware/board/network/mode, IP, FPS, drop/incomplete counters, milliseconds since DDP, render microseconds, config version and optional bounded last error. The IP is deployment routing data and never an authentication factor.
