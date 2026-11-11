import { Agent } from '../src/agent.js';

/** An Agent with stub skills/MCP, enough to drive the loop and tools in tests. */
export function makeAgent({ cwd, config = {}, confirm } = {}) {
  const skills = { list: () => [], get: () => null, suggest: () => [], search: () => [] };
  const mcp = { relevantTo: () => [], directTools: () => [], prefetch() {} };
  return new Agent({
    cwd,
    skills,
    mcp,
    config: {
      model: 'test', ollamaHost: 'http://127.0.0.1:1', numCtx: 4096, maxTurns: 10,
      maxToolResultChars: 20000, permissionMode: 'ask', showStats: false, ...config,
    },
    ui: { confirm: confirm ?? (async () => ({ allow: true })) },
  });
}
