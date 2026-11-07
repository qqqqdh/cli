---
name: reverse-engineer
description: >
  Reverse engineer a binary, desktop app, Electron/JavaScript app, .NET assembly,
  APK, Go binary or web page with the REA MCP server and report evidence-backed
  findings. Use for "how does this app/feature work", "analyze this exe/dll/apk/asar",
  "reverse engineer", "decompile", "리버스 엔지니어링", "분석해줘".
argument-hint: "<target path> [question]"
---

# Reverse engineering with REA

Target / question: $ARGUMENTS

REA tools are reached through `mcp_search_tools` → `mcp_get_tool_schema` → `mcp_call_tool`
with names like `rea/<tool>` (or directly as `mcp__rea__<tool>` if pinned).
If REA is not connected, tell the user to check `/mcp`.

## Steps

1. **Identify the target.** Confirm the absolute path exists with `list_dir` / `glob`.
   Use forward slashes in paths (C:/Users/...).
2. **Pick the entry tool by target type.** Always fetch the schema first; the argument names below are hints.

   | Target | Tool | Key arguments |
   |---|---|---|
   | Electron app (`app.asar`) or JS folder | `rea/analyze_javascript_application` | `input_path`, `detail: "summary"` |
   | .NET assembly (managed .dll/.exe) | `rea/inspect_managed_artifact` | `path`, `detail: "summary"` |
   | Android APK | `rea/inspect_android_package` | `path`, `detail: "summary"` |
   | Go binary | `rea/inspect_go_binary` | `path` |
   | Native binary (exe/dll/elf/mach-o) | `rea/open_binary`, then `rea/binary_overview`, `rea/list_procedures`, `rea/search_strings` (`pattern`), `rea/procedure_pseudo_code` (`procedure`) | `path` |
   | Anything else | `mcp_search_tools` with words like "inspect pe", "firmware", "wasm", "sqlite" | |

3. **Start small.** Prefer `detail: "summary"`. Large results are retained by REA;
   page through them with `rea/inspect_analysis_view` instead of requesting everything.
4. **Follow the question.** Search strings/symbols for words from the feature
   (UI labels, error messages, API paths), then read the functions or modules that use them.
5. **Native sessions:** call `rea/close_binary` when done.

## Report

- What the feature does and how (call flow, modules, data formats).
- The evidence for each claim: tool name + what it returned (addresses, module paths, strings).
- Unknowns: what REA could not establish. Never invent findings that no tool returned.
- If a tool errors with "Invalid arguments", read the message, fix the arguments, retry once.
