// @vitest-environment node

// A blocking interactive prompt only learns that its caller is gone through the
// abort signal the MCP SDK hands to the tool handler. The SDK fires that signal
// from its own close handling, which `Server.connect` installs by wrapping
// `transport.onclose`. This drives a real SSE connection through the wiring
// httpServer.ts uses and drops it while a tool call is pending.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachInteractivePromptCall } from '../tools/interactivePromptKeepalive';
import { openSseMcpConnection, type SseMcpConnection } from './sseMcpConnection';

let connection: SseMcpConnection | undefined;
const detachers: Array<() => void> = [];

afterEach(async () => {
  detachers.splice(0).forEach((detach) => detach());
  await connection?.close();
  connection = undefined;
});

describe('SSE transport wiring', () => {
  it('aborts a pending tool call when the SSE connection drops', async () => {
    const onAbort = vi.fn();
    const onClosed = vi.fn();
    connection = await openSseMcpConnection({
      onClosed,
      onCall: (request, extra) =>
        new Promise((resolve) => {
          detachers.push(
            attachInteractivePromptCall({
              request,
              extra,
              toolName: 'wait',
              intervalMs: 20,
              onAbort: () => {
                onAbort();
                resolve({ content: [] });
              },
            }),
          );
        }),
    });

    await connection.post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'wait', arguments: {}, _meta: { progressToken: 'wait-1' } },
    });
    // The first heartbeat proves the handler is running and the stream is live.
    await vi.waitFor(() => expect(connection!.stream()).toContain('notifications/progress'), { timeout: 2000 });

    connection.drop();

    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await vi.waitFor(() => expect(onAbort).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });
});
