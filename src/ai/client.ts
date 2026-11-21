import crypto from 'node:crypto';
import type { AIConfig, ChatMessage, ChatToolCall, ToolSchema } from './types.js';

const CLIENT_NAME = 'nexus-cli';
const CLIENT_VERSION = '1.0.1';

function generateSessionId(): string {
  return `ses_${crypto.randomBytes(16).toString('hex')}`;
}

export interface ChatResponse {
  content: string;
  toolCalls: ChatToolCall[];
  finishReason: string;
  usage?: Record<string, unknown>;
}

export type ChatRole = ChatMessage['role'];

function trimBase(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function baseRoot(baseUrl: string): string {
  const clean = trimBase(baseUrl);
  const chatIndex = clean.indexOf('/chat/completions');
  const root = chatIndex >= 0 ? clean.slice(0, chatIndex) : clean;
  return root.replace(/\/v1$/, '');
}

export function chatEndpoint(baseUrl: string): string {
  const clean = trimBase(baseUrl);
  if (clean === '') return 'http://localhost:11434/v1/chat/completions';
  if (/\/chat\/completions$/.test(clean)) return clean;
  if (/\/v1$/.test(clean)) return `${clean}/chat/completions`;
  if (/\/api\/chat$/i.test(clean)) return clean.replace(/\/api\/chat$/i, '/v1/chat/completions');
  if (/\/api\/generate$/i.test(clean)) return clean.replace(/\/api\/generate$/i, '/v1/chat/completions');
  if (/\/api$/i.test(clean)) return clean.replace(/\/api$/i, '/v1/chat/completions');
  return `${clean}/v1/chat/completions`;
}

export function modelsEndpoint(baseUrl: string): string {
  const endpoint = chatEndpoint(baseUrl);
  return endpoint.replace(/\/chat\/completions$/, '/models');
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') parts.push(part);
      else if (part && typeof part === 'object') {
        const record = part as Record<string, unknown>;
        if (typeof record.text === 'string') parts.push(record.text);
      }
    }
    return parts.join('');
  }
  return content === null || content === undefined ? '' : String(content);
}

function parseToolCalls(message: Record<string, unknown>): ChatToolCall[] {
  const raw = message.tool_calls;
  if (Array.isArray(raw)) {
    const calls: ChatToolCall[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const fn = record.function;
      if (!fn || typeof fn !== 'object') continue;
      const fnRecord = fn as Record<string, unknown>;
      const name = typeof fnRecord.name === 'string' ? fnRecord.name : '';
      if (name === '') continue;
      const rawArgs = fnRecord.arguments;
      calls.push({
        id: typeof record.id === 'string' ? record.id : `call_${calls.length}_${Date.now()}`,
        type: 'function',
        function: {
          name,
          arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {}),
        },
      });
    }
    return calls;
  }
  const legacy = message.function_call;
  if (legacy && typeof legacy === 'object') {
    const record = legacy as Record<string, unknown>;
    if (typeof record.name === 'string') {
      return [{
        id: `call_legacy_${Date.now()}`,
        type: 'function',
        function: {
          name: record.name,
          arguments: typeof record.arguments === 'string' ? record.arguments : JSON.stringify(record.arguments ?? {}),
        },
      }];
    }
  }
  return [];
}

function combineSignals(a: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  const onAbort = () => controller.abort(a?.reason);
  if (a) {
    if (a.aborted) controller.abort(a.reason);
    else a.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      if (a) a.removeEventListener('abort', onAbort);
    },
  };
}

export class AIClient {
  private sessionId = generateSessionId();

  constructor(private readonly config: AIConfig) {}

  newSession(): string {
    this.sessionId = generateSessionId();
    return this.sessionId;
  }

  get session(): string {
    return this.sessionId;
  }

  get endpoint(): string {
    return chatEndpoint(this.config.baseUrl);
  }

  get model(): string {
    return this.config.model;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const { signal: combined, dispose } = combineSignals(signal, 15000);
    try {
      const response = await fetch(modelsEndpoint(this.config.baseUrl), {
        headers: this.headers(),
        signal: combined,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const body = await response.json() as Record<string, unknown>;
      const data = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
      const names: string[] = [];
      for (const entry of data) {
        if (typeof entry === 'string') names.push(entry);
        else if (entry && typeof entry === 'object') {
          const record = entry as Record<string, unknown>;
          if (typeof record.id === 'string') names.push(record.id);
          else if (typeof record.name === 'string') names.push(record.name);
        }
      }
      return names;
    } finally {
      dispose();
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': `${CLIENT_NAME}/${CLIENT_VERSION}`,
      'x-opencode-client': CLIENT_NAME,
      'x-opencode-session': this.sessionId,
      'x-session-id': this.sessionId,
      'x-client-request-id': `${this.sessionId}:${Date.now()}`,
    };
    const extra = this.config.extraHeaders ?? {};
    for (const [key, value] of Object.entries(extra)) {
      if (key.toLowerCase() === 'authorization') continue;
      headers[key] = value;
    }
    const hasSession = Object.keys(headers).some((key) => key.toLowerCase() === 'x-opencode-session');
    if (!hasSession) headers['x-opencode-session'] = this.sessionId;
    if (this.config.apiKey.trim() !== '') headers.Authorization = `Bearer ${this.config.apiKey.trim()}`;
    return headers;
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolSchema[] = [],
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    if (!this.config.initialized) throw new Error('AI is not configured. Run /agent to set it up.');
    if (this.config.baseUrl.trim() === '') throw new Error('AI endpoint URL is empty.');
    const { signal: combined, dispose } = combineSignals(signal, 10 * 60 * 1000);
    try {
      const payload: Record<string, unknown> = {
        model: this.config.model,
        messages,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        stream: false,
      };
      if (tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = 'auto';
      }
      const response = await fetch(chatEndpoint(this.config.baseUrl), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: combined,
      });
      const raw = await response.text();
      if (!response.ok) {
        const detail = raw.length > 800 ? raw.slice(0, 800) + '…' : raw;
        throw new Error(`AI request failed (HTTP ${response.status}): ${detail.trim() || response.statusText}`);
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new Error(`AI endpoint returned non-JSON data: ${raw.slice(0, 400)}`);
      }
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const choice = (choices[0] ?? {}) as Record<string, unknown>;
      const message = (choice.message ?? {}) as Record<string, unknown>;
      const content = textFromContent(message.content).trim();
      const toolCalls = parseToolCalls(message);
      if (content === '' && toolCalls.length === 0) {
        throw new Error('The model returned an empty response. Check the model name and endpoint.');
      }
      return {
        content,
        toolCalls,
        finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : '',
        usage: body.usage && typeof body.usage === 'object' ? body.usage as Record<string, unknown> : undefined,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(signal?.aborted ? 'Request cancelled.' : 'AI request timed out.');
      }
      throw error;
    } finally {
      dispose();
    }
  }

  async generateImage(prompt: string, outputPath: string, signal?: AbortSignal): Promise<string> {
    if (this.config.imageModel.trim() === '') {
      throw new Error('No image model configured. Set one with /ai image <model>.');
    }
    const endpoint = `${baseRoot(this.config.baseUrl)}/v1/images/generations`;
    const { signal: combined, dispose } = combineSignals(signal, 5 * 60 * 1000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.config.imageModel,
          prompt,
          n: 1,
          size: '1024x1024',
          response_format: 'b64_json',
        }),
        signal: combined,
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`Image request failed (HTTP ${response.status}): ${raw.slice(0, 500)}`);
      const body = JSON.parse(raw) as Record<string, unknown>;
      const data = Array.isArray(body.data) ? body.data : [];
      const first = (data[0] ?? {}) as Record<string, unknown>;
      const fs = await import('node:fs');
      const fsp = await import('node:fs/promises');
      const path = await import('node:path');
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      if (typeof first.b64_json === 'string') {
        fs.writeFileSync(outputPath, Buffer.from(first.b64_json, 'base64'));
        return outputPath;
      }
      if (typeof first.url === 'string') {
        const image = await fetch(first.url, { signal: combined });
        if (!image.ok) throw new Error(`Could not download generated image (HTTP ${image.status}).`);
        const bytes = Buffer.from(await image.arrayBuffer());
        fs.writeFileSync(outputPath, bytes);
        return outputPath;
      }
      throw new Error('Image endpoint returned no image data.');
    } finally {
      dispose();
    }
  }
}
