/**
 * IPC ↔ NanoClaw message bridge.
 *
 * Translates IpcMessage frames from the k8s4claw IPC bus into NanoClaw
 * surface calls, and wraps NanoClaw outbound results back into IpcMessages.
 *
 * Message dispatch:
 *   - type 'message'  → processInboundMessage(channel, payload) → reply IpcMessage
 *   - type 'shutdown' → onShutdown callback (or nanoclaw.shutdown())
 *   - control frames (ack, nack, slow_down, resume, register, heartbeat) → no-op
 *
 * Threat T-05-04: type 'shutdown' only triggers graceful pod stop via the
 * registered onShutdown callback — which follows the k8s SIGTERM pattern.
 */
import type { IpcMessage } from './types.js';

// ---------------------------------------------------------------------------
// NanoClawSurface — the interface this bridge calls into NanoClaw with
// ---------------------------------------------------------------------------

/**
 * Minimal NanoClaw surface the bridge calls.
 *
 * Implementors:
 *   - Production: wired to vendor/nanoclaw/src/ exports in index.ts
 *   - Tests: vi.fn() mocks
 *
 * processInboundMessage:
 *   Called for every IPC message with type='message'. The channel identifies
 *   the ClawChannel (e.g. 'slack:channel-name'). Returns the NanoClaw output
 *   payload or null if processing was fire-and-forget.
 *
 * shutdown:
 *   Called when the bridge receives a 'shutdown' IPC frame and no custom
 *   onShutdown override is registered.
 */
export interface NanoClawSurface {
  processInboundMessage(channel: string, payload: unknown): Promise<unknown>;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// BridgeOptions
// ---------------------------------------------------------------------------

export interface BridgeOptions {
  nanoclaw: NanoClawSurface;
  /**
   * Called when the IPC bus sends a 'shutdown' frame. Defaults to
   * `nanoclaw.shutdown()` if not provided.
   */
  onShutdown?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// makeBridge
// ---------------------------------------------------------------------------

/** Cryptographically random UUID using Node 20 native crypto. */
function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Build the bridge message handler.
 *
 * Returns an object with `handleIpcMessage(msg)` suitable for passing to
 * `startServer()` in server.ts.
 */
export function makeBridge(opts: BridgeOptions): {
  handleIpcMessage: (msg: IpcMessage) => Promise<IpcMessage | null>;
} {
  async function handleIpcMessage(msg: IpcMessage): Promise<IpcMessage | null> {
    switch (msg.type) {
      case 'message': {
        // Route to NanoClaw inbound handler.
        if (!msg.channel) return null;
        const out = await opts.nanoclaw.processInboundMessage(
          msg.channel,
          msg.payload ?? null,
        );
        return {
          id: cryptoRandomId(),
          type: 'message',
          // Bus correlates replies back to the original request via correlationId.
          correlationId: msg.id,
          channel: msg.channel,
          timestamp: new Date().toISOString(),
          payload: out,
        };
      }

      case 'shutdown': {
        const cb = opts.onShutdown ?? opts.nanoclaw.shutdown.bind(opts.nanoclaw);
        await cb();
        return null;
      }

      // Control frames — accepted but produce no reply.
      case 'ack':
      case 'nack':
      case 'slow_down':
      case 'resume':
      case 'register':
      case 'heartbeat':
        return null;

      // TypeScript exhaustiveness guard — should never be reached at runtime.
      default: {
        const _exhaustive: never = msg.type;
        console.error(
          '[k8s4claw-adapter] unhandled IPC message type:',
          (_exhaustive as string),
        );
        return null;
      }
    }
  }

  return { handleIpcMessage };
}

// ---------------------------------------------------------------------------
// outboundToIpc — wrap a NanoClaw outbound result in an IpcMessage
// ---------------------------------------------------------------------------

/**
 * Convenience: wrap an arbitrary NanoClaw output value in an IpcMessage
 * suitable for writing back to the bus.
 *
 * Used in tests and for callers that build reply frames outside the bridge
 * dispatch loop.
 */
export function outboundToIpc(
  nanoclawOut: unknown,
  correlationId: string,
): IpcMessage {
  return {
    id: cryptoRandomId(),
    type: 'message',
    correlationId,
    timestamp: new Date().toISOString(),
    payload: nanoclawOut,
  };
}
