import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CONFIG_DIR } from './config.js';
import { serverMeta, matchesTriggers } from './mcpConfig.js';

const WIN_SHIMS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bunx', 'uvx']);
const CONNECT_TIMEOUT_MS = 180_000; // first `npx` run downloads the package
const CALL_TIMEOUT_MS = 600_000; // reverse-engineering calls can be slow
const CACHE_DIR = path.join(CONFIG_DIR, 'mcp-cache');

/** Identity of a server definition: a changed command/url/env means the cached tool list is stale. */
const defHash = (c) => createHash('sha1').update(JSON.stringify([c.command, c.args, c.url, c.env, c.cwd])).digest('hex').slice(0, 12);

function readCatalog(name, config) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${name}.json`), 'utf8'));
    return c.hash === defHash(config) ? c.tools : null;
  } catch { return null; }
}

function writeCatalog(name, config, tools) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const slim = tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
    fs.writeFileSync(path.join(CACHE_DIR, `${name}.json`), JSON.stringify({ hash: defHash(config), updated: new Date().toISOString(), tools: slim }));
  } catch {}
}

/**
 * MCP servers start lazily: a server is only launched when one of its tools is called, when
 * the user's message mentions it (prefetch), or when it is marked `essential: true`.
 * Tool lists are cached on disk so tools can be searched without launching the server.
 * Status: 'idle' (not running) | 'connecting' | 'connected' | 'failed' | 'disabled'.
 */
export class McpManager {
  constructor({ directToolLimit = 20, maxDirectTools = 30, mcpIdleMinutes = 10 } = {}) {
    this.directToolLimit = directToolLimit;
    this.maxDirectTools = maxDirectTools;
    this.idleMs = mcpIdleMinutes > 0 ? mcpIdleMinutes * 60_000 : 0;
    /** @type {Map<string, {config:any, client?:Client, tools:any[], cached:boolean, status:string, error?:string, stderr:string, promise?:Promise<void>, timer?:any}>} */
    this.servers = new Map();
    this.modes = new Map();
    this.onStatus = () => {};
  }

  /** Registers servers without starting them; `essential` ones are connected right away. */
  registerAll(serverConfigs, onStatus = () => {}) {
    this.onStatus = onStatus;
    const essential = [];
    for (const [name, cfg] of Object.entries(serverConfigs)) {
      this.register(name, cfg);
      if (cfg.essential && !cfg.disabled) essential.push(this.ensure(name).catch(() => {}));
    }
    return Promise.all(essential);
  }

  register(name, config) {
    const old = this.servers.get(name);
    old?.client?.close().catch(() => {});
    clearTimeout(old?.timer);
    const cached = config.disabled ? null : readCatalog(name, config);
    this.servers.set(name, {
      config,
      tools: cached ?? [],
      cached: !!cached,
      status: config.disabled ? 'disabled' : 'idle',
      stderr: '',
    });
    this.computeModes();
  }

  /** Connects every listed server now (used by `mcp add` to verify a new server). */
  async connectAll(serverConfigs, onStatus = () => {}) {
    this.onStatus = onStatus;
    await Promise.all(Object.entries(serverConfigs).map(([name, cfg]) => this.connect(name, cfg)));
  }

  async connect(name, config) {
    this.register(name, config);
    if (config.disabled) return this.onStatus(name, this.servers.get(name));
    await this.ensure(name).catch(() => {});
  }

  /** Starts the server if needed and resolves once it is connected (throws if it fails). */
  ensure(name) {
    const entry = this.servers.get(name);
    if (!entry) return Promise.reject(new Error(`MCP 서버 '${name}'가 설정되어 있지 않습니다.`));
    if (entry.status === 'disabled') return Promise.reject(new Error(`MCP 서버 '${name}'는 비활성화되어 있습니다.`));
    if (entry.status === 'connected') { this.touch(name); return Promise.resolve(); }
    if (entry.status === 'connecting') return entry.promise;
    entry.status = 'connecting';
    entry.error = undefined;
    entry.promise = this.start(name, entry).then(
      () => { this.onStatus(name, entry); },
      (e) => { this.onStatus(name, entry); throw e; },
    );
    return entry.promise;
  }

  /** Background connect, e.g. when the user's message mentions the server. */
  prefetch(name) {
    this.ensure(name).catch(() => {});
  }

  async start(name, entry) {
    const { config } = entry;
    try {
      let transport;
      if (config.url) {
        const opts = { requestInit: { headers: config.headers ?? {} } };
        transport = config.type === 'sse'
          ? new SSEClientTransport(new URL(config.url), opts)
          : new StreamableHTTPClientTransport(new URL(config.url), opts);
      } else {
        let command = config.command;
        if (process.platform === 'win32' && WIN_SHIMS.has(command)) command += '.cmd';
        transport = new StdioClientTransport({
          command,
          args: config.args ?? [],
          env: { ...getDefaultEnvironment(), ...process.env, ...(config.env ?? {}) },
          cwd: config.cwd,
          stderr: 'pipe',
        });
        transport.stderr?.on('data', (d) => {
          entry.stderr = (entry.stderr + d).slice(-8000);
        });
      }
      const client = new Client({ name: 'ollacode', version: '0.4.0' });
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      const tools = [];
      let cursor;
      do {
        const page = await client.listTools({ cursor }, { timeout: CONNECT_TIMEOUT_MS });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      if (this.servers.get(name) !== entry) { await client.close(); return; } // replaced meanwhile
      entry.client = client;
      entry.tools = tools;
      entry.cached = true;
      entry.status = 'connected';
      writeCatalog(name, config, tools);
      this.touch(name);
    } catch (e) {
      entry.status = 'failed';
      entry.error = e.message + (entry.stderr ? `\n${entry.stderr.slice(-1500)}` : '');
      throw new Error(`MCP 서버 '${name}' 연결 실패: ${e.message}`);
    } finally {
      this.computeModes();
    }
  }

  /** Restarts the idle timer; lazy servers are stopped after a quiet period to free memory. */
  touch(name) {
    const entry = this.servers.get(name);
    if (!entry || !this.idleMs || entry.config.essential) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.stop(name), this.idleMs);
    entry.timer.unref?.();
  }

  /** Stops a running server but keeps it registered (and its cached tool list). */
  async stop(name) {
    const entry = this.servers.get(name);
    if (!entry || entry.status !== 'connected') return;
    clearTimeout(entry.timer);
    const client = entry.client;
    entry.client = undefined;
    entry.status = 'idle';
    this.computeModes();
    await client?.close().catch(() => {});
  }

  async disconnect(name) {
    const s = this.servers.get(name);
    if (!s) return;
    clearTimeout(s.timer);
    this.servers.delete(name);
    this.computeModes();
    await s.client?.close().catch(() => {});
  }

  connected() {
    return [...this.servers.entries()].filter(([, s]) => s.status === 'connected');
  }

  /** Servers whose tool list is known (running, or cached from an earlier run). */
  known() {
    return [...this.servers.entries()].filter(([, s]) => s.status !== 'disabled' && s.tools.length);
  }

  enabled() {
    return [...this.servers.entries()].filter(([, s]) => s.status !== 'disabled');
  }

  pending() {
    return [...this.servers.entries()].filter(([, s]) => s.status === 'connecting').map(([n]) => n);
  }

  /** Enabled servers whose trigger words appear in the text. */
  relevantTo(text) {
    return this.enabled().filter(([name, s]) => matchesTriggers(text, serverMeta(name, s.config).triggers)).map(([n]) => n);
  }

  /** Small running servers go direct while the overall direct-tool budget lasts; the rest use the router. */
  computeModes() {
    this.modes.clear();
    let budget = this.maxDirectTools;
    const servers = this.connected().sort((a, b) => a[1].tools.length - b[1].tools.length);
    for (const [name, s] of servers) {
      let mode = s.config.mode ?? 'auto';
      if (mode === 'auto') mode = s.tools.length <= this.directToolLimit && s.tools.length <= budget ? 'direct' : 'router';
      if (mode === 'direct') budget -= s.tools.length;
      this.modes.set(name, mode);
    }
  }

  modeOf(name) {
    return this.modes.get(name) ?? 'router';
  }

  /** Tools to advertise directly to the model as [{server, tool}]. */
  directTools() {
    const out = [];
    for (const [name, s] of this.connected()) {
      const pinned = new Set(s.config.pinnedTools ?? []);
      const direct = this.modeOf(name) === 'direct';
      for (const tool of s.tools) if (direct || pinned.has(tool.name)) out.push({ server: name, tool });
    }
    return out;
  }

  hasRouterServers() {
    return this.enabled().length > 0;
  }

  /** Accepts "tool", "server/tool" or "mcp__server__tool"; searches running and cached servers. */
  resolve(ref) {
    let server, toolName = String(ref).trim();
    const m = toolName.match(/^mcp__(.+?)__(.+)$/) ?? toolName.match(/^([^/]+)\/(.+)$/);
    if (m) [, server, toolName] = m;
    for (const [name, s] of this.known()) {
      if (server && name !== server) continue;
      const tool = s.tools.find((t) => t.name === toolName);
      if (tool) return { server: name, tool };
    }
    return null;
  }

  search(query, { server, limit = 10 } = {}) {
    const terms = String(query).toLowerCase().split(/[\s,_\-/]+/).filter(Boolean);
    const scored = [];
    for (const [name, s] of this.known()) {
      if (server && name !== server) continue;
      for (const tool of s.tools) {
        const tn = tool.name.toLowerCase();
        const desc = (tool.description ?? '').toLowerCase();
        let score = name.toLowerCase() === terms[0] ? 1 : 0;
        for (const t of terms) {
          if (tn === t) score += 10;
          else if (tn.includes(t)) score += 4;
          if (desc.includes(t)) score += 1;
        }
        if (score > 1) scored.push({ score, server: name, tool });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** Enabled servers whose tool list has never been seen (they must be started to be searched). */
  uncatalogued() {
    return this.enabled().filter(([, s]) => !s.tools.length).map(([n]) => n);
  }

  async call(server, toolName, args, signal) {
    await this.ensure(server);
    const s = this.servers.get(server);
    try {
      const result = await s.client.callTool(
        { name: toolName, arguments: args ?? {} },
        undefined,
        { signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
      );
      return formatResult(result);
    } finally {
      this.touch(server);
    }
  }

  async closeAll() {
    for (const [, s] of this.servers) clearTimeout(s.timer);
    await Promise.allSettled(this.connected().map(([, s]) => s.client.close()));
  }
}

function formatResult(result) {
  const parts = [];
  for (const c of result.content ?? []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'resource') parts.push(c.resource?.text ?? `[resource ${c.resource?.uri}]`);
    else if (c.type === 'resource_link') parts.push(`[resource ${c.uri}]`);
    else parts.push(`[${c.type} content omitted]`);
  }
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 1));
  const text = parts.join('\n') || '(empty result)';
  return { text: result.isError ? `ERROR: ${text}` : text, isError: !!result.isError };
}
