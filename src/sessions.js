// Conversation persistence for /resume, --continue and /export.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_DIR } from './config.js';

export const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');

export function newSession(cwd, model) {
  const now = new Date().toISOString();
  return { id: randomUUID().slice(0, 8), cwd, model, created: now, updated: now, title: '', messages: [] };
}

export function saveSession(session) {
  const userMsgs = session.messages.filter((m) => m.role === 'user');
  if (!userMsgs.length) return;
  session.updated = new Date().toISOString();
  session.title ||= userMsgs[0].content.replace(/\s+/g, ' ').slice(0, 80);
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  // Images are large and already on disk; keep only text in the saved transcript.
  const messages = session.messages.slice(1).map(({ images, ...m }) => (images ? { ...m, content: `${m.content}\n[이미지 ${images.length}개]` } : m));
  fs.writeFileSync(path.join(SESSIONS_DIR, `${session.id}.json`), JSON.stringify({ ...session, messages }));
}

/** Newest first; sessions from `cwd` come before others. */
export function listSessions(cwd, limit = 30) {
  let files;
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const sessions = files
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.updated.localeCompare(a.updated));
  const here = sessions.filter((s) => s.cwd === cwd);
  return [...here, ...sessions.filter((s) => s.cwd !== cwd)].slice(0, limit);
}

export function exportMarkdown(messages) {
  const parts = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') parts.push(`## 🧑 사용자\n\n${m.content}`);
    else if (m.role === 'assistant') {
      if (m.content) parts.push(`## 🤖 ollacode\n\n${m.content}`);
      for (const c of m.tool_calls ?? []) parts.push(`> 🔧 \`${c.function.name}\` ${JSON.stringify(c.function.arguments)}`);
    } else if (m.role === 'tool') parts.push(`<details><summary>결과: ${m.tool_name}</summary>\n\n\`\`\`\n${m.content.slice(0, 4000)}\n\`\`\`\n</details>`);
  }
  return parts.join('\n\n') + '\n';
}

export function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
