---
name: code-review
description: >
  Review uncommitted changes, a commit or given files for bugs, security issues
  and missing tests. Use for "review", "리뷰해줘", "check my changes".
argument-hint: "[files | commit | branch]"
---

# Code review

Scope: $ARGUMENTS (default: uncommitted changes from `git diff HEAD`; if clean, the last commit via `git show HEAD`).

1. Get the diff. For each changed function, read the whole function and grep its callers.
2. Look for, in this order:
   1. Bugs: wrong logic, unhandled empty/null/zero, off-by-one, broken callers, wrong error handling.
   2. Security: injection (SQL, shell, path traversal), secrets in code, missing input validation.
   3. Data loss: swallowed errors, partial writes.
   4. Missing tests for risky new logic.
   5. Simplification: duplicated code, dead code, needless abstraction.
3. Only report issues with a concrete failing case ("input X → wrong result Y").

## Output

A ranked list. Each item: `file:line` — problem — concrete case — suggested fix.
End with a one-line verdict. Do not edit files unless the user asks.
(For a stricter review the user can run /ponytail-review.)
