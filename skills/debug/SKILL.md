---
name: debug
description: >
  Systematically find and fix the root cause of a bug, error or failing test.
  Use for "fix this error", "왜 안돼", "debug", stack traces, failing tests.
argument-hint: "<error message or symptom>"
---

# Debug

Symptom: $ARGUMENTS

1. **Reproduce.** Find or run the command that shows the failure (test, script, build). Record the exact error.
2. **Locate.** Use the stack trace or `grep` for the error text to find where it is thrown. Read that code and its callers.
3. **Hypothesize.** State one specific cause. Check it by reading code or adding a quick print/log, not by guessing.
4. **Fix the root cause** once, in the shared code, with the smallest change. Grep every caller of anything you change.
5. **Verify.** Re-run the reproducing command and related tests.
6. Remove temporary debug output.

Report: the cause (one sentence), the fix (file:line), how you verified it, and anything you could not verify.
