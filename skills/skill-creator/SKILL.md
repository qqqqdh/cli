---
name: skill-creator
description: >
  Create a new ollacode skill (SKILL.md) from the user's description. Use for
  "make a skill", "스킬 만들어줘", "create a skill for X".
argument-hint: "<what the skill should do>"
---

# Create a skill

Request: $ARGUMENTS

A skill is a folder containing `SKILL.md`: YAML frontmatter plus markdown instructions.
The same format works in Claude Code, Codex and Antigravity.

1. Ask at most one clarifying question if the purpose is unclear; otherwise proceed.
2. Choose a kebab-case name and location:
   - personal: `~/.ollacode/skills/<name>/SKILL.md` (Windows: `%USERPROFILE%\.ollacode\skills\<name>\SKILL.md`)
   - this project only: `.ollacode/skills/<name>/SKILL.md` in the working directory
3. Write it with `write_file` using this shape:

   ---
   name: <name>
   description: >
     What it does and when to use it, with trigger phrases (English and Korean).
   argument-hint: "<args>"
   ---

   # <Title>

   Input: $ARGUMENTS

   1. Concrete step with the exact tools or commands to use.
   2. ...

   ## Output
   What the final answer must contain.

4. Keep it under ~60 lines, imperative and specific. Put long reference material in extra files
   next to SKILL.md and tell the reader to `read_file` them.
5. Tell the user to run `/skills reload`, then invoke it with `/<name>`.
