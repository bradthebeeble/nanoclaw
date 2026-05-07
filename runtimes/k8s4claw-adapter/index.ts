/**
 * NanoClaw EE — k8s4claw IPC bridge entrypoint.
 *
 * Lifecycle:
 *   1. Start NanoClaw proper (existing fork code at vendor/nanoclaw/src/).
 *   2. Build the IPC ↔ NanoClaw bridge.
 *   3. Start the UDS server at IPC_SOCKET_PATH/runtime.sock
 *      (default: /var/run/claw/runtime.sock).
 *   4. Wire SIGTERM/SIGINT for graceful pod shutdown.
 *
 * Plan 06's Dockerfile wires this file as the container ENTRYPOINT.
 *
 * NanoClaw surface wiring:
 *   NanoClaw's core inbound API is routeInbound(InboundEvent) → void.
 *   The IPC 'message' frame carries a channel + JSON payload. We map it to
 *   an InboundEvent with channelType='ipc' and the IPC channel string as
 *   platformId, then call routeInbound fire-and-forget. The bridge returns
 *   an ack IpcMessage so the IPC bus knows the frame was accepted.
 *
 *   Note: NanoClaw's full session-based async response loop (container wakes,
 *   writes outbound DB, host polls and delivers) is separate from this bridge.
 *   The bridge only handles the inbound dispatch leg.
 *
 * Shutdown:
 *   NanoClaw's shutdown() function from src/index.ts fires registered
 *   callbacks, stops delivery polls and host sweep, then calls process.exit(0).
 *   We register the same SIGTERM/SIGINT handlers here and close the UDS server.
 */
import { startServer } from './server.js';
import { makeBridge } from './bridge.js';
import type { NanoClawSurface } from './bridge.js';
import type { IpcMessage } from './types.js';

async function main(): Promise<void> {
  // 1. Initialise the NanoClaw surface.
  const nanoclaw = await initNanoClawSurface();

  // 2. Build bridge.
  const bridge = makeBridge({
    nanoclaw,
    onShutdown: async () => {
      await nanoclaw.shutdown();
      server.close();
      process.exit(0);
    },
  });

  // 3. Start UDS server.
  const server = startServer(bridge.handleIpcMessage);

  const socketPath =
    process.env.IPC_SOCKET_PATH
      ? `${process.env.IPC_SOCKET_PATH}/runtime.sock`
      : '/var/run/claw/runtime.sock';
  console.log(
    '[k8s4claw-adapter] NanoClaw EE k8s4claw adapter started. Listening on',
    socketPath,
  );

  // 4. Signal handlers — graceful shutdown on SIGTERM (k8s pod stop).
  process.on('SIGTERM', async () => {
    console.log('[k8s4claw-adapter] SIGTERM received — shutting down');
    await nanoclaw.shutdown();
    server.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('[k8s4claw-adapter] SIGINT received — shutting down');
    await nanoclaw.shutdown();
    server.close();
    process.exit(0);
  });
}

/**
 * Wire the NanoClaw fork's inbound API to the NanoClawSurface interface.
 *
 * NanoClaw's inbound handler is `routeInbound(InboundEvent)` from src/router.ts.
 * It is fire-and-forget (returns Promise<void>) and initiates the full
 * session-based processing pipeline (session DB write → container wake →
 * async agent run → outbound poll → delivery).
 *
 * We map the IPC channel + payload to an InboundEvent with:
 *   - channelType: 'ipc'   (identifies this as an IPC bus message source)
 *   - platformId:  the IPC channel string (e.g. 'slack:C0123ABC' or 'system')
 *   - threadId:    null (IPC messages are not threaded)
 *   - message: {
 *       id:        a new UUID
 *       kind:      'chat'
 *       content:   JSON.stringify(payload)
 *       timestamp: ISO8601 now
 *       isMention: true  (IPC bus messages are always directed at the agent)
 *     }
 *
 * processInboundMessage always resolves to an 'accepted' acknowledgement — the
 * actual agent response arrives via the delivery pipeline, not the IPC bridge.
 *
 * shutdown: imports and calls NanoClaw's shutdown function chain.
 *
 * Plan 06 verification: confirm that 'ipc' channelType is wired to the correct
 * MessagingGroup before finalising the Dockerfile entrypoint.
 */
async function initNanoClawSurface(): Promise<NanoClawSurface> {
  // Dynamic import to avoid top-level side effects (DB init, channel adapters,
  // delivery polls) until we are ready to start them. NanoClaw's main() in
  // src/index.ts runs on import — so we import the individual exports rather
  // than the main entry.
  const { routeInbound } = await import('../../src/router.js');

  // NanoClaw's shutdown is handled via registered callbacks; we call
  // stopDeliveryPolls + stopHostSweep + teardownChannelAdapters directly.
  const { stopDeliveryPolls } = await import('../../src/delivery.js');
  const { stopHostSweep } = await import('../../src/host-sweep.js');
  const { teardownChannelAdapters } = await import(
    '../../src/channels/channel-registry.js'
  );

  return {
    async processInboundMessage(
      channel: string,
      payload: unknown,
    ): Promise<unknown> {
      const event = {
        channelType: 'ipc',
        platformId: channel,
        threadId: null as string | null,
        message: {
          id: globalThis.crypto.randomUUID(),
          kind: 'chat' as const,
          content: JSON.stringify(payload),
          timestamp: new Date().toISOString(),
          isMention: true, // IPC bus messages are always directed at the agent
        },
      };
      await routeInbound(event);
      // NanoClaw is fire-and-forget into the session pipeline. Return an
      // 'accepted' acknowledgement; the real response comes via delivery.
      return { accepted: true };
    },

    async shutdown(): Promise<void> {
      stopDeliveryPolls();
      stopHostSweep();
      try {
        await teardownChannelAdapters();
      } catch {
        // Best-effort teardown — log but don't block shutdown.
        console.error('[k8s4claw-adapter] teardownChannelAdapters threw during shutdown');
      }
    },
  };
}

// Suppress TS2304 in non-adapter contexts where IpcMessage isn't used top-level.
void (0 as unknown as IpcMessage);

main().catch((err: unknown) => {
  console.error('[k8s4claw-adapter] adapter fatal:', err);
  process.exit(1);
});
