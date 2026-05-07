/**
 * UDS server with 4-byte big-endian length-prefix framing.
 *
 * Wire protocol source of truth: vendor/k8s4claw/internal/ipcbus/framing.go
 *   - Header: 4-byte big-endian uint32 = body length in bytes
 *   - Max frame body: 16 MiB (MaxMessageSize in framing.go)
 *   - Oversize frames: destroy the socket immediately, no buffer growth
 *   - Malformed JSON: log + continue (mirrors Go handler.go serve() behaviour)
 *
 * Exports:
 *   readFrames(socket, onMessage)  — attach stateful frame decoder to a socket
 *   writeFrame(socket, msg)        — encode + write one frame
 *   startServer(handle)            — create UDS server, unlink stale socket, listen
 */
import { createServer } from 'net';
import type { Server, Socket } from 'net';
import { unlinkSync } from 'fs';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

import type { IpcMessage } from './types.js';
import { FRAME_HEADER_SIZE, MAX_MESSAGE_SIZE, DEFAULT_RUNTIME_SOCKET } from './types.js';

// ---------------------------------------------------------------------------
// Public: readFrames
// ---------------------------------------------------------------------------

/**
 * Attach a stateful length-prefix frame decoder to `socket`.
 *
 * Accumulates chunks in an internal buffer. When a complete frame is
 * available it JSON-parses the body and calls `onMessage`. Partial frames
 * are held until more data arrives.
 *
 * Error handling:
 *   - Oversize frame (length > MAX_MESSAGE_SIZE): `socket.destroy()` immediately.
 *   - Malformed JSON: logged to stderr; the frame is skipped, reading continues.
 */
export function readFrames(
  socket: Socket,
  onMessage: (m: IpcMessage) => void,
): void {
  let buf = Buffer.alloc(0);

  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);

    // Process as many complete frames as are buffered.
    while (buf.length >= FRAME_HEADER_SIZE) {
      const len = buf.readUInt32BE(0);

      // Threat T-05-01: oversize frame DoS. Destroy socket immediately so
      // we never allocate a large buffer.
      if (len > MAX_MESSAGE_SIZE) {
        socket.destroy(
          new Error(`frame size ${len} exceeds max ${MAX_MESSAGE_SIZE}`),
        );
        return;
      }

      // Incomplete frame — wait for more data.
      if (buf.length < FRAME_HEADER_SIZE + len) return;

      // Extract body (zero-copy via subarray).
      const body = buf.subarray(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + len).toString('utf8');
      buf = buf.subarray(FRAME_HEADER_SIZE + len);

      // Threat T-05-02: malformed JSON. Swallow and continue — the server
      // must not crash on a single bad frame.
      try {
        const msg = JSON.parse(body) as IpcMessage;
        onMessage(msg);
      } catch {
        console.error('[k8s4claw-adapter] malformed JSON in IPC frame — skipping frame');
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Public: writeFrame
// ---------------------------------------------------------------------------

/**
 * Encode `msg` as JSON, prepend a 4-byte big-endian length header, and write
 * the resulting frame to `socket` in a single `.write()` call.
 *
 * Matches Go's WriteMessage in framing.go:
 *   binary.BigEndian.PutUint32(frame, uint32(len(data)))
 */
export function writeFrame(socket: Socket, msg: IpcMessage): void {
  const data = Buffer.from(JSON.stringify(msg), 'utf8');
  const frame = Buffer.alloc(FRAME_HEADER_SIZE + data.length);
  frame.writeUInt32BE(data.length, 0);
  data.copy(frame, FRAME_HEADER_SIZE);
  socket.write(frame);
}

// ---------------------------------------------------------------------------
// Public: startServer
// ---------------------------------------------------------------------------

/**
 * Determine the socket path from the environment.
 *
 * k8s4claw's bridge_uds.go stores the *directory* in IPC_SOCKET_PATH and
 * appends `/runtime.sock`. We replicate that behaviour.
 */
function resolveSocketPath(): string {
  const envDir = process.env.IPC_SOCKET_PATH;
  if (envDir) return `${envDir}/runtime.sock`;
  return DEFAULT_RUNTIME_SOCKET;
}

/**
 * Create a net.Server that listens on the UDS socket path.
 *
 * Per-connection:
 *   1. `readFrames` decodes incoming frames.
 *   2. `handle(msg)` is called for every decoded IpcMessage.
 *   3. If handle returns a non-null IpcMessage, it is written back to the
 *      same socket as a length-prefix frame.
 *
 * The stale socket file is unlinked before listen() to avoid EADDRINUSE
 * if the previous process died without cleanup.
 */
export function startServer(
  handle: (m: IpcMessage) => Promise<IpcMessage | null>,
): Server {
  const socketPath = resolveSocketPath();

  // Ensure parent directory exists (e.g. /var/run/claw/).
  try {
    mkdirSync(dirname(socketPath), { recursive: true });
  } catch {
    // Non-fatal — may already exist.
  }

  // Remove stale socket file from a previous run.
  try {
    unlinkSync(socketPath);
  } catch {
    // File may not exist — that is fine.
  }

  const server = createServer((socket: Socket) => {
    readFrames(socket, (msg: IpcMessage) => {
      handle(msg)
        .then((reply) => {
          if (reply) writeFrame(socket, reply);
        })
        .catch((err: unknown) => {
          console.error('[k8s4claw-adapter] handle() threw:', err);
        });
    });
  });

  server.listen(socketPath, () => {
    console.log(`[k8s4claw-adapter] listening on ${socketPath}`);
  });

  return server;
}
