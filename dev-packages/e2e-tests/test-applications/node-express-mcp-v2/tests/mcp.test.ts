import { expect, test } from '@playwright/test';
import { waitForError, waitForTransaction } from '@sentry-internal/test-utils';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/**
 * Runs the full MCP handler flow (initialize + tool/resource/prompt + error tool) against a
 * server mounted at `path` and asserts the emitted transactions and the captured handler error.
 */
async function runMcpFlow(baseURL: string | undefined, path: string, serverName: string): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseURL}${path}`));

  const client = new Client({
    name: 'test-client-v2',
    version: '1.0.0',
  });

  const initializeTransactionPromise = waitForTransaction('node-express-mcp-v2', transactionEvent => {
    return (
      transactionEvent.transaction === 'initialize' &&
      transactionEvent.contexts?.trace?.data?.['mcp.server.name'] === serverName
    );
  });

  await client.connect(transport);

  await test.step('initialize handshake', async () => {
    const initializeTransaction = await initializeTransactionPromise;
    expect(initializeTransaction).toBeDefined();
    expect(initializeTransaction.contexts?.trace?.op).toEqual('mcp.server');
    expect(initializeTransaction.contexts?.trace?.data?.['mcp.method.name']).toEqual('initialize');
    expect(initializeTransaction.contexts?.trace?.data?.['mcp.client.name']).toEqual('test-client-v2');
    expect(initializeTransaction.contexts?.trace?.data?.['mcp.server.name']).toEqual(serverName);
    expect(initializeTransaction.contexts?.trace?.data?.['mcp.transport']).toMatch(/StreamableHTTPServerTransport/);
  });

  await test.step('registerTool handler', async () => {
    const toolTransactionPromise = waitForTransaction('node-express-mcp-v2', transactionEvent => {
      return (
        transactionEvent.transaction === 'tools/call echo' &&
        transactionEvent.contexts?.trace?.data?.['mcp.server.name'] === serverName
      );
    });

    const toolResult = await client.callTool({
      name: 'echo',
      arguments: {
        message: 'foobar',
      },
    });

    expect(toolResult).toMatchObject({
      content: [
        {
          text: 'Tool echo: foobar',
          type: 'text',
        },
      ],
    });

    const toolTransaction = await toolTransactionPromise;
    expect(toolTransaction).toBeDefined();
    expect(toolTransaction.contexts?.trace?.op).toEqual('mcp.server');
    expect(toolTransaction.contexts?.trace?.data?.['mcp.method.name']).toEqual('tools/call');
    expect(toolTransaction.contexts?.trace?.data?.['mcp.tool.name']).toEqual('echo');
    // Proves span was completed with results (span correlation worked end-to-end)
    expect(toolTransaction.contexts?.trace?.data?.['mcp.tool.result.content_count']).toEqual(1);
  });

  await test.step('registerResource handler', async () => {
    const resourceTransactionPromise = waitForTransaction('node-express-mcp-v2', transactionEvent => {
      return (
        transactionEvent.transaction === 'resources/read echo://foobar' &&
        transactionEvent.contexts?.trace?.data?.['mcp.server.name'] === serverName
      );
    });

    const resourceResult = await client.readResource({
      uri: 'echo://foobar',
    });

    expect(resourceResult).toMatchObject({
      contents: [{ text: 'Resource echo: foobar', uri: 'echo://foobar' }],
    });

    const resourceTransaction = await resourceTransactionPromise;
    expect(resourceTransaction).toBeDefined();
    expect(resourceTransaction.contexts?.trace?.op).toEqual('mcp.server');
    expect(resourceTransaction.contexts?.trace?.data?.['mcp.method.name']).toEqual('resources/read');
  });

  await test.step('registerPrompt handler', async () => {
    const promptTransactionPromise = waitForTransaction('node-express-mcp-v2', transactionEvent => {
      return (
        transactionEvent.transaction === 'prompts/get echo' &&
        transactionEvent.contexts?.trace?.data?.['mcp.server.name'] === serverName
      );
    });

    const promptResult = await client.getPrompt({
      name: 'echo',
      arguments: {
        message: 'foobar',
      },
    });

    expect(promptResult).toMatchObject({
      messages: [
        {
          content: {
            text: 'Please process this message: foobar',
            type: 'text',
          },
          role: 'user',
        },
      ],
    });

    const promptTransaction = await promptTransactionPromise;
    expect(promptTransaction).toBeDefined();
    expect(promptTransaction.contexts?.trace?.op).toEqual('mcp.server');
    expect(promptTransaction.contexts?.trace?.data?.['mcp.method.name']).toEqual('prompts/get');
  });

  await test.step('error tool captures error and sets span status to internal_error', async () => {
    const toolTransactionPromise = waitForTransaction('node-express-mcp-v2', transactionEvent => {
      return (
        transactionEvent.transaction === 'tools/call always-error' &&
        transactionEvent.contexts?.trace?.data?.['mcp.server.name'] === serverName
      );
    });

    // The handler wrapper reports the thrown error as a Sentry event with an MCP mechanism.
    // This is the signal unique to the handler wrapping (transport instrumentation only sets
    // span status), so it proves the wrapped handler ran for this route.
    const errorEventPromise = waitForError('node-express-mcp-v2', errorEvent => {
      return (
        errorEvent.exception?.values?.[0]?.value === 'intentional error for span status testing' &&
        errorEvent.exception?.values?.[0]?.mechanism?.type === 'auto.ai.mcp_server'
      );
    });

    try {
      await client.callTool({ name: 'always-error', arguments: {} });
    } catch {
      // Expected: MCP SDK throws when the tool returns a JSON-RPC error
    }

    const toolTransaction = await toolTransactionPromise;
    expect(toolTransaction).toBeDefined();
    expect(toolTransaction.contexts?.trace?.op).toEqual('mcp.server');
    expect(toolTransaction.contexts?.trace?.status).toEqual('internal_error');

    const errorEvent = await errorEventPromise;
    expect(errorEvent.exception?.values?.[0]?.mechanism?.data?.error_type).toEqual('tool_execution');
    expect(errorEvent.exception?.values?.[0]?.mechanism?.data?.tool_name).toEqual('always-error');
  });

  await client.close();
}

test('Should record transactions for MCP handlers wrapped before registration (register* API)', async ({ baseURL }) => {
  await runMcpFlow(baseURL, '/mcp', 'Echo-V2');
});

test('Should record transactions for MCP handlers wrapped after registration (retroactive wrapping)', async ({
  baseURL,
}) => {
  await runMcpFlow(baseURL, '/mcp-retro', 'Echo-V2-Retro');
});
