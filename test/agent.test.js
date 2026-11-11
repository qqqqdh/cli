import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeAgent } from './helpers.js';
import { truncateMiddle } from '../src/agent.js';

// The test runner talks to this process over stdout (as binary data), so only drop the agent's text output.
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => (typeof chunk === 'string' ? true : write(chunk, ...rest));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ollacode-test-'));

test('compactHistory drops whole exchanges and keeps the current one', (t) => {
  const agent = makeAgent({ cwd: tmp(), config: { numCtx: 1000 } });
  const big = 'x'.repeat(1500);
  for (let i = 0; i < 4; i++) {
    agent.messages.push(
      { role: 'user', content: `q${i}` },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: {} } }] },
      { role: 'tool', tool_name: 'read_file', content: big },
      { role: 'assistant', content: big },
    );
  }
  agent.compactHistory();
  const m = agent.messages;
  assert.equal(m[0].role, 'system');
  assert.equal(m[1].role, 'user', 'history starts with a user message');
  assert.equal(m.at(-4).content, 'q3', 'current exchange kept');
  m.forEach((msg, i) => {
    if (msg.role === 'tool') assert.ok(m.slice(0, i).some((p) => p.tool_calls), 'tool result has its call');
  });
});

test('truncateMiddle keeps the start and the end', () => {
  const out = truncateMiddle('A'.repeat(100) + 'END', 50);
  assert.ok(out.startsWith('AAA'));
  assert.ok(out.endsWith('END'));
});

test('writes outside the working directory ask even in auto mode', async (t) => {
  const cwd = tmp();
  let asked = 0;
  const agent = makeAgent({ cwd, config: { permissionMode: 'auto' }, confirm: async () => { asked++; return { allow: false }; } });
  const { handlers } = agent.buildTools();
  const outsideFile = path.join(tmp(), 'x.txt');
  const res = await agent.executeTool('write_file', { path: outsideFile, content: 'hi' }, handlers, new AbortController().signal);
  assert.equal(asked, 1);
  assert.match(res, /denied/);
  assert.equal(fs.existsSync(outsideFile), false);

  await agent.executeTool('write_file', { path: 'inside.txt', content: 'hi' }, handlers, new AbortController().signal);
  assert.equal(asked, 1, 'inside writes still follow the mode');
  assert.equal(fs.readFileSync(path.join(cwd, 'inside.txt'), 'utf8'), 'hi');
});

test('an edit is refused if the file changed after the diff was shown', async (t) => {
  const cwd = tmp();
  const file = path.join(cwd, 'a.txt');
  fs.writeFileSync(file, 'one');
  const agent = makeAgent({ cwd, confirm: async () => { fs.writeFileSync(file, 'changed meanwhile'); return { allow: true }; } });
  const { handlers } = agent.buildTools();
  const res = await agent.executeTool('edit_file', { path: 'a.txt', old_string: 'one', new_string: 'two' }, handlers, new AbortController().signal);
  assert.match(res, /changed after the preview/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'changed meanwhile');
});

/** Fake Ollama that always asks for the same tool call, then answers once it sees a skipped call. */
function fakeOllama() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const { messages } = JSON.parse(body);
      const skipped = messages.some((m) => m.role === 'tool' && m.content.startsWith('Not run'));
      const message = skipped
        ? { role: 'assistant', content: 'done' }
        : { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_dir', arguments: {} } }] };
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message, done: true }) + '\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('the loop stops repeating an identical tool call', async (t) => {
  const server = await fakeOllama();
  t.after(() => server.close());
  const agent = makeAgent({ cwd: tmp(), config: { ollamaHost: `http://127.0.0.1:${server.address().port}` } });
  await agent.run('list files', new AbortController().signal);
  const tools = agent.messages.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 3);
  assert.match(tools[2].content, /^Not run: you already called list_dir/);
  assert.equal(agent.messages.at(-1).content, 'done');
});

test('interrupting during tool calls leaves a result for every call', async (t) => {
  const agent = makeAgent({ cwd: tmp() });
  const calls = [{ function: { name: 'list_dir', arguments: {} } }, { function: { name: 'list_dir', arguments: { path: '.' } } }];
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: calls }, done: true }) + '\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  agent.config.ollamaHost = `http://127.0.0.1:${server.address().port}`;
  const live = new AbortController();
  // Abort right after the model's reply arrives, before tools run.
  const orig = agent.executeTool.bind(agent);
  agent.executeTool = async (...a) => { live.abort(); return orig(...a); };
  await agent.run('go', live.signal);
  const last = agent.messages.slice(-2);
  assert.equal(last.length, 2);
  assert.ok(last.every((m) => m.role === 'tool'));
  assert.match(last[1].content, /interrupted/);
});

test('compact keeps the conversation when the summary is empty', async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200); res.end(JSON.stringify({ message: { content: '' }, done: true }) + '\n'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const agent = makeAgent({ cwd: tmp(), config: { ollamaHost: `http://127.0.0.1:${server.address().port}` } });
  agent.messages.push({ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' });
  await assert.rejects(agent.compact(new AbortController().signal), /빈 요약/);
  assert.equal(agent.messages.length, 3);
});
