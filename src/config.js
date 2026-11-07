import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = path.join(os.homedir(), '.ollacode');
export const USER_CONFIG = path.join(CONFIG_DIR, 'config.json');
export const USER_SKILLS = path.join(CONFIG_DIR, 'skills');
export const HISTORY_FILE = path.join(CONFIG_DIR, 'history');
export const projectConfigPath = (cwd) => path.join(cwd, '.ollacode', 'config.json');

export const DEFAULT_CONFIG = {
  model: 'llama3.1:8b',
  ollamaHost: process.env.OLLAMA_HOST
    ? normalizeHost(process.env.OLLAMA_HOST)
    : 'http://127.0.0.1:11434',
  // Ollama defaults to a small context window; tool-using agents need more.
  numCtx: 16384,
  temperature: 0.2,
  keepAlive: '30m',
  maxTurns: 30,
  maxToolResultChars: 12000,
  // An MCP server with more tools than directToolLimit, or one that would push the
  // total past maxDirectTools, is exposed through the search/describe/call router.
  directToolLimit: 20,
  maxDirectTools: 30,
  permissionMode: 'ask', // 'ask' | 'auto'
  ponytail: 'off', // 'off' | 'lite' | 'full' | 'ultra'
  // Speed (low-end hardware)
  fast: false, // short prompt, core tools only, smaller context
  fastNumCtx: 8192,
  fastToolResultChars: 3000,
  warmup: true, // pre-process the prompt in the background so the first request hits the cache
  // Lazy loading: MCP servers start on first use (or `essential: true` to start with the session)
  // and stop after this many idle minutes (0 = never). Skills are listed by name only.
  mcpIdleMinutes: 10,
  skillsInPrompt: 'names', // 'names' | 'full'
  // Skill folders shared with other agents. Searchable via search_skills / /skills.
  externalSkillDirs: [
    '~/.claude/skills',
    '~/.codex/skills',
    '~/.gemini/skills',
    '~/.agents/skills',
  ],
  mcpServers: {
    rea: {
      command: 'npx',
      args: ['-y', 'rea-agents', 'mcp'],
      env: {
        REA_MCP_OUTPUT_SCHEMA_PROFILE: 'off',
      },
      mode: 'auto', // 'auto' | 'direct' | 'router'
      pinnedTools: [],
    },
  },
};

function normalizeHost(h) {
  if (!/^https?:\/\//.test(h)) h = `http://${h}`;
  return h.replace(/\/+$/, '').replace('0.0.0.0', '127.0.0.1');
}

export const expandHome = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir());

export function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    return text.trim() ? JSON.parse(text) : null;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`설정 파일을 읽지 못했습니다: ${file}: ${e.message}`);
    return null;
  }
}

/**
 * Merge order: defaults < ~/.ollacode/config.json < <cwd>/.ollacode/config.json.
 * `mcpServers` is merged per server name; set a server to null to remove it.
 */
export function loadConfig(cwd) {
  if (!fs.existsSync(USER_CONFIG)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(USER_CONFIG, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
  const layers = [readJson(USER_CONFIG), readJson(projectConfigPath(cwd))];
  const config = structuredClone(DEFAULT_CONFIG);
  for (const layer of layers) {
    if (!layer) continue;
    const { mcpServers, ...rest } = layer;
    Object.assign(config, rest);
    if (mcpServers) {
      for (const [name, srv] of Object.entries(mcpServers)) {
        if (srv === null) delete config.mcpServers[name];
        else config.mcpServers[name] = srv;
      }
    }
  }
  config.ollamaHost = normalizeHost(config.ollamaHost);
  return config;
}

/** Read-modify-write a config file. scope: 'user' | 'project'. */
export function updateConfigFile(scope, cwd, mutate) {
  const file = scope === 'project' ? projectConfigPath(cwd) : USER_CONFIG;
  const current = readJson(file) ?? {};
  mutate(current);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(current, null, 2));
  return file;
}

export function saveUserConfigPatch(patch) {
  updateConfigFile('user', null, (c) => Object.assign(c, patch));
}
