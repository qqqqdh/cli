import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinTools, isOutside } from '../src/tools.js';

const tool = (n) => builtinTools.find((t) => t.name === n);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ollacode-test-'));

test('grep ends on symlink cycles', { skip: process.platform === 'win32' }, async () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, 'a'));
  fs.writeFileSync(path.join(cwd, 'a', 'f.txt'), 'needle');
  fs.symlinkSync(cwd, path.join(cwd, 'a', 'loop'));
  fs.symlinkSync(path.join(cwd, 'missing'), path.join(cwd, 'broken'));
  const out = await tool('grep').run({ pattern: 'needle' }, { cwd });
  assert.equal(out.trim().split('\n').length, 1);
});

test('read_file refuses binary files', async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'b.bin'), Buffer.from([1, 0, 2]));
  assert.match(await tool('read_file').run({ path: 'b.bin' }, { cwd }), /binary/);
});

test('run_shell timeout stops child processes and says so', { skip: process.platform === 'win32' }, async () => {
  const cwd = tmp();
  const marker = path.join(cwd, 'late');
  const out = await tool('run_shell').run({ command: `(sleep 1; touch ${marker}) & sleep 5`, timeout_ms: 300 }, { cwd });
  assert.match(out, /timed out after 300 ms/);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(fs.existsSync(marker), false, 'background child was killed');
});

test('run_shell reports the exit code', { skip: process.platform === 'win32' }, async () => {
  assert.match(await tool('run_shell').run({ command: 'exit 3' }, { cwd: tmp() }), /exit code 3/);
});

test('isOutside', () => {
  const cwd = path.resolve('/w/proj');
  assert.equal(isOutside(cwd, path.join(cwd, 'a/b')), false);
  assert.equal(isOutside(cwd, path.resolve('/w/other')), true);
  assert.equal(isOutside(cwd, path.join(cwd, '..x')), false);
});
