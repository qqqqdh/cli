// `ollacode mcp …` and the REPL's `/mcp …` share this handler.
import { loadConfig, updateConfigFile } from './config.js';
import { PRESETS, addServer, discoverImports, parseAddArgs, removeServer, setServerDisabled } from './mcpConfig.js';
import { bold, cyan, gray, green, red, yellow, println, oneLine } from './ui.js';

export const MCP_HELP = `${bold('MCP 명령')}
  mcp                                   서버 상태 목록
  mcp presets                           바로 추가할 수 있는 프리셋 목록
  mcp add <프리셋>                      프리셋 추가 (예: mcp add playwright)
  mcp add <이름> -- <명령> [인자...]    stdio 서버 추가 (예: mcp add fs -- npx -y @modelcontextprotocol/server-filesystem C:/work)
  mcp add <이름> --url <URL> [-H "Authorization: Bearer xx"] [-t sse]   HTTP/SSE 서버 추가
        옵션: -s user|project (저장 위치, 기본 user), -e KEY=VALUE (환경변수)
  mcp import [claude|codex|agy|all] [이름...]   다른 에이전트의 MCP 설정 가져오기
  mcp remove <이름> [-s scope]          삭제
  mcp enable|disable <이름> [-s scope]  켜기/끄기
  mcp connect|stop <이름>               지금 연결 / 종료 (서버는 평소 필요할 때 자동 연결)
  mcp essential <이름> [on|off]         시작할 때부터 항상 연결할지 설정
  mcp reconnect <이름>                  다시 연결
  mcp get <이름>                        설정 보기`;

function takeScope(args) {
  const i = args.findIndex((a) => a === '-s' || a === '--scope');
  if (i < 0) return 'user';
  const [, scope] = args.splice(i, 2);
  return scope;
}

/**
 * @param {string[]} argv
 * @param {{cwd: string, config: any, mcp?: import('./mcp.js').McpManager, onChange?: () => void}} ctx
 *   With `mcp` (REPL), changes are applied to live connections immediately.
 */
export async function runMcpCommand(argv, { cwd, config, mcp, onChange = () => {} }) {
  const [sub = 'list', ...args] = argv;
  const live = async (name) => {
    if (!mcp) return;
    const fresh = loadConfig(cwd).mcpServers[name];
    config.mcpServers = loadConfig(cwd).mcpServers;
    if (!fresh) { await mcp.disconnect(name); onChange(); return; }
    println(gray(`  ${name} 연결 중…`));
    await mcp.connect(name, fresh);
    const s = mcp.servers.get(name);
    if (s.status === 'connected') println(`  ${green('●')} ${name} ${gray(`${s.tools.length} tools · ${mcp.modeOf(name)} 모드`)}`);
    else if (s.status === 'disabled') println(`  ${gray('○')} ${name} ${gray('비활성')}`);
    else println(`  ${red('●')} ${name} ${red('연결 실패')}\n${red(s.error?.split('\n').slice(0, 6).join('\n') ?? '')}`);
    onChange();
  };

  switch (sub) {
    case 'list':
    case 'ls': {
      const servers = Object.entries(config.mcpServers);
      if (!servers.length) return println(gray('설정된 MCP 서버가 없습니다. `mcp presets` 를 확인하세요.'));
      for (const [name, def] of servers) {
        const s = mcp?.servers.get(name);
        const status = s?.status ?? (def.disabled ? 'disabled' : 'configured');
        const icon = { connected: green('●'), failed: red('●'), connecting: yellow('●'), disabled: gray('○'), idle: gray('◌') }[status] ?? gray('●');
        const detail = status === 'connected' ? `연결됨 · ${s.tools.length} tools · ${mcp.modeOf(name)} 모드`
          : status === 'idle' ? `대기 (필요할 때 연결${s.tools.length ? ` · 도구 ${s.tools.length}개 캐시됨` : ''})`
            : { connecting: '연결 중', failed: '연결 실패', disabled: '비활성', configured: '설정됨' }[status] ?? status;
        const tag = def.essential ? yellow(' [항상]') : '';
        const target = def.url ?? [def.command, ...(def.args ?? [])].join(' ');
        println(`  ${icon} ${bold(name)}${tag} ${gray(detail)}  ${gray(oneLine(target, 60))}`);
        if (s?.status === 'failed') println(red(`      ${oneLine(s.error, 160)}`));
      }
      return;
    }
    case 'presets':
      for (const [name, p] of Object.entries(PRESETS)) {
        const added = config.mcpServers[name] ? green(' (추가됨)') : '';
        println(`  ${cyan(name.padEnd(20))} ${p.description}${added}`);
      }
      return println(gray('\n  추가: mcp add <프리셋이름>'));
    case 'add': {
      const { name, def, scope } = parseAddArgs(args, cwd);
      const file = addServer(name, def, scope, cwd);
      println(`${green('✓')} '${name}' 추가됨 → ${file}`);
      return live(name);
    }
    case 'remove':
    case 'rm': {
      const scope = takeScope(args);
      for (const name of args) {
        removeServer(name, scope, cwd);
        println(`${green('✓')} '${name}' 삭제됨 (${scope})`);
        await live(name);
      }
      return;
    }
    case 'enable':
    case 'disable': {
      const scope = takeScope(args);
      for (const name of args) {
        const def = config.mcpServers[name];
        if (!def) { println(red(`알 수 없는 서버: ${name}`)); continue; }
        setServerDisabled(name, sub === 'disable', def, scope, cwd);
        println(`${green('✓')} '${name}' ${sub === 'disable' ? '비활성화' : '활성화'}`);
        await live(name);
      }
      return;
    }
    case 'connect':
    case 'stop': {
      if (!mcp) return println(gray('대화형 모드에서만 사용할 수 있습니다.'));
      for (const name of args) {
        if (!mcp.servers.has(name)) { println(red(`알 수 없는 서버: ${name}`)); continue; }
        if (sub === 'stop') { await mcp.stop(name); println(`  ${gray('◌')} ${name} 종료됨 (필요하면 다시 자동 연결)`); continue; }
        println(gray(`  ${name} 연결 중…`));
        try { await mcp.ensure(name); const s = mcp.servers.get(name); println(`  ${green('●')} ${name} ${gray(`${s.tools.length} tools`)}`); }
        catch (e) { println(red(`  ${e.message}`)); }
      }
      return;
    }
    case 'essential': {
      const scope = takeScope(args);
      const [name, onOff = 'on'] = args;
      const def = config.mcpServers[name];
      if (!def) return println(red(`알 수 없는 서버: ${name}`));
      updateConfigFile(scope, cwd, (c) => {
        c.mcpServers ??= {};
        c.mcpServers[name] = { ...(c.mcpServers[name] ?? def), essential: onOff !== 'off' };
      });
      config.mcpServers[name] = { ...def, essential: onOff !== 'off' };
      return println(`${green('✓')} '${name}' ${onOff !== 'off' ? '시작할 때부터 항상 연결' : '필요할 때만 연결'}`);
    }
    case 'reconnect':
      if (!mcp) return println(gray('대화형 모드에서만 사용할 수 있습니다.'));
      for (const name of args.length ? args : Object.keys(config.mcpServers)) await live(name);
      return;
    case 'get': {
      const def = config.mcpServers[args[0]];
      return println(def ? JSON.stringify(def, null, 2) : red(`알 수 없는 서버: ${args[0]}`));
    }
    case 'import': {
      const scope = takeScope(args);
      const [source = 'all', ...names] = args;
      const found = discoverImports(source, cwd);
      let count = 0;
      for (const [src, servers] of Object.entries(found)) {
        const entries = Object.entries(servers).filter(([n]) => !names.length || names.includes(n));
        if (!entries.length) { println(gray(`  ${src}: 가져올 서버 없음`)); continue; }
        for (const [name, def] of entries) {
          if (config.mcpServers[name]) { println(gray(`  ${src}/${name}: 이미 있음, 건너뜀`)); continue; }
          addServer(name, def, scope, cwd);
          config.mcpServers[name] = def;
          count++;
          println(`  ${green('✓')} ${src}/${name} ${gray(oneLine(def.url ?? [def.command, ...(def.args ?? [])].join(' '), 70))}`);
          await live(name);
        }
      }
      return println(count ? `${count}개 서버를 가져왔습니다.` : gray('새로 가져온 서버가 없습니다.'));
    }
    case 'help':
      return println(MCP_HELP);
    default:
      println(red(`알 수 없는 mcp 명령: ${sub}`));
      println(MCP_HELP);
  }
}

/** Splits a command line honoring "double" and 'single' quotes. */
export function splitArgs(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
