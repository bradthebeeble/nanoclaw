/**
 * TypeScript types for the k8s4claw IPC bus wire protocol.
 *
 * These types mirror `vendor/k8s4claw/internal/ipcbus/message.go` field-for-field.
 * The wire format is the contract — JSON field names match the Go `json:` struct tags.
 *
 * Source of truth: vendor/k8s4claw/internal/ipcbus/{framing.go, message.go, bridge_uds.go}
 * DO NOT change these types without verifying against the upstream Go source.
 */
import { z } from 'zod';

/**
 * IPC message types. Mirror MessageType constants in message.go.
 * - message: carries a payload to route to NanoClaw
 * - ack/nack: delivery acknowledgements
 * - slow_down/resume: backpressure control
 * - shutdown: graceful shutdown request
 * - register: runtime registration handshake
 * - heartbeat: liveness ping from the IPC bus
 */
export const IpcMessageType = z.enum([
  'message',
  'ack',
  'nack',
  'slow_down',
  'resume',
  'shutdown',
  'register',
  'heartbeat',
]);
export type IpcMessageType = z.infer<typeof IpcMessageType>;

/**
 * IpcMessage — the JSON envelope inside each length-prefix frame.
 *
 * Maps to Go's `Message` struct in message.go:
 *   ID            → id             (required)
 *   Type          → type           (required)
 *   Channel       → channel        (omitempty)
 *   CorrelationID → correlationId  (omitempty)
 *   ReplyTo       → replyTo        (omitempty)
 *   Timestamp     → timestamp      (ISO 8601 string; Go marshals time.Time as RFC3339)
 *   Payload       → payload        (omitempty, arbitrary JSON)
 */
export const IpcMessage = z.object({
  id: z.string(),
  type: IpcMessageType,
  channel: z.string().optional(),
  correlationId: z.string().optional(),
  replyTo: z.string().optional(),
  timestamp: z.string(), // ISO 8601 / RFC 3339
  payload: z.unknown().optional(),
});
export type IpcMessage = z.infer<typeof IpcMessage>;

/**
 * Wire-protocol constants. Mirror framing.go:
 *   FrameHeaderSize = 4              (uint32 big-endian)
 *   MaxMessageSize  = 16 * 1024 * 1024  (16 MiB)
 */
export const FRAME_HEADER_SIZE = 4;
export const MAX_MESSAGE_SIZE = 16 * 1024 * 1024; // matches k8s4claw framing.go

/** Default socket path; overridden by IPC_SOCKET_PATH env var. */
export const DEFAULT_RUNTIME_SOCKET = '/var/run/claw/runtime.sock';
