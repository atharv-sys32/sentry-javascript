import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { wrapMcpServerWithSentry } from '@sentry/node';

const mcpRouter = express.Router();

/**
 * Registers the Echo tool/resource/prompt suite (plus an always-throwing tool) on a server.
 * Shared so both wrap orderings run against identical handlers.
 */
function registerEchoHandlers(server: McpServer): void {
  server.registerResource(
    'echo',
    new ResourceTemplate('echo://{message}', { list: undefined }),
    { title: 'Echo Resource' },
    async (uri, { message }) => ({
      contents: [
        {
          uri: uri.href,
          text: `Resource echo: ${message}`,
        },
      ],
    }),
  );

  server.registerTool(
    'echo',
    { description: 'Echo tool', inputSchema: z.object({ message: z.string() }) },
    async ({ message }) => ({
      content: [{ type: 'text', text: `Tool echo: ${message}` }],
    }),
  );

  server.registerPrompt(
    'echo',
    { description: 'Echo prompt', argsSchema: z.object({ message: z.string() }) },
    ({ message }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please process this message: ${message}`,
          },
        },
      ],
    }),
  );

  server.registerTool('always-error', {}, async () => {
    throw new Error('intentional error for span status testing');
  });
}

/**
 * Mounts the standard MCP streamable-HTTP session handling (POST/GET/DELETE) for a server on a route.
 */
function mountMcpServer(router: express.Router, path: string, server: McpServer): void {
  const transports: Record<string, NodeStreamableHTTPServerTransport> = {};

  router.post(path, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      let transport: NodeStreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && req.body?.method === 'initialize') {
        transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: sid => {
            transports[sid] = transport;
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
          }
        };

        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  const handleSessionRequest = async (req: express.Request, res: express.Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  router.get(path, handleSessionRequest);
  router.delete(path, handleSessionRequest);
}

// Recommended ordering: wrap first, then register handlers.
const server = wrapMcpServerWithSentry(
  new McpServer({
    name: 'Echo-V2',
    version: '2.0.0',
  }),
);
registerEchoHandlers(server);
mountMcpServer(mcpRouter, '/mcp', server);

// Retroactive ordering: register handlers first, then wrap. This exercises
// `wrapExistingHandlers`, which instruments the already-generated `executor`/
// `readCallback`/`handler` callables in place instead of patching the
// registration methods ahead of time.
const retroServer = new McpServer({
  name: 'Echo-V2-Retro',
  version: '2.0.0',
});
registerEchoHandlers(retroServer);
wrapMcpServerWithSentry(retroServer);
mountMcpServer(mcpRouter, '/mcp-retro', retroServer);

export { mcpRouter };
