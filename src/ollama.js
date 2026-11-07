// Minimal Ollama /api/chat client with streaming + tool calling.
import { fetch as undiciFetch, Agent as UndiciAgent } from 'undici';

// Ollama sends response headers only after it has processed the prompt (and after any queued
// request). On a slow CPU that can exceed the default 5-minute headers timeout, so disable it.
const dispatcher = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 });
export const ollamaFetch = (url, init = {}) => undiciFetch(url, { ...init, dispatcher });

export class OllamaError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function* chatStream({ host, model, messages, tools, options, think, keepAlive, signal }) {
  const body = { model, messages, stream: true, options };
  if (tools?.length) body.tools = tools;
  if (think !== undefined) body.think = think;
  if (keepAlive) body.keep_alive = keepAlive;

  let res;
  try {
    res = await ollamaFetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new OllamaError(`Ollama(${host})에 연결할 수 없습니다. 'ollama serve'가 실행 중인지 확인하세요. (${e.cause?.code ?? e.message})`);
  }
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try { msg = JSON.parse(text).error ?? text; } catch {}
    throw new OllamaError(`Ollama ${res.status}: ${msg}`, res.status, msg);
  }

  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const json = JSON.parse(line);
      if (json.error) throw new OllamaError(`Ollama: ${json.error}`, 500, json.error);
      yield json;
    }
  }
}

export async function listModels(host) {
  const res = await ollamaFetch(`${host}/api/tags`);
  if (!res.ok) throw new OllamaError(`Ollama ${res.status}`, res.status);
  const { models } = await res.json();
  return models ?? [];
}

/** Returns the model's capability list (e.g. ["completion","tools","thinking"]), or null if unknown. */
export async function modelCapabilities(host, model) {
  try {
    const res = await ollamaFetch(`${host}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.capabilities ?? null;
  } catch {
    return null;
  }
}
