import type { ClientOptions, Options, ServerRuntimeClientOptions } from '@sentry/core';
import {
  _INTERNAL_flushLogsBuffer,
  _INTERNAL_flushMetricsBuffer,
  applySdkMetadata,
  debug,
  ServerRuntimeClient,
  spanIsSampled,
} from '@sentry/core';
import { DEBUG_BUILD } from './debug-build';
import type { ExecutionContextCompat } from './executionContext';
import type { makeFlushLock } from './flush';
import type { CloudflareTransportOptions } from './transport';

/**
 * The Sentry Cloudflare SDK Client.
 *
 * @see CloudflareClientOptions for documentation on configuration options.
 * @see ServerRuntimeClient for usage documentation.
 */
export class CloudflareClient extends ServerRuntimeClient {
  private readonly _flushLock: ReturnType<typeof makeFlushLock> | void;
  private _pendingSpans: Set<string> = new Set();
  private _spanCompletionPromise: Promise<void> | null = null;
  private _resolveSpanCompletion: (() => void) | null = null;

  private _unsubscribeSpanStart: (() => void) | null = null;
  private _unsubscribeSpanEnd: (() => void) | null = null;

  /**
   * Whether this client is a cached, cross-invocation client (experimental.cacheClient).
   * Cached clients are never disposed at an invocation boundary, so their spans/events
   * are delivered eagerly instead of waiting for a per-invocation flush.
   */
  public readonly isCachedClient: boolean;

  /**
   * Creates a new Cloudflare SDK instance.
   * @param options Configuration options for this SDK.
   */
  public constructor(options: CloudflareClientOptions) {
    applySdkMetadata(options, 'cloudflare');
    options._metadata = options._metadata || {};
    const { flushLock, ...serverOptions } = options;

    const clientOptions: ServerRuntimeClientOptions = {
      ...serverOptions,
      platform: 'javascript',
      // TODO: Grab version information
      runtime: { name: 'cloudflare' },
      // TODO: Add server name
      _flushInterval: 0,
    };

    super(clientOptions);
    this._flushLock = flushLock;
    this.isCachedClient = options.experimental?.cacheClient === true;

    if (this.isCachedClient) {
      this.on('afterEnvelope', () => {
        void this.getTransport()?.flush(2000);
      });
      this._setupEagerLogAndMetricDelivery();
    }

    // Track span lifecycle to know when to flush. Skipped for cached clients
    // (experimental.cacheClient): they are never disposed, so spans that end after
    // a flush are still delivered. Per-invocation clients are disposed right after
    // the boundary flush, so the flush must wait for open spans to end — otherwise
    // their transaction never gets emitted.
    if (!this.isCachedClient) {
      this._unsubscribeSpanStart = this.on('spanStart', span => {
        const spanId = span.spanContext().spanId;
        DEBUG_BUILD && debug.log('[CloudflareClient] Span started:', spanId);

        // Negatively sampled spans never emit spanEnd,
        // so tracking them would cause _pendingSpans to grow unboundedly.
        // We should fix the inconsistent behavior for NonRecordingSpans in the future but
        // for now, we just ignore them.
        if (!spanIsSampled(span)) {
          return;
        }

        this._pendingSpans.add(spanId);

        if (!this._spanCompletionPromise) {
          this._spanCompletionPromise = new Promise(resolve => {
            this._resolveSpanCompletion = resolve;
          });
        }
      });

      this._unsubscribeSpanEnd = this.on('spanEnd', span => {
        const spanId = span.spanContext().spanId;
        DEBUG_BUILD && debug.log('[CloudflareClient] Span ended:', spanId);
        this._pendingSpans.delete(spanId);

        // If no more pending spans, resolve the completion promise
        if (this._pendingSpans.size === 0 && this._resolveSpanCompletion) {
          DEBUG_BUILD && debug.log('[CloudflareClient] All spans completed, resolving promise');
          this._resolveSpanCompletion();
          this._resetSpanCompletionPromise();
        }
      });
    }
  }

  /**
   * Flushes pending operations and ensures all data is processed.
   * If a timeout is provided, the operation will be completed within the specified time limit.
   *
   * It will wait for all pending spans to complete before flushing.
   *
   * @param {number} [timeout] - Optional timeout in milliseconds to force the completion of the flush operation.
   * @return {Promise<boolean>} A promise that resolves to a boolean indicating whether the flush operation was successful.
   */
  public async flush(timeout?: number): Promise<boolean> {
    // Wait for user waitUntil-registered work to settle before draining, so events
    // captured in that work are still in the buffer. Without this the final flush
    // can drain (and the client be disposed) before background captures land.
    if (this._flushLock) {
      await this._flushLock.finalize();
    }

    if (this._pendingSpans.size > 0 && this._spanCompletionPromise) {
      DEBUG_BUILD &&
        debug.log('[CloudflareClient] Waiting for', this._pendingSpans.size, 'pending spans to complete...');

      const timeoutMs = timeout ?? 5000;
      const spanCompletionRace = Promise.race([
        this._spanCompletionPromise,
        new Promise(resolve =>
          setTimeout(() => {
            DEBUG_BUILD &&
              debug.log('[CloudflareClient] Span completion timeout after', timeoutMs, 'ms, flushing anyway');
            resolve(undefined);
          }, timeoutMs),
        ),
      ]);

      await spanCompletionRace;
    }

    return super.flush(timeout);
  }

  /**
   * Disposes of the client and releases all resources.
   *
   * This method clears all Cloudflare-specific state in addition to the base client cleanup.
   * It unsubscribes from span lifecycle events and clears pending span tracking.
   *
   * Call this method after flushing to allow the client to be garbage collected.
   * After calling dispose(), the client should not be used anymore.
   */
  public override dispose(): void {
    DEBUG_BUILD && debug.log('[CloudflareClient] Disposing client...');

    super.dispose();

    if (this._unsubscribeSpanStart) {
      this._unsubscribeSpanStart();
      this._unsubscribeSpanStart = null;
    }
    if (this._unsubscribeSpanEnd) {
      this._unsubscribeSpanEnd();
      this._unsubscribeSpanEnd = null;
    }

    this._resetSpanCompletionPromise();
    (this as unknown as { _flushLock: ReturnType<typeof makeFlushLock> | void })._flushLock = undefined;
  }

  /**
   * Resets the span completion promise and resolve function.
   */
  private _resetSpanCompletionPromise(): void {
    this._pendingSpans.clear();
    this._spanCompletionPromise = null;
    this._resolveSpanCompletion = null;
  }

  /**
   * Turns log and metric captures into envelopes without waiting for a flush.
   *
   * Unlike events, logs and metrics batch client-side and only become an envelope when
   * their buffer is drained. The idle drain timer is disabled for this runtime
   * (`_flushInterval: 0`), and a cached client never reaches an invocation-boundary
   * `flush()`, so without this a captured log or metric is never delivered at all.
   *
   * The buffers are drained directly rather than via `emit('flush')`, which would also
   * flush an opt-in span buffer mid-invocation and fragment span segments. Draining is
   * debounced to a microtask so a synchronous burst (e.g. a loop of `logger` calls)
   * still produces a single envelope.
   */
  private _setupEagerLogAndMetricDelivery(): void {
    let scheduled = false;
    const scheduleDrain = (): void => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        _INTERNAL_flushLogsBuffer(this);
        _INTERNAL_flushMetricsBuffer(this);
      });
    };

    this.on('afterCaptureLog', scheduleDrain);
    this.on('afterCaptureMetric', scheduleDrain);
  }
}

interface BaseCloudflareOptions {
  /**
   * @ignore Used internally to disable the deDupeIntegration for workflows.
   * @hidden Used internally to disable the deDupeIntegration for workflows.
   * @default true
   */
  enableDedupe?: boolean;

  /**
   * The Cloudflare SDK is not OpenTelemetry native, however, we set up some OpenTelemetry compatibility
   * via a custom trace provider.
   * This ensures that any spans emitted via `@opentelemetry/api` will be captured by Sentry.
   * HOWEVER, big caveat: This does not handle custom context handling, it will always work off the current scope.
   * This should be good enough for many, but not all integrations.
   *
   * If you want to opt-out of setting up the OpenTelemetry compatibility tracer, set this to `true`.
   *
   * @default false
   */
  skipOpenTelemetrySetup?: boolean;

  /**
   * Enable trace propagation for RPC calls between Workers, Durable Objects, and Service Bindings.
   *
   * When enabled, trace context (sentry-trace + baggage) is propagated across:
   * - `stub.fetch()` calls to Durable Objects (via HTTP headers)
   * - Service binding `fetch()` calls (via HTTP headers)
   * - RPC method calls to Durable Objects and WorkerEntrypoints (via trailing argument)
   *
   * When enabled on the **receiver side** (DurableObject or WorkerEntrypoint), the SDK will also:
   * - Extract and continue traces from incoming RPC calls
   * - Create spans for each RPC method invocation
   * - Capture errors thrown by RPC methods
   *
   * **Important:** This option should be enabled on **both sides** for full trace propagation.
   *
   * @default false
   * @example
   * ```ts
   * // Worker side (caller)
   * export default Sentry.withSentry(
   *   (env) => ({
   *     dsn: env.SENTRY_DSN,
   *     enableRpcTracePropagation: true,
   *   }),
   *   handler,
   * );
   *
   * // Durable Object side (receiver)
   * export const MyDO = Sentry.instrumentDurableObjectWithSentry(
   *   (env) => ({
   *     dsn: env.SENTRY_DSN,
   *     enableRpcTracePropagation: true,
   *   }),
   *   MyDOBase,
   * );
   *
   * // WorkerEntrypoint side (receiver)
   * export const MyEntrypoint = Sentry.withSentry(
   *   env => ({ dsn: env.SENTRY_DSN, enableRpcTracePropagation: true }),
   *   MyEntrypointBase,
   * );
   * ```
   */
  enableRpcTracePropagation?: boolean;

  /**
   * Table names that should stay instrumented even though they match the reserved `cf_` prefix used
   * by Durable Object frameworks (`agents`, `partyserver`, ...) for their internal SQLite tables.
   *
   * By default, `exec` queries against `cf_`-prefixed tables are treated as framework noise and no
   * `db.query` span is created for them. If one of your own tables happens to use this prefix, add it
   * here to opt it back into instrumentation. Entries are matched against each table name in the
   * query summary — strings must match exactly, while regular expressions give you prefix/pattern
   * matching.
   *
   * @default []
   * @example
   * ```ts
   * export default Sentry.withSentry(
   *   (env) => ({
   *     dsn: env.SENTRY_DSN,
   *     durableObjectSqlSpanAllowlist: ['cf_my_table', /^cf_reports_/],
   *   }),
   *   handler,
   * );
   * ```
   */
  durableObjectSqlSpanAllowlist?: Array<string | RegExp>;

  /**
   * @deprecated Use `enableRpcTracePropagation` instead. This option will be removed in a future major version.
   *
   * Enable instrumentation of prototype methods for DurableObjects.
   *
   * When `true`, the SDK will wrap all methods on the DurableObject prototype chain
   * to automatically create spans and capture errors for RPC method calls.
   *
   * When an array of strings is provided, only the specified method names will be instrumented.
   *
   * @default false
   */
  instrumentPrototypeMethods?: boolean | string[];

  /**
   * Experimental options for the Cloudflare SDK.
   */
  experimental?: {
    /**
     * Cache the client and reuse it across invocations within the same isolate.
     *
     * When enabled, the SDK creates a single client per unique options set and
     * reuses it for all requests/DO handlers in that isolate. This avoids the
     * per-invocation cost of constructing a new client, and it is what makes
     * Durable Object telemetry reliable: a per-invocation client is disposed at
     * the end of the handler, and in a Durable Object there is no `waitUntil`
     * boundary that reliably extends execution, so spans/events that end after
     * disposal would otherwise be lost.
     *
     * Since a cached client outlives any single invocation, delivery cannot rely
     * on end-of-invocation flushes. With this enabled, captured events are flushed
     * eagerly as they are captured, so data captured in detached/background work
     * is still delivered.
     *
     * **Note:** Because a shared client also shares integration state, the dedupe
     * integration is scoped to a single invocation. The same error in two separate
     * invocations is reported each time, matching the uncached behavior, rather than
     * the second being dropped as a repeat of the first.
     *
     * When disabled (default), a new client is created per invocation and disposed
     * after the handler completes.
     *
     * @default false
     */
    cacheClient?: boolean;
  };
}

/**
 * Configuration options for the Sentry Cloudflare SDK
 *
 * @see @sentry/core Options for more information.
 */
export interface CloudflareOptions extends Options<CloudflareTransportOptions>, BaseCloudflareOptions {
  ctx?: ExecutionContextCompat;
}

/**
 * Configuration options for the Sentry Cloudflare SDK Client class
 *
 * @see CloudflareClient for more information.
 */
export interface CloudflareClientOptions extends ClientOptions<CloudflareTransportOptions>, BaseCloudflareOptions {
  flushLock?: ReturnType<typeof makeFlushLock>;
}
