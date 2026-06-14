/**
 * =========================================================================================
 * BLOODIED AND DEAD - Roll20 API Script
 * =========================================================================================
 *
 * OVERVIEW:
 * Monitors a configurable health bar on every token and reacts to HP changes by driving
 * status markers, a critical-wound tint, dramatic particle effects, and chat announcements.
 * It also rolls a unique HP pool for tokens dragged onto the map.
 *
 * All behaviour is keyed off HP *state transitions* (computed from the event's `prev`
 * snapshot), so effects and announcements fire once on the moment they happen and never on
 * no-op updates, token drags, or simple repositioning.
 *
 * HP STATES (high -> low):
 *   healthy     > bloodiedThreshold              (default > 50%)
 *   bloodied    <= bloodiedThreshold, > critical (default <= 50%)
 *   critical    <= criticalThreshold,  > 0       (default <= 20%, drives the red tint)
 *   unconscious <= 0, > -max                     (5e: a creature at 0 HP is unconscious)
 *   dead        <= -max                          (5e massive-damage / instant-death rule)
 *
 * FEATURES:
 * 1. Status Markers:    bloodied marker at/under the bloodied threshold; "dead" (X) marker
 *                       once a token is at 0 HP or below.
 * 2. Critical Tint:     tints the token red while critically wounded (0 < HP <= 20%),
 *                       clearing automatically when healed back above the threshold.
 * 3. HP Change FX:      scaled blood splash on damage, a magical sparkle on healing, and a
 *                       distinct effect at the moment a token is felled or slain.
 * 4. Announcements:     5e-flavoured chat lines for bloodied / gravely wounded / unconscious
 *                       / slain / revived transitions (public or GM-whispered).
 * 5. Instant Death:     applies the 5e massive-damage rule -- a hit whose overflow damage
 *                       meets or exceeds the HP maximum kills outright rather than downing.
 * 6. Revive Handling:   when a downed token is healed above 0, the dead marker clears and a
 *                       revival is announced.
 * 7. Unique HP Rolling: rolls each new token's Hit Dice formula into an independent HP pool.
 * 8. Durable Settings:  all configuration lives in the Roll20 `state` object and survives
 *                       sandbox restarts; new settings are back-filled onto existing games.
 * 9. Hardened:          wrapped in a closure with try/catch guards so malformed token data
 *                       never crashes the sandbox.
 *
 * COMMANDS (GM):
 *   !ChangeBar <bar1|bar2|bar3>      Set which bar tracks health.
 *   !BloodiedConfig                  Whisper the current configuration to the GM.
 *   !BloodFX <on|off|set <fx>>       Toggle / set the damage blood effect (e.g. splatter-blood).
 *   !HealFX  <on|off|set <fx>>       Toggle / set the heal sparkle effect (e.g. glow-holy).
 *   !DeathFX <on|off|set <fx>>       Toggle / set the felled/slain effect (e.g. burst-death).
 *   !Announce <on|off>               Toggle chat announcements.
 *   !Tint <on|off>                   Toggle the critical-wound token tint.
 *   !InstantDeath <on|off>           Toggle the 5e massive-damage instant-death rule.
 *
 * Roll20 FX presets are "<type>-<color>", e.g. splatter-blood, bomb-blood, glow-holy,
 * glow-magic, burst-death, explode-death, nova-holy.
 * =========================================================================================
 */

/**
 * A Roll20 sandbox object (token, character, attribute, ...).
 * Exposes a getter/setter interface over its underlying properties.
 *
 * @typedef {object} Roll20Object
 * @property {(prop: string) => *} get  - Reads a single property value.
 * @property {(props: object|string, value?: *) => void} set - Writes one or many properties.
 */

/**
 * The pre-change snapshot passed to `change:` event handlers. A plain map of property name to
 * the value it held *before* the change, read by key (e.g. `prev['bar3_value']`) -- it is NOT
 * a Roll20Object and has no `get`/`set`.
 *
 * @typedef {Object<string, *>} Roll20Prev
 */

/**
 * A point at which to spawn a particle effect, on a specific page.
 *
 * @typedef {object} Position
 * @property {number} x      - X coordinate in map pixels (token centre / `left`).
 * @property {number} y      - Y coordinate in map pixels (token centre / `top`).
 * @property {string} pageid - The page the token lives on (`_pageid`).
 */

/**
 * A classified HP state. Ordered most-healthy to least.
 *
 * @typedef {('healthy'|'bloodied'|'critical'|'unconscious'|'dead')} HpState
 */

/**
 * Persistent configuration, stored on `state[SCRIPT_NAME]`.
 *
 * @typedef {object} BloodiedConfig
 * @property {string}  barValue             - Tracked bar: 'bar1' | 'bar2' | 'bar3'.
 * @property {string}  bloodiedMarker       - Status-marker name used for the bloodied state.
 * @property {string}  deadMarker           - Status-marker name used for the downed/dead state.
 * @property {string}  hpFormulaAttr        - Attribute holding a new token's Hit Dice formula.
 * @property {number}  bloodiedThreshold    - Fraction of max HP at/under which a token is bloodied.
 * @property {number}  criticalThreshold    - Fraction of max HP at/under which a token is critical.
 * @property {number}  heavyDamageThreshold - Single-hit damage fraction that counts as a heavy hit.
 * @property {boolean} bloodFxEnabled       - Whether damage spawns a blood effect.
 * @property {string}  bloodFx              - FX preset for normal damage.
 * @property {string}  bloodFxHeavy         - FX preset for heavy hits.
 * @property {boolean} healFxEnabled        - Whether healing spawns a sparkle effect.
 * @property {string}  healFx               - FX preset for healing.
 * @property {boolean} deathFxEnabled       - Whether being felled/slain spawns a death effect.
 * @property {string}  deathFx              - FX preset for the felling/slaying moment.
 * @property {boolean} tintEnabled          - Whether critically wounded tokens are tinted.
 * @property {string}  tintColor            - Hex colour applied while critically wounded.
 * @property {boolean} announceEnabled      - Whether state transitions are announced in chat.
 * @property {boolean} announceWhisper      - true = whisper to GM, false = public.
 * @property {boolean} instantDeathEnabled  - Whether the 5e massive-damage rule applies.
 */

const BLOODIED_AND_DEAD = (() => {
    /** @type {string} Module name; also the key under which config is stored in `state`. */
    const SCRIPT_NAME = 'BloodiedAndDead';

    /** @type {string[]} Bar names accepted by !ChangeBar. */
    const ACCEPTED_BARS = ['bar1', 'bar2', 'bar3'];

    /** @type {string[]} Built-in Roll20 FX effect types (the "<type>" in "<type>-<color>"). */
    const FX_TYPES = ['beam', 'bomb', 'breath', 'bubbling', 'burn', 'burst', 'explode', 'glow', 'missile', 'nova', 'splatter'];

    /** @type {string[]} Built-in Roll20 FX colours (the "<color>" in "<type>-<color>"). */
    const FX_COLORS = ['acid', 'blood', 'charm', 'death', 'fire', 'frost', 'holy', 'magic', 'slime', 'smoke', 'water'];

    /**
     * Milliseconds to suppress FX/announcements after a token is added, while Roll20 settles
     * its properties. Dropping a token fires a cascade of change events (sheet population, bar
     * linking, and our own HP roll); without this window those would be misread as damage.
     * @type {number}
     */
    const INIT_SETTLE_MS = 1500;

    /**
     * Ids of tokens currently in their post-add settle window. Changes to these tokens still
     * reconcile markers/tint but do not spawn FX or announce, so adding several identical
     * creatures never produces spurious effects. Keyed by token id.
     * @type {Object<string, boolean>}
     */
    const INITIALIZING = {};

    // -------------------------------------------------------------------------------------
    // CONFIGURATION
    // Defaults are merged onto any saved config at init, so adding a key here automatically
    // upgrades existing games without wiping their customisations.
    // -------------------------------------------------------------------------------------

    /**
     * Default configuration, merged over any saved config at init.
     * @type {BloodiedConfig}
     */
    const DEFAULT_CONFIG = {
        // Core tracking
        barValue: 'bar3',
        bloodiedMarker: 'redmarker',
        deadMarker: 'dead',
        hpFormulaAttr: 'npc_hpformula',

        // Thresholds (fractions of max HP)
        bloodiedThreshold: 0.5,   // <= this -> bloodied
        criticalThreshold: 0.2,   // <= this (and > 0) -> critical (tint)
        heavyDamageThreshold: 0.5, // single-hit damage >= this fraction of max -> heavy FX

        // Damage (blood) effect
        bloodFxEnabled: true,
        bloodFx: 'splatter-blood',
        bloodFxHeavy: 'bomb-blood',

        // Heal (sparkle) effect
        healFxEnabled: true,
        healFx: 'glow-holy',

        // Felled / slain effect
        deathFxEnabled: true,
        deathFx: 'burst-death',

        // Critical-wound token tint
        tintEnabled: true,
        tintColor: '#cc0000',

        // Chat announcements
        announceEnabled: true,
        announceWhisper: false,   // false = public, true = whisper to GM

        // 5e massive-damage instant death
        instantDeathEnabled: true
    };

    /**
     * Returns the live, persisted configuration object.
     * @returns {BloodiedConfig} The current config stored on `state`.
     */
    const CFG = () => state[SCRIPT_NAME];

    // -------------------------------------------------------------------------------------
    // SMALL HELPERS
    // -------------------------------------------------------------------------------------

    /**
     * Whispers a message to the GM (used for command feedback).
     * @param {string} text - Message body; Roll20 chat markup/HTML is allowed.
     * @returns {void}
     */
    const WHISPER_GM = (text) => sendChat(SCRIPT_NAME, `/w gm ${text}`);

    /**
     * Announces a transition to the table, honouring the announce toggles.
     * Does nothing when announcements are disabled; whispers or broadcasts per config.
     * @param {string} text - Message body; Roll20 chat markup/HTML is allowed.
     * @returns {void}
     */
    const ANNOUNCE = (text) => {
        const CONFIG = CFG();
        if (!CONFIG.announceEnabled) return;
        if (CONFIG.announceWhisper) WHISPER_GM(text);
        else sendChat(SCRIPT_NAME, text);
    };

    /**
     * Best-effort display name for a token: token name -> character name -> fallback.
     * @param {Roll20Object} obj - The token graphic.
     * @returns {string} A human-readable name, never empty.
     */
    const TOKEN_NAME = (obj) => {
        let name = obj.get('name');
        if (!name) {
            const charId = obj.get('represents');
            if (charId) {
                const character = getObj('character', charId);
                if (character) name = character.get('name');
            }
        }
        return name || 'A creature';
    };

    /**
     * Builds an FX spawn position from a token's location.
     * @param {Roll20Object} obj - The token graphic.
     * @returns {?Position} The position, or null if the token has no valid coordinates/page.
     */
    const TOKEN_POS = (obj) => {
        const x = obj.get('left');
        const y = obj.get('top');
        const pageid = obj.get('_pageid');
        if (typeof x !== 'number' || typeof y !== 'number' || !pageid) return null;
        return { x, y, pageid };
    };

    /**
     * Returns a slightly randomised copy of a position so stacked effects don't perfectly
     * overlap (offset by +/-20px on each axis).
     * @param {Position} pos - The base position.
     * @returns {Position} A jittered position on the same page.
     */
    const JITTER = (pos) => ({
        x: pos.x + (randomInteger(41) - 21),
        y: pos.y + (randomInteger(41) - 21),
        pageid: pos.pageid
    });

    /**
     * Spawns a single built-in FX preset at a position. No-op on missing args.
     * @param {?Position} pos    - Where to spawn; ignored if null.
     * @param {?string}   effect - FX preset name (e.g. 'splatter-blood'); ignored if falsy.
     * @returns {void}
     */
    const SPAWN = (pos, effect) => {
        if (!pos || !effect) return;
        spawnFx(pos.x, pos.y, effect, pos.pageid);
    };

    /**
     * Whether an FX name looks usable: either a built-in "<type>-<color>" preset or the name
     * of a custom FX defined in the game. Used to warn (not block) on likely typos, so future
     * presets and custom effects are never rejected outright.
     * @param {string} name - The FX preset/custom name to check.
     * @returns {boolean} True if it matches a known preset or an existing custom FX.
     */
    const IS_VALID_FX = (name) => {
        const parts = String(name).toLowerCase().split('-');
        if (parts.length === 2 && FX_TYPES.includes(parts[0]) && FX_COLORS.includes(parts[1])) {
            return true;
        }
        return findObjs({ type: 'custfx', name }).length > 0;
    };

    // -------------------------------------------------------------------------------------
    // DICE
    // -------------------------------------------------------------------------------------

    /**
     * Parses a simple dice formula and rolls it.
     * @param {string} formula - A formula like "2d8+4" (whitespace and case insensitive).
     * @returns {?number} The rolled total (minimum 1), or null if the formula is invalid.
     */
    const ROLL_HP = (formula) => {
        try {
            if (!formula) return null;

            const MATCH = formula.toLowerCase().replace(/\s/g, '').match(/^(\d+)d(\d+)([+-]\d+)?$/);
            if (!MATCH) return null;

            const NUM_DICE = parseInt(MATCH[1]);
            const DIE_SIZE = parseInt(MATCH[2]);
            const MODIFIER = MATCH[3] ? parseInt(MATCH[3]) : 0;

            let total = MODIFIER;
            for (let i = 0; i < NUM_DICE; i++) {
                total += randomInteger(DIE_SIZE);
            }
            return Math.max(1, total);
        } catch (e) {
            log(`${SCRIPT_NAME} Error (ROLL_HP): ${e.message}`);
            return null;
        }
    };

    // -------------------------------------------------------------------------------------
    // HP STATE CLASSIFICATION
    // -------------------------------------------------------------------------------------

    /**
     * Maps an HP value to a state name. The order of checks matters: instant death is tested
     * before unconsciousness so a massive-damage blow resolves as 'dead' rather than 'down'.
     * @param {number} hp  - Current hit points (may be negative).
     * @param {number} max - Maximum hit points (assumed > 0 by callers).
     * @returns {HpState} The classified state.
     */
    const CLASSIFY = (hp, max) => {
        const CONFIG = CFG();
        if (max <= 0) return 'healthy';

        if (CONFIG.instantDeathEnabled && hp <= -max) return 'dead';
        if (hp <= 0) return 'unconscious';

        const ratio = hp / max;
        if (ratio <= CONFIG.criticalThreshold) return 'critical';
        if (ratio <= CONFIG.bloodiedThreshold) return 'bloodied';
        return 'healthy';
    };

    /**
     * Whether a state represents a token that is down (out of the fight).
     * @param {HpState} s - The state to test.
     * @returns {boolean} True for 'unconscious' or 'dead'.
     */
    const IS_DOWN_STATE = (s) => s === 'unconscious' || s === 'dead';

    // -------------------------------------------------------------------------------------
    // VISUALS: status markers + critical tint
    // -------------------------------------------------------------------------------------

    /**
     * Reconciles a token's status markers and critical tint with its current HP.
     * Idempotent: only writes properties that actually need to change.
     * @param {Roll20Object} obj   - The token graphic.
     * @param {number}       curHp - Current hit points.
     * @param {number}       maxHp - Maximum hit points (> 0).
     * @returns {void}
     */
    const UPDATE_VISUALS = (obj, curHp, maxHp) => {
        const CONFIG = CFG();
        const ratio = curHp / maxHp;

        const IS_BLOODIED = ratio <= CONFIG.bloodiedThreshold;
        const IS_DOWN = curHp <= 0;
        const IS_CRITICAL = curHp > 0 && ratio <= CONFIG.criticalThreshold;

        const UPDATES = {};

        if (obj.get(`status_${CONFIG.bloodiedMarker}`) !== IS_BLOODIED) {
            UPDATES[`status_${CONFIG.bloodiedMarker}`] = IS_BLOODIED;
        }
        if (obj.get(`status_${CONFIG.deadMarker}`) !== IS_DOWN) {
            UPDATES[`status_${CONFIG.deadMarker}`] = IS_DOWN;
        }

        if (CONFIG.tintEnabled) {
            // Only ever manage *our own* tint, so we never clobber a tint set by the GM or
            // another script. 'transparent' is Roll20's "no tint" value.
            const curTint = obj.get('tint_color');
            if (IS_CRITICAL) {
                if (curTint !== CONFIG.tintColor) UPDATES['tint_color'] = CONFIG.tintColor;
            } else if (curTint === CONFIG.tintColor) {
                UPDATES['tint_color'] = 'transparent';
            }
        }

        if (Object.keys(UPDATES).length > 0) obj.set(UPDATES);
    };

    /**
     * Reads current HP/max off a token and reconciles its visuals. Used when a token is
     * added (no `prev` snapshot is available). Bails on non-numeric or zero-max HP.
     * @param {Roll20Object} obj - The token graphic.
     * @returns {void}
     */
    const RECONCILE_VISUALS = (obj) => {
        const BAR = CFG().barValue;
        const curHp = parseFloat(obj.get(`${BAR}_value`));
        const maxHp = parseFloat(obj.get(`${BAR}_max`));
        if (isNaN(curHp) || isNaN(maxHp) || maxHp <= 0) return;
        UPDATE_VISUALS(obj, curHp, maxHp);
    };

    /**
     * Sweeps every token in the game when the tint feature is toggled: re-applies the tint
     * from current HP when enabling, or clears *our* tint (only `tintColor`) when disabling.
     * This is a deliberate, GM-invoked full scan and may take a moment in large games.
     * @param {boolean} enabled - The new tint-enabled state.
     * @returns {void}
     */
    const SWEEP_TINTS = (enabled) => {
        const CONFIG = CFG();
        const tokens = findObjs({ type: 'graphic', subtype: 'token' });
        tokens.forEach((token) => {
            try {
                if (enabled) {
                    RECONCILE_VISUALS(token);
                } else if (token.get('tint_color') === CONFIG.tintColor) {
                    token.set('tint_color', 'transparent');
                }
            } catch (e) {
                log(`${SCRIPT_NAME} Error (SWEEP_TINTS): ${e.message}`);
            }
        });
    };

    // -------------------------------------------------------------------------------------
    // EFFECTS: scaled damage, heal, and death
    // -------------------------------------------------------------------------------------

    /**
     * Spawns blood FX scaled to how big the hit was relative to the token's max HP:
     *  - heavy   (>= heavyDamageThreshold): a big burst plus a splatter
     *  - moderate (>= half that):           two offset splatters
     *  - light:                             a single splatter
     * @param {Position} pos    - Where to spawn the effect.
     * @param {number}   damage - Amount of HP lost in this hit (positive).
     * @param {number}   maxHp  - The token's maximum HP, for scaling.
     * @returns {void}
     */
    const SPAWN_SCALED_DAMAGE = (pos, damage, maxHp) => {
        const CONFIG = CFG();
        const ratio = maxHp > 0 ? damage / maxHp : 0;

        if (ratio >= CONFIG.heavyDamageThreshold) {
            SPAWN(pos, CONFIG.bloodFxHeavy);
            SPAWN(pos, CONFIG.bloodFx);
        } else if (ratio >= CONFIG.heavyDamageThreshold / 2) {
            SPAWN(pos, CONFIG.bloodFx);
            SPAWN(JITTER(pos), CONFIG.bloodFx);
        } else {
            SPAWN(pos, CONFIG.bloodFx);
        }
    };

    /**
     * Picks and spawns the appropriate effect for an HP change. Felling or slaying a token
     * shows the death effect (when enabled) instead of blood; otherwise damage shows scaled
     * blood and healing shows the sparkle.
     * @param {Roll20Object} obj       - The token graphic.
     * @param {number}       curHp     - Current hit points (after the change).
     * @param {number}       prevHp    - Previous hit points (before the change).
     * @param {number}       maxHp     - Maximum hit points.
     * @param {HpState}      prevState - State before the change.
     * @param {HpState}      curState  - State after the change.
     * @returns {void}
     */
    const HANDLE_FX = (obj, curHp, prevHp, maxHp, prevState, curState) => {
        const CONFIG = CFG();
        const pos = TOKEN_POS(obj);
        if (!pos) return;

        const justFelled = IS_DOWN_STATE(curState) && !IS_DOWN_STATE(prevState);
        const justSlain = curState === 'dead' && prevState !== 'dead';

        if (curHp < prevHp) {
            if ((justFelled || justSlain) && CONFIG.deathFxEnabled) {
                SPAWN(pos, CONFIG.deathFx);
            } else if (CONFIG.bloodFxEnabled) {
                SPAWN_SCALED_DAMAGE(pos, prevHp - curHp, maxHp);
            }
        } else if (curHp > prevHp && CONFIG.healFxEnabled) {
            SPAWN(pos, CONFIG.healFx);
        }
    };

    // -------------------------------------------------------------------------------------
    // ANNOUNCEMENTS
    // -------------------------------------------------------------------------------------

    /**
     * Announces a state transition in chat. Worsening states announce their new severity;
     * recovering from a downed state announces a revival. No-op when the state is unchanged.
     * @param {Roll20Object} obj       - The token graphic.
     * @param {HpState}      prevState - State before the change.
     * @param {HpState}      curState  - State after the change.
     * @returns {void}
     */
    const HANDLE_ANNOUNCE = (obj, prevState, curState) => {
        if (prevState === curState) return;

        const NAME = TOKEN_NAME(obj);

        // Revival: was down, now alive again.
        if (IS_DOWN_STATE(prevState) && !IS_DOWN_STATE(curState)) {
            ANNOUNCE(`&#128154; **${NAME}** is back on their feet!`);
            return;
        }

        switch (curState) {
            case 'dead':
                ANNOUNCE(`&#128128; **${NAME}** is slain by massive damage!`);
                break;
            case 'unconscious':
                ANNOUNCE(`&#9760;&#65039; **${NAME}** falls unconscious!`);
                break;
            case 'critical':
                // Only when newly worsening into critical from a healthier state.
                if (prevState === 'healthy' || prevState === 'bloodied') {
                    ANNOUNCE(`&#129656; **${NAME}** is gravely wounded!`);
                }
                break;
            case 'bloodied':
                if (prevState === 'healthy') {
                    ANNOUNCE(`&#129656; **${NAME}** is bloodied!`);
                }
                break;
            // 'healthy' -> no announcement.
        }
    };

    // -------------------------------------------------------------------------------------
    // ORCHESTRATION
    // -------------------------------------------------------------------------------------

    /**
     * Processes a single HP change for a token: always reconciles visuals, and additionally
     * fires FX and announcements when a real transition (known previous value) occurred.
     * Changes to a token still inside its post-add settle window only reconcile visuals, so
     * placing several identical creatures never triggers FX from the add cascade.
     * @param {Roll20Object} obj  - The token graphic.
     * @param {?Roll20Prev}  prev - The pre-change snapshot from the change event, if any.
     * @returns {void}
     */
    const PROCESS_HP_CHANGE = (obj, prev) => {
        const BAR = CFG().barValue;

        const curHp = parseFloat(obj.get(`${BAR}_value`));
        const maxHp = parseFloat(obj.get(`${BAR}_max`));
        if (isNaN(curHp) || isNaN(maxHp) || maxHp <= 0) return;

        // Always keep markers and tint in sync with the current HP.
        UPDATE_VISUALS(obj, curHp, maxHp);

        // Don't treat a token's add/initialisation cascade as in-combat damage.
        if (INITIALIZING[obj.id]) return;

        // FX and announcements need a known previous value and an actual change.
        const prevHp = prev ? parseFloat(prev[`${BAR}_value`]) : NaN;
        if (isNaN(prevHp) || curHp === prevHp) return;

        const prevState = CLASSIFY(prevHp, maxHp);
        const curState = CLASSIFY(curHp, maxHp);

        HANDLE_FX(obj, curHp, prevHp, maxHp, prevState, curState);
        HANDLE_ANNOUNCE(obj, prevState, curState);
    };

    // -------------------------------------------------------------------------------------
    // HP GENERATION (on token add)
    // -------------------------------------------------------------------------------------

    /**
     * Rolls a unique HP pool for a freshly added token from its character's Hit Dice formula.
     * No-op unless the token represents a character, its tracked bar value is empty, and the
     * configured formula attribute exists and parses.
     * @param {Roll20Object} obj - The newly added token graphic.
     * @returns {void}
     */
    const GENERATE_TOKEN_HP = (obj) => {
        const CONFIG = CFG();
        const CHARACTER_ID = obj.get('represents');

        if (!CHARACTER_ID || obj.get(`${CONFIG.barValue}_value`) !== "") return;

        const CHARACTER = getObj('character', CHARACTER_ID);
        if (!CHARACTER) return;

        const FORMULA_ATTR = findObjs({
            type: 'attribute',
            characterid: CHARACTER_ID,
            name: CONFIG.hpFormulaAttr
        })[0];

        if (FORMULA_ATTR) {
            const FORMULA = FORMULA_ATTR.get('current');
            const ROLLED_HP = ROLL_HP(FORMULA);

            if (ROLLED_HP) {
                log(`${SCRIPT_NAME}: Rolled ${ROLLED_HP} HP for ${obj.get('name')} using ${FORMULA}`);
                obj.set({
                    [`${CONFIG.barValue}_value`]: ROLLED_HP,
                    [`${CONFIG.barValue}_max`]: ROLLED_HP
                });
            }
        }
    };

    // -------------------------------------------------------------------------------------
    // COMMANDS
    // -------------------------------------------------------------------------------------

    /**
     * Definition of an effect command (accepts "<cmd> on|off" and "<cmd> set <preset>").
     * @typedef {object} FxCommandDef
     * @property {string} enabledKey - Config boolean key toggled by on/off.
     * @property {string} fxKey      - Config string key set by "set <preset>".
     * @property {string} label      - Human-readable label for feedback messages.
     * @property {string} example    - Example presets shown in usage text.
     */

    /**
     * Effect commands, keyed by lowercase command word.
     * @type {Object<string, FxCommandDef>}
     */
    const FX_COMMANDS = {
        '!bloodfx': { enabledKey: 'bloodFxEnabled', fxKey: 'bloodFx', label: 'Blood splash effect', example: 'splatter-blood, bomb-blood' },
        '!healfx':  { enabledKey: 'healFxEnabled',  fxKey: 'healFx',  label: 'Heal sparkle effect', example: 'glow-holy, glow-magic' },
        '!deathfx': { enabledKey: 'deathFxEnabled', fxKey: 'deathFx', label: 'Death effect',         example: 'burst-death, explode-death' }
    };

    /**
     * Definition of a simple toggle command (accepts "<cmd> on|off").
     * @typedef {object} ToggleCommandDef
     * @property {string} key   - Config boolean key toggled by on/off.
     * @property {string} label - Human-readable label for feedback messages.
     */

    /**
     * Simple toggle commands, keyed by lowercase command word.
     * @type {Object<string, ToggleCommandDef>}
     */
    const TOGGLE_COMMANDS = {
        '!announce':     { key: 'announceEnabled',     label: 'State announcements' },
        '!tint':         { key: 'tintEnabled',         label: 'Critical-wound tint' },
        '!instantdeath': { key: 'instantDeathEnabled', label: 'Massive-damage instant death' }
    };

    /**
     * Whether the message sender may run config commands. API/script-originated messages
     * (no playerid, or the 'API' sentinel) and the GM are allowed; players are not.
     * @param {{playerid?: string}} msg - The incoming chat message.
     * @returns {boolean} True if the sender is allowed to run GM commands.
     */
    const IS_GM = (msg) => !msg.playerid || msg.playerid === 'API' || playerIsGM(msg.playerid);

    /**
     * Whispers the full current configuration to the GM.
     * @returns {void}
     */
    const SHOW_CONFIG = () => {
        const c = CFG();
        /** @param {number} f - A fraction (0..1). @returns {string} Percentage label. */
        const pct = (f) => `${Math.round(f * 100)}%`;
        const lines = [
            `**${SCRIPT_NAME} Configuration**`,
            `Tracked bar: ${c.barValue}`,
            `Bloodied at ${pct(c.bloodiedThreshold)} | Critical at ${pct(c.criticalThreshold)} | Heavy hit at ${pct(c.heavyDamageThreshold)}`,
            `Blood FX: ${c.bloodFxEnabled ? `${c.bloodFx} (heavy: ${c.bloodFxHeavy})` : 'off'}`,
            `Heal FX: ${c.healFxEnabled ? c.healFx : 'off'}`,
            `Death FX: ${c.deathFxEnabled ? c.deathFx : 'off'}`,
            `Critical tint: ${c.tintEnabled ? c.tintColor : 'off'}`,
            `Announcements: ${c.announceEnabled ? (c.announceWhisper ? 'GM only' : 'public') : 'off'}`,
            `Instant death: ${c.instantDeathEnabled ? 'on' : 'off'}`
        ];
        WHISPER_GM(lines.join('<br>'));
    };

    /**
     * Chat command handler. Dispatches !ChangeBar, !BloodiedConfig, the effect commands
     * (FX_COMMANDS), and the simple toggles (TOGGLE_COMMANDS). Ignores non-API messages.
     * @param {{type: string, content: string}} msg - The incoming chat message.
     * @returns {void}
     */
    const ON_MESSAGE = (msg) => {
        if (msg.type !== 'api') return;

        try {
            const PARTS = msg.content.split(/\s+/);
            const COMMAND = PARTS[0]?.toLowerCase();
            const CONFIG = CFG();

            // Only react to our own commands, and only from the GM (all are config controls).
            const IS_OUR_COMMAND = COMMAND === '!changebar' || COMMAND === '!bloodiedconfig'
                || !!FX_COMMANDS[COMMAND] || !!TOGGLE_COMMANDS[COMMAND];
            if (!IS_OUR_COMMAND) return;
            if (!IS_GM(msg)) {
                sendChat(SCRIPT_NAME, `/w "${msg.who}" That command is GM-only.`);
                return;
            }

            // --- Standalone commands ---
            if (COMMAND === '!changebar') {
                const NEW_BAR = PARTS[1]?.toLowerCase();
                if (ACCEPTED_BARS.includes(NEW_BAR)) {
                    CONFIG.barValue = NEW_BAR;
                    WHISPER_GM(`Health monitoring changed to **${NEW_BAR}**.`);
                    log(`${SCRIPT_NAME}: Bar changed to ${NEW_BAR}`);
                } else {
                    WHISPER_GM(`Invalid bar. Use: !ChangeBar &lt;bar1|bar2|bar3&gt;`);
                }
                return;
            }

            if (COMMAND === '!bloodiedconfig') {
                SHOW_CONFIG();
                return;
            }

            // --- Effect commands (on|off|set) ---
            if (FX_COMMANDS[COMMAND]) {
                const def = FX_COMMANDS[COMMAND];
                const ARG = PARTS[1]?.toLowerCase();
                if (ARG === 'on' || ARG === 'off') {
                    CONFIG[def.enabledKey] = (ARG === 'on');
                    WHISPER_GM(`${def.label} **${ARG === 'on' ? 'enabled' : 'disabled'}**.`);
                } else if (ARG === 'set' && PARTS[2]) {
                    const FX = PARTS[2];
                    CONFIG[def.fxKey] = FX;
                    const warn = IS_VALID_FX(FX) ? '' : ' &#9888; that doesn\'t look like a known preset or custom FX -- set anyway.';
                    WHISPER_GM(`${def.label} set to **${FX}**.${warn}`);
                } else {
                    WHISPER_GM(`Usage: ${COMMAND} &lt;on|off&gt; or ${COMMAND} set &lt;effect-color&gt; (e.g. ${def.example})`);
                }
                return;
            }

            // --- Simple toggles (on|off) ---
            if (TOGGLE_COMMANDS[COMMAND]) {
                const def = TOGGLE_COMMANDS[COMMAND];
                const ARG = PARTS[1]?.toLowerCase();
                if (ARG === 'on' || ARG === 'off') {
                    const ENABLED = (ARG === 'on');
                    CONFIG[def.key] = ENABLED;
                    WHISPER_GM(`${def.label} **${ENABLED ? 'enabled' : 'disabled'}**.`);
                    // Toggling the tint sweeps existing tokens (set flag first so re-apply works).
                    if (COMMAND === '!tint') SWEEP_TINTS(ENABLED);
                } else {
                    WHISPER_GM(`Usage: ${COMMAND} &lt;on|off&gt;`);
                }
                return;
            }
        } catch (e) {
            log(`${SCRIPT_NAME} Error (ON_MESSAGE): ${e.message}`);
        }
    };

    // -------------------------------------------------------------------------------------
    // EVENTS
    // -------------------------------------------------------------------------------------

    /**
     * `change:graphic` handler. Processes the HP change for token graphics only.
     * @param {Roll20Object} obj  - The changed graphic.
     * @param {?Roll20Prev}  prev - The pre-change snapshot.
     * @returns {void}
     */
    const ON_GRAPHIC_CHANGE = (obj, prev) => {
        try {
            if (obj.get('_type') !== 'graphic' || obj.get('_subtype') !== 'token') return;
            PROCESS_HP_CHANGE(obj, prev);
        } catch (e) {
            log(`${SCRIPT_NAME} Error (ON_GRAPHIC_CHANGE): ${e.message}`);
        }
    };

    /**
     * `add:graphic` handler. Rolls the token's HP pool, then syncs markers/tint. Marks the
     * token as initialising for a short settle window so the add cascade (and our own HP roll)
     * doesn't spawn FX or announcements; a freshly added token has no meaningful transition.
     * @param {Roll20Object} obj - The added graphic.
     * @returns {void}
     */
    const ON_ADD_GRAPHIC = (obj) => {
        try {
            if (obj.get('_type') !== 'graphic' || obj.get('_subtype') !== 'token') return;

            // Flag before any obj.set so the resulting change events are suppressed.
            INITIALIZING[obj.id] = true;
            GENERATE_TOKEN_HP(obj);
            RECONCILE_VISUALS(obj);
            setTimeout(() => { delete INITIALIZING[obj.id]; }, INIT_SETTLE_MS);
        } catch (e) {
            log(`${SCRIPT_NAME} Error (ON_ADD_GRAPHIC): ${e.message}`);
        }
    };

    /**
     * `destroy:graphic` handler. Clears any settle-window flag for a removed token so a token
     * deleted mid-window never leaves a dangling entry in INITIALIZING.
     * @param {Roll20Object} obj - The destroyed graphic.
     * @returns {void}
     */
    const ON_DESTROY_GRAPHIC = (obj) => {
        try {
            if (obj && obj.id) delete INITIALIZING[obj.id];
        } catch (e) {
            log(`${SCRIPT_NAME} Error (ON_DESTROY_GRAPHIC): ${e.message}`);
        }
    };

    // -------------------------------------------------------------------------------------
    // INIT
    // -------------------------------------------------------------------------------------

    /**
     * Validates and corrects threshold config to safe per-field ranges, ensuring critical is
     * never above bloodied. Out-of-range or non-numeric values fall back to defaults or are
     * clamped; corrections are logged and whispered to the GM.
     * @returns {void}
     */
    const NORMALIZE_CONFIG = () => {
        const c = CFG();
        const fixes = [];

        /**
         * Clamps one numeric config field into [lo, hi], substituting the default if invalid.
         * @param {string} key - Config key to clamp.
         * @param {number} lo  - Minimum allowed value.
         * @param {number} hi  - Maximum allowed value.
         * @returns {void}
         */
        const clamp = (key, lo, hi) => {
            const v = c[key];
            const valid = typeof v === 'number' && !isNaN(v);
            if (!valid || v < lo || v > hi) {
                const base = valid ? v : DEFAULT_CONFIG[key];
                const nv = Math.min(hi, Math.max(lo, base));
                c[key] = nv;
                fixes.push(`${key} -> ${nv}`);
            }
        };

        clamp('bloodiedThreshold', 0.01, 0.99);
        clamp('criticalThreshold', 0.01, 0.99);
        clamp('heavyDamageThreshold', 0.05, 1);

        if (c.criticalThreshold > c.bloodiedThreshold) {
            c.criticalThreshold = c.bloodiedThreshold;
            fixes.push(`criticalThreshold -> ${c.criticalThreshold} (capped to bloodied)`);
        }

        if (fixes.length) {
            log(`${SCRIPT_NAME}: config auto-corrected: ${fixes.join(', ')}`);
            WHISPER_GM(`Config auto-corrected: ${fixes.join(', ')}`);
        }
    };

    /**
     * Initialises persistent config (creating or back-filling it) and registers event
     * handlers. Called once on `ready`.
     * @returns {void}
     */
    const INIT = () => {
        if (!state[SCRIPT_NAME]) {
            state[SCRIPT_NAME] = { ...DEFAULT_CONFIG };
        } else {
            // Back-fill any keys added in newer versions onto existing saved configs.
            state[SCRIPT_NAME] = { ...DEFAULT_CONFIG, ...state[SCRIPT_NAME] };
        }

        NORMALIZE_CONFIG();

        log(`${SCRIPT_NAME} initialized. Monitoring ${state[SCRIPT_NAME].barValue}.`);

        on('chat:message', ON_MESSAGE);
        on('change:graphic', ON_GRAPHIC_CHANGE);
        on('add:graphic', ON_ADD_GRAPHIC);
        on('destroy:graphic', ON_DESTROY_GRAPHIC);
    };

    /**
     * Public module interface.
     * @returns {{init: () => void}} The module's exported API.
     */
    return {
        init: INIT
    };
})();

on('ready', () => {
    BLOODIED_AND_DEAD.init();
});
