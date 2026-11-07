---
name: mcp-setup
description: >
  Help the user add, import, enable or troubleshoot MCP servers in ollacode.
  Use for "add an MCP server", "MCP 연결", "connect playwright/filesystem",
  "import MCP from Claude Code/Codex/agy".
argument-hint: "[server or need]"
---

# MCP setup

Need: $ARGUMENTS

ollacode manages MCP servers with the `ollacode mcp` command (run it with `run_shell`):

| Goal | Command |
|---|---|
| list status | `ollacode mcp` |
| show presets | `ollacode mcp presets` (rea, filesystem, memory, sequential-thinking, playwright, chrome-devtools, context7, everything) |
| add a preset | `ollacode mcp add playwright` |
| add a stdio server | `ollacode mcp add <name> -e KEY=VALUE -- <command> <args...>` |
| add an HTTP server | `ollacode mcp add <name> --url https://host/mcp -H "Authorization: Bearer <token>"` (`-t sse` for SSE) |
| project only | add `-s project` (saved in `.ollacode/config.json`) |
| import | `ollacode mcp import claude` / `codex` / `agy` / `all` |
| remove / toggle | `ollacode mcp remove <name>`, `ollacode mcp disable <name>`, `ollacode mcp enable <name>` |

1. Find the right server for the need (presets first). For anything else, ask the user for the package name or URL.
   Never invent package names.
2. Run the command. Do not put secrets on the command line unless the user provided them for that purpose.
3. Tell the user to run `/mcp reconnect <name>` in the REPL (or restart ollacode), then `/mcp` to check status.
4. Troubleshooting a failed server: show `ollacode mcp get <name>`, run its command manually with `run_shell`
   (short timeout) to read the error, and check that Node/Python and `npx`/`uvx` exist.
