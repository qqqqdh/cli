import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatStream, modelCapabilities, OllamaError, ollamaFetch } from './ollama.js';
import { builtinTools, routerTools } from './tools.js';
import { skillTools, parseFrontmatter } from './skills.js';
import { imageTool, describeImages, readImageBase64, noVisionModelMessage } from './images.js';
import { MarkdownStream, ThinkingStream } from './markdown.js';
import { renderDiff } from './diff.js';
import { CONFIG_DIR } from './config.js';
import { serverMeta } from './mcpConfig.js';
import { bold, dim, gray, green, red, yellow, println, truncate, oneLine, spinner } from './ui.js';

/** Drops per-property descriptions to shrink tool schemas in fast mode. */
function slimSchema(schema) {
  if (!schema?.properties) return schema;
  const properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => {
    const { description, ...rest } = v;
    return [k, rest];
  }));
  return { ...schema, properties };
}

const toOllamaTool = (name, description, parameters) => ({
  type: 'function',
  function: { name, description: description ?? '', parameters: parameters ?? { type: 'object', properties: {} } },
});

export const PONYTAIL_LEVELS = ['off', 'lite', 'full', 'ultra'];
export const PERMISSION_MODES = ['ask', 'acceptEdits', 'auto'];
export const USER_MEMORY = path.join(CONFIG_DIR, 'AGENTS.md');

// Sections that may change mid-conversation. Instead of rewriting the system prompt (which throws away
// Ollama's prompt cache), changes are announced in the next user message.
const LIVE_SECTIONS = ['skills', 'notes', 'ponytail'];

export class Agent {
  /**
   * @param {object} o
   * @param {any} o.config
   * @param {import('./mcp.js').McpManager} o.mcp
   * @param {import('./skills.js').SkillRegistry} o.skills
   * @param {string[]} [o.mcpServers]  names of MCP servers this session uses (connected or still connecting)
   * @param {{confirm: (req: {label:string, preview:string, detail:string[]}) => Promise<{allow:boolean, always?:boolean, reason?:string}>}} o.ui
   */
  constructor({ config, mcp, skills, ui, cwd, mcpServers = [] }) {
    this.config = config;
    this.mcp = mcp;
    this.skills = skills;
    this.mcpServers = mcpServers;
    this.ui = ui ?? { confirm: async () => ({ allow: false, reason: 'non-interactive mode' }) };
    this.cwd = cwd;
    this.alwaysAllow = new Set();
    this.capabilities = null;
    this.visionAvailable = false;
    this.stats = { input: 0, output: 0, turns: 0, lastPrompt: null };
    this.undoStack = []; // one entry per user turn: [{path, before}]
    this.pendingContext = [];
    this.warmState = null; // {status: 'warming'|'ready'|'error', started, secs}
    this.warmId = 0;
    this.reset();
  }

  reset() {
    this.snapshot = null;
    this.hinted = new Set();
    this.messages = [{ role: 'system', content: this.systemPrompt() }];
    this.pendingContext = [];
  }

  /** Forget the frozen prompt/tools; the next run or warm() rebuilds them. */
  invalidate() {
    this.snapshot = null;
    this.warmState = null;
  }

  get model() { return this.config.model; }
  get fast() { return !!this.config.fast; }
  get numCtx() { return this.fast ? Math.min(this.config.numCtx, this.config.fastNumCtx ?? 8192) : this.config.numCtx; }
  get maxToolChars() { return this.fast ? (this.config.fastToolResultChars ?? 3000) : this.config.maxToolResultChars; }
  get think() {
    // Thinking makes small CPU-bound models several times slower; fast mode turns it off where possible.
    if (this.fast && this.capabilities?.includes('thinking')) return false;
    return this.config.think;
  }
  chatOptions(extra = {}) {
    return { num_ctx: this.numCtx, temperature: this.config.temperature, ...extra };
  }

  async setModel(model) {
    this.config.model = model;
    this.capabilities = await modelCapabilities(this.config.ollamaHost, model);
    this.invalidate();
  }

  supportsTools() { return !this.capabilities || this.capabilities.includes('tools'); }
  supportsVision() { return !!this.capabilities?.includes('vision'); }

  /** Rough token estimate (~3 chars/token across English, Korean and code). */
  estimateTokens() {
    return Math.round(this.messages.reduce((n, m) => n + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? '').length, 0) / 3);
  }

  contextPercent() {
    return Math.min(100, Math.round((this.estimateTokens() / this.numCtx) * 100));
  }

  lastAssistantText() {
    return [...this.messages].reverse().find((m) => m.role === 'assistant' && m.content)?.content ?? '';
  }

  /** Text (e.g. `!` shell output) to prepend to the next user message. */
  addContext(text) { this.pendingContext.push(text); }

  ponytailRules() {
    const level = this.config.ponytail;
    if (!level || level === 'off') return '';
    const skill = this.skills.get('ponytail');
    if (!skill) return '';
    const { body } = parseFrontmatter(fs.readFileSync(skill.file, 'utf8'));
    return `# Ponytail mode is ACTIVE (level: ${level})\n${body.replace(/^# Ponytail\s*/m, '').trim()}`;
  }

  /**
   * The system prompt as named sections. Everything here must stay stable during a session:
   * MCP servers are listed by name only (not by connection state) so background connects
   * don't change the prompt.
   */
  sections() {
    const fast = this.fast;
    const shell = process.platform === 'win32' ? 'PowerShell' : 'bash';
    const notes = [[USER_MEMORY, 'User memory'], ...['AGENTS.md', 'OLLACODE.md'].map((f) => [path.join(this.cwd, f), `Project instructions (${f})`])]
      .filter(([f]) => fs.existsSync(f))
      .map(([f, title]) => `# ${title}\n${truncate(fs.readFileSync(f, 'utf8'), fast ? 1500 : 6000)}`)
      .join('\n\n');
    const servers = this.mcpServers;
    const s = {};
    if (fast) {
      s.base = `You are ollacode, a CLI coding agent. Work dir: ${this.cwd} (${process.platform}, shell: ${shell}).
Use tools to read files before editing; never guess file contents. Be brief. Reply in the user's language.`;
      s.mcp = servers.length ? `MCP servers (start on first use): ${servers.map((n) => `${n} (${this.serverAbout(n)})`).join(', ')}. Find tools with mcp_search_tools, then mcp_get_tool_schema, then mcp_call_tool.` : '';
      s.skills = this.skillsLine();
      s.rules = '';
    } else {
      s.base = `You are ollacode, an interactive CLI coding and reverse-engineering agent running on a local Ollama model.
You help the user with software engineering and reverse-engineering tasks by calling tools.

# Environment
- Working directory: ${this.cwd}
- Platform: ${process.platform} (${os.release()}); shell tool uses ${shell}
- Date: ${new Date().toISOString().slice(0, 10)}`;
      s.mcp = servers.length ? `# MCP servers
${servers.map((n) => `- ${n}: ${this.serverAbout(n)}`).join('\n')}
Servers start automatically on first use. Discover their tools with mcp_search_tools, read a tool's schema with mcp_get_tool_schema, then call it with mcp_call_tool.${servers.includes('rea') ? `
REA (Reverse Engineer Anything) inspects native binaries, JavaScript/Electron apps, .NET assemblies, APKs,
websites and more without source code. Load the "reverse-engineer" skill before reverse-engineering work.
Pass absolute paths. Report evidence and unknowns REA returns; do not invent findings.` : ''}` : '';
      const core = this.skills.list({ core: true });
      const external = this.skills.list({ core: false }).length;
      s.skills = this.config.skillsInPrompt !== 'full' ? `# Skills\n${this.skillsLine()}` : `# Skills
Skills are expert instructions for specific tasks. When the task matches one, call load_skill first and follow it.
${core.map((k) => `- ${k.name}: ${oneLine(k.description, 160)}`).join('\n') || '- (none)'}${external ? `\n- …plus ${external} more shared from Claude Code / Codex / Antigravity: find them with search_skills.` : ''}`;
      s.rules = `# Rules
- Use tools to inspect files instead of guessing. Read a file before editing it.
- Only when the user refers to an existing image file (screenshot, diagram, photo), look at it with view_image.
- Call a tool only with arguments that match its schema. If a tool fails, read the error and fix the call.
- Keep answers concise and use markdown. Answer in the user's language (Korean if they write Korean).
- Never run destructive shell commands unless the user explicitly asks.`;
    }
    s.notes = notes;
    s.ponytail = this.ponytailRules();
    return s;
  }

  serverAbout(name) {
    return serverMeta(name, this.config.mcpServers?.[name] ?? {}).about || 'MCP server';
  }

  /** One line with skill names only; details are loaded on demand with load_skill. */
  skillsLine() {
    const names = this.skills.list({ core: true }).map((s) => s.name).filter((n) => !n.startsWith('ponytail-'));
    const external = this.skills.list({ core: false }).length;
    return `Skills (expert instructions; call load_skill with the name before such a task): ${names.join(', ')}.` +
      (external ? ` ${external} more can be found with ${this.fast ? 'load_skill on a topic' : 'search_skills'}.` : '');
  }

  /**
   * Per-message hints: skills whose trigger phrases appear in the message, and MCP servers it
   * mentions (which are started in the background so they're ready when the model calls them).
   * Each hint is given once per conversation.
   */
  hintsFor(text) {
    if (!this.supportsTools()) return [];
    const hints = [];
    for (const s of this.skills.suggest(text)) {
      if (this.hinted.has(`skill:${s.name}`)) continue;
      this.hinted.add(`skill:${s.name}`);
      hints.push(`The "${s.name}" skill fits this request: call load_skill("${s.name}") first.`);
    }
    for (const name of this.mcp.relevantTo(text)) {
      if (!this.mcpServers.includes(name)) continue;
      this.mcp.prefetch(name);
      if (this.hinted.has(`mcp:${name}`)) continue;
      this.hinted.add(`mcp:${name}`);
      hints.push(`MCP server "${name}" (${this.serverAbout(name)}) is relevant: find its tools with mcp_search_tools.`);
    }
    return hints;
  }

  systemPrompt(sections = this.sections()) {
    return Object.values(sections).filter(Boolean).join('\n\n');
  }

  buildTools() {
    if (!this.supportsTools()) return { defs: [], handlers: new Map() };
    const fast = this.fast;
    const handlers = new Map();
    const defs = [];
    const add = (kind, t) => {
      handlers.set(t.name, { kind, tool: t });
      defs.push(toOllamaTool(t.name, fast ? (t.fastDescription ?? t.description) : t.description, fast ? slimSchema(t.parameters) : t.parameters));
    };
    for (const t of builtinTools) if (!fast || !t.skipInFast) add('builtin', t);
    if (this.visionAvailable && !fast) add('builtin', imageTool(this.config));
    for (const t of skillTools(this.skills)) if (!fast || t.name === 'load_skill') add('builtin', t);
    if (this.mcpServers.length) for (const t of routerTools(this.mcp)) add('router', t);
    if (!fast) {
      for (const { server, tool } of this.mcp.directTools()) {
        const name = `mcp__${server}__${tool.name}`;
        handlers.set(name, { kind: 'mcp', server, tool });
        defs.push(toOllamaTool(name, tool.description, tool.inputSchema));
      }
    }
    return { defs, handlers };
  }

  /** Builds and freezes the system prompt and tool list for cache-friendly reuse. */
  freeze() {
    const sections = this.sections();
    this.snapshot = { sections, tools: this.buildTools() };
    this.messages[0] = { role: 'system', content: this.systemPrompt(sections) };
    return this.snapshot;
  }

  /** Keeps the frozen prompt; returns a note about sections that changed since (or null). */
  liveUpdates() {
    if (!this.snapshot) { this.freeze(); return null; }
    const now = this.sections();
    const changed = LIVE_SECTIONS.filter((k) => now[k] !== this.snapshot.sections[k]);
    if (!changed.length) return null;
    if (this.messages.length <= 1) { this.freeze(); return null; } // nothing cached worth keeping
    this.snapshot.sections = { ...this.snapshot.sections, ...Object.fromEntries(changed.map((k) => [k, now[k]])) };
    return `<system-update>\n${changed.map((k) => now[k] || (k === 'ponytail' ? 'Ponytail mode is now OFF. Ignore its earlier rules.' : `(${k} cleared)`)).join('\n\n')}\n</system-update>`;
  }

  /**
   * Pre-processes the current prompt in the background so the first real request hits
   * Ollama's prompt cache instead of re-reading the system prompt and tool schemas.
   */
  async warm() {
    if (!this.snapshot) this.freeze();
    const id = ++this.warmId;
    const started = Date.now();
    this.warmState = { status: 'warming', started };
    try {
      const res = await ollamaFetch(`${this.config.ollamaHost}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          keep_alive: this.config.keepAlive,
          think: this.think,
          tools: this.snapshot.tools.defs.length ? this.snapshot.tools.defs : undefined,
          messages: [...this.messages, { role: 'user', content: '.' }],
          options: this.chatOptions({ num_predict: 1 }),
        }),
      });
      const json = await res.json();
      if (id !== this.warmId) return;
      this.warmState = res.ok
        ? { status: 'ready', secs: (Date.now() - started) / 1000, tokens: json.prompt_eval_count, at: Date.now() }
        : { status: 'error', error: json.error };
    } catch (e) {
      if (id === this.warmId) this.warmState = { status: 'error', error: e.message };
    }
  }

  /**
   * Keep the conversation inside the context window. Trims well below the limit in one go,
   * because every edit to older messages invalidates the prompt cache from that point on.
   */
  compactHistory() {
    const budget = this.numCtx * 3;
    const size = () => this.messages.reduce((n, m) => n + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? '').length, 0);
    if (size() <= budget) return;
    const target = budget * 0.6;
    for (let i = 1; i < this.messages.length - 4 && size() > target; i++) {
      const m = this.messages[i];
      if (m.role === 'tool' && m.content.length > 300) m.content = m.content.slice(0, 300) + '\n…[older tool output trimmed]';
    }
    while (size() > target && this.messages.length > 6) this.messages.splice(1, 1);
  }

  /** Builds the user message, attaching images natively or via a vision model's description. */
  async buildUserMessage(text, images, signal) {
    const hints = this.hintsFor(text);
    const parts = [...this.pendingContext.splice(0), text];
    if (hints.length) parts.push(`<hint>\n${hints.join('\n')}\n</hint>`);
    const msg = { role: 'user', content: parts.join('\n\n') };
    if (!images?.length) return msg;
    if (this.supportsVision()) {
      msg.images = images.map(readImageBase64);
      msg.content += `\n\n[첨부 이미지: ${images.map((p) => path.basename(p)).join(', ')}]`;
      return msg;
    }
    const spin = spinner(`이미지 ${images.length}개 읽는 중`);
    try {
      const { model, text: desc } = await describeImages({ config: this.config, files: images, signal,
        prompt: `The user attached ${images.length > 1 ? 'these images' : 'this image'} with the message: "${text.slice(0, 500)}". Describe what is relevant in detail and transcribe all visible text exactly.` });
      spin.stop();
      println(gray(`  ⎿ ${model}(으)로 이미지 ${images.length}개를 읽었습니다`));
      msg.content += `\n\n<attached_images files="${images.map((p) => path.basename(p)).join(', ')}" described_by="${model}">\n${desc}\n</attached_images>`;
    } catch (e) {
      spin.stop();
      println(yellow(`⚠ ${e.message}`));
      msg.content += `\n\n[The user attached images (${images.join(', ')}) but they could not be read: ${e.message}]`;
    }
    return msg;
  }

  async run(userText, signal, { images } = {}) {
    const update = this.liveUpdates();
    if (update) this.pendingContext.unshift(update);
    this.messages.push(await this.buildUserMessage(userText, images, signal));
    this.undoStack.push([]);
    const { defs, handlers } = this.snapshot.tools;
    let tools = defs;

    for (let turn = 0; turn < this.config.maxTurns; turn++) {
      this.compactHistory();
      let content = '', toolCalls = [], stats;
      const md = new MarkdownStream();
      const think = new ThinkingStream();
      let spin = spinner(`${this.model} 생각 중`);
      const stopSpin = () => { spin?.stop(); spin = null; };
      try {
        for await (const chunk of chatStream({
          host: this.config.ollamaHost,
          model: this.model,
          messages: this.messages,
          tools,
          think: this.think,
          keepAlive: this.config.keepAlive,
          options: this.chatOptions(),
          signal,
        })) {
          const msg = chunk.message ?? {};
          if (msg.thinking && this.config.showThinking !== false) { stopSpin(); think.push(msg.thinking); }
          if (msg.content) {
            stopSpin();
            if (think.started && !md.started) { think.end(); println(); }
            md.push(msg.content);
            content += msg.content;
          }
          if (msg.tool_calls?.length) toolCalls.push(...msg.tool_calls);
          if (chunk.done) stats = chunk;
        }
      } catch (e) {
        stopSpin();
        md.end();
        if (e.name === 'AbortError') {
          println(yellow('  ⎿ 중단됨'));
          this.messages.push({ role: 'assistant', content: content || '(interrupted by user)' });
          return;
        }
        if (e instanceof OllamaError && /does not support tools/i.test(e.body ?? '') && tools.length) {
          println(yellow(`⚠ ${this.model}은(는) 도구 호출을 지원하지 않습니다. 도구 없이 대화합니다.`));
          this.capabilities = (this.capabilities ?? ['completion']).filter((c) => c !== 'tools');
          tools = [];
          turn--;
          continue;
        }
        if (e instanceof OllamaError && /does not support thinking/i.test(e.body ?? '') && this.config.think !== undefined) {
          println(yellow(`⚠ ${this.model}은(는) thinking을 지원하지 않습니다. 끕니다.`));
          this.config.think = undefined;
          turn--;
          continue;
        }
        if (turn === 0) this.messages.pop(); // drop the user message so the history stays valid
        throw e;
      }
      stopSpin();
      if (!md.started) think.end();
      md.end();

      if (stats) {
        this.stats.input += stats.prompt_eval_count ?? 0;
        this.stats.output += stats.eval_count ?? 0;
        this.stats.lastTps = stats.eval_duration ? stats.eval_count / (stats.eval_duration / 1e9) : null;
        this.stats.lastPrompt = { tokens: stats.prompt_eval_count ?? 0, secs: (stats.prompt_eval_duration ?? 0) / 1e9 };
      }

      const assistant = { role: 'assistant', content };
      if (toolCalls.length) assistant.tool_calls = toolCalls;
      this.messages.push(assistant);

      if (!toolCalls.length) {
        this.stats.turns++;
        if (stats?.eval_count && this.config.showStats !== false) {
          const p = this.stats.lastPrompt;
          println(dim(`  ${stats.eval_count} tokens · ${this.stats.lastTps?.toFixed(1) ?? '?'} tok/s · 프롬프트 ${p.tokens.toLocaleString()} tok ${p.secs.toFixed(1)}s · ctx ${this.contextPercent()}%`));
        }
        return;
      }

      for (const call of toolCalls) {
        if (signal.aborted) return;
        const name = call.function?.name;
        let args = call.function?.arguments ?? {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        const result = await this.executeTool(name, args, handlers, signal);
        this.messages.push({ role: 'tool', tool_name: name, content: truncate(result, this.maxToolChars) });
      }
    }
    println(yellow(`⚠ 최대 턴 수(${this.config.maxTurns})에 도달했습니다.`));
  }

  async executeTool(name, args, handlers, signal) {
    const h = handlers.get(name);
    if (!h) return `ERROR: unknown tool '${name}'. Available: ${[...handlers.keys()].join(', ')}`;

    // Decide what we're really about to run (router calls are judged by their target tool).
    let label = name, preview, readOnly, edits = false;
    if (h.kind === 'mcp') {
      preview = JSON.stringify(args);
      readOnly = h.tool.annotations?.readOnlyHint === true;
    } else if (h.tool.name === 'mcp_call_tool') {
      const target = this.mcp.resolve(args.name);
      label = target ? `${target.server}/${target.tool.name}` : String(args.name);
      preview = JSON.stringify(args.arguments ?? {});
      readOnly = target?.tool.annotations?.readOnlyHint === true;
    } else {
      preview = h.tool.preview?.(args) ?? JSON.stringify(args);
      readOnly = !!h.tool.readOnly;
      edits = !!h.tool.edits;
    }

    println(`${green('⏺')} ${bold(label)}${gray('(')}${oneLine(preview, 140)}${gray(')')}`);

    // File edits: compute the change first so the user can see the diff.
    let diff = null;
    if (edits) {
      try {
        const plan = await h.tool.plan(args, { cwd: this.cwd });
        diff = renderDiff(plan.before ?? '', plan.after, { maxLines: Math.max(8, (process.stdout.rows || 40) - 14) });
        if (plan.before === null) diff.created = true;
      } catch (e) {
        println(red(`  ⎿ 오류: ${oneLine(e.message, 200)}`));
        return `ERROR: ${e.message}`;
      }
    }

    const mode = this.config.permissionMode;
    const auto = readOnly || mode === 'auto' || (mode === 'acceptEdits' && edits) || this.alwaysAllow.has(label);
    if (!auto) {
      const detail = diff ? diff.lines.map((l) => `    ${l}`) : [];
      const answer = await this.ui.confirm({ label, preview, detail, edits });
      if (answer.always) this.alwaysAllow.add(label);
      if (!answer.allow) {
        println(red('  ⎿ 거부됨') + (answer.reason ? gray(` — ${answer.reason}`) : ''));
        return `The user denied this tool call.${answer.reason ? ` Their instruction: ${answer.reason}` : ''} Do not retry it unchanged.`;
      }
    }

    const spin = spinner(`${label} 실행 중`);
    try {
      let out;
      const ctx = {
        cwd: this.cwd,
        signal,
        fast: this.fast,
        beforeWrite: (p, before) => this.undoStack.at(-1)?.push({ path: p, before }),
      };
      if (h.kind === 'mcp') out = (await this.mcp.call(h.server, h.tool.name, args, signal)).text;
      else out = await h.tool.run(args, ctx);
      spin.stop();
      if (diff) {
        println(gray(`  ⎿ ${diff.created ? '새 파일' : '수정'} ${green(`+${diff.added}`)} ${red(`-${diff.removed}`)}`));
        if (auto) for (const l of diff.lines.slice(0, 16)) println(`    ${l}`);
      } else {
        println(gray(`  ⎿ ${oneLine(out, 140)}${out.length > 140 ? ` (${out.length} chars)` : ''}`));
      }
      return out;
    } catch (e) {
      spin.stop();
      const msg = e.name === 'AbortError' ? 'Interrupted by user' : e.message;
      println(red(`  ⎿ 오류: ${oneLine(msg, 200)}`));
      return `ERROR: ${msg}`;
    }
  }

  /** Restores the files changed during the most recent turn that changed files. */
  undo() {
    while (this.undoStack.length && !this.undoStack.at(-1).length) this.undoStack.pop();
    const changes = this.undoStack.pop();
    if (!changes) return [];
    const restored = [];
    for (const { path: p, before } of [...changes].reverse()) {
      if (before === null) fs.rmSync(p, { force: true });
      else fs.writeFileSync(p, before);
      restored.push(p);
    }
    this.addContext(`[The user reverted your file changes to: ${[...new Set(restored)].join(', ')}]`);
    return [...new Set(restored)];
  }

  /** Summarize the conversation into one message to free context. */
  async compact(signal, focus = '') {
    if (this.messages.length < 3) return null;
    const transcript = this.messages.slice(1).map((m) =>
      `${m.role.toUpperCase()}${m.tool_name ? `(${m.tool_name})` : ''}: ${truncate(m.content, 3000)}${m.tool_calls ? ` [called ${m.tool_calls.map((c) => c.function.name).join(', ')}]` : ''}`).join('\n\n');
    const spin = spinner('대화 요약 중');
    let summary = '';
    try {
      for await (const chunk of chatStream({
        host: this.config.ollamaHost,
        model: this.model,
        keepAlive: this.config.keepAlive,
        options: this.chatOptions({ temperature: 0.1 }),
        signal,
        messages: [
          { role: 'system', content: 'You summarize coding-agent conversations so the work can continue with less context.' },
          { role: 'user', content: `Summarize this conversation for continuing the work. Keep: the user's goals and requests, decisions made, files read or changed (with paths), important findings and errors, and what remains to do. Use concise bullet points in the user's language.${focus ? ` Focus on: ${focus}` : ''}\n\n${truncate(transcript, this.numCtx * 2)}` },
        ],
      })) summary += chunk.message?.content ?? '';
    } finally {
      spin.stop();
    }
    const before = this.estimateTokens();
    this.snapshot = null;
    this.messages = [
      this.messages[0],
      { role: 'user', content: `[이전 대화 요약]\n${summary}` },
      { role: 'assistant', content: '요약을 확인했습니다. 이어서 진행하겠습니다.' },
    ];
    return { summary, before, after: this.estimateTokens() };
  }
}
