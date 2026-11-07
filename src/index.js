import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { McpManager } from './mcp.js';
import { Agent, PONYTAIL_LEVELS } from './agent.js';
import { SkillRegistry } from './skills.js';
import { startRepl } from './repl.js';
import { runMcpCommand, MCP_HELP } from './mcpCommands.js';
import { findVisionModel } from './images.js';
import { bold, box, cyan, dim, gray, green, red, yellow, println, oneLine } from './ui.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

const USAGE = `ollacode ${VERSION} — Ollama 기반 에이전트 CLI (MCP · 스킬 · Ponytail · 이미지)

사용법:
  ollacode                      대화형 모드
  ollacode "질문"               첫 메시지와 함께 대화형 모드 시작
  ollacode -p "질문"            한 번 실행하고 종료 (파이프 입력도 가능)
  ollacode -c                   마지막 대화 이어하기
  ollacode --resume             이어할 대화 선택
  ollacode mcp [하위명령]       MCP 서버 관리 (ollacode mcp help)
  ollacode skills [검색어]      스킬 목록

옵션:
  -m, --model <이름>            사용할 Ollama 모델
  -p, --print <프롬프트>        비대화형 실행
  -i, --image <경로>            이미지 첨부 (여러 번 사용 가능)
  -f, --fast                    빠른 모드 (저사양 PC용)
      --ponytail <레벨>         Ponytail 모드 (${PONYTAIL_LEVELS.join('|')})
      --yolo                    모든 도구를 확인 없이 실행
      --no-mcp                  MCP 서버 연결 안 함
      --ctx <토큰>              컨텍스트 길이 (num_ctx)
  -v, --version                 버전
  -h, --help                    도움말`;

export async function main(argv) {
  const cwd = process.cwd();
  const config = loadConfig(cwd);

  if (argv[0] === 'mcp') {
    if (argv[1] === 'help' || argv[1] === '--help') return println(MCP_HELP);
    return runMcpCommand(argv.slice(1), { cwd, config });
  }
  if (argv[0] === 'skills') {
    const skills = new SkillRegistry({ cwd, externalDirs: config.externalSkillDirs });
    const list = argv[1] ? skills.search(argv.slice(1).join(' '), 30) : skills.list();
    for (const s of list) println(`  ${cyan(s.name)} ${gray(`[${s.source}]`)} ${gray(oneLine(s.description, 90))}`);
    return println(gray(`\n  총 ${list.length}개`));
  }

  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      model: { type: 'string', short: 'm' },
      print: { type: 'string', short: 'p' },
      image: { type: 'string', short: 'i', multiple: true },
      continue: { type: 'boolean', short: 'c' },
      resume: { type: 'boolean', short: 'r' },
      ponytail: { type: 'string' },
      fast: { type: 'boolean', short: 'f' },
      yolo: { type: 'boolean' },
      'no-mcp': { type: 'boolean' },
      ctx: { type: 'string' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  if (values.help) return println(USAGE);
  if (values.version) return println(VERSION);

  if (values.model) config.model = values.model;
  if (values.yolo) config.permissionMode = 'auto';
  if (values.ctx) config.numCtx = Number(values.ctx);
  if (values.ponytail) config.ponytail = values.ponytail;
  if (values.fast) config.fast = true;
  if (!['ask', 'acceptEdits', 'auto'].includes(config.permissionMode)) config.permissionMode = 'ask';
  const images = (values.image ?? []).map((p) => path.resolve(cwd, p));

  let prompt = values.print;
  if (prompt === undefined && !process.stdin.isTTY) {
    prompt = await new Promise((r) => { let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => r(s)); });
  }
  const interactive = prompt === undefined;

  const servers = values['no-mcp'] ? {} : config.mcpServers;
  const names = Object.entries(servers).filter(([, d]) => !d.disabled).map(([n]) => n);
  const mcp = new McpManager(config);
  const skills = new SkillRegistry({ cwd, externalDirs: config.externalSkillDirs });
  const agent = new Agent({ config, mcp, skills, cwd, mcpServers: names });
  await agent.setModel(config.model);
  const vision = await findVisionModel(config);
  agent.visionAvailable = !!vision;
  const statusLine = (name, s) => s.status === 'connected'
    ? `  ${green('●')} ${name} ${gray(`${s.tools.length} tools · ${mcp.modeOf(name)} 모드`)}`
    : s.status === 'disabled' ? null
      : `  ${red('●')} ${name} ${red('연결 실패')} ${dim(oneLine(s.error, 100))} ${gray('(/mcp 로 확인)')}`;
  const shutdown = async (code = 0) => { await mcp.closeAll(); process.exit(code); };

  if (!interactive) {
    await mcp.registerAll(servers, (name, s) => { if (s.status === 'failed') println(statusLine(name, s)); });
    const ac = new AbortController();
    process.on('SIGINT', () => ac.abort());
    try {
      await agent.run(prompt.trim(), ac.signal, { images });
      await shutdown(0);
    } catch (e) {
      println(red(`✗ ${e.message}`));
      await shutdown(1);
    }
    return;
  }

  // ---------- interactive ----------
  const caps = agent.capabilities ? gray(`[${agent.capabilities.join(', ')}]`) : '';
  println(box([
    `${bold(cyan('✻ ollacode'))} ${gray(`v${VERSION}`)}`,
    '',
    `${gray('모델  ')} ${config.model} ${caps}${config.fast ? `  ${yellow('⚡ 빠른 모드')}` : ''}`,
    `${gray('이미지')} ${vision ? `${vision}${vision === config.model ? '' : gray(' (자동 선택)')}` : yellow('비전 모델 없음 — ollama pull qwen2.5vl:7b')}`,
    `${gray('스킬  ')} ${skills.list({ core: true }).length}개 ${gray(`(+공유 ${skills.list({ core: false }).length}개)`)}${config.ponytail !== 'off' ? `  ${yellow(`🐴 ponytail ${config.ponytail}`)}` : ''}`,
    `${gray('MCP   ')} ${names.length ? names.map((n) => (servers[n].essential ? `${n}*` : n)).join(', ') + gray(' (필요할 때 연결)') : gray('없음 — /mcp presets')}`,
    `${gray('폴더  ')} ${cwd}`,
  ], cyan));
  if (agent.capabilities && !agent.supportsTools()) println(yellow(`  ⚠ ${config.model}은(는) 도구 호출을 지원하지 않습니다. /model 로 변경하세요.`));
  println(gray(`  ${cyan('/')} 명령 · ${cyan('@')} 파일 · ${cyan('!')} 셸 · ${cyan('#')} 메모 · ${cyan('?')} 단축키 · ${cyan('shift+tab')} 권한 모드 · ${cyan('esc')} 중단\n`));

  await startRepl({
    agent, mcp, skills, config, cwd,
    resume: values.continue ? 'last' : values.resume ? 'pick' : null,
    initial: positionals.join(' ').trim() || null,
    initialImages: images,
    connecting: (notify) => mcp.registerAll(servers, (name, s) => {
      const line = statusLine(name, s);
      if (line) notify(line);
    }),
  });
  await shutdown(0);
}
