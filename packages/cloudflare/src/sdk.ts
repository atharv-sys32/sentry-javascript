import type { Integration } from '@sentry/core';
import {
  consoleIntegration,
  conversationIdIntegration,
  dedupeIntegration,
  functionToStringIntegration,
  getCurrentScope,
  getIntegrationsToSetup,
  GLOBAL_OBJ,
  inboundFiltersIntegration,
  initAndBind,
  linkedErrorsIntegration,
  requestDataIntegration,
  setCurrentClient,
  stackParserFromStackParserOptions,
} from '@sentry/core';
import type { CloudflareClientOptions, CloudflareOptions } from './client';
import { CloudflareClient } from './client';
import { cacheClient, fingerprintOptions, getCachedClient } from './clientCache';
import { makeFlushLock } from './flush';
import { httpServerIntegration } from './integrations/httpServer';
import { fetchIntegration } from './integrations/fetch';
import { setupOpenTelemetryTracer } from './opentelemetry/tracer';
import { makeCloudflareTransport } from './transport';
import { defaultStackParser } from './vendor/stacktrace';

// Test-only helper, re-exported here so tests can reset the global client cache.
export { _clearGlobalClientCache } from './clientCache';

/**
 * Instantiate the channel-subscriber factories the `@sentry/cloudflare/vite`
 * plugin registered on the global marker. The plugin splices a small snippet
 * into each instrumented module that `.set`s its factory here (keyed by export
 * name), so the marker holds one factory per package actually bundled.
 *
 * The marker is read directly instead of importing the factories, so a worker
 * built without the plugin — where the channels never fire — ships none of this
 * code.
 * TODO(v11): Use `@sentry/server-utils/orchestrion` once we move to `nodejs_compat` by default.
 */
function getRegisteredChannelIntegrations(): Integration[] {
  const registered = GLOBAL_OBJ.__SENTRY_ORCHESTRION__?.integrations;

  return registered ? [...registered.values()].map(factory => factory()) : [];
}

/** Get the default integrations for the Cloudflare SDK. */
export function getDefaultIntegrations(options: CloudflareOptions): Integration[] {
  // TODO(v11): Drop this transitional gating and let `requestDataIntegration` rely on the resolved
  // `dataCollection` defaults directly. Until then, preserve the historical Cloudflare behavior of not
  // attaching cookies unless the user explicitly opts in via `sendDefaultPii` or `dataCollection.cookies`.
  // eslint-disable-next-line typescript/no-deprecated
  const cookiesEnabled = options.sendDefaultPii || options.dataCollection?.cookies != null;
  return [
    // The Dedupe integration should not be used in workflows because we want to
    // capture all step failures, even if they are the same error.
    //
    // A cached client outlives the invocation that created it, so consecutive captured
    // errors can come from unrelated invocations. Scoping dedupe to a single invocation
    // keeps that from silently dropping the second request's copy of an error — which is
    // what an uncached client, with its fresh integration state per invocation, reports.
    ...(options.enableDedupe === false
      ? []
      : [dedupeIntegration({ onlyWithinInvocation: options.experimental?.cacheClient === true })]),
    // TODO(v11): Replace with `eventFiltersIntegration` once we remove the deprecated `inboundFiltersIntegration`
    // eslint-disable-next-line typescript/no-deprecated
    inboundFiltersIntegration(),
    functionToStringIntegration(),
    conversationIdIntegration(),
    linkedErrorsIntegration(),
    fetchIntegration(),
    httpServerIntegration(),
    requestDataIntegration(cookiesEnabled ? undefined : { include: { cookies: false } }),
    consoleIntegration(),
    // The orchestrion diagnostics-channel subscribers (mysql, pg, …). The
    // `@sentry/cloudflare/vite` plugin injects the channels at build time and,
    // next to each, a snippet that registers the matching subscriber factory on
    // the global marker. Read from there instead of importing them so bundles
    // built without the plugin — where the channels would never fire — don't
    // ship the code.
    ...getRegisteredChannelIntegrations(),
  ];
}

/**
 * Initializes the cloudflare SDK.
 *
 * When `experimental.cacheClient` is enabled, the client is cached and reused
 * across invocations within the same isolate. This avoids the per-invocation
 * cost of constructing a new client, and it is what makes Durable Object
 * telemetry reliable: a per-invocation client is disposed at the end of the
 * handler, and in a Durable Object there is no `waitUntil` boundary that
 * reliably extends execution, so spans/events that end after disposal would
 * otherwise be lost.
 */
export function init(options: CloudflareOptions): CloudflareClient | undefined {
  const cacheEnabled = options.experimental?.cacheClient === true;

  // Fingerprint the user-supplied options before any defaults are resolved, so the
  // fingerprint is stable across invocations that pass the same options.
  const optionsFingerprint = cacheEnabled ? fingerprintOptions(options) : undefined;

  if (cacheEnabled && options.dsn && optionsFingerprint !== undefined) {
    const cached = getCachedClient(options.dsn, optionsFingerprint);
    // A cached client that has lost its transport was disposed — e.g. by a
    // competing non-cached init for the same DSN in the same isolate. Evict it
    // and fall through to create a fresh one rather than returning a dead client.
    if (cached?.getTransport()) {
      // Mirror the two scope side effects of `initAndBind`, which only runs on first
      // creation. Without the re-bind the scope keeps whatever client a previous init
      // left behind — which may have been disposed since — and without the update
      // `initialScope` would apply only to an isolate's very first invocation.
      getCurrentScope().update(options.initialScope);
      setCurrentClient(cached);
      return cached;
    }
  }

  if (options.defaultIntegrations === undefined) {
    options.defaultIntegrations = getDefaultIntegrations(options);
  }

  // A cached client outlives any single invocation, so binding it to one
  // invocation's flush lock would make later flushes wait on that invocation's
  // waitUntil work forever. Eager delivery replaces the flush lock's purpose.
  const flushLock = !cacheEnabled && options.ctx ? makeFlushLock(options.ctx) : undefined;
  delete options.ctx;

  const clientOptions: CloudflareClientOptions = {
    ...options,
    stackParser: stackParserFromStackParserOptions(options.stackParser || defaultStackParser),
    integrations: getIntegrationsToSetup(options),
    transport: options.transport || makeCloudflareTransport,
    flushLock,
  };

  /**
   * The Cloudflare SDK is not OpenTelemetry native, however, we set up some OpenTelemetry compatibility
   * via a custom trace provider.
   * This ensures that any spans emitted via `@opentelemetry/api` will be captured by Sentry.
   * HOWEVER, big caveat: This does not handle custom context handling, it will always work off the current scope.
   * This should be good enough for many, but not all integrations.
   */
  if (!options.skipOpenTelemetrySetup) {
    setupOpenTelemetryTracer();
  }

  const client = initAndBind(CloudflareClient, clientOptions) as CloudflareClient;

  if (cacheEnabled && options.dsn && optionsFingerprint !== undefined) {
    cacheClient(options.dsn, optionsFingerprint, client);
  }

  return client;
}
