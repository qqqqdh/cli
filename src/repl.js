import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { CONFIG_DIR, USER_CONFIG, USER_SKILLS, saveUserConfigPatch } from './config.js';
import { listModels } from './ollama.js';
import { PONYTAIL_LEVELS, PERMISSION_MODES, USER_MEMORY } from './agent.js';
import { runMcpCommand, splitArgs, MCP_HELP } from './mcpCommands.js';
import { IMPORT_SOURCES, PRESETS } from './mcpConfig.js';
import { Editor } from './editor.js';
import { FileIndex, expandMentions } from './files.js';
import { clipboardImage, isImagePath, findVisionModel, noVisionModelMessage } from './images.js';
import { newSession, saveSession, listSessions, exportMarkdown, timeAgo } from './sessions.js';
import { MarkdownStream } from './markdown.js';
import { bold, cyan, dim, gray, green, magenta, red, yellow, println, oneLine, truncate } from './ui.js';

const HISTORY_FILE = path.join(CONFIG_DIR, 'history.jsonl');

export const SHORTCUTS = [
  `${cyan('/')} 명령어  ${cyan('@')} 파일·이미지 첨부  ${cyan('!')} 셸 명령 바로 실행  ${cyan('#')} 메모 저장`,
  `${cyan('enter')} 전송  ${cyan('alt+enter')}·${cyan('ctrl+j')}·줄 끝 ${cyan('\\')} 줄바꿈  ${cyan('tab')} 자동완성`,
  `${cyan('↑↓')} 입력 기록  ${cyan('ctrl+r')} 기록 검색  ${cyan('shift+tab')} 권한 모드 전환`,
  `${cyan('esc')} 응답 중단·메뉴 닫기  ${cyan('esc esc')} 입력 지우기  ${cyan('ctrl+l')} 화면 지우기`,
  `${cyan('ctrl+a/e')} 줄 처음/끝  ${cyan('ctrl+u/k')} 앞/뒤 삭제  ${cyan('ctrl+w')} 단어 삭제  ${cyan('ctrl+c')} 지우기/종료`,
];

const MODE_LABEL = {
  ask: gray('⏸ 매번 확인'),
  acceptEdits: green('⏵⏵ 편집 자동 승인'),
  auto: red('⏵⏵⏵ 모두 자동 (yolo)'),
};

export async function startRepl({ agent, mcp, skills, config, cwd, connecting, resume, initial, initialImages = [] }) {
  const editor = new Editor();
  const files = new FileIndex(cwd);
  let history = loadHistory();
  let session = newSession(cwd, config.model);
  let pendingImages = [];
  let modelNames = [];
  let lastCtrlC = 0;
  const refreshModels = () => listModels(config.ollamaHost).then((m) => { modelNames = m.map((x) => x.name); }).catch(() => {});
  refreshModels();

  connecting?.((msg) => editor.printAbove(msg));

  // Prompt pre-processing ("warm-up") so the first request reuses Ollama's prompt cache.
  const rewarm = ({ invalidate = true } = {}) => {
    if (config.warmup === false) return;
    if (invalidate) agent.invalidate();
    agent.warm().then(() => editor.redraw?.());
  };
  const ticker = setInterval(() => { if (agent.warmState?.status === 'warming') editor.redraw?.(); }, 1000);
  ticker.unref();
  const syncMcpServers = () => {
    const names = Object.entries(config.mcpServers).filter(([, d]) => !d.disabled).map(([n]) => n);
    if (names.join() !== agent.mcpServers.join()) { agent.mcpServers = names; rewarm(); }
  };

  agent.ui = {
    async confirm({ label, detail, edits }) {
      const items = [
        { label: '예' },
        { label: edits ? '예, 이번 세션 동안 파일 편집은 묻지 않기' : `예, 이번 세션 동안 ${label} 항상 허용` },
        { label: '아니요, 다르게 하라고 알려주기' },
      ];
      const i = await editor.select(yellow(`  ${label} 실행할까요?`), items, { detail });
      if (i === 0) return { allow: true };
      if (i === 1) {
        if (edits) config.permissionMode = 'acceptEdits';
        return { allow: true, always: !edits };
      }
      if (i === 2) {
        const reason = await editor.readLine({
          prompt: () => yellow('  대신 어떻게 할까요? › '),
          history: [],
          keepTypeahead: false,
          footer: () => [gray('  enter 전송 · 비워두면 그냥 거부')],
        });
        return { allow: false, reason: reason?.trim() || undefined };
      }
      return { allow: false };
    },
  };

  // ---------- commands ----------

  const cmd = (desc, run, args) => ({ desc, run, args });
  const words = (list) => (arg) => lastToken(arg, list.map((v) => (typeof v === 'string' ? { value: v } : v)));

  const commands = {
    help: cmd('도움말과 단축키', () => showHelp()),
    clear: cmd('대화 초기화 (새 세션)', () => {
      agent.reset();
      rewarm({ invalidate: false });
      session = newSession(cwd, config.model);
      println(dim('새 대화를 시작합니다.'));
    }),
    compact: cmd('대화를 요약해 컨텍스트 확보 [집중할 내용]', async (arg) => {
      const r = await withAbort((signal) => agent.compact(signal, arg));
      if (!r) return println(gray('요약할 대화가 없습니다.'));
      println(green(`✓ 요약 완료: ~${r.before.toLocaleString()} → ~${r.after.toLocaleString()} 토큰`));
      rewarm();
      const md = new MarkdownStream({ bullet: gray('⎿ '), indent: '  ' });
      md.push(r.summary + '\n');
      md.end();
    }),
    resume: cmd('이전 대화 이어하기', () => pickSession()),
    export: cmd('대화를 마크다운 파일로 저장 [파일명]', (arg) => {
      const file = path.resolve(cwd, arg || `ollacode-${session.id}.md`);
      fs.writeFileSync(file, exportMarkdown(agent.messages));
      println(green(`✓ 저장됨: ${file}`));
    }),
    copy: cmd('마지막 응답을 클립보드에 복사', async () => {
      const text = agent.lastAssistantText();
      if (!text) return println(gray('복사할 응답이 없습니다.'));
      await copyToClipboard(text);
      println(green(`✓ ${text.length}자를 클립보드에 복사했습니다.`));
    }),
    undo: cmd('마지막 파일 변경 되돌리기', () => {
      const restored = agent.undo();
      if (!restored.length) return println(gray('되돌릴 파일 변경이 없습니다.'));
      println(green('✓ 되돌림:'));
      for (const p of restored) println(gray(`  ${path.relative(cwd, p) || p}`));
    }),
    status: cmd('모델·컨텍스트·토큰·MCP 상태', () => showStatus()),
    image: cmd('이미지 첨부 [경로] (없으면 클립보드)', async (arg) => {
      let file = arg ? path.resolve(cwd, arg.replace(/^@/, '').replace(/^"|"$/g, '')) : await clipboardImage();
      if (!file) return println(yellow('클립보드에 이미지가 없습니다. (스크린샷: Win+Shift+S 후 다시 시도)'));
      if (!fs.existsSync(file) || !isImagePath(file)) return println(red(`이미지 파일이 아닙니다: ${file}`));
      pendingImages.push(file);
      println(green(`📎 ${path.basename(file)} 첨부됨`) + gray(' — 다음 메시지와 함께 전송됩니다'));
      if (!agent.supportsVision() && !(await findVisionModel(config))) println(yellow(`⚠ ${noVisionModelMessage()}`));
    }, (arg) => lastToken(arg, files.match(arg.split(/\s+/).pop()).filter((f) => isImagePath(f) || f.endsWith('/')).map((f) => ({ value: f })))),
    model: cmd('모델 보기/변경', async (arg) => {
      if (!arg) {
        if (!modelNames.length) return println(`현재 모델: ${bold(agent.model)} (Ollama 모델 목록을 가져오지 못했습니다)`);
        const i = await editor.select('모델 선택', modelNames.map((n) => ({ label: n, hint: n === agent.model ? '(현재)' : '' })), { initial: Math.max(0, modelNames.indexOf(agent.model)) });
        if (i < 0) return;
        arg = modelNames[i];
      }
      await agent.setModel(arg);
      saveUserConfigPatch({ model: arg });
      rewarm();
      println(`모델 변경: ${bold(arg)} ${gray(agent.capabilities ? `[${agent.capabilities.join(', ')}]` : '(capabilities 확인 불가)')}`);
      if (!agent.supportsTools()) println(yellow('⚠ 이 모델은 도구 호출을 지원하지 않아 MCP/파일 도구를 쓸 수 없습니다.'));
    }, (arg) => lastToken(arg, modelNames.map((v) => ({ value: v })))),
    models: cmd('설치된 Ollama 모델', async () => {
      await refreshModels();
      for (const n of modelNames) println(`  ${n === agent.model ? green('●') : ' '} ${n}`);
    }),
    mcp: cmd('MCP 서버 관리 (add·import·enable…)', async (arg) => {
      if (arg === 'help') return println(MCP_HELP);
      await runMcpCommand(splitArgs(arg ?? ''), { cwd, config, mcp });
      syncMcpServers();
    },
      (arg) => {
        const parts = arg.split(/\s+/);
        if (parts.length <= 1) return words(['list', 'presets', 'add', 'import', 'connect', 'stop', 'essential', 'enable', 'disable', 'reconnect', 'remove', 'get', 'help'])(arg);
        if (['connect', 'stop', 'essential', 'enable', 'disable', 'reconnect', 'remove', 'get'].includes(parts[0])) return words(Object.keys(config.mcpServers))(arg);
        if (parts[0] === 'import') return words([...Object.keys(IMPORT_SOURCES), 'all'])(arg);
        if (parts[0] === 'add') return words(Object.keys(PRESETS))(arg);
        return null;
      }),
    tools: cmd('사용 가능한 도구 [검색어]', (arg) => {
      const { defs } = agent.buildTools();
      if (!arg) {
        println(bold(`모델에 노출된 도구 (${defs.length}):`));
        for (const d of defs) println(`  ${cyan(d.function.name)} ${gray(oneLine(d.function.description, 80))}`);
        if (mcp.hasRouterServers()) println(dim('\n  MCP 도구 검색: /tools <검색어>'));
        return;
      }
      for (const h of mcp.search(arg, { limit: 25 })) println(`  ${cyan(`${h.server}/${h.tool.name}`)} ${gray(oneLine(h.tool.description, 90))}`);
    }),
    pin: cmd('MCP 도구를 모델에 직접 노출', (arg) => togglePin(arg, true)),
    unpin: cmd('MCP 도구 직접 노출 해제', (arg) => togglePin(arg, false)),
    skills: cmd('스킬 목록/검색 [검색어|reload]', (arg) => showSkills(arg), words(['reload'])),
    ponytail: cmd('🐴 Ponytail 모드 [lite|full|ultra|off|default]', (arg) => ponytail(arg), words([...PONYTAIL_LEVELS, 'default'])),
    permissions: cmd('권한 모드 설정', async (arg) => {
      if (!arg) {
        const i = await editor.select('권한 모드', [
          { label: '매번 확인', hint: '읽기 전용 외 모든 도구 확인' },
          { label: '편집 자동 승인', hint: '파일 편집은 묻지 않음' },
          { label: '모두 자동 (yolo)', hint: '모든 도구를 확인 없이 실행' },
          { label: '항상 허용 목록 비우기', hint: [...agent.alwaysAllow].join(', ') || '(비어 있음)' },
        ], { initial: PERMISSION_MODES.indexOf(config.permissionMode) });
        if (i === 3) { agent.alwaysAllow.clear(); return println('항상 허용 목록을 비웠습니다.'); }
        if (i < 0) return;
        arg = PERMISSION_MODES[i];
      }
      if (!PERMISSION_MODES.includes(arg)) return println(red(`모드: ${PERMISSION_MODES.join(' | ')}`));
      config.permissionMode = arg;
      println(`권한 모드: ${MODE_LABEL[arg]}`);
    }, words(PERMISSION_MODES)),
    fast: cmd('⚡ 빠른 모드 (저사양용: 짧은 프롬프트·핵심 도구만) [on|off|default on|off]', (arg) => {
      const [a, b] = (arg ?? '').split(/\s+/);
      if (a === 'default') {
        if (!['on', 'off'].includes(b)) return println(red('사용법: /fast default on|off'));
        saveUserConfigPatch({ fast: b === 'on' });
        config.fast = b === 'on';
      } else {
        config.fast = a === 'on' ? true : a === 'off' ? false : !config.fast;
      }
      rewarm();
      println(config.fast
        ? `${yellow('⚡ 빠른 모드')} — 짧은 프롬프트, 핵심 도구 ${agent.snapshot?.tools.defs.length ?? '?'}개, 컨텍스트 ${agent.numCtx.toLocaleString()}, 도구 결과 ${agent.maxToolChars.toLocaleString()}자${agent.think === false ? ', thinking 끔' : ''}`
        : '일반 모드로 돌아왔습니다.');
      if (a === 'default') println(gray(`  기본값 저장: ${b}`));
    }, words(['on', 'off', 'default'])),
    yolo: cmd('모든 도구 자동 실행 토글', () => {
      config.permissionMode = config.permissionMode === 'auto' ? 'ask' : 'auto';
      println(`권한 모드: ${MODE_LABEL[config.permissionMode]}`);
    }),
    think: cmd('thinking 모드 [on|off]', (arg) => {
      config.think = arg === 'off' ? false : arg === 'on' ? true : !config.think;
      println(`thinking: ${config.think ? 'on' : 'off'}`);
    }, words(['on', 'off'])),
    memory: cmd('메모리 파일 보기/열기', async () => {
      const targets = [path.join(cwd, 'AGENTS.md'), USER_MEMORY];
      const i = await editor.select('어느 메모리를 열까요?', targets.map((f) => ({
        label: f === USER_MEMORY ? '사용자 메모리' : '프로젝트 AGENTS.md',
        hint: `${f}${fs.existsSync(f) ? ` (${fs.readFileSync(f, 'utf8').split('\n').length}줄)` : ' (없음)'}`,
      })));
      if (i < 0) return;
      if (!fs.existsSync(targets[i])) fs.writeFileSync(targets[i], '# Memory\n\n');
      openFile(targets[i]);
      println(gray(`열었습니다: ${targets[i]} (# 으로 시작하는 입력으로 바로 추가할 수 있습니다)`));
    }),
    keys: cmd('단축키 목록', () => { for (const l of SHORTCUTS) println('  ' + l); }),
    config: cmd('설정 파일 위치', () => println(`설정: ${USER_CONFIG}\n프로젝트 설정: .ollacode/config.json\n내 스킬: ${USER_SKILLS}\n세션: ${path.join(CONFIG_DIR, 'sessions')}`)),
    exit: cmd('종료', () => 'exit'),
  };

  function complete({ before }) {
    let m;
    if ((m = before.match(/^\/(\S*)$/))) {
      const q = m[1].toLowerCase();
      const entries = [
        ...Object.entries(commands).map(([name, c]) => ({ name, desc: c.desc })),
        ...skills.list().filter((s) => !commands[s.name] && (s.core || q.length >= 2)).map((s) => ({ name: s.name, desc: `${s.argumentHint ? s.argumentHint + ' ' : ''}${oneLine(s.description, 70)}`, skill: s, rankPenalty: s.core ? 0.5 : 1 })),
      ];
      const items = rank(entries, q).slice(0, 60).map((e) => ({
        label: '/' + e.name,
        value: '/' + e.name + ' ',
        desc: e.skill ? `${e.desc} ${gray(`[${e.skill.source}]`)}` : e.desc,
        submit: true,
      }));
      return { items, replace: Array.from(before).length };
    }
    if ((m = before.match(/^\/(\S+)\s+([\s\S]*)$/)) && commands[m[1]]?.args) {
      const r = commands[m[1]].args(m[2]);
      if (r) return { ...r, items: r.items.map((it) => ({ submit: !it.value.endsWith('/'), ...it })) };
    }
    if ((m = before.match(/(?:^|\s)@(\S*)$/))) {
      const q = m[1];
      const items = files.match(q, 40).map((f) => ({
        label: (isImagePath(f) ? '🖼 ' : f.endsWith('/') ? '📁 ' : '   ') + f,
        value: '@' + f + (f.endsWith('/') ? '' : ' '),
      }));
      return { items, replace: Array.from('@' + q).length };
    }
    return null;
  }

  function warmLabel() {
    const w = agent.warmState;
    if (w?.status === 'warming') return yellow(`⏳ 준비 중 ${Math.round((Date.now() - w.started) / 1000)}s`);
    if (w?.status === 'ready' && Date.now() - w.at < 4000) return green('✓ 준비됨');
    return null;
  }

  function footer(text) {
    if (text === '?') return SHORTCUTS.map((l) => '  ' + l);
    if (text.startsWith('!')) return [yellow('  ! 셸 모드 — enter 로 명령을 바로 실행하고 결과를 대화에 추가합니다')];
    if (text.startsWith('#')) return [magenta('  # 메모 모드 — enter 로 AGENTS.md 메모리에 저장합니다')];
    const right = [
      config.model,
      `ctx ${agent.contextPercent()}%`,
      config.fast ? yellow('⚡ fast') : null,
      warmLabel(),
      config.ponytail !== 'off' ? yellow(`🐴 ${config.ponytail}`) : null,
      pendingImages.length ? green(`📎 이미지 ${pendingImages.length}`) : null,
      mcp.pending().length ? yellow(`MCP 연결 중…`) : null,
    ].filter(Boolean).join(gray(' · '));
    const left = text ? '' : gray('? 단축키 · ');
    return [`  ${left}${MODE_LABEL[config.permissionMode]} ${gray('(shift+tab)')}${gray(' · ')}${gray(right)}`];
  }

  const prompt = (text) => (text.startsWith('!') ? yellow('› ') : text.startsWith('#') ? magenta('› ') : magenta('› '));

  // ---------- helpers ----------

  async function withAbort(fn) {
    const ac = new AbortController();
    const stop = editor.watch(() => ac.abort());
    try { return await fn(ac.signal); }
    catch (e) { if (e.name !== 'AbortError') throw e; println(yellow('  ⎿ 중단됨')); }
    finally { stop(); }
  }

  async function runAgent(text, images = []) {
    const started = Date.now();
    await withAbort((signal) => agent.run(text, signal, { images }));
    session.messages = agent.messages;
    session.model = config.model;
    try { saveSession(session); } catch {}
    if (Date.now() - started > 20_000 && config.notify !== false) process.stdout.write('\x07');
    println();
    // While the user reads and types, pre-process the conversation up to the next question.
    // Some templates (e.g. llama3.1) move tool definitions into the newest user message, so
    // without this every question would re-read all tool schemas.
    rewarm({ invalidate: false });
  }

  async function runShellCommand(command) {
    const [bin, args] = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`]]
      : ['bash', ['-lc', command]];
    let out = '';
    const code = await withAbort((signal) => new Promise((resolve) => {
      const child = spawn(bin, args, { cwd, signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const onData = (d) => { out += d; process.stdout.write(d); };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (e) => { out += e.message; resolve(-1); });
      child.on('close', resolve);
    }));
    if (out && !out.endsWith('\n')) println();
    println(gray(`  ⎿ exit ${code ?? '중단'} · 결과를 다음 메시지의 맥락으로 추가했습니다`));
    agent.addContext(`<shell command="${command}" exit="${code}">\n${truncate(out.trim(), 8000)}\n</shell>`);
  }

  async function saveMemory(note) {
    const targets = [path.join(cwd, 'AGENTS.md'), USER_MEMORY];
    const i = await editor.select(`메모 저장 위치: ${oneLine(note, 50)}`, [
      { label: '프로젝트 메모리', hint: targets[0] },
      { label: '사용자 메모리 (모든 프로젝트)', hint: targets[1] },
    ]);
    if (i < 0) return println(gray('취소했습니다.'));
    const file = targets[i];
    const prefix = fs.existsSync(file) ? (fs.readFileSync(file, 'utf8').endsWith('\n') ? '' : '\n') : '# Memory\n\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${prefix}- ${note}\n`);
    println(green(`✓ 저장됨 → ${file}`));
  }

  async function pickSession(last = false) {
    const sessions = listSessions(cwd);
    if (!sessions.length) return println(gray('저장된 대화가 없습니다.'));
    let chosen = sessions[0];
    if (!last) {
      const i = await editor.select('이어할 대화 선택', sessions.map((s) => ({
        label: oneLine(s.title, 50),
        hint: `${timeAgo(s.updated)} · ${s.messages.length}개 메시지${s.cwd !== cwd ? ` · ${s.cwd}` : ''}`,
      })));
      if (i < 0) return;
      chosen = sessions[i];
    }
    session = chosen;
    agent.messages = [{ role: 'system', content: agent.systemPrompt() }, ...chosen.messages];
    rewarm();
    println(green(`✓ 대화를 불러왔습니다: ${oneLine(chosen.title, 60)}`) + gray(` (${timeAgo(chosen.updated)})`));
    for (const m of chosen.messages.filter((x) => (x.role === 'user' || x.role === 'assistant') && x.content).slice(-4)) {
      println(gray(`  ${m.role === 'user' ? '›' : '●'} ${oneLine(m.content, 100)}`));
    }
  }

  function showHelp() {
    println(bold('\n단축키'));
    for (const l of SHORTCUTS) println('  ' + l);
    println(bold('\n명령어'));
    for (const [name, c] of Object.entries(commands)) println(`  ${cyan(('/' + name).padEnd(14))} ${gray(c.desc)}`);
    println(gray(`\n  스킬 ${skills.list().length}개도 /<스킬이름> 으로 실행할 수 있습니다 (/skills)`));
  }

  function showStatus() {
    const pct = agent.contextPercent();
    const bar = '▓'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    const servers = [...mcp.servers.entries()].map(([n, s]) =>
      `${n} ${s.status === 'connected' ? green('●') : s.status === 'failed' ? red('●') : s.status === 'disabled' ? gray('○') : s.status === 'idle' ? gray('◌ 대기') : yellow('●')}${s.status === 'connected' ? gray(` ${s.tools.length} (${mcp.modeOf(n)})`) : ''}`).join(gray(' · '));
    const rows = [
      ['모델', `${config.model} ${gray(agent.capabilities ? `[${agent.capabilities.join(', ')}]` : '')}`],
      ['컨텍스트', `~${agent.estimateTokens().toLocaleString()} / ${agent.numCtx.toLocaleString()} 토큰 (${pct}%) ${pct > 80 ? red(bar) : cyan(bar)}`],
      ['토큰', `입력 ${agent.stats.input.toLocaleString()} · 출력 ${agent.stats.output.toLocaleString()}${agent.stats.lastTps ? ` · ${agent.stats.lastTps.toFixed(1)} tok/s` : ''}`],
      ['권한 모드', MODE_LABEL[config.permissionMode] + (agent.alwaysAllow.size ? gray(` · 항상 허용: ${[...agent.alwaysAllow].join(', ')}`) : '')],
      ['Ponytail', config.ponytail],
      ['속도', [
        config.fast ? yellow('⚡ 빠른 모드') : '일반 모드',
        agent.warmState?.status === 'ready' ? green(`프롬프트 미리 처리됨 (${agent.warmState.tokens?.toLocaleString() ?? '?'} tok, ${agent.warmState.secs.toFixed(1)}s)`)
          : agent.warmState?.status === 'warming' ? yellow('프롬프트 미리 처리 중…')
            : agent.warmState?.status === 'error' ? red(`미리 처리 실패: ${agent.warmState.error}`) : gray('미리 처리 안 함'),
        agent.stats.lastPrompt ? `마지막 요청: 프롬프트 ${agent.stats.lastPrompt.tokens.toLocaleString()} tok ${agent.stats.lastPrompt.secs.toFixed(1)}s` : null,
      ].filter(Boolean).join(gray(' · '))],
      ['MCP', servers || gray('(없음)')],
      ['스킬', `${skills.list({ core: true }).length}개 (+공유 ${skills.list({ core: false }).length}개)`],
      ['세션', `${session.id} · ${agent.messages.length - 1}개 메시지`],
      ['작업 폴더', cwd],
    ];
    for (const [k, v] of rows) println(`  ${gray(k.padEnd(8))}  ${v}`);
    if (pct > 70) println(yellow('  컨텍스트가 많이 찼습니다. /compact 로 요약하세요.'));
  }

  function showSkills(arg) {
    if (arg === 'reload') { skills.reload(); return println(`스킬 ${skills.list().length}개를 다시 불러왔습니다.`); }
    const list = arg ? skills.search(arg, 30) : skills.list({ core: true });
    for (const [source, items] of Object.entries(Object.groupBy(list, (s) => s.source))) {
      println(bold(`\n[${source}]`));
      for (const s of items) println(`  ${cyan('/' + s.name)}${s.argumentHint ? gray(` ${s.argumentHint}`) : ''} ${gray(oneLine(s.description, 80))}`);
    }
    const external = skills.list({ core: false }).length;
    if (!arg && external) println(gray(`\n  + Claude Code/Codex/agy 공유 스킬 ${external}개 (/skills <검색어>)`));
    println(gray(`  새 스킬: ${USER_SKILLS}\\<이름>\\SKILL.md · /skill-creator 로 만들기 · /skills reload`));
  }

  function ponytail(arg) {
    const [a, b] = (arg ?? '').split(/\s+/);
    if (a === 'default') {
      if (!PONYTAIL_LEVELS.includes(b)) return println(red(`레벨: ${PONYTAIL_LEVELS.join(' | ')}`));
      saveUserConfigPatch({ ponytail: b });
      config.ponytail = b;
      return println(`🐴 기본 Ponytail 레벨을 ${bold(b)}(으)로 저장했습니다.`);
    }
    const level = a || (config.ponytail !== 'off' ? 'off' : 'full');
    if (!PONYTAIL_LEVELS.includes(level)) return println(red(`레벨: ${PONYTAIL_LEVELS.join(' | ')}`));
    if (level !== 'off' && !skills.get('ponytail')) return println(red('ponytail 스킬을 찾을 수 없습니다.'));
    config.ponytail = level;
    if (agent.messages.length <= 1) rewarm();
    println(level === 'off'
      ? '🐴 Ponytail 모드를 껐습니다.'
      : `🐴 Ponytail ${bold(level)} — 가장 작은 완전한 변경만. ${gray('(/ponytail-review · /ponytail-audit · /ponytail-debt)')}`);
  }

  function togglePin(ref, on) {
    const found = ref && mcp.resolve(ref);
    if (!found) return println(red(`도구를 찾을 수 없습니다: ${ref ?? ''}`));
    const cfg = mcp.servers.get(found.server).config;
    const set = new Set(cfg.pinnedTools ?? []);
    on ? set.add(found.tool.name) : set.delete(found.tool.name);
    cfg.pinnedTools = [...set];
    println(`${on ? '고정' : '해제'}: ${found.server}/${found.tool.name}`);
  }

  // ---------- main loop ----------

  if (resume === 'last') await pickSession(true);
  else if (resume === 'pick') await pickSession();
  if (!agent.warmState) rewarm({ invalidate: false });

  pendingImages.push(...initialImages);
  let queued = initial;
  while (true) {
    const input = queued ?? await editor.readLine({
      prompt,
      history,
      complete,
      footer,
      onShiftTab: () => {
        config.permissionMode = PERMISSION_MODES[(PERMISSION_MODES.indexOf(config.permissionMode) + 1) % PERMISSION_MODES.length];
      },
    });
    if (queued) println(`${magenta('›')} ${queued}`);
    queued = null;
    if (input === undefined) break;
    if (input === null) {
      if (Date.now() - lastCtrlC < 2000) break;
      lastCtrlC = Date.now();
      println(dim('  (Ctrl+C 를 한 번 더 누르면 종료합니다)'));
      continue;
    }
    const text = input.trim();
    if (!text) continue;
    history = rememberHistory(history, text);

    if (text.startsWith('!')) { await runShellCommand(text.slice(1).trim()); continue; }
    if (text.startsWith('#') && !/^#{2,}/.test(text)) { await saveMemory(text.slice(1).trim()); continue; }

    if (text.startsWith('/')) {
      const [, name, rest = ''] = text.match(/^\/(\S+)\s*([\s\S]*)$/);
      const c = commands[name];
      const skill = !c && skills.get(name);
      if (c) {
        try {
          if ((await c.run(rest.trim() || undefined)) === 'exit') break;
        } catch (e) { println(red(e.message)); }
      } else if (skill) {
        println(gray(`⚡ 스킬 ${skill.name} [${skill.source}]`));
        await runAgent(`${skills.render(skill, rest.trim())}\n\n` +
          (rest.trim() ? `Follow the skill above. Arguments: ${rest.trim()}` : 'Follow the skill above for the current context.'), takeImages());
      } else {
        println(red(`알 수 없는 명령어: /${name}`) + gray(' (/ 를 입력하면 목록이 나옵니다)'));
      }
      continue;
    }

    const { blocks, images } = expandMentions(text, cwd);
    for (const b of blocks) println(gray(`  ⎿ 첨부: ${b.match(/path="([^"]+)"/)?.[1]}`));
    const allImages = [...takeImages(), ...images];
    await runAgent(blocks.length ? `${text}\n\n${blocks.join('\n\n')}` : text, allImages);
  }

  function takeImages() {
    return pendingImages.splice(0);
  }

  editor.restore();
}

function rank(entries, q) {
  if (!q) return entries;
  const scored = [];
  for (const e of entries) {
    const n = e.name.toLowerCase();
    let s = 0;
    if (n === q) s = 100;
    else if (n.startsWith(q)) s = 50 - n.length / 100;
    else if (n.includes(q)) s = 30;
    else if (isSubsequence(q, n)) s = 10;
    else if (q.length > 1 && e.desc?.toLowerCase().includes(q)) s = 5;
    if (s) scored.push([s - (e.rankPenalty ?? 0), e]);
  }
  return scored.sort((a, b) => b[0] - a[0]).map(([, e]) => e);
}

function isSubsequence(q, s) {
  let i = 0;
  for (const c of s) if (c === q[i]) i++;
  return i === q.length;
}

/** Completion of the last whitespace-separated token in `arg` from a list of {value, desc}. */
function lastToken(arg, list) {
  const token = arg.split(/\s+/).pop();
  const t = token.toLowerCase();
  const items = list.filter((x) => x.value.toLowerCase().includes(t))
    .sort((a, b) => b.value.toLowerCase().startsWith(t) - a.value.toLowerCase().startsWith(t))
    .slice(0, 40)
    .map((x) => ({ label: x.value, value: x.value.endsWith('/') ? x.value : x.value + ' ', desc: x.desc }));
  return items.length ? { items, replace: Array.from(token).length } : null;
}

function loadHistory() {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(-500);
  } catch { return []; }
}

function rememberHistory(history, text) {
  const next = [...history.filter((h) => h !== text), text].slice(-500);
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, next.map((h) => JSON.stringify(h)).join('\n') + '\n');
  } catch {}
  return next;
}

function copyToClipboard(text) {
  const tmp = path.join(os.tmpdir(), `ollacode-clip-${process.pid}.txt`);
  fs.writeFileSync(tmp, text);
  const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true }, (e) => (e ? reject(e) : resolve())));
  const done = () => fs.rmSync(tmp, { force: true });
  if (process.platform === 'win32') {
    return run('powershell.exe', ['-NoProfile', '-Command', `Get-Content -Raw -Encoding UTF8 -LiteralPath '${tmp.replace(/'/g, "''")}' | Set-Clipboard`]).finally(done);
  }
  const sh = process.platform === 'darwin' ? `pbcopy < '${tmp}'` : `(wl-copy < '${tmp}' || xclip -selection clipboard < '${tmp}')`;
  return run('sh', ['-c', sh]).finally(done);
}

function openFile(file) {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], { detached: true, stdio: 'ignore' }).unref();
}
