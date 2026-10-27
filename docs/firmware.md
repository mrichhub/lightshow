# ESP32 firmware

The shared code builds `wt32-eth01` (LAN8720 Ethernet) and `esp32dev` (original ESP-WROOM-32 / ESP-32S Wi-Fi). PlatformIO pins `espressif32@6.12.0`, Arduino-ESP32 2.0.17, FastLED 3.9.15, ArduinoJson 7.4.2 and PubSubClient 2.8. RMT4 is selected explicitly for the pinned IDF4 framework. Do not change framework/FastLED major versions without rebuilding and measuring both boards.

| Board             | Permitted output GPIOs                                    | Network                                                                 |
| ----------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| WT32-ETH01        | 4, 14, 32, 33                                             | LAN8720, PHY address 1, power 16, MDC 23, MDIO 18, GPIO0 external clock |
| ESP32 development | 4, 13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33 | Station Wi-Fi                                                           |

All output GPIOs are registered through explicit FastLED template instantiations. Runtime configuration selects an existing controller and its buffer range; runtime integers are never passed as template parameters. Four outputs maximum, 2048 pixels per output and 4096 total. Flash pins, input-only pins, known boot-strapping pins and Ethernet-reserved pins are excluded. Avoid WROVER variants where GPIO16/17 connect to PSRAM. The supported development target is WROOM, without PSRAM.

Configuration is parsed into a bounded plain C++ struct, checked for board/network match, allowed and duplicate pins, unique output IDs, pixel limits, color order, DDP range and source IPs. It is written as one NVS configuration blob before publishing a new configuration epoch. The lighting task consumes a complete snapshot, blanks old outputs, rebinds registered controllers and reports its applied version only after installation. Cached configuration is loaded during startup to initialize the correct physical string for status indication.

Core 0 runs network management, a bounded nonblocking UDP receive loop and MQTT control. A separate core-0 REST worker performs blocking certificate-validated HTTPS initialization, refetches and diagnostics; this prevents an API timeout from blocking UDP reception. Core 1 renders local effects, consumes completed DDP buffers, changes output registrations and calls FastLED. Task creation uses `xTaskCreatePinnedToCore`.

The buffer exchange has explicit ownership: UDP writes one RGB array, publishes by swapping with a pending array under a short critical section, and lighting swaps pending/read arrays before copying into its independent CRGB output storage. A newer complete frame can replace an unread pending frame. No task mutates the other's current buffer. This uses three received-frame arrays rather than double buffering because receiving must continue while a prior frame is pending and the lighting task still owns its current frame. FastLED consumes a separate output array so dynamic wire color order cannot corrupt the canonical received RGB data.

The portable `ddp.hpp` parser is tested natively. It enforces RGB24 DDP header fields, byte bounds/alignment, source lock, ordered complete-frame assembly, sequence rollover and timeout. The network loop rejects disallowed sources before reading pixel payloads. Unsupported oversized datagrams are dropped. The sender's normal payload is 1440 bytes. DDP is never used to change mode, configuration or credentials.

Status pixel behavior uses the first actual output pixel; there is no permanently reserved pixel. Yellow indicates network connection attempts, red indicates a failed attempt after 15 seconds, and green indicates network connected before any DDP arrives. A complete DDP frame controls the whole array. Listening inactivity turns all pixels off after the configured timeout (default five seconds); local mode owns all pixels and is exempt. Connection retries continue.

Firmware heartbeats report uptime, software/profile/interface, connectivity/IP/RSSI, heap/minimum heap, task high-water marks, DDP/output FPS, dropped/incomplete counters, packet age, render duration, applied version and optional error. Requests run every five seconds when the HTTPS worker is available; slow failed requests can delay subsequent reports without blocking lighting. MQTT receives QoS 1 config notifications, uses a retained availability Will and retained applied state. PubSubClient's state publishes are QoS 0; REST heartbeat/version reconciliation supplies durable recovery.

Provision public trust, credentials and network defaults using [provisioning.md](provisioning.md). NVS contains sensitive device credentials; production installers may enable flash encryption/secure boot according to their hardware process. Do not rely on a public hardware identifier for credential replacement. LAN time is required for TLS validity checks.

## Editor include paths

When opening the repository root in VS Code, the checked-in C/C++ configuration reads PlatformIO's compilation database for the ESP32 compiler, include paths and board definitions. Generate it after installing PlatformIO and whenever dependencies or build flags change:

```sh
pio run -d firmware/esp32 -e wt32-eth01 -t compiledb
```

Use `-e esp32dev` instead to index the Wi-Fi build. Generate one environment at a time so the shared source has one unambiguous board configuration. The generated `compile_commands.json` contains machine-specific paths and is ignored by Git. Open `firmware/esp32/src/main.cpp` so the C/C++ extension can associate included headers such as `secrets.example.h` with that translation unit. If stale include warnings remain, run **C/C++: Reset IntelliSense Database** from the command palette.

## Physical verification

Both targets are compile-tested, not electrically validated in this workspace. Before a yard installation, verify PHY power/clock and reconnection, DHCP/DNS/NTP, HTTPS and MQTT chain validation, WS2811 voltage/level conversion, common ground, wire color order, multi-output behavior, RMT/network coexistence, startup indicators, end-of-string timing, outage recovery and measured output FPS. Long strings may exceed a 25 ms budget. Start with low brightness and a short string. Never power a long LED string directly from an ESP board.
