---
name: explain-code
description: >
  Explain how a codebase, file, function or feature works, with file:line
  references. Use for "explain", "설명해줘", "how does X work", onboarding.
argument-hint: "[path | feature]"
---

# Explain code

Subject: $ARGUMENTS (default: the whole project in the working directory)

1. Orient: `list_dir`, then read the README and manifest (package.json, pyproject.toml, go.mod, Cargo.toml...).
2. Find the entry points (main, bin, routes, CLI commands) and follow the flow for the subject.
   Use `grep` to find where things are defined and used.
3. Read only what you need; do not dump whole files.

## Output

- One-paragraph summary.
- How it works: the flow step by step, each step with `file:line`.
- Key files: file — role.
- Gotchas or non-obvious behavior you noticed.
