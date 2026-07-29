import type { RawAttributes } from '../../attributes';
import type { Client } from '../../client';
import { DEBUG_BUILD } from '../../debug-build';
import type { ScopeData } from '../../scope';
import {
  SEMANTIC_ATTRIBUTE_SENTRY_ENVIRONMENT,
  SEMANTIC_ATTRIBUTE_SENTRY_RELEASE,
  SEMANTIC_ATTRIBUTE_SENTRY_SDK_INTEGRATIONS,
  SEMANTIC_ATTRIBUTE_SENTRY_SOURCE,
  SEMANTIC_ATTRIBUTE_USER_EMAIL,
  SEMANTIC_ATTRIBUTE_USER_ID,
  SEMANTIC_ATTRIBUTE_USER_IP_ADDRESS,
  SEMANTIC_ATTRIBUTE_USER_USERNAME,
} from '../../semanticAttributes';
import type { SerializedStreamedSpan, Span, SpanJSON, StreamedSpanJSON } from '../../types/span';
import { debug } from '../../utils/debug-logger';
import { getCombinedScopeData } from '../../utils/scopeData';
import {
  INTERNAL_getSegmentSpan,
  showSpanDropWarning,
  spanToStreamedSpanJSON,
  streamedSpanJsonToSerializedSpan,
} from '../../utils/spanUtils';
import { getCapturedScopesOnSpan } from '../utils';
import { isStaticBeforeSendSpanCallback, isStreamedBeforeSendSpanCallback } from './beforeSendSpan';
import { hasSpanStreamingEnabled } from './hasSpanStreamingEnabled';
import { scopeContextsToSpanAttributes } from './scopeContextAttributes';
import { spanJsonToStreamedSpanJson, streamedSpanJsonToSpanJson } from './spanJsonToStreamedSpan';
import { DEFAULT_ENVIRONMENT } from '../../constants';
import {
  SENTRY_SDK_NAME,
  SENTRY_SDK_VERSION,
  SENTRY_SEGMENT_ID,
  SENTRY_SEGMENT_NAME,
  SENTRY_TRACE_LIFECYCLE,
} from '@sentry/conventions/attributes';

export type SerializedStreamedSpanWithSegmentSpan = SerializedStreamedSpan & {
  _segmentSpan: Span;
};

/**
 * Captures a span and returns a JSON representation to be enqueued for sending.
 *
 * IMPORTANT: This function converts the span to JSON immediately to avoid writing
 * to an already-ended OTel span instance (which is blocked by the OTel Span class).
 *
 * @returns the final serialized span with a reference to its segment span. This reference
 * is needed later on to compute the DSC for the span envelope.
 */
export function captureSpan(span: Span, client: Client): SerializedStreamedSpanWithSegmentSpan {
  // Convert to JSON FIRST - we cannot write to an already-ended span
  const spanJSON = spanToStreamedSpanJSON(span);

  const segmentSpan = INTERNAL_getSegmentSpan(span);
  const serializedSegmentSpan = spanToStreamedSpanJSON(segmentSpan);

  const { isolationScope: spanIsolationScope, scope: spanScope } = getCapturedScopesOnSpan(span);

  const finalScopeData = getCombinedScopeData(spanIsolationScope, spanScope);

  applyCommonSpanAttributes(spanJSON, serializedSegmentSpan, client, finalScopeData);

  // Preprocess the span JSON before any other hooks run, so that `processSpan`/`processSegmentSpan`
  // subscribers (incl. integrations) and `beforeSendSpan` see fully inferred span data.
  client.emit('preprocessSpan', spanJSON);

  if (spanJSON.is_segment) {
    applyScopeToSegmentSpan(spanJSON, finalScopeData);
    applySdkMetadataToSegmentSpan(spanJSON, client);
    // Allow hook subscribers to mutate the segment span JSON
    // This also invokes the `processSegmentSpan` hook of all integrations
    client.emit('processSegmentSpan', spanJSON);
  }

  // This allows hook subscribers to mutate the span JSON
  // This also invokes the `processSpan` hook of all integrations
  client.emit('processSpan', spanJSON);

  const processedSpan = applyBeforeSendSpan(spanJSON, client);

  const spanNameSource = processedSpan.attributes?.[SEMANTIC_ATTRIBUTE_SENTRY_SOURCE];
  if (spanJSON.is_segment && spanNameSource) {
    // Backfill sentry.segment.name.source from sentry.source.
    // TODO(v11): Remove this backfill once we removed setting SEMANTIC_ATTRIBUTE_SENTRY_SOURCE in favour of
    // SENTRY_SEGMENT_NAME_SOURCE from @sentry/conventions/attributes only on segment spans.
    safeSetSpanJSONAttributes(processedSpan, {
      ['sentry.segment.name.source']: spanNameSource,
    });
  }

  return {
    ...streamedSpanJsonToSerializedSpan(processedSpan),
    _segmentSpan: segmentSpan,
  };
}

function applyScopeToSegmentSpan(segmentSpanJSON: StreamedSpanJSON, scopeData: ScopeData): void {
  const contextAttributes = scopeContextsToSpanAttributes(scopeData.contexts);
  safeSetSpanJSONAttributes(segmentSpanJSON, contextAttributes);
}

/**
 * Safely set attributes on a span JSON.
 * If an attribute already exists, it will not be overwritten.
 */
export function safeSetSpanJSONAttributes(
  spanJSON: StreamedSpanJSON,
  newAttributes: RawAttributes<Record<string, unknown>>,
): void {
  const originalAttributes = spanJSON.attributes ?? (spanJSON.attributes = {});

  Object.entries(newAttributes).forEach(([key, value]) => {
    if (value != null && !(key in originalAttributes)) {
      originalAttributes[key] = value;
    }
  });
}

function applySdkMetadataToSegmentSpan(segmentSpanJSON: StreamedSpanJSON, client: Client): void {
  const integrationNames = client.getIntegrationNames();
  if (!integrationNames.length) return;

  safeSetSpanJSONAttributes(segmentSpanJSON, {
    [SEMANTIC_ATTRIBUTE_SENTRY_SDK_INTEGRATIONS]: integrationNames,
  });
}

function applyCommonSpanAttributes(
  spanJSON: StreamedSpanJSON,
  serializedSegmentSpan: StreamedSpanJSON,
  client: Client,
  scopeData: ScopeData,
): void {
  const sdk = client.getSdkMetadata();
  const { release, environment } = client.getOptions();

  // avoid overwriting any previously set attributes (from users or potentially our SDK instrumentation)
  safeSetSpanJSONAttributes(spanJSON, {
    [SENTRY_TRACE_LIFECYCLE]: 'stream',
    [SENTRY_SEGMENT_NAME]: serializedSegmentSpan.name,
    [SENTRY_SEGMENT_ID]: serializedSegmentSpan.span_id,
    [SENTRY_SDK_NAME]: sdk?.sdk?.name,
    [SENTRY_SDK_VERSION]: sdk?.sdk?.version,
    [SEMANTIC_ATTRIBUTE_SENTRY_RELEASE]: release,
    [SEMANTIC_ATTRIBUTE_SENTRY_ENVIRONMENT]: environment || DEFAULT_ENVIRONMENT,
    [SEMANTIC_ATTRIBUTE_USER_ID]: scopeData.user?.id,
    [SEMANTIC_ATTRIBUTE_USER_EMAIL]: scopeData.user?.email,
    [SEMANTIC_ATTRIBUTE_USER_IP_ADDRESS]: scopeData.user?.ip_address,
    [SEMANTIC_ATTRIBUTE_USER_USERNAME]: scopeData.user?.username,
    ...scopeData.attributes,
  });
}

/**
 * Apply the configured `beforeSendSpan` callback to a span JSON, in whichever span format the
 * callback expects.
 *
 * Standalone spans (INP web vital spans) are sent as v2 spans even when the static trace
 * lifecycle is configured, so a `withStaticSpan` callback would otherwise never see them. For those,
 * the span is converted to the v1 format for the callback and converted back afterwards.
 *
 * TODO(v12): Remove the v1 and static callback conversion shenanigans once we drop transactions.
 */
function applyBeforeSendSpan(span: StreamedSpanJSON, client: Client): StreamedSpanJSON {
  const { beforeSendSpan } = client.getOptions();

  if (!beforeSendSpan) {
    return span;
  }

  if (hasSpanStreamingEnabled(client)) {
    return isStreamedBeforeSendSpanCallback(beforeSendSpan) ? applyBeforeSendSpanCallback(span, beforeSendSpan) : span;
  }

  return isStaticBeforeSendSpanCallback(beforeSendSpan)
    ? spanJsonToStreamedSpanJson(applyBeforeSendSpanCallback(streamedSpanJsonToSpanJson(span), beforeSendSpan))
    : span;
}

/**
 * Apply a user-provided beforeSendSpan callback to a span JSON.
 */
export function applyBeforeSendSpanCallback<T extends StreamedSpanJSON | SpanJSON>(
  span: T,
  beforeSendSpan: (span: T) => T,
): T {
  let modifedSpan: T;
  try {
    modifedSpan = beforeSendSpan(span);
  } catch (error) {
    // Spans are captured synchronously when they end, so a throwing callback would otherwise
    // propagate into whatever user code ended the span.
    DEBUG_BUILD && debug.error('The `beforeSendSpan` callback threw an error, sending the span unmodified:', error);
    return span;
  }

  if (!modifedSpan) {
    showSpanDropWarning();
    return span;
  }
  return modifedSpan;
}
