# Lightshow engineering rules

Read README.md and docs/architecture.md before changing service boundaries.

- Use tabs for indentation, double-quoted strings and no optional JavaScript/TypeScript semicolons. Follow `.prettierrc.json`, `.editorconfig` and `.clang-format`; retain punctuation and space indentation required by other languages, including C++, CSS and YAML.
- Leave blank lines between top-level declarations, class methods and logical statement groups. Separate validation, setup, control flow and return statements. Prefer one variable declaration per statement instead of comma-separated declarations. Preserve this spacing when editing; Prettier retains intentional blank lines.
- MongoDB is authoritative for persistent configuration. The API owns configuration writes and validation.
- The Show Engine alone owns the show timeline, frame composition, overrides, logical mappings and DDP transmission.
- ESP firmware owns physical LED output and local fallback; it never knows about elements or skipped pixels.
- DDP carries standard RGB pixel data only. MQTT carries commands/events. REST handles initialization, configuration and diagnostics.
- Preserve cross-device mappings, zero-based indexes and mandatory black skipped pixels. Compile mappings outside the frame loop.
- Support both WT32-ETH01 Ethernet and original ESP32 Wi-Fi builds. Register only supported compile-time FastLED pins.
- Keep the lighting task independent of blocking network work; exchange complete buffers with explicit ownership.
- Never weaken TLS validation. Never commit credentials, CA private keys, network secrets, .env or generated firmware secrets.
- Keep administrator, enrollment, REST device and MQTT credentials separate. Store opaque token hashes, never plaintext tokens, in MongoDB.
- Cookie mutations require a matching Origin. Bearer credentials must be explicitly scoped and revocable.
- Validate request and response schemas, physical boundaries and board pin restrictions. Check mapping overlaps transactionally.
- No queries, code evaluation or per-frame mapping compilation in the render loop.
- Use pinned dependencies and offline-capable runtime assets. Do not add hosted fonts, CDNs or external runtime services.
- Run pnpm typecheck, pnpm test, pnpm build and relevant integration checks. Build both firmware targets for firmware changes.
- Report hardware-only checks honestly. A successful build is not physical validation.
- Commit after each major implementation milestone as requested by the project owner. Do not commit generated local configuration.
