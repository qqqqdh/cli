import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_SKILLS, expandHome } from './config.js';

export const BUNDLED_SKILLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');

/**
 * Parses the YAML frontmatter subset used by SKILL.md files
 * (Claude Code / Codex / Antigravity): `key: value` and folded `key: >` / `|` blocks.
 */
export function parseFrontmatter(text) {
  const m = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let [, key, value] = kv;
    if (/^[>|][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      value = value.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else {
      value = value.trim().replace(/^(['"])(.*)\1$/, '$2');
    }
    meta[key] = value;
  }
  return { meta, body: m[2] };
}

export class SkillRegistry {
  /** @param {{cwd: string, externalDirs?: string[]}} o */
  constructor({ cwd, externalDirs = [] }) {
    this.cwd = cwd;
    this.externalDirs = externalDirs;
    this.reload();
  }

  /** Earlier sources win on name clashes. `core` skills are listed in the system prompt. */
  sources() {
    return [
      { dir: path.join(this.cwd, '.ollacode', 'skills'), source: 'project', core: true },
      { dir: USER_SKILLS, source: 'user', core: true },
      { dir: BUNDLED_SKILLS, source: 'builtin', core: true },
      { dir: path.join(this.cwd, '.claude', 'skills'), source: 'project', core: true },
      { dir: path.join(this.cwd, '.agents', 'skills'), source: 'project', core: true },
      ...this.externalDirs.map((d) => ({ dir: expandHome(d), source: labelFor(d), core: false })),
    ];
  }

  reload() {
    /** @type {Map<string, {name, description, argumentHint, dir, file, source, core}>} */
    this.skills = new Map();
    for (const src of this.sources()) {
      for (const file of findSkillFiles(src.dir, 4)) {
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        const { meta } = parseFrontmatter(text);
        const name = meta.name || path.basename(path.dirname(file));
        if (this.skills.has(name)) continue;
        this.skills.set(name, {
          name,
          description: meta.description ?? '',
          argumentHint: meta['argument-hint'] ?? '',
          dir: path.dirname(file),
          file,
          source: src.source,
          core: src.core,
        });
      }
    }
  }

  get(name) {
    return this.skills.get(String(name).replace(/^\//, '').trim());
  }

  list({ core } = {}) {
    return [...this.skills.values()].filter((s) => core === undefined || s.core === core);
  }

  search(query, limit = 10) {
    const terms = String(query).toLowerCase().split(/[\s,_\-/]+/).filter(Boolean);
    return this.list()
      .map((s) => {
        const n = s.name.toLowerCase(), d = s.description.toLowerCase();
        let score = 0;
        for (const t of terms) score += (n === t ? 10 : n.includes(t) ? 4 : 0) + (d.includes(t) ? 1 : 0);
        return { s, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.s);
  }

  /**
   * Skills whose trigger phrases appear in the text. Trigger phrases are the quoted examples
   * in a skill's description (e.g. Use for "commit", "커밋해줘"). Only core skills are suggested.
   */
  suggest(text, limit = 2) {
    const s = text.toLowerCase();
    return this.list({ core: true })
      .map((skill) => {
        const phrases = [...skill.description.matchAll(/["“]([^"”]{2,40})["”]/g)]
          .map((m) => m[1].toLowerCase().trim())
          .filter((p) => !p.startsWith('/') && p.length >= 2);
        const hits = phrases.filter((p) => s.includes(p)).length;
        return { skill, hits };
      })
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, limit)
      .map((x) => x.skill);
  }

  /** Full instructions for the model, with $ARGUMENTS substituted. */
  render(skill, args = '') {
    const { body } = parseFrontmatter(fs.readFileSync(skill.file, 'utf8'));
    const text = body.includes('$ARGUMENTS') ? body.replaceAll('$ARGUMENTS', args) : body;
    return `<skill name="${skill.name}" dir="${skill.dir}">\n` +
      `(Files referenced by this skill are relative to ${skill.dir}; read them with read_file when needed.)\n\n` +
      `${text.trim()}\n</skill>`;
  }
}

function labelFor(dir) {
  if (dir.includes('.claude')) return 'claude';
  if (dir.includes('.codex')) return 'codex';
  if (dir.includes('.gemini')) return 'agy';
  return 'external';
}

function findSkillFiles(dir, depth) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) return [path.join(dir, 'SKILL.md')];
  if (depth === 0) return out;
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') out.push(...findSkillFiles(path.join(dir, e.name), depth - 1));
  }
  return out;
}

/** Tools that let the model discover and load skills on its own. */
export function skillTools(registry) {
  return [
    {
      name: 'search_skills',
      description: 'Search available skills (reusable expert instructions, including ones shared from Claude Code, Codex and Antigravity) by keywords.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      readOnly: true,
      preview: (a) => a.query,
      async run(a) {
        const hits = registry.search(a.query);
        return hits.length
          ? hits.map((s) => `${s.name} [${s.source}]: ${s.description.slice(0, 200)}`).join('\n')
          : 'No skills matched.';
      },
    },
    {
      name: 'load_skill',
      description: 'Load the full instructions of a skill by name. Do this before a task the skill covers, then follow the instructions.',
      fastDescription: 'Load skill instructions by name or topic (e.g. commit, debug, code-review, reverse-engineer, image-reader).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          arguments: { type: 'string', description: 'Optional arguments for the skill' },
        },
        required: ['name'],
      },
      readOnly: true,
      preview: (a) => a.name,
      async run(a) {
        const skill = registry.get(a.name);
        if (!skill) {
          const hits = registry.search(a.name, 5);
          return hits.length
            ? `Unknown skill '${a.name}'. Closest matches: ${hits.map((h) => `${h.name} (${h.description.slice(0, 80)})`).join('; ')}. Call load_skill again with one of these names.`
            : `Unknown skill '${a.name}'. No similar skills found.`;
        }
        return registry.render(skill, a.arguments ?? '');
      },
    },
  ];
}
