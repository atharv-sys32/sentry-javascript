import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as currentScopes from '../../../../src/currentScopes';
import * as exports from '../../../../src/exports';
import { wrapMcpServerWithSentry } from '../../../../src/integrations/mcp-server';
import { captureError } from '../../../../src/integrations/mcp-server/errorCapture';
import * as spanUtils from '../../../../src/utils/spanUtils';
import {
  createMockClient,
  createMockMcpServer,
  createMockMcpServerV2WithUpdatableHandlers,
  createMockMcpServerWithRegisterApi,
} from './testUtils';

describe('MCP Server Error Capture', () => {
  const captureExceptionSpy = vi.spyOn(exports, 'captureException');
  const getClientSpy = vi.spyOn(currentScopes, 'getClient');

  beforeEach(() => {
    vi.clearAllMocks();
    getClientSpy.mockReturnValue(createMockClient(true));
  });

  describe('captureError', () => {
    it('should capture errors with error type', () => {
      const error = new Error('Tool execution failed');

      captureError(error, 'tool_execution');

      expect(captureExceptionSpy).toHaveBeenCalledWith(error, {
        mechanism: {
          type: 'auto.ai.mcp_server',
          handled: false,
          data: {
            error_type: 'tool_execution',
          },
        },
      });
    });

    it('should capture transport errors', () => {
      const error = new Error('Connection failed');

      captureError(error, 'transport');

      expect(captureExceptionSpy).toHaveBeenCalledWith(error, {
        mechanism: {
          type: 'auto.ai.mcp_server',
          handled: false,
          data: {
            error_type: 'transport',
          },
        },
      });
    });

    it('should capture protocol errors', () => {
      const error = new Error('Invalid JSON-RPC request');

      captureError(error, 'protocol');

      expect(captureExceptionSpy).toHaveBeenCalledWith(error, {
        mechanism: {
          type: 'auto.ai.mcp_server',
          handled: false,
          data: {
            error_type: 'protocol',
          },
        },
      });
    });

    it('should capture validation errors', () => {
      const error = new Error('Invalid parameters');

      captureError(error, 'validation');

      expect(captureExceptionSpy).toHaveBeenCalledWith(error, {
        mechanism: {
          type: 'auto.ai.mcp_server',
          handled: false,
          data: {
            error_type: 'validation',
          },
        },
      });
    });

    it('should capture timeout errors', () => {
      const error = new Error('Operation timed out');

      captureError(error, 'timeout');

      expect(captureExceptionSpy).toHaveBeenCalledWith(error, {
        mechanism: {
          type: 'auto.ai.mcp_server',
          handled: false,
          data: {
            error_type: 'timeout',
          },
        },
      });
    });

    it('should capture errors with MCP data for filtering', () => {
      const error = new Error('Tool failed');

      captureError(error, 'tool_execution', { tool_name: 'my-tool' });

      expect(captureExceptionSpy).toHaveBeenCalledWith(error, {
        mechanism: {
          type: 'auto.ai.mcp_server',
          handled: false,
          data: {
            error_type: 'tool_execution',
            tool_name: 'my-tool',
          },
        },
      });
    });

    it('should not capture when no client is available', () => {
      getClientSpy.mockReturnValue(undefined);

      const error = new Error('Test error');

      captureError(error, 'tool_execution');

      expect(captureExceptionSpy).not.toHaveBeenCalled();
    });

    it('defaults error_type to handler_execution when no type is given', () => {
      captureError(new Error('untyped'));

      expect(captureExceptionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'untyped' }),
        expect.objectContaining({
          mechanism: expect.objectContaining({ data: expect.objectContaining({ error_type: 'handler_execution' }) }),
        }),
      );
    });

    it('sets the active span status to internal_error when a recording span exists', () => {
      const setStatusSpy = vi.fn();
      const getActiveSpanSpy = vi.spyOn(spanUtils, 'getActiveSpan').mockReturnValue({
        isRecording: () => true,
        setStatus: setStatusSpy,
      } as unknown as ReturnType<typeof spanUtils.getActiveSpan>);

      captureError(new Error('boom'), 'tool_execution');

      expect(setStatusSpy).toHaveBeenCalledWith({ code: 2, message: 'internal_error' });
      expect(captureExceptionSpy).toHaveBeenCalled();

      getActiveSpanSpy.mockRestore();
    });

    it('does not set span status when the active span is not recording', () => {
      const setStatusSpy = vi.fn();
      const getActiveSpanSpy = vi.spyOn(spanUtils, 'getActiveSpan').mockReturnValue({
        isRecording: () => false,
        setStatus: setStatusSpy,
      } as unknown as ReturnType<typeof spanUtils.getActiveSpan>);

      captureError(new Error('boom'), 'tool_execution');

      expect(setStatusSpy).not.toHaveBeenCalled();
      expect(captureExceptionSpy).toHaveBeenCalled();

      getActiveSpanSpy.mockRestore();
    });

    it('should handle Sentry capture errors gracefully', () => {
      captureExceptionSpy.mockImplementation(() => {
        throw new Error('Sentry error');
      });

      const error = new Error('Test error');

      // Should not throw
      expect(() => captureError(error, 'tool_execution')).not.toThrow();
    });

    it('should handle undefined client gracefully', () => {
      getClientSpy.mockReturnValue(undefined);

      const error = new Error('Test error');

      // Should not throw and not capture
      expect(() => captureError(error, 'tool_execution')).not.toThrow();
      expect(captureExceptionSpy).not.toHaveBeenCalled();
    });
  });

  describe('Error Capture Integration', () => {
    let mockMcpServer: ReturnType<typeof createMockMcpServer>;
    let wrappedMcpServer: ReturnType<typeof createMockMcpServer>;

    beforeEach(() => {
      mockMcpServer = createMockMcpServer();
      wrappedMcpServer = wrapMcpServerWithSentry(mockMcpServer);
    });

    it('should capture tool execution errors and continue normal flow', async () => {
      const toolError = new Error('Tool execution failed');
      const mockToolHandler = vi.fn().mockRejectedValue(toolError);

      wrappedMcpServer.tool('failing-tool', mockToolHandler);

      await expect(mockToolHandler({ input: 'test' }, { requestId: 'req-123', sessionId: 'sess-456' })).rejects.toThrow(
        'Tool execution failed',
      );

      // The capture should be set up correctly
      expect(captureExceptionSpy).toHaveBeenCalledTimes(0); // No capture yet since we didn't call the wrapped handler
    });

    it('should handle Sentry capture errors gracefully', async () => {
      captureExceptionSpy.mockImplementation(() => {
        throw new Error('Sentry error');
      });

      // Test that the capture function itself doesn't throw
      const toolError = new Error('Tool execution failed');
      const mockToolHandler = vi.fn().mockRejectedValue(toolError);

      wrappedMcpServer.tool('failing-tool', mockToolHandler);

      // The error capture should be resilient to Sentry errors
      expect(captureExceptionSpy).toHaveBeenCalledTimes(0);
    });
  });

  describe('Retroactive handler wrapping (v2 register* API, wrapped after registration)', () => {
    it('should capture errors when a pre-registered tool executor is invoked', async () => {
      const server = createMockMcpServerV2WithUpdatableHandlers();
      wrapMcpServerWithSentry(server);

      const executor = server._registeredTools['my-tool']!.executor as (...args: unknown[]) => Promise<unknown>;
      await expect(executor({}, {})).rejects.toThrow('tool boom');

      expect(captureExceptionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'tool boom' }),
        expect.objectContaining({
          mechanism: expect.objectContaining({
            data: expect.objectContaining({ error_type: 'tool_execution', tool_name: 'my-tool' }),
          }),
        }),
      );
    });

    it('should capture synchronously thrown handler errors (not just rejected promises)', () => {
      const server = createMockMcpServerWithRegisterApi();
      let wrappedHandler: ((...args: unknown[]) => unknown) | undefined;
      (server.registerTool as ReturnType<typeof vi.fn>).mockImplementation((_n, _c, handler) => {
        wrappedHandler = handler as (...args: unknown[]) => unknown;
      });

      wrapMcpServerWithSentry(server);
      server.registerTool(
        'sync-throw',
        {},
        vi.fn(() => {
          throw new Error('sync failure');
        }),
      );

      expect(() => (wrappedHandler as (...args: unknown[]) => unknown)({}, {})).toThrow('sync failure');
      expect(captureExceptionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'sync failure' }),
        expect.objectContaining({
          mechanism: expect.objectContaining({ data: expect.objectContaining({ error_type: 'tool_execution' }) }),
        }),
      );
    });

    it('should capture errors when a pre-registered resource readCallback is invoked', async () => {
      const server = createMockMcpServerV2WithUpdatableHandlers();
      wrapMcpServerWithSentry(server);

      const readCallback = server._registeredResources['res://my-resource']!.readCallback as (
        ...args: unknown[]
      ) => Promise<unknown>;
      await expect(readCallback({}, {})).rejects.toThrow('resource boom');

      expect(captureExceptionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'resource boom' }),
        expect.objectContaining({
          mechanism: expect.objectContaining({ data: expect.objectContaining({ error_type: 'resource_execution' }) }),
        }),
      );
    });

    it('should re-wrap the tool executor after MCP SDK v2 regenerates it via update()', async () => {
      const server = createMockMcpServerV2WithUpdatableHandlers();
      wrapMcpServerWithSentry(server);

      const tool = server._registeredTools['my-tool']!;
      const rawExecutorBeforeUpdate = tool.executor;

      // Simulate `registeredTool.update({ paramsSchema })` — the SDK swaps in a fresh, unwrapped executor
      (tool.update as () => void)();

      // Our wrapper must have re-applied to the regenerated executor
      expect(tool.executor).not.toBe(rawExecutorBeforeUpdate);

      const executor = tool.executor as (...args: unknown[]) => Promise<unknown>;
      await expect(executor({}, {})).rejects.toThrow('tool boom');

      expect(captureExceptionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'tool boom' }),
        expect.objectContaining({
          mechanism: expect.objectContaining({ data: expect.objectContaining({ error_type: 'tool_execution' }) }),
        }),
      );
    });

    it('should re-wrap the prompt handler after update() regeneration', async () => {
      const server = createMockMcpServerV2WithUpdatableHandlers();
      wrapMcpServerWithSentry(server);

      const prompt = server._registeredPrompts['my-prompt']!;
      (prompt.update as () => void)();

      const handler = prompt.handler as (...args: unknown[]) => Promise<unknown>;
      await expect(handler({}, {})).rejects.toThrow('prompt boom');

      expect(captureExceptionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'prompt boom' }),
        expect.objectContaining({
          mechanism: expect.objectContaining({ data: expect.objectContaining({ error_type: 'prompt_execution' }) }),
        }),
      );
    });

    it('should capture exactly once per invocation (single wrapping layer, no double-wrap)', async () => {
      const server = createMockMcpServerV2WithUpdatableHandlers();
      wrapMcpServerWithSentry(server);

      const executor = server._registeredTools['my-tool']!.executor as (...args: unknown[]) => Promise<unknown>;
      await expect(executor({}, {})).rejects.toThrow('tool boom');

      expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Handler error classification (via wrapped registerTool)', () => {
    /**
     * Registers a tool through the wrapped `registerTool`, capturing the wrapped handler the SDK
     * would store, then invokes it with a rejecting original so we can assert the error_type.
     */
    async function invokeWrappedTool(name: string, error: Error): Promise<void> {
      const server = createMockMcpServerWithRegisterApi();
      let wrappedHandler: ((...args: unknown[]) => unknown) | undefined;
      (server.registerTool as ReturnType<typeof vi.fn>).mockImplementation((_name, _config, handler) => {
        wrappedHandler = handler as (...args: unknown[]) => unknown;
      });

      wrapMcpServerWithSentry(server);
      server.registerTool(name, {}, vi.fn().mockRejectedValue(error));

      await expect((wrappedHandler as (...args: unknown[]) => Promise<unknown>)({}, {})).rejects.toThrow(error.message);
    }

    it('classifies validation errors from the message', async () => {
      await invokeWrappedTool('t', new Error('input failed validation'));

      expect(captureExceptionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'input failed validation' }),
        expect.objectContaining({
          mechanism: expect.objectContaining({ data: expect.objectContaining({ error_type: 'validation' }) }),
        }),
      );
    });

    it('classifies validation errors from the error name', async () => {
      const err = new Error('bad');
      err.name = 'ProtocolValidationError';
      await invokeWrappedTool('t', err);

      expect(captureExceptionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'ProtocolValidationError' }),
        expect.objectContaining({
          mechanism: expect.objectContaining({ data: expect.objectContaining({ error_type: 'validation' }) }),
        }),
      );
    });

    it('classifies timeout errors from the message', async () => {
      await invokeWrappedTool('t', new Error('operation timed out'));

      expect(captureExceptionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'operation timed out' }),
        expect.objectContaining({
          mechanism: expect.objectContaining({ data: expect.objectContaining({ error_type: 'timeout' }) }),
        }),
      );
    });

    it('classifies timeout errors from the ServerTimeoutError name', async () => {
      const err = new Error('slow');
      err.name = 'ServerTimeoutError';
      await invokeWrappedTool('t', err);

      expect(captureExceptionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'ServerTimeoutError' }),
        expect.objectContaining({
          mechanism: expect.objectContaining({ data: expect.objectContaining({ error_type: 'timeout' }) }),
        }),
      );
    });

    it('falls back to tool_execution for generic errors', async () => {
      await invokeWrappedTool('my-tool', new Error('something broke'));

      expect(captureExceptionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'something broke' }),
        expect.objectContaining({
          mechanism: expect.objectContaining({
            data: expect.objectContaining({ error_type: 'tool_execution', tool_name: 'my-tool' }),
          }),
        }),
      );
    });
  });
});
