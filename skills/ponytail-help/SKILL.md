---
name: ponytail-help
description: >
  Quick reference for ponytail levels, skills and commands. One-shot display.
  Use for /ponytail-help, "ponytail help", "how do I use ponytail".
---

# Ponytail Help

Display this reference card when invoked. One-shot, do NOT change mode,
write flag files, or persist anything.

## Levels

| Level | Trigger | What change |
|-------|---------|-------------|
| **Lite** | `/ponytail lite` | Build what was asked, name the smaller option in one line. |
| **Full** | `/ponytail` | The smallest complete change, a check where the logic needs one, and a reply that names what was skipped and any risk. Default. |
| **Ultra** | `/ponytail ultra` | Also questions the request and pushes back before building. |

Level sticks until changed or session end.

## Skills

| Skill | Trigger | What it does |
|-------|---------|--------------|
| **ponytail** | `/ponytail` | Lazy mode itself: least new code, clear replies that name skipped work and risks. |
| **ponytail-review** | `/ponytail-review` | Quality review of a diff: bugs, security, load, missing tests, speed, what to cut. Each finding says what goes wrong and how to fix it. |
| **ponytail-audit** | `/ponytail-audit` | The same quality review for the whole repo, ranked. |
| **ponytail-debt** | `/ponytail-debt` | Harvest `shortcut:` comments into a tracked ledger. |
| **ponytail-gain** | `/ponytail-gain` | Measured-impact scoreboard: less code, less cost, more speed. |
| **ponytail-help** | `/ponytail-help` | This card. |

In ollacode, every skill is a slash command: `/ponytail-review`, `/ponytail-audit`, ...
The model can also load them itself with the load_skill tool.

## Deactivate

`/ponytail off` (or say "stop ponytail" / "normal mode"). Resume anytime with `/ponytail`.
The prompt shows 🐴 and the level while the mode is on.

## Configure Default Mode

Default is `off` in ollacode. Make a level start with every session:

- `/ponytail default full` (saved to ~/.ollacode/config.json as `"ponytail": "full"`)
- or start once with `ollacode --ponytail ultra`

## Update

These skills are vendored in ollacode's `skills/` folder. To update, copy newer SKILL.md files from
https://github.com/DietrichGebert/ponytail/tree/main/skills over them.

## More

Full docs + examples: https://github.com/DietrichGebert/ponytail
