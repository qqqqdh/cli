import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { serverMeta } from './mcpConfig.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.next']);

const resolvePath = (ctx, p) => path.resolve(ctx.cwd, p ?? '.');
const readIfExists = (p) => fs.readFile(p, 'utf8').catch((e) => { if (e.code === 'ENOENT') return null; throw e; });

const MAX_READ_BYTES = 5_000_000;
const MAX_SHELL_OUTPUT = 1_000_000;

/** True when `p` is outside `cwd` (writes there always need the user's confirmation). */
export const isOutside = (cwd, p) => {
  const rel = path.relative(cwd, p);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
};

/** Fails if the file changed after the user was shown the diff, so what runs is what was approved. */
async function checkUnchanged(plan) {
  const now = await readIfExists(plan.path);
  if (now !== plan.before) throw new Error('The file changed after the preview was shown. Read it again and retry.');
}

/** Kills a shell and everything it started (e.g. a dev server launched by the command). */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Built-in tools. `readOnly` tools run without asking for permission.
 * `preview(args)` is the one-line summary shown to the user.
 */
export const builtinTools = [
  {
    name: 'read_file',
    description: 'Read a text file. Returns lines prefixed with line numbers. Use offset/limit for large files.',
    fastDescription: 'Read a file (numbered lines). Use offset/limit.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute or relative to the working directory)' },
        offset: { type: 'integer', description: '1-based line to start from' },
        limit: { type: 'integer', description: 'Max lines to read (default 2000)' },
      },
      required: ['path'],
    },
    readOnly: true,
    preview: (a) => a.path,
    async run(a, ctx) {
      const p = resolvePath(ctx, a.path);
      const st = await fs.stat(p);
      if (st.isDirectory()) throw new Error(`${a.path} is a directory; use list_dir`);
      if (st.size > MAX_READ_BYTES) throw new Error(`File is too large (${st.size} bytes). Use grep or run_shell to look inside it.`);
      const text = await fs.readFile(p, 'utf8');
      if (text.includes('\0')) return `${a.path} looks like a binary file (${st.size} bytes); not shown.`;
      const lines = text.split(/\r?\n/);
      const start = Math.max(1, a.offset ?? 1);
      // Fast mode reads less by default: every line read has to be processed again on later turns.
      const end = Math.min(lines.length, start - 1 + (a.limit ?? (ctx.fast ? 250 : 2000)));
      const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}\t${l}`).join('\n');
      return end < lines.length ? `${body}\n… (${lines.length} lines total; use offset to read more)` : body;
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content. Parent directories are created.',
    fastDescription: 'Create or overwrite a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    edits: true,
    preview: (a) => `${a.path} (${String(a.content ?? '').length} chars)`,
    async plan(a, ctx) {
      const p = resolvePath(ctx, a.path);
      return { path: p, before: await readIfExists(p), after: a.content ?? '' };
    },
    async run(a, ctx) {
      const plan = ctx.plan ?? await this.plan(a, ctx);
      if (ctx.plan) await checkUnchanged(plan);
      const { path: p, before, after } = plan;
      ctx.beforeWrite?.(p, before);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, after);
      return before === null ? `Created ${p}` : `Wrote ${p}`;
    },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact string in a file. old_string must match exactly and be unique unless replace_all is true.',
    fastDescription: 'Replace exact old_string with new_string in a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    edits: true,
    preview: (a) => a.path,
    async plan(a, ctx) {
      const p = resolvePath(ctx, a.path);
      const text = await fs.readFile(p, 'utf8');
      const count = text.split(a.old_string).length - 1;
      if (count === 0) throw new Error('old_string not found in file');
      if (count > 1 && !a.replace_all) throw new Error(`old_string matches ${count} times; add context or set replace_all`);
      const after = a.replace_all ? text.split(a.old_string).join(a.new_string) : text.replace(a.old_string, () => a.new_string);
      return { path: p, before: text, after, count };
    },
    async run(a, ctx) {
      const plan = ctx.plan ?? await this.plan(a, ctx);
      if (ctx.plan) await checkUnchanged(plan);
      const { path: p, before, after, count } = plan;
      ctx.beforeWrite?.(p, before);
      await fs.writeFile(p, after);
      return `Edited ${p} (${a.replace_all ? count : 1} replacement${count > 1 && a.replace_all ? 's' : ''})`;
    },
  },
  {
    name: 'list_dir',
    description: 'List entries of a directory (directories end with /).',
    fastDescription: 'List a directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory (default: working directory)' } },
    },
    readOnly: true,
    preview: (a) => a.path ?? '.',
    async run(a, ctx) {
      const entries = await fs.readdir(resolvePath(ctx, a.path), { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort().join('\n') || '(empty)';
    },
  },
  {
    name: 'glob',
    description: 'Find files by glob pattern, e.g. "src/**/*.ts".',
    skipInFast: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Base directory (default: working directory)' },
      },
      required: ['pattern'],
    },
    readOnly: true,
    preview: (a) => a.pattern,
    async run(a, ctx) {
      const out = [];
      for await (const f of fs.glob(a.pattern, {
        cwd: resolvePath(ctx, a.path),
        exclude: (f) => SKIP_DIRS.has(path.basename(f)),
      })) {
        out.push(f.replaceAll('\\', '/'));
        if (out.length >= 300) break;
      }
      return out.join('\n') || 'No files matched';
    },
  },
  {
    name: 'grep',
    description: 'Search file contents with a JavaScript regular expression. Returns file:line: text.',
    fastDescription: 'Regex search in files. Returns file:line: text.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'File or directory (default: working directory)' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
    },
    readOnly: true,
    preview: (a) => `/${a.pattern}/ in ${a.path ?? '.'}`,
    async run(a, ctx) {
      const re = new RegExp(a.pattern, a.ignore_case ? 'i' : '');
      const root = resolvePath(ctx, a.path);
      const hits = [];
      const seen = new Set(); // real paths of visited directories, so symlink cycles end
      const visit = async (p) => {
        if (hits.length >= 200) return;
        const st = await fs.stat(p).catch(() => null); // broken symlink or no access
        if (!st) return;
        if (st.isDirectory()) {
          const real = await fs.realpath(p);
          if (seen.has(real)) return;
          seen.add(real);
          for (const e of await fs.readdir(p)) if (!SKIP_DIRS.has(e)) await visit(path.join(p, e));
        } else if (st.size < 2_000_000) {
          const text = await fs.readFile(p, 'utf8');
          if (text.includes('\0')) return; // binary
          text.split(/\r?\n/).forEach((line, i) => {
            if (hits.length < 200 && re.test(line)) hits.push(`${path.relative(ctx.cwd, p)}:${i + 1}: ${line.slice(0, 300)}`);
          });
        }
      };
      await visit(root);
      return hits.join('\n') || 'No matches';
    },
  },
  {
    name: 'run_shell',
    fastDescription: process.platform === 'win32' ? 'Run a PowerShell command.' : 'Run a bash command.',
    description: process.platform === 'win32'
      ? 'Run a PowerShell command in the working directory and return stdout/stderr.'
      : 'Run a bash command in the working directory and return stdout/stderr.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'integer', description: 'Default 120000' },
      },
      required: ['command'],
    },
    preview: (a) => a.command,
    run(a, ctx) {
      const [cmd, args] = process.platform === 'win32'
        ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${a.command}`]]
        : ['bash', ['-lc', a.command]];
      const timeout = a.timeout_ms ?? 120_000;
      if (ctx.signal?.aborted) return Promise.resolve('[interrupted by user]');
      return new Promise((resolve) => {
        // Own process group on Unix so a timeout or Ctrl+C can stop the whole tree.
        const child = spawn(cmd, args, { cwd: ctx.cwd, windowsHide: true, detached: process.platform !== 'win32' });
        let out = '', dropped = 0, timedOut = false;
        const collect = (d) => {
          out += d;
          // Keep the start and the end; errors are usually at the end.
          if (out.length > MAX_SHELL_OUTPUT) {
            const half = MAX_SHELL_OUTPUT / 2;
            dropped += out.length - MAX_SHELL_OUTPUT;
            out = out.slice(0, half) + out.slice(-half);
          }
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
        const onAbort = () => killTree(child);
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        const done = (text) => {
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onAbort);
          resolve(text);
        };
        child.on('error', (e) => done(`ERROR: ${e.message}`));
        child.on('close', (code, sig) => {
          let text = out.trim() || '(no output)';
          if (dropped) text += `\n[${dropped} chars of output dropped from the middle]`;
          if (timedOut) text += `\n[timed out after ${timeout} ms; the command and its child processes were stopped]`;
          else if (ctx.signal?.aborted) text += '\n[interrupted by user]';
          else text += `\n[exit code ${code ?? sig}]`;
          done(text);
        });
      });
    },
  },
];

/** Meta tools that give the model access to large MCP catalogs without advertising every schema. */
export function routerTools(mcp) {
  return [
    {
      name: 'mcp_search_tools',
      fastDescription: 'Search MCP tools by keywords.',
      description:
        'Search the tools of the configured MCP servers (e.g. REA reverse-engineering tools) by keywords. ' +
        'Servers start automatically when needed. Call this first to discover a tool, then mcp_get_tool_schema, then mcp_call_tool.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords, e.g. "electron javascript analyze" or "pe imports"' },
          limit: { type: 'integer', description: 'Max results (default 10)' },
        },
        required: ['query'],
      },
      readOnly: true,
      preview: (a) => a.query,
      async run(a) {
        // A server that has never run has no cached tool list yet: start it if the query is about it
        // (or if nothing else matched), so its tools become searchable.
        const terms = String(a.query).toLowerCase().split(/\s+/).filter(Boolean);
        const unseen = mcp.uncatalogued();
        const about = (n) => `${n} ${serverMeta(n, mcp.servers.get(n).config).about}`.toLowerCase();
        let start = unseen.filter((n) => terms.some((t) => about(n).includes(t)));
        if (!start.length && !mcp.search(a.query).length) start = unseen;
        const failed = [];
        await Promise.all(start.map((n) => mcp.ensure(n).catch((e) => failed.push(e.message))));
        const hits = mcp.search(a.query, { limit: a.limit ?? 10 });
        const notes = [...failed, ...mcp.uncatalogued().map((n) => `(server ${n} not started yet: ${serverMeta(n, mcp.servers.get(n).config).about})`)];
        if (!hits.length) return ['No tools matched. Try other keywords.', ...notes].join('\n');
        return [...hits.map((h) => `${h.server}/${h.tool.name}: ${firstSentence(h.tool.description)}`), ...notes].join('\n');
      },
    },
    {
      name: 'mcp_get_tool_schema',
      description: 'Get the full description and JSON input schema of an MCP tool found with mcp_search_tools.',
      fastDescription: 'Get an MCP tool\'s input schema.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Tool name, e.g. "rea/analyze_javascript_application"' } },
        required: ['name'],
      },
      readOnly: true,
      preview: (a) => a.name,
      async run(a) {
        const found = mcp.resolve(a.name);
        if (!found) return `Unknown tool '${a.name}'. Use mcp_search_tools first.`;
        const { tool } = found;
        return JSON.stringify({ name: `${found.server}/${tool.name}`, description: tool.description, inputSchema: tool.inputSchema }, null, 1);
      },
    },
    {
      name: 'mcp_call_tool',
      description: 'Call an MCP tool with arguments that follow its input schema (from mcp_get_tool_schema).',
      fastDescription: 'Call an MCP tool, e.g. name "rea/inspect_go_binary".',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tool name, e.g. "rea/inspect_pe_imports"' },
          arguments: { type: 'object', description: 'Arguments object matching the tool input schema' },
        },
        required: ['name', 'arguments'],
      },
      // Permission is decided per target tool in the agent.
      preview: (a) => `${a.name} ${JSON.stringify(a.arguments ?? {})}`,
      async run(a, ctx) {
        const found = mcp.resolve(a.name);
        if (!found) return `Unknown tool '${a.name}'. Use mcp_search_tools first.`;
        let args = a.arguments ?? {};
        if (typeof args === 'string') args = JSON.parse(args);
        const res = await mcp.call(found.server, found.tool.name, args, ctx.signal);
        return res.text;
      },
    },
  ];
}

function firstSentence(s = '') {
  const t = s.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{20,200}?[.!?])(\s|$)/);
  return m ? m[1] : t.slice(0, 200);
}
