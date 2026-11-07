---
name: init
description: >
  Analyze the project and create an AGENTS.md with build/test commands,
  structure and conventions for future agent sessions. Use for "init",
  "AGENTS.md 만들어줘".
---

# Init: write AGENTS.md

1. Explore: `list_dir` at the root, read the README and manifests, glob for source and test folders and CI config.
2. Collect only facts an agent needs and cannot guess:
   - How to install, build, run, test and lint (exact commands).
   - Layout: main folders and what lives there.
   - Conventions: language versions, code style, naming, where tests go.
   - Gotchas: required env vars, generated files not to edit, platform quirks.
3. If AGENTS.md exists, read it and improve it instead of overwriting.
4. Write `AGENTS.md` at the project root: short sections, bullet points, under ~80 lines.

ollacode (and Codex, Antigravity) read AGENTS.md at the start of every session.
