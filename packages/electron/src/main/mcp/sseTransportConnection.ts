import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

/**
 * Connect a legacy SSE transport to its MCP server and run `onClosed` once the
 * SSE stream closes.
 *
 * `onclose` is set before `connect()` on purpose, as the Streamable HTTP branch
 * of httpServer.ts does: `Protocol.connect` wraps the handler that is already
 * there with its own close handling, which aborts in-flight tool calls.
 * Assigned after `connect()`, it replaced that wrapper, so a dropped SSE
 * connection never reached a pending interactive prompt and its waiter leaked.
 */
export function connectSseTransport(
  server: Pick<Server, "connect">,
  transport: SSEServerTransport,
  onClosed: () => void,
): Promise<void> {
  transport.onclose = onClosed;
  return server.connect(transport);
}
