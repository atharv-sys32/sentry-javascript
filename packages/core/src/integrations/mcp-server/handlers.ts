/**
 * Handler method wrapping for MCP server instrumentation
 *
 * Provides automatic error capture and span correlation for tool, resource,
 * and prompt handlers.
 */

import { DEBUG_BUILD } from '../../debug-build';
import { debug } from '../../utils/debug-logger';
import { addNonEnumerableProperty, fill } from '../../utils/object';
import { captureError } from './errorCapture';
import type { MCPHandler, MCPServerInstance } from './types';

/**
 * Marks a function as an already-instrumented MCP handler so we never wrap it twice.
 * @internal
 */
const WRAPPED_HANDLER_MARKER = '__sentry_mcp_wrapped__';

function isWrappedHandler(fn: unknown): boolean {
  return typeof fn === 'function' && !!(fn as unknown as Record<string, unknown>)[WRAPPED_HANDLER_MARKER];
}

/**
 * Generic function to wrap MCP server method handlers
 * @internal
 * @param serverInstance - MCP server instance
 * @param methodName - Method name to wrap (tool, resource, prompt)
 */
function wrapMethodHandler(serverInstance: MCPServerInstance, methodName: keyof MCPServerInstance): void {
  fill(serverInstance, methodName, originalMethod => {
    return function (this: MCPServerInstance, name: string, ...args: unknown[]) {
      const handler = args[args.length - 1];

      if (typeof handler !== 'function') {
        return (originalMethod as (...args: unknown[]) => unknown).call(this, name, ...args);
      }

      const wrappedHandler = createWrappedHandler(handler as MCPHandler, methodName, name);
      return (originalMethod as (...args: unknown[]) => unknown).call(this, name, ...args.slice(0, -1), wrappedHandler);
    };
  });
}

/**
 * Creates a wrapped handler with span correlation and error capture
 * @internal
 * @param originalHandler - Original handler function
 * @param methodName - MCP method name
 * @param handlerName - Handler identifier
 * @returns Wrapped handler function
 */
function createWrappedHandler(originalHandler: MCPHandler, methodName: keyof MCPServerInstance, handlerName: string) {
  const wrappedHandler = function (this: unknown, ...handlerArgs: unknown[]): unknown {
    try {
      return createErrorCapturingHandler.call(this, originalHandler, methodName, handlerName, handlerArgs);
    } catch (error) {
      DEBUG_BUILD && debug.warn('MCP handler wrapping failed:', error);
      return originalHandler.apply(this, handlerArgs);
    }
  };

  addNonEnumerableProperty(wrappedHandler, WRAPPED_HANDLER_MARKER, true);

  return wrappedHandler;
}

/**
 * Creates an error-capturing wrapper for handler execution
 * @internal
 * @param originalHandler - Original handler function
 * @param methodName - MCP method name
 * @param handlerName - Handler identifier
 * @param handlerArgs - Handler arguments
 * @param extraHandlerData - Additional handler context
 * @returns Handler execution result
 */
function createErrorCapturingHandler(
  this: MCPServerInstance,
  originalHandler: MCPHandler,
  methodName: keyof MCPServerInstance,
  handlerName: string,
  handlerArgs: unknown[],
): unknown {
  try {
    const result = originalHandler.apply(this, handlerArgs);

    if (result && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
      return Promise.resolve(result).catch(error => {
        captureHandlerError(error, methodName, handlerName);
        throw error;
      });
    }

    return result;
  } catch (error) {
    captureHandlerError(error as Error, methodName, handlerName);
    throw error;
  }
}

/**
 * Captures handler execution errors based on handler type
 * @internal
 * @param error - Error to capture
 * @param methodName - MCP method name
 * @param handlerName - Handler identifier
 */
function captureHandlerError(error: Error, methodName: keyof MCPServerInstance, handlerName: string): void {
  try {
    const extraData: Record<string, unknown> = {};

    if (methodName === 'tool' || methodName === 'registerTool') {
      extraData.tool_name = handlerName;

      if (
        error.name === 'ProtocolValidationError' ||
        error.message.includes('validation') ||
        error.message.includes('protocol')
      ) {
        captureError(error, 'validation', extraData);
      } else if (
        error.name === 'ServerTimeoutError' ||
        error.message.includes('timed out') ||
        error.message.includes('timeout')
      ) {
        captureError(error, 'timeout', extraData);
      } else {
        captureError(error, 'tool_execution', extraData);
      }
    } else if (methodName === 'resource' || methodName === 'registerResource') {
      extraData.resource_uri = handlerName;
      captureError(error, 'resource_execution', extraData);
    } else if (methodName === 'prompt' || methodName === 'registerPrompt') {
      extraData.prompt_name = handlerName;
      captureError(error, 'prompt_execution', extraData);
    }
  } catch (_captureErr) {
    // noop
  }
}

/**
 * Wraps tool handlers to associate them with request spans.
 * Instruments both `tool` (legacy API) and `registerTool` (new API) if present.
 * @param serverInstance - MCP server instance
 */
export function wrapToolHandlers(serverInstance: MCPServerInstance): void {
  // eslint-disable-next-line typescript/no-deprecated
  if (typeof serverInstance.tool === 'function') wrapMethodHandler(serverInstance, 'tool');
  if (typeof serverInstance.registerTool === 'function') wrapMethodHandler(serverInstance, 'registerTool');
}

/**
 * Wraps resource handlers to associate them with request spans.
 * Instruments both `resource` (legacy API) and `registerResource` (new API) if present.
 * @param serverInstance - MCP server instance
 */
export function wrapResourceHandlers(serverInstance: MCPServerInstance): void {
  // eslint-disable-next-line typescript/no-deprecated
  if (typeof serverInstance.resource === 'function') wrapMethodHandler(serverInstance, 'resource');
  if (typeof serverInstance.registerResource === 'function') wrapMethodHandler(serverInstance, 'registerResource');
}

/**
 * Wraps prompt handlers to associate them with request spans.
 * Instruments both `prompt` (legacy API) and `registerPrompt` (new API) if present.
 * @param serverInstance - MCP server instance
 */
export function wrapPromptHandlers(serverInstance: MCPServerInstance): void {
  // eslint-disable-next-line typescript/no-deprecated
  if (typeof serverInstance.prompt === 'function') wrapMethodHandler(serverInstance, 'prompt');
  if (typeof serverInstance.registerPrompt === 'function') wrapMethodHandler(serverInstance, 'registerPrompt');
}

/**
 * Wraps all MCP handler types for span correlation.
 * Supports both the legacy API (`tool`, `resource`, `prompt`) and the newer API
 * (`registerTool`, `registerResource`, `registerPrompt`), instrumenting whichever methods are present.
 * @param serverInstance - MCP server instance
 */
export function wrapAllMCPHandlers(serverInstance: MCPServerInstance): void {
  wrapToolHandlers(serverInstance);
  wrapResourceHandlers(serverInstance);
  wrapPromptHandlers(serverInstance);
}

/**
 * Wraps a single pre-registered entry's callable property and guards it against
 * MCP SDK v2 regeneration.
 *
 * The SDK stores each entry's callable under a fixed property (`executor` for tools,
 * `readCallback` for resources/templates, `handler` for prompts) and invokes it by
 * reading that property at call time, so replacing it in-place instruments the entry.
 * v2 additionally rebuilds that callable inside `entry.update(...)` whenever the schema
 * or callback changes (e.g. `registeredTool.update({ paramsSchema })` regenerates
 * `executor`), which would drop our wrapper — so we also wrap `update` to re-apply
 * instrumentation to the freshly generated callable.
 * @internal
 */
function wrapRegisteredEntry(
  entry: Record<string, unknown>,
  callableProp: string,
  methodName: keyof MCPServerInstance,
  name: string,
): void {
  if (typeof entry[callableProp] === 'function' && !isWrappedHandler(entry[callableProp])) {
    entry[callableProp] = createWrappedHandler(entry[callableProp] as MCPHandler, methodName, name);
  }

  if (typeof entry['update'] === 'function' && !isWrappedHandler(entry['update'])) {
    fill(entry, 'update', originalUpdate => {
      const wrappedUpdate = function (this: unknown, ...updateArgs: unknown[]): unknown {
        const result = (originalUpdate as (...args: unknown[]) => unknown).apply(this, updateArgs);
        if (typeof entry[callableProp] === 'function' && !isWrappedHandler(entry[callableProp])) {
          entry[callableProp] = createWrappedHandler(entry[callableProp] as MCPHandler, methodName, name);
        }
        return result;
      };
      addNonEnumerableProperty(wrappedUpdate, WRAPPED_HANDLER_MARKER, true);
      return wrappedUpdate;
    });
  }
}

/**
 * Retroactively wraps handlers on tools, resources, and prompts that were registered
 * before `wrapMcpServerWithSentry` was called.
 *
 * The MCP SDK stores registered entries in private maps and invokes them via the entry's
 * own property at call time — `executor` for tools, `readCallback` for resources, and
 * `handler` for prompts. Replacing those properties
 * in-place is therefore equivalent to having wrapped the original registration call.
 *
 * NOTE: This intentionally accesses private MCP SDK internals (`_registeredTools` etc.).
 * The map names and callable properties are verified against @modelcontextprotocol/sdk v1
 * (https://github.com/modelcontextprotocol/typescript-sdk/blob/2c0c481cb9dbfd15c8613f765c940a5f5bace94d/packages/server/src/server/mcp.ts#L304)
 * and @modelcontextprotocol/server v2 (`2.0.0-beta.4`), where they are unchanged and the
 * callables are still invoked via the mutable property (not captured by closure at
 * registration). When upgrading the MCP SDK, re-verify these. All access is defensive — if
 * a property is absent or not a function we skip silently.
 * @internal
 */
export function wrapExistingHandlers(serverInstance: MCPServerInstance): void {
  const server = serverInstance as unknown as Record<string, unknown>;

  const registries: Array<[string, string, keyof MCPServerInstance]> = [
    // Tools: MCP SDK calls registeredTool.executor (generated from handler at registration time)
    ['_registeredTools', 'executor', 'registerTool'],
    // Resources: MCP SDK calls registeredResource.readCallback
    ['_registeredResources', 'readCallback', 'registerResource'],
    // Resource templates: MCP SDK calls registeredResourceTemplate.readCallback
    ['_registeredResourceTemplates', 'readCallback', 'registerResource'],
    // Prompts: MCP SDK calls registeredPrompt.handler
    ['_registeredPrompts', 'handler', 'registerPrompt'],
  ];

  for (const [registryName, callableProp, methodName] of registries) {
    const registry = server[registryName];
    if (registry && typeof registry === 'object') {
      for (const [name, entry] of Object.entries(registry as Record<string, Record<string, unknown>>)) {
        wrapRegisteredEntry(entry, callableProp, methodName, name);
      }
    }
  }
}
