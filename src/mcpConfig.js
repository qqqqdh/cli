// Adding, removing and importing MCP server definitions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { readJson, updateConfigFile } from './config.js';

// `about` is shown to the model; `triggers` are words in a user message that make ollacode
// connect the server ahead of time (servers start lazily, on first use).
export const PRESETS = {
  rea: {
    description: 'REA 리버스 엔지니어링 (바이너리, Electron/JS, .NET, APK, 웹)',
    about: 'reverse engineering of binaries, Electron/JS apps, .NET, APK, Go, firmware, web pages',
    triggers: ['리버스', '역공학', '디컴파일', '디스어셈', '바이너리', 'reverse engineer', 'decompil', 'disassembl', 'binary', '.exe', '.dll', '.apk', '.asar', '.elf', '.wasm', 'electron', 'apk', 'reverse-engineer'],
    def: { command: 'npx', args: ['-y', 'rea-agents', 'mcp'], env: { REA_MCP_OUTPUT_SCHEMA_PROFILE: 'off' } },
  },
  filesystem: {
    description: '지정 폴더 파일 읽기/쓰기/검색 (기본: 현재 폴더)',
    about: 'file access in allowed folders',
    triggers: [],
    def: (cwd) => ({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', cwd] }),
  },
  memory: {
    description: '지식 그래프 기반 장기 기억',
    about: 'long-term memory as a knowledge graph',
    triggers: ['기억해', '기억나', 'remember', 'memory'],
    def: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  },
  'sequential-thinking': {
    description: '단계별 사고 도구',
    about: 'step-by-step thinking scratchpad',
    triggers: ['단계별', 'step by step'],
    def: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
  },
  playwright: {
    description: '브라우저 자동화 (Playwright)',
    about: 'browser automation: open pages, click, fill forms, screenshots',
    triggers: ['브라우저', '웹페이지', '웹사이트', '사이트', 'browser', 'website', 'web page', 'http://', 'https://', 'playwright'],
    def: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  },
  'chrome-devtools': {
    description: 'Chrome DevTools 제어/디버깅',
    about: 'control and debug Chrome via DevTools',
    triggers: ['크롬', 'chrome', 'devtools', '콘솔 로그'],
    def: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
  },
  context7: {
    description: '라이브러리 최신 문서 검색 (Context7)',
    about: 'up-to-date documentation for libraries and frameworks',
    triggers: ['문서', '공식 문서', 'docs', 'documentation', 'api reference', 'context7'],
    def: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  },
  everything: {
    description: 'MCP 테스트용 레퍼런스 서버',
    about: 'MCP reference/test server',
    triggers: [],
    def: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] },
  },
};

/** True when the text contains one of the trigger words (ASCII words must start at a word boundary). */
export function matchesTriggers(text, triggers) {
  const s = text.toLowerCase();
  return triggers.some((w) => {
    if (!/^[a-z0-9]/.test(w)) return s.includes(w);
    const i = s.indexOf(w);
    return i >= 0 && (i === 0 || !/[a-z0-9]/.test(s[i - 1]));
  });
}

/** Description and trigger words for a server: its own config first, then the matching preset. */
export function serverMeta(name, cfg = {}) {
  const p = PRESETS[name];
  return {
    about: cfg.about ?? cfg.description ?? p?.about ?? '',
    triggers: (cfg.triggers ?? p?.triggers ?? [name]).map((w) => w.toLowerCase()),
  };
}

export function presetDef(name, cwd) {
  const p = PRESETS[name];
  if (!p) return null;
  return structuredClone(typeof p.def === 'function' ? p.def(cwd) : p.def);
}

export function addServer(name, def, scope, cwd) {
  return updateConfigFile(scope, cwd, (c) => {
    c.mcpServers ??= {};
    c.mcpServers[name] = def;
  });
}

export function removeServer(name, scope, cwd) {
  return updateConfigFile(scope, cwd, (c) => {
    c.mcpServers ??= {};
    // A null entry also hides a server that comes from defaults or another layer.
    c.mcpServers[name] = null;
  });
}

export function setServerDisabled(name, disabled, def, scope, cwd) {
  return updateConfigFile(scope, cwd, (c) => {
    c.mcpServers ??= {};
    c.mcpServers[name] = { ...(c.mcpServers[name] ?? def), disabled };
  });
}

/**
 * Parses `add` arguments:
 *   <name> [-s user|project] [-e KEY=VAL]... [-H "Key: Val"]... [--transport http|sse] [--url URL | -- <command> [args...]]
 *   <name> <command> [args...]
 *   <preset>
 */
export function parseAddArgs(argv, cwd) {
  const args = [...argv];
  const name = args.shift();
  if (!name) throw new Error('사용법: mcp add <이름> [-s user|project] [-e KEY=VAL] [--url URL | -- <명령> [인자...]]');
  let scope = 'user', url, transport;
  const env = {}, headers = {};
  const rest = [];
  while (args.length) {
    const a = args.shift();
    if (a === '--') { rest.push(...args.splice(0)); break; }
    if (a === '-s' || a === '--scope') scope = args.shift();
    else if (a === '-e' || a === '--env') {
      const [k, ...v] = args.shift().split('=');
      env[k] = v.join('=');
    } else if (a === '-H' || a === '--header') {
      const [k, ...v] = args.shift().split(':');
      headers[k.trim()] = v.join(':').trim();
    } else if (a === '--url') url = args.shift();
    else if (a === '-t' || a === '--transport') transport = args.shift();
    else { rest.push(a, ...args.splice(0)); break; }
  }
  if (!['user', 'project'].includes(scope)) throw new Error(`scope는 user 또는 project 여야 합니다: ${scope}`);
  if (!url && /^https?:\/\//.test(rest[0] ?? '')) url = rest.shift();

  let def;
  if (url) def = { url, ...(transport === 'sse' ? { type: 'sse' } : {}), ...(Object.keys(headers).length ? { headers } : {}) };
  else if (rest.length) def = { command: rest[0], args: rest.slice(1) };
  else {
    def = presetDef(name, cwd);
    if (!def) throw new Error(`'${name}'은(는) 프리셋이 아닙니다. 명령이나 --url 을 지정하세요. 프리셋: ${Object.keys(PRESETS).join(', ')}`);
  }
  if (Object.keys(env).length) def.env = { ...(def.env ?? {}), ...env };
  return { name, def, scope };
}

// ---------- importing from other agents ----------

const home = os.homedir();
const norm = (p) => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

function fromJsonServers(servers = {}) {
  const out = {};
  for (const [name, s] of Object.entries(servers ?? {})) {
    if (!s || typeof s !== 'object') continue;
    const url = s.url ?? s.serverUrl ?? s.httpUrl;
    if (url) {
      out[name] = { url, ...(s.type === 'sse' ? { type: 'sse' } : {}), ...(s.headers ? { headers: s.headers } : {}) };
    } else if (s.command) {
      out[name] = { command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}), ...(s.cwd ? { cwd: s.cwd } : {}) };
    } else continue;
    if (s.disabled || s.enabled === false) out[name].disabled = true;
  }
  return out;
}

export const IMPORT_SOURCES = {
  claude: {
    label: 'Claude Code',
    read(cwd) {
      const j = readJson(path.join(home, '.claude.json')) ?? {};
      const project = Object.entries(j.projects ?? {}).find(([p]) => norm(p) === norm(cwd))?.[1];
      return {
        ...fromJsonServers(j.mcpServers),
        ...fromJsonServers(project?.mcpServers),
        ...fromJsonServers(readJson(path.join(cwd, '.mcp.json'))?.mcpServers),
      };
    },
  },
  codex: {
    label: 'Codex',
    read() {
      let toml;
      try { toml = parseToml(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')); } catch { return {}; }
      const out = {};
      for (const [name, s] of Object.entries(toml.mcp_servers ?? {})) {
        if (s.url) out[name] = { url: s.url, ...(s.http_headers ? { headers: s.http_headers } : {}) };
        else if (s.command) out[name] = { command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}), ...(s.cwd ? { cwd: s.cwd } : {}) };
        else continue;
        if (s.enabled === false) out[name].disabled = true;
      }
      return out;
    },
  },
  agy: {
    label: 'Antigravity / Gemini CLI',
    read(cwd) {
      return Object.assign(
        {},
        ...[
          path.join(home, '.gemini', 'settings.json'),
          path.join(home, '.gemini', 'config', 'mcp_config.json'),
          path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
          path.join(home, '.gemini', 'antigravity-cli', 'mcp_config.json'),
          path.join(cwd, '.gemini', 'settings.json'),
        ].map((f) => fromJsonServers(readJson(f)?.mcpServers)),
      );
    },
  },
};

/** Returns {source: {name: def}} for the requested sources ('all' = every source). */
export function discoverImports(which, cwd) {
  const keys = which === 'all' || !which ? Object.keys(IMPORT_SOURCES) : [which];
  const out = {};
  for (const k of keys) {
    if (!IMPORT_SOURCES[k]) throw new Error(`알 수 없는 소스: ${k} (claude, codex, agy, all)`);
    out[k] = IMPORT_SOURCES[k].read(cwd);
  }
  return out;
}
