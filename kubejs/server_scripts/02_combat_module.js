// priority: 800
// 02_combat_module.js — Vitality & Combat Suite
// Depends on global.RPCore (00_core_engine.js)

(function () {
    'use strict';

    const RP = global.RPCore;
    if (!RP) {
        console.error('[RPCombat] global.RPCore missing — load order: 00_core_engine.js must run first.');
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────

    const C = {
        DOWNED:   '#AA2222',
        REVIVE:   '#55FF55',
        DUEL:     '#FFD700',
        DUEL_END: '#FFAA00',
        DRAG:     '#88AAFF',
        ERROR:    '#FF5555'
    };

    const MEDKIT_ID            = 'kubejs:medkit';
    const TREAT_RANGE          = 3;
    const DRAG_START_RANGE     = 4;
    const DRAG_BREAK_RANGE_SQ  = 144; // 12 blocks
    const DRAG_TICK_INTERVAL   = 4;   // 5 Hz
    const DUEL_INVITE_MS       = 60_000;
    const INJURY_DURATION_TICKS = 6_000;  // 5 minutes
    const INJURY_DURATION_MS   = INJURY_DURATION_TICKS * 50;
    const COMBAT_LOG_PCT       = 0.05; // 5% of each stat (min loss = 1)

    // Negative-attribute deltas applied while injured.
    // [attributeId, deltaPerInjuryStack, operation]
    const INJURY_MODS = [
        ['minecraft:generic.attack_damage',   -2.0,   'addition'],
        ['minecraft:generic.movement_speed',  -0.015, 'addition'],
        ['minecraft:generic.max_health',      -4.0,   'addition']
    ];

    // ─────────────────────────────────────────────────────────────
    // Volatile state (in-memory, resets on server restart)
    // ─────────────────────────────────────────────────────────────

    const drags          = {}; // downedUuid -> draggerUuid
    const duels          = {}; // duelId -> { a: uuid, b: uuid }
    const duelByPlayer   = {}; // playerUuid -> duelId
    const duelChallenges = {}; // targetUuid -> { from: uuid, expiresAt: ms }
    const forceKilling   = {}; // uuid -> true (bypass downed/duel during programmatic kill)

    // ─────────────────────────────────────────────────────────────
    // Utilities
    // ─────────────────────────────────────────────────────────────

    function uuidStr(player) { return player.uuid.toString(); }

    function pdataCompound(player) {
        const root = player.persistentData;
        if (!root.contains('rp_core')) root.put('rp_core', {});
        return root.getCompound('rp_core');
    }

    function findPlayerByUuid(server, uuidString) {
        if (!uuidString) return null;
        const players = server.players;
        for (let i = 0; i < players.length; i++) {
            if (players[i].uuid.toString() === uuidString) return players[i];
        }
        return null;
    }

    function err(player, message) {
        if (player && player.tell) player.tell(Text.string(message).color(C.ERROR));
    }

    function broadcast(server, message) {
        const ps = server.players;
        for (let i = 0; i < ps.length; i++) ps[i].tell(message);
    }

    function isCreative(player) {
        return player.abilities && player.abilities.instabuild;
    }

    function injuryModName(attrId) {
        return 'rpcore.injury.' + attrId.replace(/[:.]/g, '_');
    }

    // ─────────────────────────────────────────────────────────────
    // Downed State
    // ─────────────────────────────────────────────────────────────

    function isDowned(player) {
        const c = pdataCompound(player);
        return c.contains('downed') && c.getBoolean('downed');
    }

    function applyDowned(player) {
        if (isDowned(player)) return;
        if (isCreative(player)) return;

        pdataCompound(player).putBoolean('downed', true);

        // Long-lived effects; refreshed in the housekeeping tick if needed.
        const D = 1_000_000; // ~13 hours, more than enough for any RP downtime
        player.potionEffects.add('minecraft:slowness',       D, 250, false, false);
        player.potionEffects.add('minecraft:blindness',      D, 1,   false, false);
        player.potionEffects.add('minecraft:weakness',       D, 250, false, false); // zeroes attack damage
        player.potionEffects.add('minecraft:mining_fatigue', D, 250, false, false);
        player.potionEffects.add('minecraft:jump_boost',     D, 128, false, false); // amp 128 = no jump (overflow)

        // Pin to 1 HP so subsequent damage logic sees a non-zero, near-fatal value.
        if (player.health < 1) player.health = 1;

        RP.rpNotify(player, 'You are DOWNED. Stay still — wait for help.', 'Danger');
        broadcastNearby(player, Text.string('* ' + RP.getRPName(player) + ' collapses, gravely wounded *')
            .color(C.DOWNED).italic(true), 32);
    }

    function clearDownedState(player) {
        pdataCompound(player).putBoolean('downed', false);
        player.potionEffects.remove('minecraft:slowness');
        player.potionEffects.remove('minecraft:blindness');
        player.potionEffects.remove('minecraft:weakness');
        player.potionEffects.remove('minecraft:mining_fatigue');
        player.potionEffects.remove('minecraft:jump_boost');
    }

    function broadcastNearby(player, message, range) {
        const rangeSq = range * range;
        const ps = player.server.players;
        for (let i = 0; i < ps.length; i++) {
            if (ps[i].level !== player.level && ps[i].level.dimension !== player.level.dimension) continue;
            if (ps[i].distanceToSqr(player) <= rangeSq) ps[i].tell(message);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Injury
    // ─────────────────────────────────────────────────────────────

    function isInjured(player) {
        const c = pdataCompound(player);
        return c.contains('injuryUntil') && c.getLong('injuryUntil') > Date.now();
    }

    function applyInjury(player) {
        for (let i = 0; i < INJURY_MODS.length; i++) {
            const rule = INJURY_MODS[i];
            if (!player.getAttribute(rule[0])) continue;
            player.modifyAttribute(rule[0], injuryModName(rule[0]), rule[1], rule[2]);
        }
        pdataCompound(player).putLong('injuryUntil', Date.now() + INJURY_DURATION_MS);
        RP.rpNotify(player, 'You are injured. Stats reduced for 5 minutes.', 'Warning');
    }

    function clearInjury(player) {
        for (let i = 0; i < INJURY_MODS.length; i++) {
            const rule = INJURY_MODS[i];
            if (!player.getAttribute(rule[0])) continue;
            // Set the modifier amount to 0 — modifyAttribute replaces by deterministic UUID.
            player.modifyAttribute(rule[0], injuryModName(rule[0]), 0, rule[2]);
        }
        pdataCompound(player).remove('injuryUntil');
        RP.rpNotify(player, 'You have recovered from your injuries.', 'Success');
    }

    // ─────────────────────────────────────────────────────────────
    // Treat
    // ─────────────────────────────────────────────────────────────

    function cmdTreat(healer, target) {
        if (!target) { err(healer, 'Target not found.'); return 0; }
        if (healer === target) { err(healer, 'You cannot treat yourself.'); return 0; }
        if (!isDowned(target)) { err(healer, RP.getRPName(target) + ' is not downed.'); return 0; }
        if (healer.level !== target.level && healer.level.dimension !== target.level.dimension) {
            err(healer, 'Target is in another world.'); return 0;
        }
        if (healer.distanceToSqr(target) > TREAT_RANGE * TREAT_RANGE) {
            err(healer, 'Get closer to administer treatment.'); return 0;
        }
        const main = healer.mainHandItem;
        if (!main || main.empty || main.id !== MEDKIT_ID) {
            err(healer, 'You need a Medical Kit in your main hand.'); return 0;
        }
        main.shrink(1);

        // Revive
        clearDownedState(target);
        target.health = Math.max(target.health, target.maxHealth * 0.5);
        applyInjury(target);

        const healerName = RP.getRPName(healer);
        const targetName = RP.getRPName(target);
        broadcastNearby(healer, Text.string('* ' + healerName + ' tends to ' + targetName + "'s wounds *")
            .color(C.REVIVE).italic(true), 32);
        RP.rpNotify(target, healerName + ' revived you.', 'Success');
        return 1;
    }

    // ─────────────────────────────────────────────────────────────
    // Drag
    // ─────────────────────────────────────────────────────────────

    function startDrag(dragger, target) {
        if (!target) { err(dragger, 'Target not found.'); return 0; }
        if (dragger === target) { err(dragger, 'You cannot drag yourself.'); return 0; }
        if (!isDowned(target)) { err(dragger, RP.getRPName(target) + ' is not downed.'); return 0; }
        if (isDowned(dragger)) { err(dragger, 'You cannot drag while downed.'); return 0; }
        if (dragger.level !== target.level) { err(dragger, 'Target is in another world.'); return 0; }
        if (dragger.distanceToSqr(target) > DRAG_START_RANGE * DRAG_START_RANGE) {
            err(dragger, 'Get closer to grab them.'); return 0;
        }
        // If someone else was dragging, transfer.
        drags[uuidStr(target)] = uuidStr(dragger);
        RP.rpNotify(dragger, 'You are dragging ' + RP.getRPName(target) + '. Use /drag stop to release.', 'Info');
        RP.rpNotify(target, RP.getRPName(dragger) + ' is dragging you to safety.', 'Info');
        return 1;
    }

    function stopDrag(dragger) {
        const dUuid = uuidStr(dragger);
        let stopped = 0;
        const keys = Object.keys(drags);
        for (let i = 0; i < keys.length; i++) {
            if (drags[keys[i]] === dUuid) { delete drags[keys[i]]; stopped++; }
        }
        if (stopped === 0) { err(dragger, 'You are not dragging anyone.'); return 0; }
        RP.rpNotify(dragger, 'You release your grip.', 'Info');
        return 1;
    }

    function processDrags(server) {
        const keys = Object.keys(drags);
        for (let i = 0; i < keys.length; i++) {
            const downedUuid = keys[i];
            const draggerUuid = drags[downedUuid];
            const downed  = findPlayerByUuid(server, downedUuid);
            const dragger = findPlayerByUuid(server, draggerUuid);

            if (!downed || !dragger) { delete drags[downedUuid]; continue; }
            if (!isDowned(downed))  { delete drags[downedUuid]; continue; }
            if (downed.level !== dragger.level) { delete drags[downedUuid]; continue; }
            if (dragger.distanceToSqr(downed) > DRAG_BREAK_RANGE_SQ) {
                delete drags[downedUuid];
                RP.rpNotify(dragger, 'You lost your grip — too far away.', 'Warning');
                continue;
            }
            // Teleport just behind the dragger.
            downed.teleportTo(dragger.x, dragger.y, dragger.z);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Duel
    // ─────────────────────────────────────────────────────────────

    function isDueling(player) {
        return !!duelByPlayer[uuidStr(player)];
    }

    function getDuel(player) {
        const id = duelByPlayer[uuidStr(player)];
        return id ? duels[id] : null;
    }

    function challengeDuel(challenger, target) {
        if (!target) { err(challenger, 'Target not found.'); return 0; }
        if (challenger === target) { err(challenger, 'You cannot duel yourself.'); return 0; }
        if (isDueling(challenger)) { err(challenger, 'You are already in a duel.'); return 0; }
        if (isDueling(target))     { err(challenger, RP.getRPName(target) + ' is already in a duel.'); return 0; }
        if (isDowned(challenger) || isDowned(target)) { err(challenger, 'A downed combatant cannot duel.'); return 0; }

        duelChallenges[uuidStr(target)] = {
            from: uuidStr(challenger),
            expiresAt: Date.now() + DUEL_INVITE_MS
        };
        RP.rpNotify(challenger, 'Challenge sent to ' + RP.getRPName(target) + '.', 'Info');
        target.tell(Text.string(RP.getRPName(challenger) + ' challenges you to a duel.').color(C.DUEL).bold(true)
            .append(Text.string(' Type ').color(C.DUEL))
            .append(Text.string('/duel accept').color('#FFFFFF').bold(true)
                .click('/duel accept').hover(Text.string('Click to accept')))
            .append(Text.string(' or ').color(C.DUEL))
            .append(Text.string('/duel decline').color('#FFFFFF').bold(true)
                .click('/duel decline').hover(Text.string('Click to decline')))
            .append(Text.string(' within 60s.').color(C.DUEL)));
        return 1;
    }

    function acceptDuel(target) {
        const ch = duelChallenges[uuidStr(target)];
        if (!ch) { err(target, 'No active duel challenge.'); return 0; }
        if (Date.now() > ch.expiresAt) {
            delete duelChallenges[uuidStr(target)];
            err(target, 'The challenge expired.'); return 0;
        }
        delete duelChallenges[uuidStr(target)];
        const challenger = findPlayerByUuid(target.server, ch.from);
        if (!challenger) { err(target, 'The challenger is no longer online.'); return 0; }
        startDuel(challenger, target);
        return 1;
    }

    function declineDuel(target) {
        const ch = duelChallenges[uuidStr(target)];
        if (!ch) { err(target, 'No active duel challenge.'); return 0; }
        delete duelChallenges[uuidStr(target)];
        const challenger = findPlayerByUuid(target.server, ch.from);
        if (challenger) RP.rpNotify(challenger, RP.getRPName(target) + ' declined your duel.', 'Warning');
        RP.rpNotify(target, 'You declined the duel.', 'Info');
        return 1;
    }

    function startDuel(a, b) {
        const id = uuidStr(a) + ':' + uuidStr(b) + ':' + Date.now();
        duels[id] = { a: uuidStr(a), b: uuidStr(b) };
        duelByPlayer[uuidStr(a)] = id;
        duelByPlayer[uuidStr(b)] = id;

        const announce = Text.string('⚔ ' + RP.getRPName(a) + ' vs ' + RP.getRPName(b) + ' — duel begins!')
            .color(C.DUEL).bold(true);
        broadcast(a.server, announce);
    }

    function endDuel(duelId, loser, reason) {
        const duel = duels[duelId];
        if (!duel) return;
        delete duels[duelId];
        delete duelByPlayer[duel.a];
        delete duelByPlayer[duel.b];

        const server = loser ? loser.server : null;
        const a = server ? findPlayerByUuid(server, duel.a) : null;
        const b = server ? findPlayerByUuid(server, duel.b) : null;
        const winner = (loser && uuidStr(loser) === duel.a) ? b : a;

        [a, b].forEach(p => {
            if (!p) return;
            p.health = p.maxHealth;
            p.foodData.foodLevel = 20;
            p.potionEffects.remove('minecraft:weakness');
            p.potionEffects.remove('minecraft:slowness');
            p.potionEffects.remove('minecraft:poison');
            p.potionEffects.remove('minecraft:wither');
        });

        if (server) {
            const winLine = winner && loser
                ? '⚔ ' + RP.getRPName(winner) + ' bested ' + RP.getRPName(loser) + ' in single combat.'
                : '⚔ The duel has ended.';
            broadcast(server, Text.string(winLine + (reason ? ' (' + reason + ')' : '')).color(C.DUEL_END).bold(true));
        }
    }

    // Helper to wrap up a duel cleanly when one combatant disconnects mid-fight.
    function abandonDuel(player, reason) {
        const id = duelByPlayer[uuidStr(player)];
        if (!id) return;
        endDuel(id, player, reason || 'forfeited');
    }

    // ─────────────────────────────────────────────────────────────
    // Combat Log Penalty
    // ─────────────────────────────────────────────────────────────

    function applyCombatLogPenalty(player) {
        const stats = RP.STATS;
        for (let i = 0; i < stats.length; i++) {
            const cur = RP.getStat(player, stats[i]);
            const lost = Math.max(1, Math.floor(cur * COMBAT_LOG_PCT));
            RP.setStat(player, stats[i], Math.max(RP.MIN_STAT, cur - lost));
        }
        pdataCompound(player).putBoolean('combatLogDeath', true);
    }

    function forceKill(player) {
        forceKilling[uuidStr(player)] = true;
        try {
            player.kill();
        } finally {
            // Clear flag shortly after so future death events resume normal handling.
            player.server.scheduleInTicks(2, () => { delete forceKilling[uuidStr(player)]; });
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────

    global.RPCombat = {
        // state queries
        isDowned:   isDowned,
        isInjured:  isInjured,
        isDueling:  isDueling,
        getDuel:    getDuel,
        // downed
        applyDowned:      applyDowned,
        clearDownedState: clearDownedState,
        // injury
        applyInjury: applyInjury,
        clearInjury: clearInjury,
        // commands (for testing / external callers)
        treat:        cmdTreat,
        startDrag:    startDrag,
        stopDrag:     stopDrag,
        challengeDuel: challengeDuel,
        acceptDuel:    acceptDuel,
        declineDuel:   declineDuel,
        endDuel:       endDuel,
        abandonDuel:   abandonDuel,
        // penalty
        applyCombatLogPenalty: applyCombatLogPenalty,
        forceKill:    forceKill,
        // tick processors
        processDrags: processDrags,
        expireChallenges: function (now) {
            const keys = Object.keys(duelChallenges);
            for (let i = 0; i < keys.length; i++) {
                if (duelChallenges[keys[i]].expiresAt <= now) delete duelChallenges[keys[i]];
            }
        },
        // shared state
        _drags:        drags,
        _duels:        duels,
        _duelByPlayer: duelByPlayer,
        _forceKilling: forceKilling
    };

})();

// ─────────────────────────────────────────────────────────────────
// Damage / death interception
// ─────────────────────────────────────────────────────────────────

EntityEvents.hurt(event => {
    const RPC = global.RPCombat;
    if (!RPC) return;
    const target = event.entity;
    if (!target || !target.isPlayer || !target.isPlayer()) {
        // Non-player target: still block attacks from downed players.
        const src = event.source;
        const atk = src && (src.actual || src.entity);
        if (atk && atk.isPlayer && atk.isPlayer() && RPC.isDowned(atk)) {
            event.cancel();
        }
        return;
    }

    // 1. Programmatic kill bypass (combat-log force kill).
    if (RPC._forceKilling[target.uuid.toString()]) return;

    // 2. Block attacks originating from downed players.
    const src = event.source;
    const atk = src && (src.actual || src.entity);
    if (atk && atk.isPlayer && atk.isPlayer() && RPC.isDowned(atk)) {
        event.cancel();
        return;
    }

    // 3. Downed players take no damage.
    if (RPC.isDowned(target)) { event.cancel(); return; }

    // 4. Active duel → clamp the killing blow to leave 1 HP, schedule the resolution.
    if (RPC.isDueling(target)) {
        const projected = target.health - event.damage;
        if (projected <= 1) {
            event.damage = Math.max(0, target.health - 1);
            const id = RPC._duelByPlayer[target.uuid.toString()];
            target.server.scheduleInTicks(1, () => RPC.endDuel(id, target, 'reduced to 1 HP'));
        }
        return; // duel bypasses the downed system
    }

    // 5. Lethal damage outside of a duel → enter Downed state instead of dying.
    if (target.health - event.damage <= 0) {
        event.cancel();
        target.health = 1;
        RPC.applyDowned(target);
    }
});

EntityEvents.death(event => {
    const RPC = global.RPCombat;
    if (!RPC) return;
    const target = event.entity;
    if (!target || !target.isPlayer || !target.isPlayer()) return;

    // Allow programmatic kills (combat-log) through.
    if (RPC._forceKilling[target.uuid.toString()]) return;

    // Catch-all: any death event for a non-creative player that wasn't pre-empted
    // by the hurt hook (commands, void, instakill mods) gets converted to Downed.
    if (target.abilities && target.abilities.instabuild) return;

    if (RPC.isDueling(target)) {
        // Should be unreachable because hurt clamps to 1 HP first; treat as a forfeit.
        event.cancel();
        target.health = 1;
        const id = RPC._duelByPlayer[target.uuid.toString()];
        if (id) RPC.endDuel(id, target, 'fell unconscious');
        return;
    }
    if (!RPC.isDowned(target)) {
        event.cancel();
        target.health = 1;
        RPC.applyDowned(target);
    }
});

// ─────────────────────────────────────────────────────────────────
// Anti-Combat-Log
// ─────────────────────────────────────────────────────────────────

PlayerEvents.loggedOut(event => {
    const RPC = global.RPCombat;
    if (!RPC) return;
    const player = event.player;
    if (!player) return;

    const downed  = RPC.isDowned(player);
    const dueling = RPC.isDueling(player);
    if (!downed && !dueling) return;

    RPC.applyCombatLogPenalty(player);

    if (dueling) RPC.abandonDuel(player, 'logged out');
    if (downed)  RPC.clearDownedState(player); // they died — clear state for next login

    // Force kill so they actually die. The combatLogDeath flag set by
    // applyCombatLogPenalty is the safety net if the kill loses the race
    // with the disconnect — we'll finish the job on next login.
    RPC._forceKilling[player.uuid.toString()] = true;
    try { player.kill(); } catch (e) { /* logout-time kill can be racy; flag persists */ }
});

PlayerEvents.loggedIn(event => {
    const RPC = global.RPCombat;
    if (!RPC) return;
    const player = event.player;
    const root = player.persistentData;
    if (!root.contains('rp_core')) return;
    const c = root.getCompound('rp_core');

    // Combat-log fallback: if the kill at logout failed, finish the job here.
    if (c.contains('combatLogDeath') && c.getBoolean('combatLogDeath')) {
        c.putBoolean('combatLogDeath', false);
        player.server.scheduleInTicks(20, () => {
            if (player.isAlive && player.isAlive()) {
                RPC._forceKilling[player.uuid.toString()] = true;
                try { player.kill(); } catch (e) {}
            }
            global.RPCore.rpNotify(player, 'Combat-log penalty applied.', 'Danger');
        });
    }

    // If they were mid-down at logout, ensure effects are re-applied on rejoin.
    if (c.contains('downed') && c.getBoolean('downed')) {
        player.server.scheduleInTicks(2, () => RPC.applyDowned(player));
    }
});

PlayerEvents.respawned(event => {
    // Respawn is a clean slate: clear downed/injury so the new body is whole.
    const RPC = global.RPCombat;
    if (!RPC) return;
    const player = event.player;
    if (RPC.isDowned(player))  RPC.clearDownedState(player);
    if (RPC.isInjured(player)) RPC.clearInjury(player);
});

// ─────────────────────────────────────────────────────────────────
// Housekeeping tick
// ─────────────────────────────────────────────────────────────────

ServerEvents.tick(event => {
    const RPC = global.RPCombat;
    if (!RPC) return;
    const tick = event.server.tickCount;

    if (tick % 4 === 0) {
        RPC.processDrags(event.server);
    }

    if (tick % 20 === 0) {
        const now = Date.now();
        const players = event.server.players;
        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            const root = p.persistentData;
            if (!root.contains('rp_core')) continue;
            const c = root.getCompound('rp_core');
            if (c.contains('injuryUntil') && c.getLong('injuryUntil') > 0 && c.getLong('injuryUntil') <= now) {
                RPC.clearInjury(p);
            }
        }
        RPC.expireChallenges(now);
    }
});

// ─────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────

ServerEvents.commandRegistry(event => {
    const Commands  = event.commands;
    const Arguments = event.arguments;
    const RPC       = global.RPCombat;

    const safePlayer = (ctx) => { try { return ctx.source.player; } catch (e) { return null; } };
    const requirePlayer = (ctx, fn) => { const p = safePlayer(ctx); return p ? fn(p) : 0; };

    // /treat <target>
    event.register(
        Commands.literal('treat')
            .then(Commands.argument('target', Arguments.PLAYER.create(event))
                .executes(ctx => requirePlayer(ctx, p =>
                    RPC.treat(p, Arguments.PLAYER.getResult(ctx, 'target'))
                ))
            )
    );

    // /drag <target>  /drag stop
    event.register(
        Commands.literal('drag')
            .then(Commands.literal('stop').executes(ctx => requirePlayer(ctx, p => RPC.stopDrag(p))))
            .then(Commands.argument('target', Arguments.PLAYER.create(event))
                .executes(ctx => requirePlayer(ctx, p =>
                    RPC.startDrag(p, Arguments.PLAYER.getResult(ctx, 'target'))
                ))
            )
    );

    // /duel <target>  /duel accept  /duel decline
    event.register(
        Commands.literal('duel')
            .then(Commands.literal('accept').executes(ctx => requirePlayer(ctx, p => RPC.acceptDuel(p))))
            .then(Commands.literal('decline').executes(ctx => requirePlayer(ctx, p => RPC.declineDuel(p))))
            .then(Commands.argument('target', Arguments.PLAYER.create(event))
                .executes(ctx => requirePlayer(ctx, p =>
                    RPC.challengeDuel(p, Arguments.PLAYER.getResult(ctx, 'target'))
                ))
            )
    );
});
