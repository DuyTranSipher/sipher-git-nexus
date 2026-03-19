/**
 * LLM Client for Wiki Generation
 * 
 * OpenAI-compatible API client using native fetch.
 * Supports OpenAI, Azure, LiteLLM, Ollama, and any OpenAI-compatible endpoint.
 * 
 * Config priority: CLI flags > env vars > defaults
 */

export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  extraHeaders?: Record<string, string>;
  streamingMode?: 'auto' | 'on' | 'off';
}

export interface LLMResponse {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
}

const ATHER_GATEWAY_HOST = 'ai-gateway.atherlabs.com';

export function normalizeLLMBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    if (url.hostname === ATHER_GATEWAY_HOST && (!url.pathname || url.pathname === '/')) {
      url.pathname = '/v1';
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    if (/^https:\/\/ai-gateway\.atherlabs\.com\/?$/i.test(trimmed)) {
      return 'https://ai-gateway.atherlabs.com/v1';
    }
    return trimmed;
  }
}

export function resolveGatewayExtraHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};

  if (env.AI_GATEWAY_CREDENTIAL) {
    headers['X-AI-Gateway-Credential'] = env.AI_GATEWAY_CREDENTIAL;
  }
  if (env.AI_GATEWAY_GROUP) {
    headers['X-AI-Gateway-Group'] = env.AI_GATEWAY_GROUP;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function isAtherGatewayBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(normalizeLLMBaseUrl(baseUrl)).hostname === ATHER_GATEWAY_HOST;
  } catch {
    return normalizeLLMBaseUrl(baseUrl).includes(ATHER_GATEWAY_HOST);
  }
}

export function shouldUseStreaming(
  config: Pick<LLMConfig, 'baseUrl' | 'streamingMode'>,
  options?: CallLLMOptions,
): boolean {
  if (!options?.onChunk) return false;
  if (config.streamingMode === 'on') return true;
  if (config.streamingMode === 'off') return false;
  return !isAtherGatewayBaseUrl(config.baseUrl);
}

function shouldFallbackToNonStreaming(status?: number, errorText?: string): boolean {
  const message = `${status ?? ''} ${errorText ?? ''}`.toLowerCase();
  return message.includes('empty_stream')
    || message.includes('stream disconnected')
    || message.includes('stream closed')
    || message.includes('response.completed')
    || message.includes('empty streaming response')
    || message.includes('upstream stream closed');
}

/**
 * Resolve LLM configuration from env vars, saved config, and optional overrides.
 * Priority: overrides (CLI flags) > env vars > ~/.gitnexus/config.json > error
 * 
 * If no API key is found, returns config with empty apiKey (caller should handle).
 */
export async function resolveLLMConfig(overrides?: Partial<LLMConfig>): Promise<LLMConfig> {
  const { loadCLIConfig } = await import('../../storage/repo-manager.js');
  const savedConfig = await loadCLIConfig();

  const apiKey = overrides?.apiKey
    || process.env.GITNEXUS_API_KEY
    || process.env.OPENAI_API_KEY
    || savedConfig.apiKey
    || '';

  return {
    apiKey,
    baseUrl: normalizeLLMBaseUrl(
      overrides?.baseUrl
      || process.env.GITNEXUS_LLM_BASE_URL
      || savedConfig.baseUrl
      || 'https://openrouter.ai/api/v1',
    ),
    model: overrides?.model
      || process.env.GITNEXUS_MODEL
      || savedConfig.model
      || 'minimax/minimax-m2.5',
    maxTokens: overrides?.maxTokens ?? 16_384,
    temperature: overrides?.temperature ?? 0,
    extraHeaders: overrides?.extraHeaders ?? resolveGatewayExtraHeaders(),
    streamingMode: overrides?.streamingMode ?? 'auto',
  };
}

/**
 * Estimate token count from text (rough heuristic: ~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface CallLLMOptions {
  onChunk?: (charsReceived: number) => void;
}

/**
 * Call an OpenAI-compatible LLM API.
 * Uses streaming when onChunk callback is provided for real-time progress.
 * Retries up to 3 times on transient failures (429, 5xx, network errors).
 */
export async function callLLM(
  prompt: string,
  config: LLMConfig,
  systemPrompt?: string,
  options?: CallLLMOptions,
): Promise<LLMResponse> {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const normalizedBaseUrl = normalizeLLMBaseUrl(config.baseUrl);
  const url = `${normalizedBaseUrl.replace(/\/+$/, '')}/chat/completions`;
  let useStream = shouldUseStreaming(
    { baseUrl: normalizedBaseUrl, streamingMode: config.streamingMode },
    options,
  );
  let streamFallbackTried = false;

  const baseBody: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
  };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
    ...(config.extraHeaders ?? {}),
  };

  const MAX_RETRIES = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const body: Record<string, unknown> = { ...baseBody };
      if (useStream) body.stream = true;

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown error');

        if (useStream && !streamFallbackTried && shouldFallbackToNonStreaming(response.status, errorText)) {
          useStream = false;
          streamFallbackTried = true;
          continue;
        }

        // Rate limit — wait with exponential backoff and retry
        if (response.status === 429 && attempt < MAX_RETRIES - 1) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
          const delay = retryAfter > 0 ? retryAfter * 1000 : (2 ** attempt) * 3000;
          await sleep(delay);
          continue;
        }

        // Server error — retry with backoff
        if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
          await sleep((attempt + 1) * 2000);
          continue;
        }

        throw new Error(`LLM API error (${response.status}): ${errorText.slice(0, 500)}`);
      }

      // Streaming path
      if (useStream && response.body) {
        try {
          return await readSSEStream(response.body, options!.onChunk!);
        } catch (err: any) {
          lastError = err;
          if (!streamFallbackTried && shouldFallbackToNonStreaming(undefined, err?.message)) {
            useStream = false;
            streamFallbackTried = true;
            continue;
          }
          throw err;
        }
      }

      // Non-streaming path
      const json = await response.json() as any;
      const choice = json.choices?.[0];
      if (!choice?.message?.content) {
        throw new Error('LLM returned empty response');
      }

      return {
        content: choice.message.content,
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
      };
    } catch (err: any) {
      lastError = err;

      if (useStream && !streamFallbackTried && shouldFallbackToNonStreaming(undefined, err?.message)) {
        useStream = false;
        streamFallbackTried = true;
        continue;
      }

      // Network error — retry with backoff
      if (attempt < MAX_RETRIES - 1 && (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.message?.includes('fetch'))) {
        await sleep((attempt + 1) * 3000);
        continue;
      }

      throw err;
    }
  }

  throw lastError || new Error('LLM call failed after retries');
}

/**
 * Read an SSE stream from an OpenAI-compatible streaming response.
 */
async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (charsReceived: number) => void,
): Promise<LLMResponse> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let content = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
          onChunk(content.length);
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  if (!content) {
    throw new Error('LLM returned empty streaming response');
  }

  return { content };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
