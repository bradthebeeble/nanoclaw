/**
 * server.ts — UDS framing unit tests.
 *
 * Uses in-memory PassThrough streams (not real UDS sockets) for fast,
 * platform-independent CI runs.
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
import { PassThrough } from 'stream';
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
 * A pair of PassThrough streams wired together so writes to `client` appear
 * as reads on `server` and vice-versa — simulates a socket pair without
 * actually opening a UDS descriptor.
 */
function makePair(): { client: PassThrough; server: PassThrough } {
  const client = new PassThrough();
  const server = new PassThrough();
  // Route client→server and server→client
  client.on('data', (chunk: Buffer) => server.push(chunk));
  server.on('data', (chunk: Buffer) => client.push(chunk));
  return { client, server };
}

/** Wait one event-loop turn so 'data' event handlers fire. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('readFrames', () => {
  it('decodes a single complete frame', async () => {
    const { client, server } = makePair();
    const onMessage = vi.fn<[IpcMessage], void>();

    readFrames(server as unknown as import('net').Socket, onMessage);

    const json = JSON.stringify({
      id: 'a',
      type: 'message',
      timestamp: '2026-05-06T00:00:00Z',
    });
    client.write(makeFrame(json));
    await tick();

    expect(onMessage).toHaveBeenCalledOnce();
    const msg = onMessage.mock.calls[0][0];
    expect(msg.id).toBe('a');
    expect(msg.type).toBe('message');
  });

  it('buffers partial frames until complete', async () => {
    const { client, server } = makePair();
    const onMessage = vi.fn<[IpcMessage], void>();

    readFrames(server as unknown as import('net').Socket, onMessage);

    const json = JSON.stringify({
      id: 'b',
      type: 'heartbeat',
      timestamp: '2026-05-06T00:00:00Z',
    });
    const frame = makeFrame(json);

    // Write 4-byte header alone
    client.write(frame.subarray(0, 4));
    await tick();
    expect(onMessage).not.toHaveBeenCalled();

    // Write first half of body
    const mid = 4 + Math.floor(json.length / 2);
    client.write(frame.subarray(4, mid));
    await tick();
    expect(onMessage).not.toHaveBeenCalled();

    // Write remaining bytes
    client.write(frame.subarray(mid));
    await tick();

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0][0].id).toBe('b');
  });

  it('rejects oversize frame (>16 MiB) by destroying the socket', async () => {
    const { client, server } = makePair();
    const onMessage = vi.fn<[IpcMessage], void>();
    const destroySpy = vi.spyOn(server, 'destroy');

    readFrames(server as unknown as import('net').Socket, onMessage);

    // Write 0xFFFFFFFF as length — well above 16 MiB
    const oversizeHeader = Buffer.alloc(4);
    oversizeHeader.writeUInt32BE(0xffffffff, 0);
    client.write(oversizeHeader);
    await tick();

    expect(destroySpy).toHaveBeenCalledOnce();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('handles two back-to-back frames in one chunk', async () => {
    const { client, server } = makePair();
    const onMessage = vi.fn<[IpcMessage], void>();

    readFrames(server as unknown as import('net').Socket, onMessage);

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

    // Concatenate both frames and write in one shot
    client.write(Buffer.concat([makeFrame(json1), makeFrame(json2)]));
    await tick();

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[0][0].id).toBe('first');
    expect(onMessage.mock.calls[1][0].id).toBe('second');
  });

  it('swallows malformed JSON without crashing', async () => {
    const { client, server } = makePair();
    const onMessage = vi.fn<[IpcMessage], void>();

    readFrames(server as unknown as import('net').Socket, onMessage);

    const garbage = Buffer.from('not-valid-json!!!', 'utf8');
    const frame = Buffer.alloc(4 + garbage.length);
    frame.writeUInt32BE(garbage.length, 0);
    garbage.copy(frame, 4);

    // Should not throw
    expect(() => client.write(frame)).not.toThrow();
    await tick();

    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe('writeFrame', () => {
  it('round-trip: written bytes decode back to the original message', async () => {
    const { client, server } = makePair();
    const received: IpcMessage[] = [];

    readFrames(client as unknown as import('net').Socket, (msg) => received.push(msg));

    const original: IpcMessage = {
      id: 'round-trip-id',
      type: 'message',
      channel: 'test-channel',
      correlationId: 'corr-123',
      timestamp: '2026-05-06T00:00:00Z',
      payload: { hello: 'world' },
    };

    writeFrame(server as unknown as import('net').Socket, original);
    await tick();

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('round-trip-id');
    expect(received[0].type).toBe('message');
    expect(received[0].channel).toBe('test-channel');
    expect(received[0].correlationId).toBe('corr-123');
    expect(received[0].payload).toEqual({ hello: 'world' });
  });
});
