---
name: doc-writer
description: >
  Write or update README and docs from the actual code: install, usage,
  configuration, examples. Use for "write README", "문서 작성", "document this".
argument-hint: "[file or topic]"
---

# Write docs

Topic: $ARGUMENTS (default: the project's README.md)

1. Read the code the docs describe: entry points, CLI flags, config files, public API. Run `--help` if there is a CLI.
2. If a doc exists, update the outdated parts instead of rewriting everything.
3. README structure: one-line purpose → install → quick start (copy-pasteable) → usage/config reference → troubleshooting.
4. Every command and option you document must exist in the code. Verify examples by running them when safe.
5. Match the language of the existing docs.

Report which files you changed and anything you could not verify.
