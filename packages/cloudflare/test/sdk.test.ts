import * as SentryCore from '@sentry/core';
import type { Envelope, Integration } from '@sentry/core';
import { getClient } from '@sentry/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CloudflareOptions } from '../src/client';
import { CloudflareClient } from '../src/client';
import { getDefaultIntegrations, init, _clearGlobalClientCache } from '../src/sdk';
import { resetSdk } from './testUtils';
import { spanStreamingIntegration } from '../src/';

describe('init', () => {
  beforeEach(() => {
    resetSdk();
    _clearGlobalClientCache();
  });

  test('should call initAndBind with the correct options', () => {
    const initAndBindSpy = vi.spyOn(SentryCore, 'initAndBind');
    const client = init({});

    expect(initAndBindSpy).toHaveBeenCalledWith(CloudflareClient, expect.any(Object));

    expect(client).toBeDefined();
    expect(client).toBeInstanceOf(CloudflareClient);
  });

  test('installs SpanStreaming integration when traceLifecycle is "stream"', () => {
    init({
      dsn: 'https://public@dsn.ingest.sentry.io/1337',
      traceLifecycle: 'stream',
    });
    const client = getClient();

    expect(client?.getOptions()).toEqual(
      expect.objectContaining({
        integrations: expect.arrayContaining([expect.objectContaining({ name: 'SpanStreaming' })]),
      }),
    );
  });

  test("does not install SpanStreaming integration when traceLifecycle is not 'stream'", () => {
    init({ dsn: 'https://public@dsn.ingest.sentry.io/1337' });
    const client = getClient();

    expect(client?.getOptions()).toEqual(
      expect.objectContaining({
        integrations: expect.not.arrayContaining([expect.objectContaining({ name: 'SpanStreaming' })]),
      }),
    );
  });

  type MarkedIntegration = Integration & { _custom?: boolean };

  test("doesn't add spanStreamingIntegration if user added it manually", () => {
    const customSpanStreamingIntegration: MarkedIntegration = spanStreamingIntegration();
    customSpanStreamingIntegration._custom = true;

    const client = init({ integrations: [customSpanStreamingIntegration], traceLifecycle: 'stream' });
    const integrations = client?.getOptions().integrations.filter(i => i.name === 'SpanStreaming');

    expect(integrations?.length).toBe(1);
    expect((integrations?.[0] as MarkedIntegration)?._custom).toBe(true);
  });
});

describe('experimental.cacheClient', () => {
  beforeEach(() => {
    resetSdk();
    _clearGlobalClientCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const TEST_ENVELOPE = [
    { event_id: 'aa3ff046696b4bc6b609ce6d28fde9e2', sent_at: '2023-05-31T12:00:00.000Z' },
    [[{ type: 'event' }, { event_id: 'aa3ff046696b4bc6b609ce6d28fde9e2' }]],
  ] as Envelope;

  test('returns the same client for repeated init with identical options', () => {
    const options = {
      dsn: 'https://public@dsn.ingest.sentry.io/1337',
      experimental: { cacheClient: true },
    } as const;

    const first = init({ ...options });
    const second = init({ ...options });

    expect(second).toBe(first);
  });

  test('creates a new client when the options fingerprint differs', () => {
    const first = init({
      dsn: 'https://public@dsn.ingest.sentry.io/1337',
      tracesSampleRate: 0.5,
      experimental: { cacheClient: true },
    });
    const second = init({
      dsn: 'https://public@dsn.ingest.sentry.io/1337',
      tracesSampleRate: 1,
      experimental: { cacheClient: true },
    });

    expect(second).not.toBe(first);
  });

  test('re-binds the cached client to the current scope on repeated init', () => {
    const options = {
      dsn: 'https://public@dsn.ingest.sentry.io/1337',
      experimental: { cacheClient: true },
    } as const;

    const cached = init({ ...options });

    // Simulate a competing init leaving a different client bound to the scope
    SentryCore.getCurrentScope().setClient(undefined);
    expect(getClient()).toBeUndefined();

    const again = init({ ...options });
    expect(again).toBe(cached);
    expect(getClient()).toBe(cached);
  });

  test('creates a fresh client when the cached one was disposed', () => {
    const options = {
      dsn: 'https://public@dsn.ingest.sentry.io/1337',
      experimental: { cacheClient: true },
    } as const;

    const cached = init({ ...options });
    cached?.dispose();

    const again = init({ ...options });
    expect(again).toBeDefined();
    expect(again).not.toBe(cached);
    expect(again?.getTransport()).toBeDefined();
  });

  test('flushes eagerly when an envelope is sent on a cached client', async () => {
    // The eager drain fires the buffered fetch, so stub out the network
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));

    const client = init({
      dsn: 'https://public@dsn.ingest.sentry.io/1337',
      experimental: { cacheClient: true },
    });

    const transport = client?.getTransport();
    expect(transport).toBeDefined();

    const flushSpy = vi.spyOn(transport!, 'flush');
    await client!.sendEnvelope(TEST_ENVELOPE);

    expect(flushSpy).toHaveBeenCalled();
  });

  test('does not flush eagerly when cacheClient is disabled', async () => {
    const client = init({ dsn: 'https://public@dsn.ingest.sentry.io/1337' });

    const transport = client?.getTransport();
    expect(transport).toBeDefined();

    const flushSpy = vi.spyOn(transport!, 'flush');
    await client!.sendEnvelope(TEST_ENVELOPE);

    expect(flushSpy).not.toHaveBeenCalled();
  });

  // Logs and metrics batch client-side and the idle drain timer is disabled for this
  // runtime, so unlike an event a capture alone never produces an envelope. A cached
  // client never reaches an invocation-boundary flush, so without an eager drain these
  // are dropped entirely — and silently, since errors keep working.
  describe('log and metric delivery', () => {
    function initWithCapturingTransport(options: Partial<CloudflareOptions> = {}) {
      const envelopes: Envelope[] = [];
      const client = init({
        dsn: 'https://public@dsn.ingest.sentry.io/1337',
        enableLogs: true,
        transport: () => ({
          send: (envelope: Envelope) => {
            envelopes.push(envelope);
            return Promise.resolve({});
          },
          flush: () => Promise.resolve(true),
        }),
        ...options,
      })!;

      return { client, envelopes };
    }

    const itemTypes = (envelopes: Envelope[]): string[] =>
      envelopes.map(envelope => (envelope[1]?.[0]?.[0] as { type: string })?.type);

    test('delivers a log captured on a cached client without an explicit flush', async () => {
      const { envelopes } = initWithCapturingTransport({ experimental: { cacheClient: true } });

      SentryCore.logger.info('detached log');
      await vi.waitFor(() => expect(itemTypes(envelopes)).toContain('log'));
    });

    test('delivers a metric captured on a cached client without an explicit flush', async () => {
      const { envelopes } = initWithCapturingTransport({ experimental: { cacheClient: true } });

      SentryCore.metrics.count('detached_metric', 1);
      await vi.waitFor(() => expect(itemTypes(envelopes)).toContain('trace_metric'));
    });

    test('coalesces a synchronous burst of logs into a single envelope', async () => {
      const { envelopes } = initWithCapturingTransport({ experimental: { cacheClient: true } });

      for (let i = 0; i < 5; i++) {
        SentryCore.logger.info(`burst ${i}`);
      }

      await vi.waitFor(() => expect(itemTypes(envelopes)).toContain('log'));
      expect(itemTypes(envelopes).filter(type => type === 'log')).toHaveLength(1);
    });

    test('keeps batching logs until flush for a non-cached client', async () => {
      const { client, envelopes } = initWithCapturingTransport();

      SentryCore.logger.info('batched log');
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(envelopes).toHaveLength(0);

      await client.flush(0);
      expect(itemTypes(envelopes)).toContain('log');
    });
  });

  test('applies initialScope on every cached init, not just the first', () => {
    const options = {
      dsn: 'https://public@dsn.ingest.sentry.io/1337',
      experimental: { cacheClient: true },
    } as const;

    init({ ...options });
    SentryCore.getCurrentScope().clear();

    init({ ...options, initialScope: { tags: { from: 'initialScope' } } });

    expect(SentryCore.getCurrentScope().getScopeData().tags).toEqual({ from: 'initialScope' });
  });

  describe('options fingerprint', () => {
    const DSN = 'https://public@dsn.ingest.sentry.io/1337';

    test('reuses the cached client when options differ only in property order', () => {
      const first = init({ dsn: DSN, environment: 'prod', experimental: { cacheClient: true } });
      const second = init({ experimental: { cacheClient: true }, environment: 'prod', dsn: DSN });

      expect(second).toBe(first);
    });

    test('distinguishes regex-valued options', () => {
      const first = init({ dsn: DSN, experimental: { cacheClient: true }, durableObjectSqlSpanAllowlist: [/^cf_a_/] });
      const second = init({ dsn: DSN, experimental: { cacheClient: true }, durableObjectSqlSpanAllowlist: [/^cf_b_/] });

      expect(second).not.toBe(first);
    });

    test('keeps both entries so configs sharing a DSN do not evict each other', () => {
      const first = init({ dsn: DSN, experimental: { cacheClient: true }, environment: 'a' });
      init({ dsn: DSN, experimental: { cacheClient: true }, environment: 'b' });

      expect(init({ dsn: DSN, experimental: { cacheClient: true }, environment: 'a' })).toBe(first);
    });

    test('evicts the oldest entry once the per-isolate cap is reached', () => {
      // Options carrying a per-invocation value fingerprint differently every time, so the cap is
      // what keeps the cache from growing without bound. Past it, the oldest entry is dropped and
      // that config degrades to building a client per invocation.
      const clients = Array.from({ length: 11 }, (_, i) =>
        init({ dsn: DSN, experimental: { cacheClient: true }, environment: `env-${i}` }),
      );

      expect(init({ dsn: DSN, experimental: { cacheClient: true }, environment: 'env-0' })).not.toBe(clients[0]);
      expect(init({ dsn: DSN, experimental: { cacheClient: true }, environment: 'env-10' })).toBe(clients[10]);
    });

    test('does not throw on options that cannot be serialized', () => {
      const circular: Record<string, unknown> = { name: 'Circular' };
      circular.self = circular;

      expect(() =>
        init({ dsn: DSN, experimental: { cacheClient: true }, integrations: [circular as unknown as Integration] }),
      ).not.toThrow();
    });
  });

  test('does not instrument ctx.waitUntil with the flush lock for cached clients', () => {
    const waitUntil = vi.fn();
    const context = { waitUntil, passThroughOnException: vi.fn() };

    init({
      dsn: 'https://public@dsn.ingest.sentry.io/1337',
      experimental: { cacheClient: true },
      ctx: context,
    });

    expect(context.waitUntil).toBe(waitUntil);
  });

  test('instruments ctx.waitUntil with the flush lock for non-cached clients', () => {
    const waitUntil = vi.fn();
    const context = { waitUntil, passThroughOnException: vi.fn() };

    init({ dsn: 'https://public@dsn.ingest.sentry.io/1337', ctx: context });

    expect(context.waitUntil).not.toBe(waitUntil);
  });
});

describe('getDefaultIntegrations', () => {
  afterEach(() => {
    delete globalThis.__SENTRY_ORCHESTRION__;
  });

  test('does not add orchestrion channel integrations when none were registered', () => {
    delete globalThis.__SENTRY_ORCHESTRION__;

    const names = getDefaultIntegrations({}).map(i => i.name);

    expect(names).not.toContain('Mysql');
    expect(names).not.toContain('Postgres');
    expect(names).not.toContain('LruMemoizer');
  });

  test('does not add orchestrion channel integrations when only the bundler marker is set', () => {
    globalThis.__SENTRY_ORCHESTRION__ = { bundler: true };

    const names = getDefaultIntegrations({}).map(i => i.name);

    expect(names).not.toContain('Mysql');
    expect(names).not.toContain('Postgres');
    expect(names).not.toContain('LruMemoizer');
  });

  test('adds orchestrion channel integrations registered on the marker by injected modules', async () => {
    // Mirror what the snippet the vite plugin injects into each instrumented
    // module does at runtime: import its factory and `.set` it on the marker map,
    // keyed by export name (so a package split across files registers once).
    const { mysqlChannelIntegration, postgresChannelIntegration, lruMemoizerChannelIntegration } =
      await import('@sentry/server-utils/orchestrion');
    globalThis.__SENTRY_ORCHESTRION__ = {
      bundler: true,
      integrations: new Map([
        ['mysqlChannelIntegration', mysqlChannelIntegration],
        ['postgresChannelIntegration', postgresChannelIntegration],
        ['lruMemoizerChannelIntegration', lruMemoizerChannelIntegration],
      ]),
    };

    const names = getDefaultIntegrations({}).map(i => i.name);

    expect(names).toContain('Mysql');
    expect(names).toContain('Postgres');
    expect(names).toContain('LruMemoizer');
  });
});
