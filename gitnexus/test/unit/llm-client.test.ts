import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadCLIConfig = vi.fn();

vi.mock('../../src/storage/repo-manager.js', () => ({
  loadCLIConfig,
}));

import { callLLM, resolveLLMConfig } from '../../src/core/wiki/llm-client.js';

describe('llm-client', () => {
  const originalFetch = global.fetch;
  const originalCredential = process.env.AI_GATEWAY_CREDENTIAL;
  const originalGroup = process.env.AI_GATEWAY_GROUP;

  beforeEach(() => {
    loadCLIConfig.mockReset();
    loadCLIConfig.mockResolvedValue({});
    process.env.AI_GATEWAY_CREDENTIAL = originalCredential;
    process.env.AI_GATEWAY_GROUP = originalGroup;
    global.fetch = vi.fn() as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalCredential === undefined) delete process.env.AI_GATEWAY_CREDENTIAL;
    else process.env.AI_GATEWAY_CREDENTIAL = originalCredential;
    if (originalGroup === undefined) delete process.env.AI_GATEWAY_GROUP;
    else process.env.AI_GATEWAY_GROUP = originalGroup;
  });

  it('normalizes the Ather base URL and forwards gateway headers', async () => {
    process.env.AI_GATEWAY_CREDENTIAL = 'cred';
    process.env.AI_GATEWAY_GROUP = 'group';

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }),
      text: async () => '',
      headers: new Headers(),
    });

    const config = await resolveLLMConfig({
      apiKey: 'key',
      baseUrl: 'https://ai-gateway.atherlabs.com',
      model: 'gpt-5.4-mini',
    });

    expect(config.baseUrl).toBe('https://ai-gateway.atherlabs.com/v1');
    expect(config.extraHeaders).toEqual({
      'X-AI-Gateway-Credential': 'cred',
      'X-AI-Gateway-Group': 'group',
    });

    await callLLM('hello', config);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://ai-gateway.atherlabs.com/v1/chat/completions');
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      'X-AI-Gateway-Credential': 'cred',
      'X-AI-Gateway-Group': 'group',
    });
  });

  it('uses non-stream mode for the Ather gateway in auto mode', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }),
      text: async () => '',
      headers: new Headers(),
    });

    await callLLM(
      'hello',
      {
        apiKey: 'key',
        baseUrl: 'https://ai-gateway.atherlabs.com/v1',
        model: 'gpt-5.4-mini',
        maxTokens: 100,
        temperature: 0,
        streamingMode: 'auto',
      },
      undefined,
      { onChunk: vi.fn() },
    );

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(requestBody.stream).toBeUndefined();
  });

  it('retries once without streaming after a stream failure', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        headers: new Headers(),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'fallback ok' } }], usage: {} }),
        text: async () => '',
        headers: new Headers(),
      });

    const result = await callLLM(
      'hello',
      {
        apiKey: 'key',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-5.4-mini',
        maxTokens: 100,
        temperature: 0,
        streamingMode: 'auto',
      },
      undefined,
      { onChunk: vi.fn() },
    );

    expect(result.content).toBe('fallback ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string);
    expect(firstBody.stream).toBe(true);
    expect(secondBody.stream).toBeUndefined();
  });
});
