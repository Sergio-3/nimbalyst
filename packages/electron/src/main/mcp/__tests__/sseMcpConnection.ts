// Test harness: a real HTTP server that wires each SSE connection exactly the
// way httpServer.ts does (`connectSseTransport`), plus a raw client for it.
// Shared by the tests that need a tool call to lose its SSE connection.

import { createServer, request as httpRequest, type ClientRequest } from 'http';
import type { AddressInfo } from 'net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectSseTransport } from '../sseTransportConnection';

export interface SseMcpConnection {
  /** Everything the server has written to the SSE stream so far. */
  stream: () => string;
  /** Send a JSON-RPC message the way an SSE client does (POST to the endpoint). */
  post: (body: unknown) => Promise<void>;
  /** Drop the SSE connection from the client side. */
  drop: () => void;
  close: () => Promise<void>;
}

export async function openSseMcpConnection(options: {
  onCall: (request: any, extra: any) => Promise<any>;
  onClosed: () => void;
}): Promise<SseMcpConnection> {
  const transports = new Map<string, SSEServerTransport>();
  const httpServer = createServer((req, res) => {
    if (req.method === 'GET') {
      const transport = new SSEServerTransport('/mcp', res);
      transports.set(transport.sessionId, transport);
      const server = new Server({ name: 'sse-test', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(CallToolRequestSchema, (request, extra) => options.onCall(request, extra));
      void connectSseTransport(server, transport, options.onClosed);
      return;
    }
    const sessionId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId') ?? '';
    void transports.get(sessionId)?.handlePostMessage(req, res);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const { port } = httpServer.address() as AddressInfo;

  let stream = '';
  let sseRequest: ClientRequest | undefined;
  const endpoint = await new Promise<string>((resolve) => {
    sseRequest = httpRequest({ host: '127.0.0.1', port, path: '/mcp', method: 'GET' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        stream += chunk;
        const match = /event: endpoint\ndata: (\S+)\n/.exec(stream);
        if (match) resolve(match[1]);
      });
    });
    sseRequest.on('error', () => {});
    sseRequest.end();
  });

  const post = (body: unknown) =>
    new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: endpoint, method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });

  await post({
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sse-test', version: '1.0.0' } },
  });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    stream: () => stream,
    post,
    drop: () => sseRequest?.destroy(),
    close: async () => {
      sseRequest?.destroy();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
