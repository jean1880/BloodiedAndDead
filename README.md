# BloodiedAndDead

A Roll20 API script that automates token health feedback. It watches a configurable health
bar on every token and reacts to HP changes with status markers, a critical-wound tint,
dramatic particle effects, and 5e-flavoured chat announcements — and rolls a unique HP pool
for tokens dragged onto the map.

All behaviour is driven by HP **state transitions** (computed from each event's `prev`
snapshot), so effects and announcements fire once at the moment they happen and never on
no-op updates, token drags, or repositioning.

## Features

- **Status markers** — a *bloodied* marker at/under the bloodied threshold and a *dead* (X)
  marker once a token is at 0 HP or below.
- **Critical tint** — tints a token red while critically wounded (`0 < HP ≤ 20%`), clearing
  automatically when healed back above the threshold.
- **HP-change effects** — a blood splash scaled to the size of the hit, a magical sparkle on
  healing, and a distinct effect at the moment a token is felled or slain.
- **Announcements** — 5e-flavoured chat lines for *bloodied → gravely wounded → unconscious
  → slain → revived* transitions (public or whispered to the GM).
- **Instant death** — applies the 5e massive-damage rule: a hit whose overflow damage meets
  or exceeds the HP maximum kills outright instead of downing.
- **Revive handling** — healing a downed token above 0 clears the dead marker and announces
  the revival.
- **Unique HP rolling** — rolls each new token's Hit Dice formula into an independent HP pool
  (so identical monsters don't share a health total).
- **Durable settings** — all configuration lives in the Roll20 `state` object and survives
  sandbox restarts; new settings are back-filled onto existing games automatically.
- **Hardened** — wrapped in a closure with `try/catch` guards so malformed token data never
  crashes the sandbox.

## HP states

From most to least healthy (thresholds are configurable):

| State        | Condition                       | Effects                                  |
| ------------ | ------------------------------- | ---------------------------------------- |
| healthy      | `> 50%`                         | —                                        |
| bloodied     | `≤ 50%` (and `> 20%`)           | bloodied marker, "is bloodied" announce  |
| critical     | `≤ 20%` (and `> 0`)             | red tint, "gravely wounded" announce     |
| unconscious  | `≤ 0` (and `> -max`)            | dead marker, death FX, "falls unconscious" |
| dead         | `≤ -max` (massive damage)       | dead marker, death FX, "slain" announce  |

## Installation

1. In your Roll20 game go to **Settings → API Scripts** (requires a Pro subscription).
2. Add a new script and paste the contents of [`BloodiedAndDead.js`](./BloodiedAndDead.js).
3. Save. The script logs `BloodiedAndDead initialized.` to the API console on start.

By default it tracks **bar3**. Use `!ChangeBar` to change that.

## Commands (GM)

| Command | Description |
| --- | --- |
| `!ChangeBar <bar1\|bar2\|bar3>` | Set which bar tracks health. |
| `!BloodiedConfig` | Whisper the current configuration to the GM. |
| `!BloodFX <on\|off>` / `!BloodFX set <fx>` | Toggle / set the damage blood effect. |
| `!HealFX <on\|off>` / `!HealFX set <fx>` | Toggle / set the heal sparkle effect. |
| `!DeathFX <on\|off>` / `!DeathFX set <fx>` | Toggle / set the felled/slain effect. |
| `!Announce <on\|off>` | Toggle chat announcements. |
| `!Tint <on\|off>` | Toggle the critical-wound token tint. |
| `!InstantDeath <on\|off>` | Toggle the 5e massive-damage instant-death rule. |

FX presets follow Roll20's `"<type>-<color>"` format, e.g. `splatter-blood`, `bomb-blood`,
`glow-holy`, `glow-magic`, `burst-death`, `explode-death`, `nova-holy`. The name of a custom FX
defined in your game also works. When you `set` a name that is neither a known preset nor a
custom FX, the command still applies it but whispers a warning (in case it's a typo).

All commands are **GM-only**; players who try them get a whispered notice.

## Configuration

Defaults live in `DEFAULT_CONFIG` and are merged onto any saved config at startup, so adding
a new setting upgrades existing games without wiping customisations. Key options:

| Setting | Default | Meaning |
| --- | --- | --- |
| `barValue` | `bar3` | Bar tracked for HP. |
| `bloodiedThreshold` | `0.5` | Fraction of max HP at/under which a token is bloodied. |
| `criticalThreshold` | `0.2` | Fraction at/under which a token is critical (tint). |
| `heavyDamageThreshold` | `0.5` | Single-hit damage fraction that counts as a heavy hit. |
| `bloodFx` / `bloodFxHeavy` | `splatter-blood` / `bomb-blood` | Normal / heavy damage presets. |
| `healFx` | `glow-holy` | Healing preset. |
| `deathFx` | `burst-death` | Felling/slaying preset. |
| `tintColor` | `#cc0000` | Colour applied while critically wounded. |
| `announceWhisper` | `false` | `true` whispers announcements to the GM instead of the table. |
| `instantDeathEnabled` | `true` | Whether the 5e massive-damage rule applies. |

### Unique HP rolling

When a token that represents a character is dropped onto the map and its tracked bar value is
empty, the script reads the character's `npc_hpformula` attribute (e.g. `2d8+4`), rolls it,
and writes the result to both the bar's value and max (minimum 1).

## Notes & caveats

- **Newly added tokens are FX-suppressed briefly.** Dropping a token fires a cascade of
  property-change events (sheet population, bar linking, the HP roll) that would otherwise look
  like damage — so FX and announcements are held off for ~1.5s after a token is added (markers
  and tint still apply). Effects only fire for HP edits made after a token has settled.
- **Instant death needs the bar to go negative.** If your damage workflow clamps HP at 0, the
  `≤ -max` condition never triggers and a massive hit resolves as unconscious instead.
- **`!Tint on`/`off` sweeps every token** to apply or clear the tint immediately. This is a
  full scan and may take a moment in very large games. It only ever clears the script's own
  tint colour (`tintColor`), so a token you happened to tint the same hex by hand would also be
  cleared — pick a distinctive `tintColor` if that matters.
- **Multiple tokens of the same character with a *linked* HP bar share one HP pool.** Damaging
  one then fires the change event on every linked copy, so FX/announcements appear on all of
  them. Unique HP rolling deliberately gives monsters their own *unlinked* pools to avoid this;
  the caveat only applies if you link a bar to a character attribute and place duplicates.
- **Max-HP changes don't announce.** Buffing/debuffing a token's max so it crosses a threshold
  updates the marker and tint but does not post a chat line — announcements track damage/heals
  (value changes), not max changes.
- **Thresholds are validated at startup.** Out-of-range or inverted thresholds (e.g. critical
  above bloodied) are clamped to safe values, logged, and whispered to the GM.
- Requires a Roll20 **Pro** subscription (API scripts are a Pro feature).

## Development

The script is plain Roll20 sandbox JavaScript in a single file, wrapped in an IIFE module and
fully documented with JSDoc. Syntax-check before committing:

```bash
node --check BloodiedAndDead.js
```
