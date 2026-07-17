import { describe, expect, it } from 'vitest';
import {
  extractPromptResultAttributes,
  extractToolResultAttributes,
} from '../../../../src/integrations/mcp-server/resultExtraction';

describe('resultExtraction', () => {
  describe('extractToolResultAttributes', () => {
    it('returns an empty object for non-object results', () => {
      expect(extractToolResultAttributes(null, true)).toEqual({});
      expect(extractToolResultAttributes('nope', true)).toEqual({});
    });

    it('records content_count without content when recordOutputs is false', () => {
      const result = { content: [{ type: 'text', text: 'secret' }], isError: false };

      const attrs = extractToolResultAttributes(result, false);

      expect(attrs).toEqual({
        'mcp.tool.result.content_count': 1,
        'mcp.tool.result.content_type': 'text',
        'mcp.tool.result.is_error': false,
      });
      expect(attrs).not.toHaveProperty('mcp.tool.result.content');
    });

    it('captures full content and metadata for a single text item when recordOutputs is true', () => {
      const result = {
        content: [{ type: 'text', text: 'hello', mimeType: 'text/plain', name: 'greeting' }],
      };

      const attrs = extractToolResultAttributes(result, true);

      expect(attrs).toMatchObject({
        'mcp.tool.result.content_count': 1,
        'mcp.tool.result.content_type': 'text',
        'mcp.tool.result.content': 'hello',
        'mcp.tool.result.mime_type': 'text/plain',
        'mcp.tool.result.name': 'greeting',
      });
    });

    it('uses indexed prefixes for multiple content items and skips invalid entries', () => {
      const result = {
        content: [
          { type: 'text', text: 'first' },
          'not-an-object',
          { type: 'image', data: 'base64data', mimeType: 'image/png' },
        ],
      };

      const attrs = extractToolResultAttributes(result, true);

      expect(attrs['mcp.tool.result.content_count']).toBe(3);
      expect(attrs['mcp.tool.result.0.content']).toBe('first');
      // index 1 is a string -> skipped, no attributes emitted for it
      expect(attrs).not.toHaveProperty('mcp.tool.result.1.content_type');
      expect(attrs['mcp.tool.result.2.content_type']).toBe('image');
      expect(attrs['mcp.tool.result.2.mime_type']).toBe('image/png');
      // `data` is recorded as a size, never the raw payload
      expect(attrs['mcp.tool.result.2.data_size']).toBe('base64data'.length);
      expect(attrs).not.toHaveProperty('mcp.tool.result.2.data');
    });

    it('captures embedded resource metadata (uri, mime_type)', () => {
      const result = {
        content: [
          {
            type: 'resource',
            uri: 'file:///doc.txt',
            resource: { uri: 'file:///embedded.txt', mimeType: 'text/plain' },
          },
        ],
      };

      const attrs = extractToolResultAttributes(result, true);

      expect(attrs).toMatchObject({
        'mcp.tool.result.uri': 'file:///doc.txt',
        'mcp.tool.result.resource_uri': 'file:///embedded.txt',
        'mcp.tool.result.resource_mime_type': 'text/plain',
      });
    });

    it('records isError=true when the tool result signals an error', () => {
      const result = { content: [{ type: 'text', text: 'boom' }], isError: true };

      expect(extractToolResultAttributes(result, false)['mcp.tool.result.is_error']).toBe(true);
    });

    it('handles a result without a content array (only isError)', () => {
      expect(extractToolResultAttributes({ isError: false }, true)).toEqual({
        'mcp.tool.result.is_error': false,
      });
    });
  });

  describe('extractPromptResultAttributes', () => {
    it('returns an empty object for non-object results', () => {
      expect(extractPromptResultAttributes(undefined, true)).toEqual({});
    });

    it('records message_count without content when recordOutputs is false', () => {
      const result = {
        description: 'a prompt',
        messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
      };

      const attrs = extractPromptResultAttributes(result, false);

      expect(attrs).toEqual({ 'mcp.prompt.result.message_count': 1 });
      expect(attrs).not.toHaveProperty('mcp.prompt.result.description');
      expect(attrs).not.toHaveProperty('mcp.prompt.result.message_role');
    });

    it('captures description, role and content for a single message when recordOutputs is true', () => {
      const result = {
        description: 'code review',
        messages: [{ role: 'assistant', content: { type: 'text', text: 'looks good' } }],
      };

      const attrs = extractPromptResultAttributes(result, true);

      expect(attrs).toMatchObject({
        'mcp.prompt.result.description': 'code review',
        'mcp.prompt.result.message_count': 1,
        'mcp.prompt.result.message_role': 'assistant',
        'mcp.prompt.result.message_content': 'looks good',
      });
    });

    it('uses indexed prefixes for multiple messages and skips invalid ones', () => {
      const result = {
        messages: [
          { role: 'user', content: { type: 'text', text: 'question' } },
          42,
          { role: 'assistant', content: { type: 'text', text: 'answer' } },
        ],
      };

      const attrs = extractPromptResultAttributes(result, true);

      expect(attrs['mcp.prompt.result.message_count']).toBe(3);
      expect(attrs['mcp.prompt.result.0.role']).toBe('user');
      expect(attrs['mcp.prompt.result.0.content']).toBe('question');
      expect(attrs).not.toHaveProperty('mcp.prompt.result.1.role');
      expect(attrs['mcp.prompt.result.2.role']).toBe('assistant');
      expect(attrs['mcp.prompt.result.2.content']).toBe('answer');
    });

    it('omits description when it is not a string even with recordOutputs', () => {
      const result = { description: 123, messages: [] };

      const attrs = extractPromptResultAttributes(result, true);

      expect(attrs).toEqual({ 'mcp.prompt.result.message_count': 0 });
    });
  });
});
