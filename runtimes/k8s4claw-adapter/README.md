# k8s4claw IPC Bridge Adapter

In-pod TypeScript UDS bridge that connects the k8s4claw IPC bus sidecar to the
NanoClaw runtime. This is the in-pod side of the IPC contract described in
CONTEXT.md D-02 and D-03.

## Purpose

When a `Claw` resource starts, the k8s4claw operator injects an IPC bus sidecar
into the pod. The sidecar is the **client** that dials the runtime socket — this
adapter is the **server** that listens. Without a process holding `runtime.sock`,
the pod's readiness probe (`test -S /var/run/claw/runtime.sock`) never passes
and the pod stays in `Pending`/`Initializing` indefinitely.

The adapter:
1. Listens on `/var/run/claw/runtime.sock` (UDS).
2. Decodes 4-byte big-endian length-prefixed JSON `IpcMessage` frames.
3. Routes `type: 'message'` frames into NanoClaw's inbound pipeline via
   `routeInbound()` from `src/router.ts`.
4. Returns an acknowledgement frame so the bus marks the message delivered.
5. Handles `type: 'shutdown'` by draining NanoClaw and exiting gracefully.
6. Accepts control frames (`heartbeat`, `register`, `ack`, `nack`, `slow_down`,
   `resume`) as no-ops.

## Wire Protocol

**Source of truth:** `vendor/k8s4claw/internal/ipcbus/{framing.go, message.go, bridge_uds.go}`

If you change the wire format here without updating the k8s4claw IPC bus, the
operator will refuse the connection. Always check framing.go first.

### Frame format

```
[4-byte big-endian uint32 body-length][JSON-encoded IpcMessage body]
```

- Header: `uint32` big-endian — matches Go's `binary.BigEndian.PutUint32`.
- Body: UTF-8 JSON; no null terminator.
- Max frame size: **16 MiB** (`MaxMessageSize = 16 * 1024 * 1024` in framing.go).
  Frames exceeding this limit cause the socket to be destroyed immediately —
  no buffer growth, no further reads (defence against T-05-01 frame DoS).

### IpcMessage schema

```json
{
  "id":            "string (required)",
  "type":          "message|ack|nack|slow_down|resume|shutdown|register|heartbeat",
  "channel":       "string (omitempty)",
  "correlationId": "string (omitempty)",
  "replyTo":       "string (omitempty)",
  "timestamp":     "RFC 3339 string (required)",
  "payload":       "any JSON (omitempty)"
}
```

Fields map 1-to-1 to the Go `Message` struct in `message.go`.

## Socket Path

Default: `/var/run/claw/runtime.sock`

Override by setting `IPC_SOCKET_PATH` to the **directory** (the adapter
appends `/runtime.sock`), matching k8s4claw's `bridge_uds.go` convention:

```sh
IPC_SOCKET_PATH=/custom/path  # adapter listens on /custom/path/runtime.sock
```

The socket directory is created at startup if it does not exist. A stale socket
file from a previous run is unlinked before `listen()` to avoid `EADDRINUSE`.

## Build & Test

```sh
pnpm install          # install deps (first time or after package.json changes)
pnpm test             # run vitest tests (10 passing: 6 framing + 4 bridge)
pnpm build            # tsc strict type-check (noEmit)
pnpm dev              # run adapter via tsx (development only)
```

Test coverage:
- Single complete frame decode
- Partial-frame buffering (header arrives before body)
- Oversize frame rejection (`socket.destroy()`)
- Two back-to-back frames in one TCP chunk
- Malformed JSON safety (server stays alive)
- `writeFrame` round-trip
- `type: 'message'` dispatch to NanoClaw inbound handler
- `type: 'shutdown'` calls onShutdown callback
- `outboundToIpc` correlationId passthrough
- All 6 control frame types → no-op

## Container Entrypoint

This package's `index.ts` is wired by `vendor/nanoclaw/Dockerfile` (plan 06
task 3) as the runtime container's `ENTRYPOINT`:

```dockerfile
ENTRYPOINT ["tsx", "runtimes/k8s4claw-adapter/index.ts"]
```

The adapter starts NanoClaw's internal pipeline (DB, channel adapters, delivery
polls, host sweep) and then opens the UDS server.

## Upstream-Tracking Note

This directory is **fork-only**. It must never be proposed for upstream
`qwibitai/nanoclaw` without first updating CONTEXT.md.

The weekly upstream-tracking cron at
`.github/workflows/upstream-tracking-nanoclaw.yml` excludes this directory
from its diff via the path-spec exclusion `:^runtimes/k8s4claw-adapter`
per CONTEXT.md D-03. This ensures fork-only bridge code does not surface
as upstream divergence noise in the weekly PR.

## Security Notes

| Threat | Mitigation |
|--------|------------|
| T-05-01 Frame DoS (oversize length-prefix) | `MAX_MESSAGE_SIZE = 16 MiB`; oversize → `socket.destroy()` immediately |
| T-05-02 Malformed JSON crash | `try/catch` around `JSON.parse`; log + continue |
| T-05-04 Crafted shutdown frame | `type: 'shutdown'` only triggers graceful pod stop via `onShutdown` |
| T-05-05 Adapter runs as root | Plan 04 NanoClawAdapter sets `RunAsUser=1000, RunAsNonRoot=true` |
