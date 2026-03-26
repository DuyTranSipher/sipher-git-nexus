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
  gatewayApiKey?: string;
  gatewayCredential?: string;
  gatewayGroup?: string;
}

export interface LLMResponse {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
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
    || process.env.AI_GATEWAY_API_KEY
    || savedConfig.apiKey
    || '';

  return {
    apiKey,
    baseUrl: overrides?.baseUrl
      || process.env.GITNEXUS_LLM_BASE_URL
      || savedConfig.baseUrl
      || 'https://openrouter.ai/api/v1',
    model: overrides?.model
      || process.env.GITNEXUS_MODEL
      || savedConfig.model
      || 'minimax/minimax-m2.5',
    maxTokens: overrides?.maxTokens ?? 16_384,
    temperature: overrides?.temperature ?? 0,
    gatewayApiKey: overrides?.gatewayApiKey || process.env.AI_GATEWAY_API_KEY || '',
    gatewayCredential: overrides?.gatewayCredential || process.env.AI_GATEWAY_CREDENTIAL || '',
    gatewayGroup: overrides?.gatewayGroup || process.env.AI_GATEWAY_GROUP || '',
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

function isGatewayStreamStartFailure(status: number, errorText: string): boolean {
  if (status < 500) return false;
  const normalized = errorText.toLowerCase();
  return normalized.includes('empty_stream')
    || normalized.includes('upstream stream closed before first payload');
}

/**
 * Detect whether a base URL points to the Anthropic Messages API.
 */
function isAnthropicAPI(baseUrl: string): boolean {
  return /anthropic\.com/i.test(baseUrl);
}

/**
 * Resolve the API key for Anthropic, preferring Anthropic-specific sources.
 * Priority: ANTHROPIC_API_KEY env > saved config key (if Anthropic-shaped) > config.apiKey
 */
async function resolveAnthropicApiKey(configApiKey: string): Promise<string> {
  // 1. Dedicated Anthropic env var
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  // 2. If the resolved key looks like an Anthropic key, use it
  if (configApiKey.startsWith('sk-ant-')) return configApiKey;

  // 3. Fall back to saved config key (may differ from resolved key when env vars override)
  const { loadCLIConfig } = await import('../../storage/repo-manager.js');
  const saved = await loadCLIConfig();
  if (saved.apiKey?.startsWith('sk-ant-')) return saved.apiKey;

  // 4. Use whatever was resolved
  return configApiKey;
}

/**
 * Call the Anthropic Messages API (/v1/messages).
 * Handles both streaming and non-streaming modes.
 */
async function callAnthropicLLM(
  prompt: string,
  config: LLMConfig,
  systemPrompt?: string,
  options?: CallLLMOptions,
): Promise<LLMResponse> {
  const apiKey = await resolveAnthropicApiKey(config.apiKey);
  const url = `${config.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const useStream = !!options?.onChunk;

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    messages: [{ role: 'user', content: prompt }],
  };
  if (systemPrompt) {
    body.system = systemPrompt;
  }
  if (useStream) {
    body.stream = true;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };

  const MAX_RETRIES = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown error');

        if (response.status === 429 && attempt < MAX_RETRIES - 1) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
          const delay = retryAfter > 0 ? retryAfter * 1000 : (2 ** attempt) * 3000;
          await sleep(delay);
          continue;
        }

        if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
          await sleep((attempt + 1) * 2000);
          continue;
        }

        throw new Error(`LLM API error (${response.status}): ${errorText.slice(0, 500)}`);
      }

      if (useStream && response.body) {
        return await readAnthropicSSEStream(response.body, options!.onChunk!);
      }

      const json = await response.json() as any;
      const text = json.content?.find((b: any) => b.type === 'text')?.text;
      if (!text) {
        throw new Error('LLM returned empty response');
      }

      return {
        content: text,
        promptTokens: json.usage?.input_tokens,
        completionTokens: json.usage?.output_tokens,
      };
    } catch (err: any) {
      lastError = err;

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
 * Read an SSE stream from the Anthropic Messages API.
 * Anthropic uses event types: content_block_delta with delta.text.
 */
async function readAnthropicSSEStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (charsReceived: number) => void,
): Promise<LLMResponse> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let content = '';
  let buffer = '';
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

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
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          content += parsed.delta.text;
          onChunk(content.length);
        } else if (parsed.type === 'message_delta' && parsed.usage) {
          completionTokens = parsed.usage.output_tokens;
        } else if (parsed.type === 'message_start' && parsed.message?.usage) {
          promptTokens = parsed.message.usage.input_tokens;
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  if (!content) {
    throw new Error('LLM returned empty streaming response');
  }

  return { content, promptTokens, completionTokens };
}

/**
 * Call an OpenAI-compatible LLM API.
 * Uses streaming when onChunk callback is provided for real-time progress.
 * Retries up to 3 times on transient failures (429, 5xx, network errors).
 *
 * Automatically detects Anthropic API URLs and routes to the Messages API.
 */
export async function callLLM(
  prompt: string,
  config: LLMConfig,
  systemPrompt?: string,
  options?: CallLLMOptions,
): Promise<LLMResponse> {
  // Route to Anthropic Messages API when baseUrl points to anthropic.com
  if (isAnthropicAPI(config.baseUrl)) {
    return callAnthropicLLM(prompt, config, systemPrompt, options);
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const useStream = !!options?.onChunk;

  const baseBody: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
  };

  const MAX_RETRIES = 3;
  let lastError: Error | null = null;
  let preferStream = useStream;
  let streamFallbackUsed = false;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
  };
  if (config.gatewayApiKey) headers.AI_GATEWAY_API_KEY = config.gatewayApiKey;
  if (config.gatewayCredential) headers.AI_GATEWAY_CREDENTIAL = config.gatewayCredential;
  if (config.gatewayGroup) headers.AI_GATEWAY_GROUP = config.gatewayGroup;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(preferStream ? { ...baseBody, stream: true } : baseBody),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown error');

        if (preferStream && !streamFallbackUsed && isGatewayStreamStartFailure(response.status, errorText)) {
          streamFallbackUsed = true;
          preferStream = false;
          attempt--;
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
      if (preferStream && response.body) {
        return await readSSEStream(response.body, options!.onChunk!);
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
