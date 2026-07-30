import { DEBUG_BUILD } from '../debug-build';
import { defineIntegration } from '../integration';
import { getCurrentScope, getIsolationScope } from '../currentScopes';
import type { Scope } from '../scope';
import type { Event } from '../types/event';
import type { Exception } from '../types/exception';
import type { IntegrationFn } from '../types/integration';
import type { StackFrame } from '../types/stackframe';
import { debug } from '../utils/debug-logger';
import { getFramesFromEvent } from '../utils/stacktrace';

const INTEGRATION_NAME = 'Dedupe' as const;

interface DedupeOptions {
  /**
   * Only drop errors that repeat within the same invocation.
   *
   * By default the integration drops any error identical to the previously captured one,
   * no matter when it occurred. That assumes the client is as short-lived as the work it
   * reports on. On a client shared across invocations (e.g. a cached serverless client)
   * it no longer holds: the same error thrown by two separate requests is reported only
   * once, because the second looks like a repeat of the first.
   *
   * With this enabled the previous event is remembered against the scopes that were
   * active when it was captured, so a new invocation starts from a clean slate and only
   * a genuine repeat inside one invocation is dropped.
   *
   * @default false
   */
  onlyWithinInvocation?: boolean;
}

const _dedupeIntegration = ((options: DedupeOptions = {}) => {
  let previousEvent: Event | undefined;

  /**
   * Per-invocation mode: the previous event, remembered against the scope pair that was
   * active when it was captured, as `isolation scope -> current scope -> event`.
   *
   * Both scopes are needed because wrappers fork different ones, and neither is on its own
   * fresh per invocation. A request handler forks the isolation scope and inherits the
   * ambient current scope; an RPC/method wrapper forks the current scope and inherits the
   * isolation scope from the object handling the call. Keying on the pair means either kind
   * of fork starts a new invocation, and — since a fork is unique to its invocation —
   * concurrent invocations cannot overwrite each other's entry. `WeakMap`s also let a
   * finished invocation's event be collected with its scopes.
   */
  const previousEventByScopes = new WeakMap<Scope, WeakMap<Scope, Event>>();

  return {
    name: INTEGRATION_NAME,
    processEvent(currentEvent) {
      // We want to ignore any non-error type events, e.g. transactions or replays
      // These should never be deduped, and also not be compared against as _previousEvent.
      if (currentEvent.type) {
        return currentEvent;
      }

      // Juuust in case something goes wrong
      try {
        if (options.onlyWithinInvocation) {
          const currentScope = getCurrentScope();
          const isolationScope = getIsolationScope();

          let previousEventByCurrentScope = previousEventByScopes.get(isolationScope);
          if (!previousEventByCurrentScope) {
            previousEventByCurrentScope = new WeakMap();
            previousEventByScopes.set(isolationScope, previousEventByCurrentScope);
          }

          if (_shouldDropEvent(currentEvent, previousEventByCurrentScope.get(currentScope))) {
            DEBUG_BUILD && debug.warn('Event dropped due to being a duplicate of previously captured event.');
            return null;
          }

          previousEventByCurrentScope.set(currentScope, currentEvent);
          return currentEvent;
        }

        if (_shouldDropEvent(currentEvent, previousEvent)) {
          DEBUG_BUILD && debug.warn('Event dropped due to being a duplicate of previously captured event.');
          return null;
        }
      } catch {} // eslint-disable-line no-empty

      return (previousEvent = currentEvent);
    },
  };
}) satisfies IntegrationFn;

/**
 * Deduplication filter.
 */
export const dedupeIntegration = defineIntegration(_dedupeIntegration);

/** only exported for tests. */
export function _shouldDropEvent(currentEvent: Event, previousEvent?: Event): boolean {
  if (!previousEvent) {
    return false;
  }

  if (_isSameMessageEvent(currentEvent, previousEvent)) {
    return true;
  }

  if (_isSameExceptionEvent(currentEvent, previousEvent)) {
    return true;
  }

  return false;
}

function _isSameMessageEvent(currentEvent: Event, previousEvent: Event): boolean {
  const currentMessage = currentEvent.message;
  const previousMessage = previousEvent.message;

  // If neither event has a message property, they were both exceptions, so bail out
  if (!currentMessage && !previousMessage) {
    return false;
  }

  // If only one event has a stacktrace, but not the other one, they are not the same
  if ((currentMessage && !previousMessage) || (!currentMessage && previousMessage)) {
    return false;
  }

  if (currentMessage !== previousMessage) {
    return false;
  }

  if (!_isSameFingerprint(currentEvent, previousEvent)) {
    return false;
  }

  if (!_isSameStacktrace(currentEvent, previousEvent)) {
    return false;
  }

  return true;
}

function _isSameExceptionEvent(currentEvent: Event, previousEvent: Event): boolean {
  const previousException = _getExceptionFromEvent(previousEvent);
  const currentException = _getExceptionFromEvent(currentEvent);

  if (!previousException || !currentException) {
    return false;
  }

  if (previousException.type !== currentException.type || previousException.value !== currentException.value) {
    return false;
  }

  if (!_isSameFingerprint(currentEvent, previousEvent)) {
    return false;
  }

  if (!_isSameStacktrace(currentEvent, previousEvent)) {
    return false;
  }

  return true;
}

function _isSameStacktrace(currentEvent: Event, previousEvent: Event): boolean {
  let currentFrames = getFramesFromEvent(currentEvent);
  let previousFrames = getFramesFromEvent(previousEvent);

  // If neither event has a stacktrace, they are assumed to be the same
  if (!currentFrames && !previousFrames) {
    return true;
  }

  // If only one event has a stacktrace, but not the other one, they are not the same
  if ((currentFrames && !previousFrames) || (!currentFrames && previousFrames)) {
    return false;
  }

  currentFrames = currentFrames as StackFrame[];
  previousFrames = previousFrames as StackFrame[];

  // If number of frames differ, they are not the same
  if (previousFrames.length !== currentFrames.length) {
    return false;
  }

  // Otherwise, compare the two
  for (let i = 0; i < previousFrames.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const frameA = previousFrames[i]!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const frameB = currentFrames[i]!;

    if (
      frameA.filename !== frameB.filename ||
      frameA.lineno !== frameB.lineno ||
      frameA.colno !== frameB.colno ||
      frameA.function !== frameB.function
    ) {
      return false;
    }
  }

  return true;
}

function _isSameFingerprint(currentEvent: Event, previousEvent: Event): boolean {
  let currentFingerprint = currentEvent.fingerprint;
  let previousFingerprint = previousEvent.fingerprint;

  // If neither event has a fingerprint, they are assumed to be the same
  if (!currentFingerprint && !previousFingerprint) {
    return true;
  }

  // If only one event has a fingerprint, but not the other one, they are not the same
  if ((currentFingerprint && !previousFingerprint) || (!currentFingerprint && previousFingerprint)) {
    return false;
  }

  currentFingerprint = currentFingerprint as string[];
  previousFingerprint = previousFingerprint as string[];

  // Otherwise, compare the two
  try {
    return !!(currentFingerprint.join('') === previousFingerprint.join(''));
  } catch {
    return false;
  }
}

function _getExceptionFromEvent(event: Event): Exception | undefined {
  return event.exception?.values?.[0];
}
