/**
 * server.ts — UDS framing unit tests.
 *
 * Uses in-memory EventEmitter-based mock sockets (not real UDS sockets)
 * for fast, platform-independent CI runs.
 *
 * Test matrix:
 *  1. Single complete frame decodes correctly
 *  2. Partial frames buffer until complete
 *  3. Oversize frame destroys socket without calling onMessage
 *  4. Two back-to-back frames in one chunk dispatch in order
 *  5. Malformed JSON is swallowed — server does not throw
 *  6. writeFrame round-trip: what we write, we can read back
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { readFrames, writeFrame } from './server.js';
import type { IpcMessage } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a length-prefix frame buffer from a JSON string. */
function makeFrame(json: string): Buffer {
  const body = Buffer.from(json, 'utf8');
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/**
 * Minimal mock socket.
 *
 * - emit('data', chunk) feeds bytes into readFrames' buffer.
 * - write(chunk) captures bytes written by writeFrame (for round-trip test).
 * - destroy(err?) marks the socket as destroyed.
 *
 * This avoids the circular-pipe problem: readFrames only reads from the
 * socket (via 'data' events), so there is no feedback path.
 */
function makeMockSocket() {
  const ee = new EventEmitter();
  const writtenChunks: Buffer[] = [];
  let destroyed = false;
  let destroyError: Error | undefined;

  const socket = {
    on: ee.on.bind(ee),
    emit: ee.emit.bind(ee),
    write(chunk: Buffer | string): void {
      writtenChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    },
    destroy(err?: Error): void {
      destroyed = true;
      destroyError = err;
    },
    get destroyed(): boolean {
      return destroyed;
    },
    get destroyError(): Error | undefined {
      return destroyError;
    },
    // Expose collected writes for assertions.
    get written(): Buffer[] {
      return writtenChunks;
    },
    get writtenConcat(): Buffer {
      return Buffer.concat(writtenChunks);
    },
  };

  return socket;
}

type MockSocket = ReturnType<typeof makeMockSocket>;

/** Wait one event-loop turn so 'data' event handlers fire. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('readFrames', () => {
  it('decodes a single complete frame', async () => {
    const socket = makeMockSocket();
    const onMessage = vi.fn<[IpcMessage], void>();

    readFrames(socket as unknown as import('net').Socket, onMessage);

    const json = JSON.stringify({
      id: 'a',
      type: 'message',
      timestamp: '2026-05-06T00:00:00Z',
    });
    socket.emit('data', makeFrame(json));
    await tick();

    expect(onMessage).toHaveBeenCalledOnce();
    const msg = onMessage.mock.calls[0][0];
    expect(msg.id).toBe('a');
    expect(msg.type).toBe('message');
  });

  it('buffers partial frames until complete', async () => {
    const socket = makeMockSocket();
    const onMessage = vi.fn<[IpcMessage], void>();

    readFrames(socket as unknown as import('net').Socket, onMessage);

    const json = JSON.stringify({
      id: 'b',
      type: 'heartbeat',
      timestamp: '2026-05-06T00:00:00Z',
    });
    const frame = makeFrame(json);

    // Write 4-byte header alone
    socket.emit('data', frame.subarray(0, 4));
    await tick();
    expect(onMessage).not.toHaveBeenCalled();

    // Write first half of body
    const mid = 4 + Math.floor(json.length / 2);
    socket.emit('data', frame.subarray(4, mid));
    await tick();
    expect(onMessage).not.toHaveBeenCalled();

    // Write remaining bytes
    socket.emit('data', frame.subarray(mid));
    await tick();

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0][0].id).toBe('b');
  });

  it('rejects oversize frame (>16 MiB) by destroying the socket', async () => {
    const socket = makeMockSocket();
    const onMessage = vi.fn<[IpcMessage], void>();

    readFrames(socket as unknown as import('net').Socket, onMessage);

    // Write 0xFFFFFFFF as length — well above 16 MiB
    const oversizeHeader = Buffer.alloc(4);
    oversizeHeader.writeUInt32BE(0xffffffff, 0);
    socket.emit('data', oversizeHeader);
    await tick();

    expect(socket.destroyed).toBe(true);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('handles two back-to-back frames in one chunk', async () => {
    const socket = makeMockSocket();
    const onMessage = vi.fn<[IpcMessage], void>();

    readFrames(socket as unknown as import('net').Socket, onMessage);

    const json1 = JSON.stringify({
      id: 'first',
      type: 'message',
      timestamp: '2026-05-06T00:00:00Z',
    });
    const json2 = JSON.stringify({
      id: 'second',
      type: 'ack',
      timestamp: '2026-05-06T00:00:01Z',
    });

    // Concatenate both frames and emit in one shot
    socket.emit('data', Buffer.concat([makeFrame(json1), makeFrame(json2)]));
    await tick();

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[0][0].id).toBe('first');
    expect(onMessage.mock.calls[1][0].id).toBe('second');
  });

  it('swallows malformed JSON without crashing', async () => {
    const socket = makeMockSocket();
    const onMessage = vi.fn<[IpcMessage], void>();

    readFrames(socket as unknown as import('net').Socket, onMessage);

    const garbage = Buffer.from('not-valid-json!!!', 'utf8');
    const frame = Buffer.alloc(4 + garbage.length);
    frame.writeUInt32BE(garbage.length, 0);
    garbage.copy(frame, 4);

    // Should not throw — readFrames catches JSON parse errors internally
    expect(() => socket.emit('data', frame)).not.toThrow();
    await tick();

    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe('writeFrame', () => {
  it('round-trip: written bytes decode back to the original message', async () => {
    // For round-trip we use one socket for writing and a separate one for reading
    const writeSocket = makeMockSocket();
    const readSocket = makeMockSocket();
    const received: IpcMessage[] = [];

    readFrames(readSocket as unknown as import('net').Socket, (msg) =>
      received.push(msg),
    );

    const original: IpcMessage = {
      id: 'round-trip-id',
      type: 'message',
      channel: 'test-channel',
      correlationId: 'corr-123',
      timestamp: '2026-05-06T00:00:00Z',
      payload: { hello: 'world' },
    };

    // Write frame to writeSocket — this captures the bytes in writeSocket.written
    writeFrame(writeSocket as unknown as import('net').Socket, original);

    // Feed those exact bytes into the readSocket as if they arrived over the wire
    for (const chunk of writeSocket.written) {
      readSocket.emit('data', chunk);
    }
    await tick();

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('round-trip-id');
    expect(received[0].type).toBe('message');
    expect(received[0].channel).toBe('test-channel');
    expect(received[0].correlationId).toBe('corr-123');
    expect(received[0].payload).toEqual({ hello: 'world' });
  });
});
