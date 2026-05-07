/**
 * bridge.ts — dispatch unit tests.
 *
 * Tests:
 *  1. type 'message' calls processInboundMessage with decoded channel + payload
 *  2. type 'shutdown' triggers the onShutdown callback
 *  3. outboundToIpc returns an IpcMessage with correct correlationId
 *  4. Control frames (heartbeat, register, ack, nack, slow_down, resume) are
 *     no-ops — inbound handler not invoked
 */
import { describe, it, expect, vi } from 'vitest';
import { makeBridge, outboundToIpc } from './bridge.js';
import type { NanoClawSurface } from './bridge.js';
import type { IpcMessage } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<IpcMessage>): IpcMessage {
  return {
    id: 'test-id',
    type: 'message',
    timestamp: '2026-05-06T00:00:00Z',
    ...overrides,
  };
}

function makeSurface(
  processResult: unknown = { ok: true },
): NanoClawSurface & {
  processInboundMessage: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
} {
  return {
    processInboundMessage: vi.fn().mockResolvedValue(processResult),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bridge.handleIpcMessage', () => {
  it("type 'message' calls processInboundMessage with channel + payload", async () => {
    const surface = makeSurface({ result: 'done' });
    const { handleIpcMessage } = makeBridge({ nanoclaw: surface });

    const msg = makeMsg({
      type: 'message',
      channel: 'slack:general',
      payload: { text: 'hello' },
    });

    const reply = await handleIpcMessage(msg);

    expect(surface.processInboundMessage).toHaveBeenCalledOnce();
    expect(surface.processInboundMessage).toHaveBeenCalledWith(
      'slack:general',
      { text: 'hello' },
    );
    expect(reply).not.toBeNull();
    expect(reply!.type).toBe('message');
    expect(reply!.correlationId).toBe(msg.id);
  });

  it("type 'shutdown' calls the onShutdown callback", async () => {
    const surface = makeSurface();
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const { handleIpcMessage } = makeBridge({ nanoclaw: surface, onShutdown });

    const msg = makeMsg({ type: 'shutdown' });
    const reply = await handleIpcMessage(msg);

    expect(onShutdown).toHaveBeenCalledOnce();
    expect(surface.processInboundMessage).not.toHaveBeenCalled();
    expect(reply).toBeNull();
  });

  it('outboundToIpc returns IpcMessage with correct correlationId and no replyTo', () => {
    const nanoclawOut = { message: 'response text' };
    const correlationId = 'orig-msg-id';

    const result = outboundToIpc(nanoclawOut, correlationId);

    expect(result.type).toBe('message');
    expect(result.correlationId).toBe(correlationId);
    expect(result.replyTo).toBeUndefined();
    expect(result.payload).toEqual(nanoclawOut);
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
  });

  it('control frames (heartbeat/register/ack/nack/slow_down/resume) do not invoke inbound handler', async () => {
    const controlTypes = [
      'heartbeat',
      'register',
      'ack',
      'nack',
      'slow_down',
      'resume',
    ] as const;

    for (const msgType of controlTypes) {
      const surface = makeSurface();
      const { handleIpcMessage } = makeBridge({ nanoclaw: surface });

      const msg = makeMsg({ type: msgType });
      const reply = await handleIpcMessage(msg);

      expect(surface.processInboundMessage).not.toHaveBeenCalled();
      expect(reply).toBeNull();
    }
  });
});
