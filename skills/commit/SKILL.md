---
name: commit
description: >
  Review the current git changes and create a well-formed commit. Use for
  "commit", "커밋해줘", "write a commit message".
argument-hint: "[extra notes]"
---

# Commit

Notes from the user: $ARGUMENTS

1. Run `git status --short` and `git diff --staged`; if nothing is staged, run `git diff` too.
2. If nothing is staged, stage only the files that belong to this change (`git add <files>`).
   Never stage secrets (.env, keys, credentials) or build output.
3. Run `git log --oneline -5` to match the repository's message style.
4. Write the message:
   - Subject ≤ 72 chars, imperative mood ("Add", "Fix"), conventional prefix if the repo uses one (feat:, fix:, docs:).
   - Body: why the change was made. Skip the body for trivial changes.
5. Commit with `git commit -m "<subject>" -m "<body>"`.
6. Show `git log --oneline -1` and stop. Do not push unless asked.
