import type { Envelope, Event } from '@sentry/core';
import { expect, it } from 'vitest';
import { createRunner } from '../../runner';

type Mechanism = { type: string; handled: boolean };

/**
 * Matches an error event by exception value and capture mechanism.
 *
 * Callback-style (instead of exact `eventEnvelope` matching) because Durable Object
 * RPC events carry no `request` and their trace context varies with propagation —
 * only the exception payload is stable. Non-matching envelopes (worker-side duplicate
 * captures, transactions) are dropped by the runner's unordered mode.
 */
function errorEventExpectation(value: string, mechanism: Mechanism) {
  return (envelope: Envelope) => {
    const event = envelope[1]?.[0]?.[1] as Event;
    expect(event).toEqual(
      expect.objectContaining({
        level: 'error',
        exception: {
          values: [
            expect.objectContaining({
              type: 'Error',
              value,
              stacktrace: { frames: expect.any(Array) },
              mechanism,
            }),
          ],
        },
      }),
    );
  };
}

const DO_MECHANISM: Mechanism = { type: 'auto.faas.cloudflare.durable_object', handled: false };
// Direct `captureException` calls (not routed through a wrapped handler) always get this mechanism
const CAPTURE_MECHANISM: Mechanism = { type: 'generic', handled: true };

it('cacheClient: false - DO handler error is captured', async ({ signal }) => {
  const runner = createRunner(__dirname)
    .expect(errorEventExpectation('No-cache DO handler error from instance-1', DO_MECHANISM))
    .expect(errorEventExpectation('No-cache DO handler error from instance-2', DO_MECHANISM))
    .unordered()
    .start(signal);

  await runner.makeRequest('get', '/no-cache/handler-error?id=instance-1', { expectError: true });
  await runner.makeRequest('get', '/no-cache/handler-error?id=instance-2', { expectError: true });
  await runner.completed();
});

it('cacheClient: true - DO handler error is captured', async ({ signal }) => {
  const runner = createRunner(__dirname)
    .expect(errorEventExpectation('Cache DO handler error from instance-1', DO_MECHANISM))
    .expect(errorEventExpectation('Cache DO handler error from instance-2', DO_MECHANISM))
    .unordered()
    .start(signal);

  await runner.makeRequest('get', '/cache/handler-error?id=instance-1', { expectError: true });
  await runner.makeRequest('get', '/cache/handler-error?id=instance-2', { expectError: true });
  await runner.completed();
});

it('cacheClient: true - detached work events ARE captured', async ({ signal }) => {
  const runner = createRunner(__dirname)
    .expect(errorEventExpectation('Detached work from cache DO instance-1', CAPTURE_MECHANISM))
    .expect(errorEventExpectation('Detached work from cache DO instance-2', CAPTURE_MECHANISM))
    // Logs batch client-side and the idle drain timer is disabled for this runtime, so a
    // log only ever becomes an envelope if the cached client drains its log buffer on
    // capture. Without that, detached logs are silently dropped while errors still arrive.
    .expect((envelope: Envelope) => {
      const payload = envelope[1]?.[0]?.[1] as { items?: Array<{ body?: string }> };
      expect(payload.items?.some(log => log.body?.startsWith('Detached log: Detached work from cache DO'))).toBe(true);
    })
    .unordered()
    .start(signal);

  await runner.makeRequest('get', '/cache/detached?id=instance-1');
  await runner.makeRequest('get', '/cache/detached?id=instance-2');
  await runner.completed();
});

it('cacheClient: false - repro #22545: detached work events are silently dropped', async ({ signal }) => {
  const runner = createRunner(__dirname).ignore('transaction').start(signal);

  // Make the request that spawns detached work
  await runner.makeRequest('get', '/no-cache/detached?id=repro-1');

  // With cacheClient: false, the client is disposed after the handler returns,
  // so the detached work's captureException (3s later) is silently dropped.
  // We verify by waiting for the event with a timeout — if it doesn't arrive,
  // the event was silently dropped as expected.
  const result = await Promise.race([
    runner.makeRequestAndWaitForEnvelope('get', '/no-cache/detached?id=repro-2', () => {
      throw new Error('Received an event that should have been dropped with cacheClient: false');
    }),
    // Timeout: resolve with 'timeout' if no event arrives within 5s
    new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 5000)),
  ]);

  // The event should NOT have been received (timeout should win the race)
  expect(result).toBe('timeout');
});

it('cacheClient: true - dedupe reports the same error in each separate invocation', async ({ signal }) => {
  // A shared client shares its dedupe state too. RPC methods are wrapped with `withScope`,
  // which forks the current scope but leaves the isolation scope shared, so dedupe cannot
  // key on the isolation scope alone: three calls into the same Durable Object would report
  // only the first error and silently drop the rest, unlike an uncached client.
  const runner = createRunner(__dirname).ignore('transaction').start(signal);

  for (let i = 0; i < 3; i++) {
    await runner.makeRequestAndWaitForEnvelope(
      'get',
      '/cache/dedupe?id=dedupe-shared',
      errorEventExpectation('Same error', CAPTURE_MECHANISM),
    );
  }
});

// A cached client outlives the invocation that created it, so this checks that reusing it does not
// also start reusing the isolation scope `setTag`/`setUser` write to. The uncached counterpart of
// this test lives in the `durable-object-scope` suite.
it('cacheClient: true - two consecutive invocations get different isolation scopes', async ({ signal }) => {
  const runner = createRunner(__dirname).ignore('transaction').start(signal);

  await runner.makeRequestAndWaitForEnvelope('get', '/cache/scope?id=scope-shared&seed=1', (envelope: Envelope) => {
    const event = envelope[1]?.[0]?.[1] as Event;
    expect(event.exception?.values?.[0]?.value).toBe('Cache scope seed');
    // Guards the probe assertions below against passing vacuously.
    expect(event.tags).toEqual(expect.objectContaining({ seeded_tag: 'from-seeding-call' }));
    expect(event.user).toEqual({ id: 'user-from-seeding-call' });
  });

  await runner.makeRequestAndWaitForEnvelope('get', '/cache/scope?id=scope-shared&seed=0', (envelope: Envelope) => {
    const event = envelope[1]?.[0]?.[1] as Event;
    expect(event.exception?.values?.[0]?.value).toBe('Cache scope probe');
    expect(event.tags?.seeded_tag).toBeUndefined();
    expect(event.user).toBeUndefined();
  });
});

it('cacheClient: true - streaming response works with shared client', async ({ signal }) => {
  const transactionExpectation = (envelope: Envelope) => {
    const tx = envelope[1]?.[0]?.[1] as Event;
    expect(tx.transaction).toBe('GET /streaming');
  };

  const runner = createRunner(__dirname)
    .expect(transactionExpectation)
    .expect(transactionExpectation)
    .unordered()
    .start(signal);

  const text1 = await runner.makeRequest<string>('get', '/cache/streaming');
  expect(text1).toBe('chunk1chunk2');

  const text2 = await runner.makeRequest<string>('get', '/cache/streaming');
  expect(text2).toBe('chunk1chunk2');

  await runner.completed();
});

it('cacheClient: true - multiple DO instances share the same client', async ({ signal }) => {
  const runner = createRunner(__dirname)
    .expect(errorEventExpectation('Cache DO handler error from instance-1', DO_MECHANISM))
    .expect(errorEventExpectation('Cache DO handler error from instance-2', DO_MECHANISM))
    .unordered()
    .start(signal);

  // Two different DO instances — both should capture errors
  await runner.makeRequest('get', '/cache/handler-error?id=instance-1', { expectError: true });
  await runner.makeRequest('get', '/cache/handler-error?id=instance-2', { expectError: true });
  await runner.completed();
});
