import * as Sentry from '@sentry/cloudflare';
import { DurableObject } from 'cloudflare:workers';

interface Env {
  SENTRY_DSN: string;
  SCOPE_DO: DurableObjectNamespace;
}

class ScopeDurableObjectBase extends DurableObject<Env> {
  /**
   * `setTag`/`setUser` write to the isolation scope, which a Durable Object keeps across
   * invocations. Only the seeding invocation writes, so whatever a later invocation reports it
   * must have inherited from a scope the two shared.
   */
  async scopeCheck(seed: boolean): Promise<string> {
    if (seed) {
      Sentry.setTag('seeded_tag', 'from-seeding-invocation');
      Sentry.setUser({ id: 'user-from-seeding-invocation' });
    }

    Sentry.captureException(new Error(seed ? 'Scope seed' : 'Scope probe'));

    return 'ok';
  }
}

export const ScopeDurableObject = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1,
    enableRpcTracePropagation: true,
  }),
  ScopeDurableObjectBase,
);

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1,
    enableRpcTracePropagation: true,
  }),
  {
    async fetch(request, env) {
      const url = new URL(request.url);

      if (url.pathname === '/scope') {
        // Always the same instance, so both invocations land on the same Durable Object.
        const stub = env.SCOPE_DO.get(env.SCOPE_DO.idFromName('scope-do')) as DurableObjectStub<ScopeDurableObjectBase>;

        return new Response(await stub.scopeCheck(url.searchParams.get('seed') === '1'));
      }

      return new Response('Hello World!');
    },
  } satisfies ExportedHandler<Env>,
);
