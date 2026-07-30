import type { Envelope, Event } from '@sentry/core';
import { expect, it } from 'vitest';
import { createRunner } from '../../runner';

it('cacheClient: false - two consecutive invocations get different isolation scopes', async ({ signal }) => {
  const runner = createRunner(__dirname).ignore('transaction').start(signal);

  await runner.makeRequestAndWaitForEnvelope('get', '/scope?seed=1', (envelope: Envelope) => {
    const event = envelope[1]?.[0]?.[1] as Event;
    expect(event.exception?.values?.[0]?.value).toBe('Scope seed');
    // Guards the probe assertions below against passing vacuously: the seeding invocation really
    // did write to its isolation scope.
    expect(event.tags).toEqual(expect.objectContaining({ seeded_tag: 'from-seeding-invocation' }));
    expect(event.user).toEqual({ id: 'user-from-seeding-invocation' });
  });

  await runner.makeRequestAndWaitForEnvelope('get', '/scope?seed=0', (envelope: Envelope) => {
    const event = envelope[1]?.[0]?.[1] as Event;
    expect(event.exception?.values?.[0]?.value).toBe('Scope probe');
    expect(event.tags?.seeded_tag).toBeUndefined();
    expect(event.user).toBeUndefined();
  });
});
