import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadCLIConfig = vi.fn();

vi.mock('../../src/storage/repo-manager.js', () => ({
  loadCLIConfig,
}));

import { callLLM, resolveLLMConfig } from '../../src/core/wiki/llm-client.js';

describe('wiki llm client', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
    loadCLIConfig.mockReset();
    loadCLIConfig.mockResolvedValue({});
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('resolves AI_GATEWAY_API_KEY as the runtime API key fallback', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gateway-api-key';
    process.env.AI_GATEWAY_CREDENTIAL = 'credential-secret';
    process.env.AI_GATEWAY_GROUP = 'group-secret';

    const config = await resolveLLMConfig();

    expect(config.apiKey).toBe('gateway-api-key');
    expect(config.gatewayApiKey).toBe('gateway-api-key');
    expect(config.gatewayCredential).toBe('credential-secret');
    expect(config.gatewayGroup).toBe('group-secret');
  });

  it('sends authorization and Sipher gateway headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200 }));
    global.fetch = fetchMock as typeof fetch;

    await callLLM('hello', {
      apiKey: 'gateway-api-key',
      baseUrl: 'https://ai-gateway.atherlabs.com/v1',
      model: 'openai/gpt-4.1-mini',
      maxTokens: 100,
      temperature: 0,
      gatewayApiKey: 'gateway-api-key',
      gatewayCredential: 'credential-secret',
      gatewayGroup: 'group-secret',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = request.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer gateway-api-key');
    expect(headers.AI_GATEWAY_API_KEY).toBe('gateway-api-key');
    expect(headers.AI_GATEWAY_CREDENTIAL).toBe('credential-secret');
    expect(headers.AI_GATEWAY_GROUP).toBe('group-secret');
  });

  it('falls back to non-streaming on the gateway empty-stream failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'empty_stream: upstream stream closed before first payload',
          type: 'server_error',
          code: 'internal_server_error',
        },
      }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 }));
    global.fetch = fetchMock as typeof fetch;

    const result = await callLLM('hello', {
      apiKey: 'gateway-api-key',
      baseUrl: 'https://ai-gateway.atherlabs.com/v1',
      model: 'openai/gpt-4.1-mini',
      maxTokens: 100,
      temperature: 0,
    }, undefined, {
      onChunk: () => {},
    });

    expect(result.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(firstBody.stream).toBe(true);
    expect(secondBody.stream).toBeUndefined();
  });

  it('keeps existing retry behavior for unrelated server failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValue(new Response(JSON.stringify({
        error: {
          message: 'generic upstream 500',
          type: 'server_error',
          code: 'internal_server_error',
        },
      }), { status: 500 }));
    global.fetch = fetchMock as typeof fetch;

    await expect(callLLM('hello', {
      apiKey: 'gateway-api-key',
      baseUrl: 'https://ai-gateway.atherlabs.com/v1',
      model: 'openai/gpt-4.1-mini',
      maxTokens: 100,
      temperature: 0,
    }, undefined, {
      onChunk: () => {},
    })).rejects.toThrow(/LLM API error \(500\)/);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mock.calls.forEach(([, request]) => {
      const body = JSON.parse(String((request as RequestInit).body));
      expect(body.stream).toBe(true);
    });
  });
});
