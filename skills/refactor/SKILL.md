---
name: refactor
description: >
  Restructure code without changing behavior: remove duplication, simplify,
  rename, split functions that do several jobs. Use for "refactor", "리팩토링", "clean up".
argument-hint: "<file or area> [goal]"
---

# Refactor

Target and goal: $ARGUMENTS

1. Read the target and grep all its callers. Note public interfaces that must not change.
2. Find or run existing tests first so you can show behavior is unchanged. If risky logic has no test, add one small test first.
3. Change in small steps (one idea per edit): delete dead code, merge duplicates, extract only when a piece is reused or does a separate job, rename for clarity.
4. Keep validation and error handling. Keep the codebase's existing conventions.
5. Re-run the tests.

Report what changed and why, the test results, and any behavior you were unsure about.
