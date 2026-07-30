import * as Sentry from '@sentry/cloudflare';
import { DurableObject } from 'cloudflare:workers';

interface Env {
  SENTRY_DSN: string;
  CACHE_DO: DurableObjectNamespace;
  NO_CACHE_DO: DurableObjectNamespace;
}

function startDetachedWork(message: string): string {
  void (async () => {
    await new Promise(r => setTimeout(r, 3000));
    Sentry.logger.info(`Detached log: ${message}`);
    Sentry.captureException(new Error(message));
  })();
  return `Detached work started: ${message}`;
}

// DO with cacheClient: true — detached work events SHOULD be captured
class CacheDurableObjectBase extends DurableObject<Env> {
  async handlerError(instanceId: string): Promise<void> {
    throw new Error(`Cache DO handler error from ${instanceId}`);
  }

  async dedupe(): Promise<string> {
    Sentry.captureException(new Error('Same error'));
    return 'dedupe test';
  }

  async scopeCheck(seed: boolean): Promise<string> {
    if (seed) {
      Sentry.setTag('seeded_tag', 'from-seeding-call');
      Sentry.setUser({ id: 'user-from-seeding-call' });
    }
    Sentry.captureException(new Error(seed ? 'Cache scope seed' : 'Cache scope probe'));
    return 'ok';
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/detached') {
      return new Response(startDetachedWork(`Detached work from cache DO ${url.searchParams.get('id')}`));
    }
    if (url.pathname === '/streaming') {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('chunk1'));
          controller.enqueue(new TextEncoder().encode('chunk2'));
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('Cache DO');
  }
}

// DO with cacheClient: false (default) — detached work events should NOT be captured
class NoCacheDurableObjectBase extends DurableObject<Env> {
  async handlerError(instanceId: string): Promise<void> {
    throw new Error(`No-cache DO handler error from ${instanceId}`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/detached') {
      return new Response(startDetachedWork(`Detached work from no-cache DO ${url.searchParams.get('id')}`));
    }
    return new Response('No-cache DO');
  }
}

export const CacheDurableObject = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1,
    enableLogs: true,
    experimental: { cacheClient: true },
    enableRpcTracePropagation: true,
  }),
  CacheDurableObjectBase,
);

export const NoCacheDurableObject = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1,
    experimental: { cacheClient: false },
    enableRpcTracePropagation: true,
  }),
  NoCacheDurableObjectBase,
);

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1,
    enableLogs: true,
    experimental: { cacheClient: true },
    enableRpcTracePropagation: true,
  }),
  {
    async fetch(request, env) {
      const url = new URL(request.url);
      const instanceId = url.searchParams.get('id') || 'default';

      // Cache DO RPC calls
      if (url.pathname === '/cache/handler-error') {
        const stub = env.CACHE_DO.get(
          env.CACHE_DO.idFromName(`cache-do-${instanceId}`),
        ) as DurableObjectStub<CacheDurableObjectBase>;
        await stub.handlerError(instanceId);
      }

      if (url.pathname === '/cache/dedupe') {
        const stub = env.CACHE_DO.get(
          env.CACHE_DO.idFromName(`cache-do-${instanceId}`),
        ) as DurableObjectStub<CacheDurableObjectBase>;
        const result = await stub.dedupe();
        return new Response(String(result));
      }

      if (url.pathname === '/cache/scope') {
        const stub = env.CACHE_DO.get(
          env.CACHE_DO.idFromName(`cache-do-${instanceId}`),
        ) as DurableObjectStub<CacheDurableObjectBase>;
        return new Response(await stub.scopeCheck(url.searchParams.get('seed') === '1'));
      }

      // Cache DO fetch calls — detached work goes through fetch (matching the #22545 repro),
      // since the DO fetch handler always initializes the DO's own client
      if (url.pathname === '/cache/detached') {
        const stub = env.CACHE_DO.get(
          env.CACHE_DO.idFromName(`cache-do-${instanceId}`),
        ) as DurableObjectStub<CacheDurableObjectBase>;
        return stub.fetch(new Request(`http://do/detached?id=${instanceId}`));
      }

      if (url.pathname === '/cache/streaming') {
        const stub = env.CACHE_DO.get(
          env.CACHE_DO.idFromName(`cache-do-${instanceId}`),
        ) as DurableObjectStub<CacheDurableObjectBase>;
        return stub.fetch(new Request('http://do/streaming'));
      }

      // No-cache DO calls
      if (url.pathname === '/no-cache/handler-error') {
        const stub = env.NO_CACHE_DO.get(
          env.NO_CACHE_DO.idFromName(`no-cache-do-${instanceId}`),
        ) as DurableObjectStub<NoCacheDurableObjectBase>;
        await stub.handlerError(instanceId);
      }

      if (url.pathname === '/no-cache/detached') {
        const stub = env.NO_CACHE_DO.get(
          env.NO_CACHE_DO.idFromName(`no-cache-do-${instanceId}`),
        ) as DurableObjectStub<NoCacheDurableObjectBase>;
        return stub.fetch(new Request(`http://do/detached?id=${instanceId}`));
      }

      return new Response('Hello World!');
    },
  } satisfies ExportedHandler<Env>,
);
