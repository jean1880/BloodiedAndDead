# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file **Roll20 Mod (API) script** (`BloodiedAndDead.js`) that monitors a token health
bar and reacts to HP changes (status markers, critical tint, particle FX, chat announcements)
plus rolls unique HP pools for newly dropped tokens. `README.md` is the user-facing manual
(commands, config, caveats); `GEMINI.md` is an older design note kept for history.

## Runtime & deployment

Code runs in the **Roll20 API sandbox** (server-side JS, no DOM, shared global namespace).
There is no build, package manager, bundler, or deploy pipeline — the file *is* the artifact.
To "deploy": paste the whole file into a game's API Script editor. To debug: read `log()`
output and caught errors in Roll20's API Console.

Relied-upon sandbox globals (no imports): `on`, `state`, `log`, `getObj`, `findObjs`,
`sendChat`, `spawnFx`, `spawnFxBetweenPoints`, `randomInteger`, `playerIsGM`, `setTimeout`. Don't assume Node/browser
APIs beyond these.

## The only local check

```bash
node --check BloodiedAndDead.js   # syntax only
```

This validates syntax but **not behavior** — none of the Roll20 globals exist outside the
sandbox, so there is no local test runner. Real verification is manual, in-game. Treat the
sandbox as the acceptance gate; never claim runtime behavior is verified from `node --check`.

## Architecture (the parts that span files/functions)

The script is an **HP-state machine**, not a set of independent feature handlers. Understanding
this is the key to changing it safely:

- **`CLASSIFY(hp, max)`** is the single source of truth → `healthy | bloodied | critical |
  unconscious | dead`. Order of checks matters (instant-death before unconscious). Every
  feature derives from these states, so adjust classification here, not in callers.
- Behavior is driven by **state *transitions***, computed from the `change:graphic` event's
  `prev` snapshot — **`prev` is a plain `{prop: oldValue}` map, not a Roll20 object** (read it
  by key, e.g. `prev['bar3_value']`; it has no `.get()`).
- **`PROCESS_HP_CHANGE`** orchestrates one change: always reconcile visuals, then (only on a
  real transition) fire FX + announcements. `UPDATE_VISUALS` (markers + tint) is **idempotent**
  — it only writes properties that differ.

### Invariants you must preserve

- **No write loops.** Marker/tint writes re-fire `change:graphic`; the system stays stable only
  because (a) `UPDATE_VISUALS` writes nothing when already correct and (b) FX/announce bail when
  `prevHp === curHp`. Keep both properties when editing.
- **Add-cascade suppression.** Dropping a token fires a burst of change events (sheet
  population, bar linking, our own HP roll) that look like damage. `ON_ADD_GRAPHIC` flags the
  token id in `INITIALIZING` before any `obj.set`, and `PROCESS_HP_CHANGE` skips FX/announce
  while flagged (visuals still apply). Flag is cleared by a timer and by `destroy:graphic`.
- **Tint ownership.** Only ever manage the script's own `tintColor`; never clear/overwrite a
  tint the script didn't set (avoids clobbering GM/other-script tints).
- **Config lives in `state[SCRIPT_NAME]`.** Add new settings to `DEFAULT_CONFIG`; `INIT`
  back-fills them onto existing saved configs (`{...DEFAULT_CONFIG, ...saved}`), so older games
  upgrade automatically. `NORMALIZE_CONFIG` clamps thresholds at startup.
- **Commands are GM-only**, dispatched in `ON_MESSAGE` via the `FX_COMMANDS` / `TOGGLE_COMMANDS`
  tables (add a command by extending a table, not by adding another `if`). FX names are
  validated as a *warning only* (`IS_VALID_FX`) so presets and custom FX both work.

## Conventions

- Internal helpers are `const` arrow functions in **SCREAMING_SNAKE_CASE**; everything is
  wrapped in one IIFE (`BLOODIED_AND_DEAD`) exposing only `init()`.
- **All JS/TS in this project must be documented with JSDoc** — function descriptions plus
  `@param`/`@returns`, and `@typedef`s for shared shapes (`HpState`, `BloodiedConfig`,
  `Roll20Object`, `Roll20Prev`, `Position`). Match this when adding code.
- Roll20 FX presets are `"<type>-<color>"` (see `FX_TYPES` / `FX_COLORS`); a custom FX name
  defined in-game also works.
