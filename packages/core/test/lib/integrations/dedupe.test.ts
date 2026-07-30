import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { setAsyncContextStrategy } from '../../../src/asyncContext';
import { getDefaultCurrentScope, getDefaultIsolationScope } from '../../../src/defaultScopes';
import { withIsolationScope, withScope } from '../../../src/currentScopes';
import type { Scope } from '../../../src/scope';
import { _shouldDropEvent, dedupeIntegration } from '../../../src/integrations/dedupe';
import type { Event as SentryEvent } from '../../../src/types/event';
import type { Exception } from '../../../src/types/exception';
import type { StackFrame } from '../../../src/types/stackframe';
import type { Stacktrace } from '../../../src/types/stacktrace';

type EventWithException = SentryEvent & {
  exception: {
    values: ExceptionWithStacktrace[];
  };
};
type ExceptionWithStacktrace = Exception & { stacktrace: StacktraceWithFrames };
type StacktraceWithFrames = Stacktrace & { frames: StackFrame[] };

function clone<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

const messageEvent: EventWithException = {
  fingerprint: ['MrSnuffles'],
  message: 'PickleRick',
  exception: {
    values: [
      {
        value: 'PickleRick',
        stacktrace: {
          frames: [
            {
              colno: 1,
              filename: 'filename.js',
              function: 'function',
              lineno: 1,
            },
            {
              colno: 2,
              filename: 'filename.js',
              function: 'function',
              lineno: 2,
            },
          ],
        },
      },
    ],
  },
};
const exceptionEvent: EventWithException = {
  exception: {
    values: [
      {
        stacktrace: {
          frames: [
            {
              colno: 1,
              filename: 'filename.js',
              function: 'function',
              lineno: 1,
            },
            {
              colno: 2,
              filename: 'filename.js',
              function: 'function',
              lineno: 2,
            },
          ],
        },
        type: 'SyntaxError',
        value: 'missing ( on line 10',
      },
    ],
  },
  fingerprint: ['MrSnuffles'],
};

describe('Dedupe', () => {
  describe('shouldDropEvent(messageEvent)', () => {
    it('should not drop if there was no previous event', () => {
      const event = clone(messageEvent);
      expect(_shouldDropEvent(event)).toBe(false);
    });

    it('should not drop if events have different messages', () => {
      const eventA = clone(messageEvent);
      const eventB = clone(messageEvent);
      eventB.message = 'EvilMorty';
      eventB.exception.values[0]!.value = 'EvilMorty';
      expect(_shouldDropEvent(eventA, eventB)).toBe(false);
    });

    it('should not drop if events have same messages, but different stacktraces', () => {
      const eventA = clone(messageEvent);
      const eventB = clone(messageEvent);
      eventB.exception.values[0]!.stacktrace.frames[0]!.colno = 1337;
      expect(_shouldDropEvent(eventA, eventB)).toBe(false);
    });

    it('should drop if there are two events with same messages and no fingerprints', () => {
      const eventA = clone(messageEvent);
      delete eventA.fingerprint;
      const eventB = clone(messageEvent);
      delete eventB.fingerprint;
      expect(_shouldDropEvent(eventA, eventB)).toBe(true);
    });

    it('should drop if there are two events with same messages and same fingerprints', () => {
      const eventA = clone(messageEvent);
      const eventB = clone(messageEvent);
      expect(_shouldDropEvent(eventA, eventB)).toBe(true);
    });

    it('should not drop if there are two events with same message but different fingerprints', () => {
      const eventA = clone(messageEvent);
      const eventB = clone(messageEvent);
      eventA.fingerprint = ['Birdperson'];
      const eventC = clone(messageEvent);
      delete eventC.fingerprint;
      expect(_shouldDropEvent(eventA, eventB)).toBe(false);
      expect(_shouldDropEvent(eventA, eventC)).toBe(false);
      expect(_shouldDropEvent(eventB, eventC)).toBe(false);
    });
  });

  describe('shouldDropEvent(exceptionEvent)', () => {
    it('should not drop if there was no previous event', () => {
      const event = clone(exceptionEvent);
      expect(_shouldDropEvent(event)).toBe(false);
    });

    it('should drop when events type, value and stacktrace are the same', () => {
      const event = clone(exceptionEvent);
      expect(_shouldDropEvent(event, event)).toBe(true);
    });

    it('should not drop if types are different', () => {
      const eventA = clone(exceptionEvent);
      const eventB = clone(exceptionEvent);
      eventB.exception.values[0]!.type = 'TypeError';
      expect(_shouldDropEvent(eventA, eventB)).toBe(false);
    });

    it('should not drop if values are different', () => {
      const eventA = clone(exceptionEvent);
      const eventB = clone(exceptionEvent);
      eventB.exception.values[0]!.value = 'Expected number, got string';
      expect(_shouldDropEvent(eventA, eventB)).toBe(false);
    });

    it('should not drop if stacktraces are different', () => {
      const eventA = clone(exceptionEvent);
      const eventB = clone(exceptionEvent);
      eventB.exception.values[0]!.stacktrace.frames[0]!.colno = 1337;
      expect(_shouldDropEvent(eventA, eventB)).toBe(false);
    });

    it('should drop if there are two events with same exception and no fingerprints', () => {
      const eventA = clone(exceptionEvent);
      delete eventA.fingerprint;
      const eventB = clone(exceptionEvent);
      delete eventB.fingerprint;
      expect(_shouldDropEvent(eventA, eventB)).toBe(true);
    });

    it('should drop if there are two events with same exception and same fingerprints', () => {
      const eventA = clone(exceptionEvent);
      const eventB = clone(exceptionEvent);
      expect(_shouldDropEvent(eventA, eventB)).toBe(true);
    });

    it('should not drop if there are two events with same exception but different fingerprints', () => {
      const eventA = clone(exceptionEvent);
      const eventB = clone(exceptionEvent);
      eventA.fingerprint = ['Birdperson'];
      const eventC = clone(exceptionEvent);
      delete eventC.fingerprint;
      expect(_shouldDropEvent(eventA, eventB)).toBe(false);
      expect(_shouldDropEvent(eventA, eventC)).toBe(false);
      expect(_shouldDropEvent(eventB, eventC)).toBe(false);
    });
  });

  describe('processEvent', () => {
    it('ignores consecutive errors', () => {
      const integration = dedupeIntegration();

      expect(integration.processEvent?.(clone(exceptionEvent), {}, {} as any)).not.toBeNull();
      expect(integration.processEvent?.(clone(exceptionEvent), {}, {} as any)).toBeNull();
      expect(integration.processEvent?.(clone(exceptionEvent), {}, {} as any)).toBeNull();
    });

    it('ignores transactions between errors', () => {
      const integration = dedupeIntegration();

      expect(integration.processEvent?.(clone(exceptionEvent), {}, {} as any)).not.toBeNull();
      expect(
        integration.processEvent?.(
          {
            event_id: 'aa3ff046696b4bc6b609ce6d28fde9e2',
            message: 'someMessage',
            transaction: 'wat',
            type: 'transaction',
          },
          {},
          {} as any,
        ),
      ).not.toBeNull();
      expect(integration.processEvent?.(clone(exceptionEvent), {}, {} as any)).toBeNull();
      expect(integration.processEvent?.(clone(exceptionEvent), {}, {} as any)).toBeNull();
    });

    describe('onlyWithinInvocation', () => {
      afterEach(() => {
        // Restore the default (stack-based) strategy so other tests are unaffected
        setAsyncContextStrategy(undefined);
      });

      // Install an AsyncLocalStorage-backed strategy so `withIsolationScope` yields
      // a genuinely fresh isolation scope per call, mirroring the serverless runtimes
      // this option is meant for.
      function useAlsStrategy(): void {
        const asyncStorage = new AsyncLocalStorage<{ scope: Scope; isolationScope: Scope }>();
        const getScopes = (): { scope: Scope; isolationScope: Scope } =>
          asyncStorage.getStore() ?? { scope: getDefaultCurrentScope(), isolationScope: getDefaultIsolationScope() };

        setAsyncContextStrategy({
          withScope: callback => {
            const scope = getScopes().scope.clone();
            return asyncStorage.run({ scope, isolationScope: getScopes().isolationScope }, () => callback(scope));
          },
          withSetScope: (scope, callback) =>
            asyncStorage.run({ scope, isolationScope: getScopes().isolationScope.clone() }, () => callback(scope)),
          withIsolationScope: callback =>
            asyncStorage.run({ scope: getScopes().scope, isolationScope: getScopes().isolationScope.clone() }, () =>
              callback(getScopes().isolationScope),
            ),
          withSetIsolationScope: (isolationScope, callback) =>
            asyncStorage.run({ scope: getScopes().scope, isolationScope }, () => callback(isolationScope)),
          getCurrentScope: () => getScopes().scope,
          getIsolationScope: () => getScopes().isolationScope,
        });
      }

      it('still drops errors that repeat within one invocation', () => {
        useAlsStrategy();
        const integration = dedupeIntegration({ onlyWithinInvocation: true });

        withIsolationScope(() => {
          expect(integration.processEvent?.(clone(exceptionEvent), {}, {} as any)).not.toBeNull();
          expect(integration.processEvent?.(clone(exceptionEvent), {}, {} as any)).toBeNull();
          expect(integration.processEvent?.(clone(exceptionEvent), {}, {} as any)).toBeNull();
        });
      });

      // How a request handler is wrapped: the isolation scope is forked per invocation
      // while the current scope is inherited from the surrounding context.
      it('does not drop the same error across forked isolation scopes', () => {
        useAlsStrategy();
        const integration = dedupeIntegration({ onlyWithinInvocation: true });

        for (let i = 0; i < 3; i++) {
          withIsolationScope(() => {
            expect(integration.processEvent?.(clone(exceptionEvent), {}, {} as any)).not.toBeNull();
          });
        }
      });

      // How a Durable Object RPC method is wrapped: the current scope is forked per call
      // while the isolation scope is shared by every call into that object. Keying on the
      // isolation scope alone would report only the first call's error.
      it('does not drop the same error across forked current scopes', () => {
        useAlsStrategy();
        const integration = dedupeIntegration({ onlyWithinInvocation: true });

        withIsolationScope(() => {
          for (let i = 0; i < 3; i++) {
            withScope(() => {
              expect(integration.processEvent?.(clone(exceptionEvent), {}, {} as any)).not.toBeNull();
            });
          }
        });
      });

      it('keeps concurrent invocations out of each other comparisons', async () => {
        useAlsStrategy();
        const integration = dedupeIntegration({ onlyWithinInvocation: true });

        // Interleave two invocations so each sees the other's event in between its own.
        const invocation = async (): Promise<Array<SentryEvent | null>> =>
          withIsolationScope(async () => {
            const results = [integration.processEvent?.(clone(exceptionEvent), {}, {} as any) ?? null];
            await new Promise(resolve => setTimeout(resolve, 10));
            results.push(integration.processEvent?.(clone(exceptionEvent), {}, {} as any) ?? null);
            return results;
          });

        const [first, second] = await Promise.all([invocation(), invocation()]);

        // Each invocation reports its first error and dedupes its own repeat, regardless
        // of what the other invocation captured in between.
        expect(first?.[0]).not.toBeNull();
        expect(first?.[1]).toBeNull();
        expect(second?.[0]).not.toBeNull();
        expect(second?.[1]).toBeNull();
      });
    });
  });
});
