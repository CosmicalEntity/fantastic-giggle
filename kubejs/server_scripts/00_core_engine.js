// priority: 1000
// 00_core_engine.js — RP Engine Foundation
// Loads first; all other RP scripts depend on global.RPCore.
// Target: KubeJS 1.20.1 Forge (Rhino)

(function () {
    'use strict';

    // ─────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────

    const NS              = 'rp_core';   // persistentData root key
    const MOD_PREFIX      = 'rpcore';    // attribute-modifier name prefix
    const STATS           = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
    const DEFAULT_STAT    = 10;
    const MIN_STAT        = 1;
    const MAX_STAT        = 100;

    // Centralised attribute IDs — adjust here for mod-version drift.
    const ATTR = {
        ATTACK_DAMAGE:    'minecraft:generic.attack_damage',
        MOVEMENT_SPEED:   'minecraft:generic.movement_speed',
        MAX_HEALTH:       'minecraft:generic.max_health',
        IMPACT:           'epicfight:impact',
        DODGE_CHANCE:     'attributeslib:dodge_chance',
        HEALING_RECEIVED: 'attributeslib:healing_received',
        MAX_MANA:         'irons_spellbooks:max_mana',
        SPELL_POWER:      'irons_spellbooks:spell_power'
    };

    // Per-stat scaling table.
    //   [attributeId, perPointAmount, operation]
    // Amount applied to attribute = (statValue - DEFAULT_STAT) * perPointAmount.
    // operation: 'addition' | 'multiply_base' | 'multiply_total'
    const SCALING = {
        STR: [
            [ATTR.ATTACK_DAMAGE,    0.5,   'addition'],
            [ATTR.IMPACT,           0.10,  'addition']
        ],
        DEX: [
            [ATTR.MOVEMENT_SPEED,   0.002, 'addition'],
            [ATTR.DODGE_CHANCE,     0.005, 'addition']
        ],
        CON: [
            [ATTR.MAX_HEALTH,       1.0,   'addition'],
            [ATTR.HEALING_RECEIVED, 0.01,  'addition']
        ],
        INT: [
            [ATTR.MAX_MANA,         10.0,  'addition']
        ],
        WIS: [
            [ATTR.SPELL_POWER,      0.02,  'multiply_total']
        ],
        CHA: [] // social / dialogue system — no Forge attributes
    };

    // Hex palette for action-bar feedback.
    const COLORS = {
        Success: '#55FF55',
        Warning: '#FFAA00',
        Danger:  '#FF5555',
        Info:    '#55AAFF',
        Default: '#FFFFFF'
    };

    // ─────────────────────────────────────────────────────────────
    // Utilities
    // ─────────────────────────────────────────────────────────────

    const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const isStat = (s) => STATS.indexOf(s) !== -1;

    // Returns the inner CompoundTag for our namespace, creating it if missing.
    // CompoundTag.getCompound returns a live reference, so mutations persist.
    function pdata(player) {
        const root = player.persistentData;
        if (!root.contains(NS)) root.put(NS, {});
        return root.getCompound(NS);
    }

    function modifierName(stat, attrId) {
        return MOD_PREFIX + '.' + stat.toLowerCase() + '.' + attrId.replace(/[:.]/g, '_');
    }

    // ─────────────────────────────────────────────────────────────
    // Stat API
    // ─────────────────────────────────────────────────────────────

    function getStat(player, stat) {
        if (!player || !isStat(stat)) return DEFAULT_STAT;
        const c = pdata(player);
        return c.contains(stat) ? c.getInt(stat) : DEFAULT_STAT;
    }

    // Classic d20-style modifier: (stat − 10) / 2, floored.
    function getStatModifier(player, stat) {
        return Math.floor((getStat(player, stat) - DEFAULT_STAT) / 2);
    }

    function setStat(player, stat, value) {
        if (!player || !isStat(stat)) return false;
        const v   = clamp(Math.floor(value), MIN_STAT, MAX_STAT);
        const cur = getStat(player, stat);
        if (v === cur) return false; // no-op fast path — avoids attribute churn
        pdata(player).putInt(stat, v);
        applyStatScaling(player, stat); // refresh only the affected attributes
        return true;
    }

    function addStat(player, stat, delta) {
        return setStat(player, stat, getStat(player, stat) + delta);
    }

    function getAllStats(player) {
        const out = {};
        for (let i = 0; i < STATS.length; i++) {
            out[STATS[i]] = getStat(player, STATS[i]);
        }
        return out;
    }

    // ─────────────────────────────────────────────────────────────
    // RP Name & Faction
    // ─────────────────────────────────────────────────────────────

    function getRPName(player) {
        const c = pdata(player);
        return c.contains('rpName') ? c.getString('rpName') : player.username;
    }

    function setRPName(player, name) {
        pdata(player).putString('rpName', String(name));
    }

    function getFaction(player) {
        const c = pdata(player);
        return c.contains('faction') ? c.getString('faction') : '';
    }

    function setFaction(player, faction) {
        pdata(player).putString('faction', String(faction || ''));
    }

    // ─────────────────────────────────────────────────────────────
    // Attribute Application
    // ─────────────────────────────────────────────────────────────

    // Applies one stat's scaling. Skips attributes whose backing mod isn't loaded.
    // Uses modifyAttribute, which derives a deterministic UUID from the modifier
    // name and atomically replaces any existing modifier with the same UUID —
    // so repeated calls don't stack and there's no need to track previous values.
    function applyStatScaling(player, stat) {
        const rules = SCALING[stat];
        if (!rules || rules.length === 0) return;
        const delta = getStat(player, stat) - DEFAULT_STAT;

        for (let i = 0; i < rules.length; i++) {
            const attrId = rules[i][0];
            const per    = rules[i][1];
            const op     = rules[i][2];

            // Bail if the attribute isn't registered on this player
            // (mod absent, datapack disabled, etc.)
            if (!player.getAttribute(attrId)) continue;

            player.modifyAttribute(attrId, modifierName(stat, attrId), per * delta, op);
        }
    }

    function applyAttributes(player, onlyStat) {
        if (!player || !player.isPlayer || !player.isPlayer()) return;
        if (onlyStat) {
            if (isStat(onlyStat)) applyStatScaling(player, onlyStat);
            return;
        }
        for (let i = 0; i < STATS.length; i++) {
            applyStatScaling(player, STATS[i]);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // UI: Action-Bar Notification
    // ─────────────────────────────────────────────────────────────

    function rpNotify(player, message, type) {
        if (!player || message == null) return;
        const color = COLORS[type] || COLORS.Default;
        const txt = Text.string(String(message)).color(color);
        if (type === 'Danger')  txt.bold(true);
        if (type === 'Success') txt.bold(true);
        player.sendActionBar(txt);
    }

    // Convenience wrapper for chat (kept here so other scripts have one place).
    function rpChat(player, message, type) {
        if (!player || message == null) return;
        const color = COLORS[type] || COLORS.Default;
        player.tell(Text.string(String(message)).color(color));
    }

    // ─────────────────────────────────────────────────────────────
    // Initialisation
    // ─────────────────────────────────────────────────────────────

    function ensureInitialized(player) {
        const c = pdata(player);
        if (c.contains('initialized') && c.getBoolean('initialized')) return false;

        for (let i = 0; i < STATS.length; i++) {
            if (!c.contains(STATS[i])) c.putInt(STATS[i], DEFAULT_STAT);
        }
        if (!c.contains('rpName'))  c.putString('rpName',  player.username);
        if (!c.contains('faction')) c.putString('faction', '');
        c.putBoolean('initialized', true);
        return true;
    }

    // ─────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────

    global.RPCore = {
        // constants
        STATS:        STATS,
        DEFAULT_STAT: DEFAULT_STAT,
        MIN_STAT:     MIN_STAT,
        MAX_STAT:     MAX_STAT,
        COLORS:       COLORS,
        ATTR:         ATTR,
        SCALING:      SCALING,
        // stats
        getStat:         getStat,
        setStat:         setStat,
        addStat:         addStat,
        getStatModifier: getStatModifier,
        getAllStats:     getAllStats,
        // identity
        getRPName:  getRPName,
        setRPName:  setRPName,
        getFaction: getFaction,
        setFaction: setFaction,
        // attributes
        applyAttributes: applyAttributes,
        // ui
        rpNotify: rpNotify,
        rpChat:   rpChat,
        // lifecycle
        ensureInitialized: ensureInitialized
    };

    // Top-level shortcuts so callers can write `getStat(p,'STR')` directly.
    global.getStat         = getStat;
    global.setStat         = setStat;
    global.addStat         = addStat;
    global.getStatModifier = getStatModifier;
    global.applyAttributes = applyAttributes;
    global.rpNotify        = rpNotify;

})();

// ─────────────────────────────────────────────────────────────────
// Lifecycle Hooks
// ─────────────────────────────────────────────────────────────────

PlayerEvents.loggedIn(event => {
    const player = event.player;
    const fresh  = global.RPCore.ensureInitialized(player);

    // Defer one tick: ensures Forge attribute instances are fully attached
    // (Iron's Spells / Epic Fight register lazily on capability sync).
    player.server.scheduleInTicks(1, () => {
        global.RPCore.applyAttributes(player);
        if (fresh) {
            global.RPCore.rpNotify(player, 'Welcome, traveller — your tale begins.', 'Success');
        }
    });
});

PlayerEvents.respawned(event => {
    const player = event.player;
    player.server.scheduleInTicks(1, () => global.RPCore.applyAttributes(player));
});
