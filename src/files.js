// File index for @-mentions, and expansion of @path references into message context.
import fs from 'node:fs';
import path from 'node:path';
import { isImagePath } from './images.js';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', 'target', '.cache']);
const MAX_FILES = 8000;

export class FileIndex {
  constructor(cwd) {
    this.cwd = cwd;
    this.files = [];
    this.at = 0;
  }

  list() {
    if (Date.now() - this.at > 15_000) this.scan();
    return this.files;
  }

  scan() {
    const out = [];
    const walk = (dir, depth) => {
      if (out.length >= MAX_FILES || depth > 8) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.ollacode')) continue;
        const rel = path.relative(this.cwd, path.join(dir, e.name)).replaceAll('\\', '/');
        if (e.isDirectory()) { out.push(rel + '/'); walk(path.join(dir, e.name), depth + 1); }
        else out.push(rel);
        if (out.length >= MAX_FILES) return;
      }
    };
    walk(this.cwd, 0);
    this.files = out;
    this.at = Date.now();
  }

  /** Fuzzy-ish match: basename prefix > path substring > subsequence. */
  match(query, limit = 50) {
    const q = query.toLowerCase();
    const scored = [];
    for (const f of this.list()) {
      const lf = f.toLowerCase();
      const base = path.posix.basename(lf.replace(/\/$/, ''));
      let score = 0;
      if (!q) score = 1 / (1 + f.split('/').length);
      else if (base.startsWith(q)) score = 3;
      else if (lf.includes(q)) score = 2;
      else if (isSubsequence(q, lf)) score = 1;
      if (score) scored.push({ f, score: score - f.length / 10000 });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.f);
  }
}

function isSubsequence(q, s) {
  let i = 0;
  for (const c of s) if (c === q[i]) i++;
  return i === q.length;
}

/**
 * Finds @path tokens that exist on disk. Text files and folders are inlined,
 * images are returned separately so they can be sent to a vision model.
 */
export function expandMentions(text, cwd, maxChars = 20000) {
  const blocks = [];
  const images = [];
  for (const m of text.matchAll(/(?:^|\s)@("[^"]+"|\S+)/g)) {
    const ref = m[1].replace(/^"|"$/g, '');
    const abs = path.resolve(cwd, ref);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      const list = fs.readdirSync(abs, { withFileTypes: true }).map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('\n');
      blocks.push(`<directory path="${ref}">\n${list}\n</directory>`);
    } else if (isImagePath(abs)) {
      images.push(abs);
    } else if (st.size <= 2_000_000) {
      let content = fs.readFileSync(abs, 'utf8');
      if (content.includes('\0')) continue;
      if (content.length > maxChars) content = content.slice(0, maxChars) + `\n…[${content.length - maxChars} chars truncated; use read_file for more]`;
      blocks.push(`<file path="${ref}">\n${content}\n</file>`);
    }
  }
  return { blocks, images };
}
