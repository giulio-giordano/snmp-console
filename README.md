# SNMP Console

A local SNMP management tool that runs SNMP **Get** and streaming **Walk** operations against any reachable agent, from a clean browser UI or a packaged Tauri desktop app.

Walk results are streamed row by row over HTTP as **NDJSON** — the table fills in while the walk is still running, and huge subtrees never have to be buffered in full in memory.

- ⚡ **Streaming walks** — bindings arrive as they are retrieved (one SNMP round trip at a time), with full backpressure.
- 🔌 **SNMPv1, SNMPv2c, SNMPv3 (USM)** — community strings and the `noAuthNoPriv`, `authNoPriv`, and `authPriv` security levels.
- 🖥️ **Browser + Desktop** — the same UI runs in a browser via a local Bun server and as a self-contained Tauri desktop app that bundles its own backend.
- 🔒 **Local only** — the API binds to the loopback interface, rejects cross-origin requests, and never logs credentials.

## How it works

```
Agent (UDP:161) ◄──GetNext/GetBulk──► ts-snmp client (async generator)
                                           │ yields one binding at a time
                                           ▼
Bun HTTP server (127.0.0.1) ── NDJSON stream ──► Browser / Tauri UI
                                           ▲
                              pull() drives the walk in lockstep
                              with the UI's read() (backpressure)
```

Instead of waiting for a full walk to finish, the server returns a `ReadableStream` body immediately. Every time the browser's `read()` accepts a new chunk, the server asks the SNMP client for the *next* binding (`GetNext` for v1, `GetBulk` with `max-repetitions = 10` for v2c/v3), yielding rows as fast (or as slowly) as the consumer wants them.

Cancelling the walk from the UI aborts the HTTP stream, which closes the SNMP client and releases the UDP socket.

## Features

- **Walk subtree** or **Get one OID**, with SNMPv1, SNMPv2c, and SNMPv3 USM.
- Live result table: each binding appears as soon as it is received, with a running count.
- **Cancel walk** mid-stream; bindings already collected are retained.
- JSON-safe value handling:
  - byte/octet values (`OCTET_STRING`, `OPAQUE`, …) are encoded as **base64**,
  - `Counter64` values are encoded as **decimal strings** (no precision loss).
- Configurable port, timeout (up to 60 s), and retry count (up to 5).
- Same codebase serves both the browser app and the Tauri desktop app.

## Screenshots

> Add a screenshot here, e.g. `![SNMP Console](docs/screenshot.png)`

## Getting started (browser app)

Requires [Bun](https://bun.sh).

```sh
bun install
bun run dev
```

Then open <http://127.0.0.1:3000>. The server binds to loopback only; set `PORT` to use a different local port.

1. Enter the agent's IP address (IPv4 or IPv6).
2. Choose **Walk subtree** or **Get one OID**.
3. Pick the SNMP version and fill in the credentials:
   - v1/v2c: a community string (e.g. `public`),
   - v3: username, and depending on the security level an auth passphrase and/or privacy passphrase.
4. Run the query. Walk results stream into the table; **Cancel walk** stops it at any time.

## Desktop app (Tauri)

```sh
# Development: use the local Bun web server.
bun run desktop:dev

# Package the app for the current platform.
bun run desktop:build
```

On Linux x86_64 the build produces a Debian package under `desktop/src-tauri/target/release/bundle/deb/`. Build on the target OS to produce platform-specific packages.

The desktop bundle contains a compiled Bun sidecar (`snmp-backend-<target-triple>`), so end users do **not** need Bun installed. The sidecar serves the same `frontend/` assets and web API as the browser app.

> Desktop builds additionally require the [Tauri prerequisites](https://tauri.app/start/prerequisites/) (Rust toolchain, system webview).

## HTTP API

The API is same-origin and only accepts loopback requests.

### `POST /api/snmp/get`

```json
{ "options": { "version": "v2c", "host": "192.168.1.10", "community": "public" }, "oid": "1.3.6.1.2.1.1.5.0" }
```

Returns a single binding:

```json
{ "binding": { "oid": "1.3.6.1.2.1.1.5.0", "type": "OCTET_STRING", "value": "YXBwLXNlcnZlcjE=", "valueEncoding": "base64" } }
```

### `POST /api/snmp/walk`

```json
{ "options": { "version": "v2c", "host": "192.168.1.10", "community": "public" }, "oid": "1.3.6.1.2.1.1" }
```

Returns a newline-delimited JSON stream (`application/x-ndjson`):

```
{"event":"binding","binding":{"oid":"1.3.6.1.2.1.1.1.0","type":"OCTET_STRING","value":"YXBwLXNlcnZlcjE=","valueEncoding":"base64"}}
{"event":"binding","binding":{"oid":"1.3.6.1.2.1.1.2.0","type":"OBJECT_IDENTIFIER","value":"1.3.6.1.4.1.8072.3.2.10"}}
{"event":"done"}
```

Event types: `binding` (one row), `done` (walk finished), `error` (walk failed; includes a sanitized message).

### `GET /api/health`

Health check for the local server.

## Project layout

```
frontend/                Shared HTML/TypeScript/CSS UI (built with Bun, not Vite)
src/web/                 Bun HTTP API, request validation, NDJSON serialization
desktop/src-tauri/       Tauri 2 wrapper and bundled sidecar configuration
scripts/                 Tauri sidecar build helper
@ptrsnake/ts-snmp        SNMP library installed from npm
```

## Security notes

- The HTTP server binds to `127.0.0.1` only and rejects cross-origin requests.
- Credentials are never logged or persisted.
- Request payloads are size-limited and strictly validated.
- SNMPv1/v2c community strings travel in clear text to the agent; SNMPv3 uses **SHA-1** authentication and **DES** privacy — both legacy algorithms. Use this tool on a trusted machine and network.

## Verification

```sh
bun test
bun run typecheck
```

The test suite covers request validation, error mapping, and JSON-safe serialization of binary and 64-bit values.

## Credits

This code was written by **GPT-6 Luna**. 🚀