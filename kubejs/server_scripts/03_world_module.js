// priority: 700
// 03_world_module.js — World Logic & Progression
// Depends on global.RPCore (00_core_engine.js)

(function () {
    'use strict';

    const RP = global.RPCore;
    if (!RP) {
        console.error('[RPWorld] global.RPCore missing — load 00_core_engine.js first.');
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────

    const C = {
        FACTION:  '#FFD479',
        WAR:      '#FF5544',
        PEACE:    '#88FFAA',
        BOUNTY:   '#FFAA00',
        BIZ:      '#88DDFF',
        PROGRESS: '#FFFF88',
        ERROR:    '#FF5555'
    };

    const FACTION_KEY  = 'rp_factions';
    const BOUNTY_KEY   = 'rp_bounties';
    const BUSINESS_KEY = 'rp_businesses';

    const FACTION_NAME_MAX = 32;
    const BUSINESS_NAME_MAX = 48;

    const WAR_KILL_BONUS   = 5;     // Isons per kill in wartime
    const PROGRESSION_INTERVAL_S = 600;   // 10 minutes of *active* play
    const PROGRESSION_CHANCE     = 0.20;  // 20% per interval — "tiny" but felt
    const ACTIVITY_GAP_MS        = 60_000; // counted active if moved within 60s

    // Maps an activity counter to the stat it nudges.
    const ACTIVITY_STATS = {
        mine:    'STR',
        sprint:  'DEX',
        sneak:   'WIS',
        eat:     'CON',
        craft:   'INT',
        chat:    'CHA',
        fish:    'WIS',
        attack:  'STR',
        cast:    'INT'
    };

    // ─────────────────────────────────────────────────────────────
    // Volatile state
    // ─────────────────────────────────────────────────────────────

    const lastPos       = {}; // uuid -> [x,y,z]
    const lastActiveAt  = {}; // uuid -> ms

    // ─────────────────────────────────────────────────────────────
    // Persistence helpers (server-wide, JSON-encoded for simplicity)
    // ─────────────────────────────────────────────────────────────

    function loadJson(server, key, fallback) {
        const root = server.persistentData;
        if (!root.contains(key)) return fallback;
        try {
            const v = JSON.parse(root.getString(key));
            return v == null ? fallback : v;
        } catch (e) {
            console.warn('[RPWorld] decode failed for ' + key + ': ' + e);
            return fallback;
        }
    }

    function saveJson(server, key, value) {
        server.persistentData.putString(key, JSON.stringify(value));
    }

    function loadFactions(server) { return loadJson(server, FACTION_KEY,  {}); }
    function saveFactions(server, v) { saveJson(server, FACTION_KEY, v); }
    function loadBounties(server) { return loadJson(server, BOUNTY_KEY,  {}); }
    function saveBounties(server, v) { saveJson(server, BOUNTY_KEY, v); }
    function loadBusinesses(server) { return loadJson(server, BUSINESS_KEY, []); }
    function saveBusinesses(server, v) { saveJson(server, BUSINESS_KEY, v); }

    function pdataCompound(player) {
        const root = player.persistentData;
        if (!root.contains('rp_core')) root.put('rp_core', {});
        return root.getCompound('rp_core');
    }

    function uuidStr(player) { return player.uuid.toString(); }

    function err(player, msg) {
        if (player && player.tell) player.tell(Text.string(msg).color(C.ERROR));
    }

    function broadcast(server, message) {
        const ps = server.players;
        for (let i = 0; i < ps.length; i++) ps[i].tell(message);
    }

    function findPlayerByUuid(server, uuid) {
        if (!uuid) return null;
        const ps = server.players;
        for (let i = 0; i < ps.length; i++) if (ps[i].uuid.toString() === uuid) return ps[i];
        return null;
    }

    // ─────────────────────────────────────────────────────────────
    // Factions
    // ─────────────────────────────────────────────────────────────
    // Faction key = lowercase displayName; uniqueness enforced case-insensitively.
    // Player-side faction state lives on RPCore (RPCore.getFaction stores the
    // displayName, the same string used as the key after toLowerCase()).

    function factionKey(name) { return String(name || '').toLowerCase().trim(); }

    function getFactionOf(server, player) {
        const name = RP.getFaction(player);
        if (!name) return null;
        const factions = loadFactions(server);
        return factions[factionKey(name)] || null;
    }

    function rankIn(faction, player) {
        const u = uuidStr(player);
        if (faction.leader === u) return 'Leader';
        if (faction.officers.indexOf(u) !== -1) return 'Officer';
        if (faction.members.indexOf(u) !== -1) return 'Member';
        return null;
    }

    function factionCreate(player, name) {
        const display = String(name || '').replace(/§./g, '').trim();
        if (!display) { err(player, 'Faction name required.'); return 0; }
        if (display.length > FACTION_NAME_MAX) { err(player, 'Name too long (max ' + FACTION_NAME_MAX + ').'); return 0; }
        if (RP.getFaction(player)) { err(player, 'Leave your current faction first.'); return 0; }

        const factions = loadFactions(player.server);
        const key = factionKey(display);
        if (factions[key]) { err(player, 'A faction by that name already exists.'); return 0; }

        factions[key] = {
            displayName: display,
            leader:      uuidStr(player),
            officers:    [],
            members:     [],
            wars:        [],
            created:     Date.now()
        };
        saveFactions(player.server, factions);
        RP.setFaction(player, display);
        RP.rpNotify(player, 'Faction "' + display + '" founded. You are its Leader.', 'Success');
        return 1;
    }

    function factionInvite(player, target) {
        if (!target) { err(player, 'Target not found.'); return 0; }
        if (player === target) { err(player, 'You cannot invite yourself.'); return 0; }
        if (RP.getFaction(target)) { err(player, target.username + ' is already in a faction.'); return 0; }

        const f = getFactionOf(player.server, player);
        if (!f) { err(player, 'You are not in a faction.'); return 0; }
        const r = rankIn(f, player);
        if (r !== 'Leader' && r !== 'Officer') { err(player, 'Only Leaders and Officers can invite.'); return 0; }

        // Stash invite on the target's pdata; expires after 5 minutes.
        const c = pdataCompound(target);
        c.putString('factionInvite', f.displayName);
        c.putLong('factionInviteAt', Date.now());

        target.tell(Text.string(RP.getRPName(player) + ' invites you to ' + f.displayName + '.').color(C.FACTION).bold(true)
            .append(Text.string(' Type ').color(C.FACTION))
            .append(Text.string('/faction accept ' + f.displayName).color('#FFFFFF').bold(true)
                .click('/faction accept ' + f.displayName).hover(Text.string('Click to accept'))));
        RP.rpNotify(player, 'Invitation sent to ' + target.username + '.', 'Success');
        return 1;
    }

    function factionAccept(player, name) {
        if (RP.getFaction(player)) { err(player, 'Leave your current faction first.'); return 0; }
        const c = pdataCompound(player);
        if (!c.contains('factionInvite')) { err(player, 'No active invitation.'); return 0; }
        const invited = c.getString('factionInvite');
        const sentAt  = c.getLong('factionInviteAt');
        if (Date.now() - sentAt > 5 * 60_000) { err(player, 'That invitation expired.'); c.remove('factionInvite'); return 0; }
        if (factionKey(invited) !== factionKey(name)) { err(player, 'Your invitation is for "' + invited + '".'); return 0; }

        const factions = loadFactions(player.server);
        const f = factions[factionKey(invited)];
        if (!f) { err(player, 'That faction no longer exists.'); return 0; }
        f.members.push(uuidStr(player));
        saveFactions(player.server, factions);
        RP.setFaction(player, f.displayName);
        c.remove('factionInvite');
        c.remove('factionInviteAt');

        RP.rpNotify(player, 'You joined ' + f.displayName + '.', 'Success');
        return 1;
    }

    function factionPromote(player, target) {
        if (!target) { err(player, 'Target not found.'); return 0; }
        const factions = loadFactions(player.server);
        const f = factions[factionKey(RP.getFaction(player) || '')];
        if (!f) { err(player, 'You are not in a faction.'); return 0; }
        if (f.leader !== uuidStr(player)) { err(player, 'Only the Leader can promote.'); return 0; }
        const tu = uuidStr(target);
        const idx = f.members.indexOf(tu);
        if (idx === -1) { err(player, target.username + ' is not a Member of your faction.'); return 0; }
        f.members.splice(idx, 1);
        f.officers.push(tu);
        saveFactions(player.server, factions);
        RP.rpNotify(player, target.username + ' promoted to Officer.', 'Success');
        RP.rpNotify(target, 'You have been promoted to Officer of ' + f.displayName + '.', 'Success');
        return 1;
    }

    function factionWar(player, otherName) {
        const f = getFactionOf(player.server, player);
        if (!f) { err(player, 'You are not in a faction.'); return 0; }
        const r = rankIn(f, player);
        if (r !== 'Leader' && r !== 'Officer') { err(player, 'Only Leaders and Officers can declare war.'); return 0; }

        const factions = loadFactions(player.server);
        const otherKey = factionKey(otherName);
        const other = factions[otherKey];
        if (!other) { err(player, 'No such faction: ' + otherName); return 0; }
        if (otherKey === factionKey(f.displayName)) { err(player, 'You cannot war yourself.'); return 0; }
        if (f.wars.indexOf(otherKey) !== -1) { err(player, 'Already at war with ' + other.displayName + '.'); return 0; }

        f.wars.push(otherKey);
        if (other.wars.indexOf(factionKey(f.displayName)) === -1) other.wars.push(factionKey(f.displayName));
        factions[factionKey(f.displayName)] = f;
        factions[otherKey] = other;
        saveFactions(player.server, factions);

        broadcast(player.server, Text.string('⚔ ' + f.displayName + ' declares WAR on ' + other.displayName + '!')
            .color(C.WAR).bold(true));
        return 1;
    }

    function factionPeace(player, otherName) {
        const f = getFactionOf(player.server, player);
        if (!f) { err(player, 'You are not in a faction.'); return 0; }
        const r = rankIn(f, player);
        if (r !== 'Leader' && r !== 'Officer') { err(player, 'Only Leaders and Officers can sue for peace.'); return 0; }

        const factions = loadFactions(player.server);
        const otherKey = factionKey(otherName);
        const other = factions[otherKey];
        if (!other) { err(player, 'No such faction: ' + otherName); return 0; }

        const fKey = factionKey(f.displayName);
        f.wars = f.wars.filter(w => w !== otherKey);
        other.wars = other.wars.filter(w => w !== fKey);
        factions[fKey] = f;
        factions[otherKey] = other;
        saveFactions(player.server, factions);

        broadcast(player.server, Text.string('✦ ' + f.displayName + ' and ' + other.displayName + ' make peace.')
            .color(C.PEACE).bold(true));
        return 1;
    }

    function factionInfo(player, name) {
        const factions = loadFactions(player.server);
        const targetKey = name ? factionKey(name) : factionKey(RP.getFaction(player) || '');
        if (!targetKey) { err(player, 'You are not in a faction. Specify a name.'); return 0; }
        const f = factions[targetKey];
        if (!f) { err(player, 'No such faction.'); return 0; }
        const total = 1 + f.officers.length + f.members.length;
        const lines = [
            Text.string('═══ ' + f.displayName + ' ═══').color(C.FACTION).bold(true),
            Text.string('Members: ' + total + '   Wars: ' + (f.wars.length || 'none')).color(C.FACTION),
            Text.string('Leader UUID: ' + f.leader).color('#888888'),
            Text.string('Officers: ' + f.officers.length + '   Members: ' + f.members.length).color('#AAAAAA')
        ];
        for (let i = 0; i < lines.length; i++) player.tell(lines[i]);
        return 1;
    }

    function areAtWar(server, factionA, factionB) {
        if (!factionA || !factionB) return false;
        if (factionKey(factionA) === factionKey(factionB)) return false;
        const factions = loadFactions(server);
        const a = factions[factionKey(factionA)];
        return !!(a && a.wars && a.wars.indexOf(factionKey(factionB)) !== -1);
    }

    // ─────────────────────────────────────────────────────────────
    // Bounties
    // ─────────────────────────────────────────────────────────────

    function bountyPlace(player, target, amount) {
        const amt = Math.floor(amount);
        if (!target) { err(player, 'Target not found.'); return 0; }
        if (player === target) { err(player, 'You cannot place a bounty on yourself.'); return 0; }
        if (amt <= 0) { err(player, 'Bounty must be a positive amount.'); return 0; }
        if (RP.getBalance(player) < amt) { err(player, 'You need ' + amt + ' Isons.'); return 0; }
        const taken = RP.takeBalance(player, amt);
        if (taken !== amt) {
            // Refund partial — defensive; shouldn't normally happen.
            if (taken > 0) RP.giveBalance(player, taken);
            err(player, 'Could not collect the Isons.');
            return 0;
        }

        const bounties = loadBounties(player.server);
        const tu = uuidStr(target);
        const entry = bounties[tu] || { total: 0, name: target.username, placers: [] };
        entry.total += amt;
        entry.name = target.username;
        entry.placers.push({ uuid: uuidStr(player), name: player.username, amount: amt, at: Date.now() });
        bounties[tu] = entry;
        saveBounties(player.server, bounties);

        broadcast(player.server, Text.string('☠ A bounty of ' + entry.total + ' Isons is on ' + RP.getRPName(target) + "'s head.")
            .color(C.BOUNTY).bold(true));
        return 1;
    }

    function bountyList(player) {
        const bounties = loadBounties(player.server);
        const keys = Object.keys(bounties);
        if (keys.length === 0) { player.tell(Text.string('No active bounties.').color(C.BOUNTY)); return 1; }
        player.tell(Text.string('═══ Active Bounties ═══').color(C.BOUNTY).bold(true));
        for (let i = 0; i < keys.length; i++) {
            const b = bounties[keys[i]];
            player.tell(Text.string('• ' + b.name + ' — ' + b.total + ' Isons').color(C.BOUNTY));
        }
        return 1;
    }

    function bountyInfo(player, target) {
        if (!target) { err(player, 'Target not found.'); return 0; }
        const bounties = loadBounties(player.server);
        const b = bounties[uuidStr(target)];
        if (!b || b.total <= 0) {
            player.tell(Text.string(target.username + ' has no bounty.').color(C.BOUNTY));
            return 1;
        }
        player.tell(Text.string(target.username + ' — ' + b.total + ' Isons (' + b.placers.length + ' placer' + (b.placers.length === 1 ? '' : 's') + ')').color(C.BOUNTY));
        return 1;
    }

    function claimBounty(killer, target) {
        const bounties = loadBounties(killer.server);
        const tu = uuidStr(target);
        const b = bounties[tu];
        if (!b || b.total <= 0) return 0;
        const reward = b.total;
        delete bounties[tu];
        saveBounties(killer.server, bounties);
        RP.giveBalance(killer, reward);
        RP.rpNotify(killer, 'Bounty claimed: ' + reward + ' Isons.', 'Success');
        broadcast(killer.server,
            Text.string('☠ ' + RP.getRPName(killer) + ' collects the bounty on ' + RP.getRPName(target) + ' (' + reward + ' Isons).')
                .color(C.BOUNTY).bold(true));
        return reward;
    }

    // ─────────────────────────────────────────────────────────────
    // Business & Payroll
    // ─────────────────────────────────────────────────────────────

    function findBusinessByCEO(list, ceoUuid) {
        for (let i = 0; i < list.length; i++) if (list[i].ceo === ceoUuid) return list[i];
        return null;
    }

    function findBusinessByEmployee(list, uuid) {
        for (let i = 0; i < list.length; i++) {
            for (let j = 0; j < list[i].employees.length; j++) {
                if (list[i].employees[j].uuid === uuid) return list[i];
            }
        }
        return null;
    }

    function businessRegister(player, name) {
        const display = String(name || '').replace(/§./g, '').trim();
        if (!display) { err(player, 'Business name required.'); return 0; }
        if (display.length > BUSINESS_NAME_MAX) { err(player, 'Name too long.'); return 0; }
        const list = loadBusinesses(player.server);
        const u = uuidStr(player);
        if (findBusinessByCEO(list, u)) { err(player, 'You already run a business.'); return 0; }
        if (findBusinessByEmployee(list, u)) { err(player, 'Resign from your current job first.'); return 0; }
        list.push({
            id: u + ':' + Date.now(),
            name: display,
            ceo: u,
            ceoName: player.username,
            employees: [],
            wagePerHour: 10,
            created: Date.now()
        });
        saveBusinesses(player.server, list);
        RP.rpNotify(player, 'Business "' + display + '" registered. Default wage: 10 Isons/hour.', 'Success');
        return 1;
    }

    function businessHire(player, target) {
        if (!target) { err(player, 'Target not found.'); return 0; }
        if (player === target) { err(player, 'You cannot hire yourself.'); return 0; }
        const list = loadBusinesses(player.server);
        const biz = findBusinessByCEO(list, uuidStr(player));
        if (!biz) { err(player, 'You do not run a business.'); return 0; }
        if (findBusinessByEmployee(list, uuidStr(target))) { err(player, target.username + ' already has a job.'); return 0; }
        if (findBusinessByCEO(list, uuidStr(target)))      { err(player, target.username + ' runs their own business.'); return 0; }
        biz.employees.push({
            uuid: uuidStr(target),
            name: target.username,
            hiredAt: Date.now(),
            accruedSeconds: 0,
            lastPaidAt: Date.now()
        });
        saveBusinesses(player.server, list);
        RP.rpNotify(player, 'Hired ' + target.username + '.', 'Success');
        RP.rpNotify(target, 'You have been hired by ' + biz.name + '.', 'Success');
        return 1;
    }

    function businessFire(player, target) {
        if (!target) { err(player, 'Target not found.'); return 0; }
        const list = loadBusinesses(player.server);
        const biz = findBusinessByCEO(list, uuidStr(player));
        if (!biz) { err(player, 'You do not run a business.'); return 0; }
        const tu = uuidStr(target);
        const idx = biz.employees.findIndex(e => e.uuid === tu);
        if (idx === -1) { err(player, target.username + ' is not on your payroll.'); return 0; }
        biz.employees.splice(idx, 1);
        saveBusinesses(player.server, list);
        RP.rpNotify(player, 'Fired ' + target.username + '.', 'Success');
        RP.rpNotify(target, 'You have been let go from ' + biz.name + '.', 'Warning');
        return 1;
    }

    function businessSetWage(player, perHour) {
        const wage = Math.max(0, Math.floor(perHour));
        const list = loadBusinesses(player.server);
        const biz = findBusinessByCEO(list, uuidStr(player));
        if (!biz) { err(player, 'You do not run a business.'); return 0; }
        biz.wagePerHour = wage;
        saveBusinesses(player.server, list);
        RP.rpNotify(player, 'Wage set to ' + wage + ' Isons/hour.', 'Success');
        return 1;
    }

    function businessPay(player) {
        const list = loadBusinesses(player.server);
        const biz = findBusinessByCEO(list, uuidStr(player));
        if (!biz) { err(player, 'You do not run a business.'); return 0; }
        if (biz.employees.length === 0) { err(player, 'No employees on the payroll.'); return 0; }

        const onlinePayouts = []; // {emp, payout}
        let total = 0;
        for (let i = 0; i < biz.employees.length; i++) {
            const e = biz.employees[i];
            const target = findPlayerByUuid(player.server, e.uuid);
            if (!target) continue; // offline
            const hours = e.accruedSeconds / 3600;
            const pay = Math.floor(hours * biz.wagePerHour);
            if (pay <= 0) continue;
            onlinePayouts.push({ emp: e, target: target, pay: pay });
            total += pay;
        }
        if (total === 0) { err(player, 'No accrued wages to disburse.'); return 0; }
        if (RP.getBalance(player) < total) { err(player, 'You need ' + total + ' Isons to make payroll.'); return 0; }
        const taken = RP.takeBalance(player, total);
        if (taken !== total) {
            if (taken > 0) RP.giveBalance(player, taken);
            err(player, 'Failed to collect payroll funds.');
            return 0;
        }

        for (let i = 0; i < onlinePayouts.length; i++) {
            const o = onlinePayouts[i];
            RP.giveBalance(o.target, o.pay);
            o.emp.accruedSeconds = 0;
            o.emp.lastPaidAt = Date.now();
            RP.rpNotify(o.target, 'Wages received from ' + biz.name + ': ' + o.pay + ' Isons.', 'Success');
        }
        saveBusinesses(player.server, list);
        RP.rpNotify(player, 'Payroll disbursed: ' + total + ' Isons across ' + onlinePayouts.length + ' employees.', 'Success');
        return 1;
    }

    function businessInfo(player) {
        const list = loadBusinesses(player.server);
        const u = uuidStr(player);
        const ceoOf = findBusinessByCEO(list, u);
        const empOf = findBusinessByEmployee(list, u);
        if (!ceoOf && !empOf) { err(player, 'You are not affiliated with a business.'); return 0; }
        if (ceoOf) {
            player.tell(Text.string('═══ ' + ceoOf.name + ' (CEO) ═══').color(C.BIZ).bold(true));
            player.tell(Text.string('Wage: ' + ceoOf.wagePerHour + ' Isons/hour    Employees: ' + ceoOf.employees.length).color(C.BIZ));
            for (let i = 0; i < ceoOf.employees.length; i++) {
                const e = ceoOf.employees[i];
                const minutes = Math.floor(e.accruedSeconds / 60);
                player.tell(Text.string('• ' + e.name + ' — ' + minutes + ' min accrued').color(C.BIZ));
            }
        }
        if (empOf) {
            const me = empOf.employees.find(e => e.uuid === u);
            const minutes = Math.floor(me.accruedSeconds / 60);
            player.tell(Text.string('═══ ' + empOf.name + ' (Employee) ═══').color(C.BIZ).bold(true));
            player.tell(Text.string('Wage: ' + empOf.wagePerHour + ' Isons/hour    Accrued: ' + minutes + ' min').color(C.BIZ));
        }
        return 1;
    }

    // Per-second tick: accrue active work time for online employees.
    function tickBusinessAccrual(server, activeUuids) {
        const list = loadBusinesses(server);
        let dirty = false;
        for (let i = 0; i < list.length; i++) {
            for (let j = 0; j < list[i].employees.length; j++) {
                const e = list[i].employees[j];
                if (activeUuids[e.uuid]) { e.accruedSeconds += 1; dirty = true; }
            }
        }
        if (dirty) saveBusinesses(server, list);
    }

    // ─────────────────────────────────────────────────────────────
    // Organic Progression
    // ─────────────────────────────────────────────────────────────

    function getActivityCompound(player) {
        const c = pdataCompound(player);
        if (!c.contains('act')) c.put('act', {});
        return c.getCompound('act');
    }

    function bumpActivity(player, key, amount) {
        const a = getActivityCompound(player);
        a.putInt(key, (a.contains(key) ? a.getInt(key) : 0) + (amount || 1));
    }

    function rollProgression(player) {
        const c = pdataCompound(player);
        const a = getActivityCompound(player);

        // Build weighted pool by activity → stat.
        const weights = { STR: 0, DEX: 0, CON: 0, INT: 0, WIS: 0, CHA: 0 };
        const keys = Object.keys(ACTIVITY_STATS);
        let total = 0;
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const v = a.contains(k) ? a.getInt(k) : 0;
            if (v > 0) { weights[ACTIVITY_STATS[k]] += v; total += v; }
        }

        let chosen;
        if (total === 0) {
            chosen = RP.STATS[Math.floor(Math.random() * RP.STATS.length)];
        } else {
            let roll = Math.random() * total;
            chosen = RP.STATS[0];
            for (let i = 0; i < RP.STATS.length; i++) {
                roll -= weights[RP.STATS[i]];
                if (roll <= 0) { chosen = RP.STATS[i]; break; }
            }
        }

        // Reset activity bucket regardless of whether the roll lands.
        c.put('act', {});

        if (Math.random() >= PROGRESSION_CHANCE) return false;
        const cur = RP.getStat(player, chosen);
        if (cur >= RP.MAX_STAT) return false;
        RP.setStat(player, chosen, cur + 1);
        RP.rpNotify(player, 'Through practice, your ' + chosen + ' grows (now ' + (cur + 1) + ').', 'Success');
        return true;
    }

    // ─────────────────────────────────────────────────────────────
    // PvP reward routing
    // ─────────────────────────────────────────────────────────────

    function handlePvPKill(killer, target) {
        // War bonus
        const kf = RP.getFaction(killer);
        const tf = RP.getFaction(target);
        if (kf && tf && areAtWar(killer.server, kf, tf)) {
            RP.giveBalance(killer, WAR_KILL_BONUS);
            RP.rpNotify(killer, 'Wartime kill against ' + tf + ': +' + WAR_KILL_BONUS + ' Isons.', 'Success');
        }
        // Bounty payout (always — independent of war)
        claimBounty(killer, target);
    }

    // ─────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────

    global.RPWorld = {
        // factions
        factionCreate: factionCreate,
        factionInvite: factionInvite,
        factionAccept: factionAccept,
        factionPromote: factionPromote,
        factionWar:    factionWar,
        factionPeace:  factionPeace,
        factionInfo:   factionInfo,
        areAtWar:      areAtWar,
        // bounties
        bountyPlace: bountyPlace,
        bountyList:  bountyList,
        bountyInfo:  bountyInfo,
        claimBounty: claimBounty,
        // business
        businessRegister: businessRegister,
        businessHire:     businessHire,
        businessFire:     businessFire,
        businessSetWage:  businessSetWage,
        businessPay:      businessPay,
        businessInfo:     businessInfo,
        // progression
        bumpActivity:    bumpActivity,
        rollProgression: rollProgression,
        // pvp
        handlePvPKill: handlePvPKill,
        // tick hooks
        tickBusinessAccrual: tickBusinessAccrual,
        // shared volatile state
        _lastPos:      lastPos,
        _lastActiveAt: lastActiveAt
    };

})();

// ─────────────────────────────────────────────────────────────────
// Event Hooks
// ─────────────────────────────────────────────────────────────────

// PvP kill detection — fires alongside the combat module's hurt handler.
// This handler does not cancel anything; it only routes rewards.
EntityEvents.hurt(event => {
    const W = global.RPWorld;
    if (!W) return;
    const target = event.entity;
    if (!target || !target.isPlayer || !target.isPlayer()) return;
    if (target.health - event.damage > 0) return; // not lethal

    const src = event.source;
    const killer = src && (src.actual || src.entity);
    if (!killer || !killer.isPlayer || !killer.isPlayer() || killer === target) return;

    W.handlePvPKill(killer, target);
});

// Activity counters — event-driven sources.
BlockEvents.broken(event => {
    const W = global.RPWorld;
    if (!W) return;
    if (event.player) W.bumpActivity(event.player, 'mine');
});

PlayerEvents.crafted(event => {
    const W = global.RPWorld;
    if (!W) return;
    if (event.player) W.bumpActivity(event.player, 'craft');
});

PlayerEvents.chat(event => {
    const W = global.RPWorld;
    if (!W) return;
    if (event.player) W.bumpActivity(event.player, 'chat');
    // Note: 01_social_module.js cancels this event; KubeJS still calls every
    // listener regardless of cancellation, so the counter increments either way.
});

// Per-second housekeeping: activity sampling + progression + business accrual.
ServerEvents.tick(event => {
    const W = global.RPWorld;
    if (!W) return;
    if (event.server.tickCount % 20 !== 0) return;

    const players = event.server.players;
    const now = Date.now();
    const activeUuids = {};

    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        const u = p.uuid.toString();
        const cur = [p.x, p.y, p.z];
        const prev = W._lastPos[u];
        const moved = !prev || prev[0] !== cur[0] || prev[1] !== cur[1] || prev[2] !== cur[2];
        W._lastPos[u] = cur;
        if (moved) W._lastActiveAt[u] = now;

        const lastAt = W._lastActiveAt[u] || 0;
        if ((now - lastAt) >= 60_000) continue; // AFK — don't accrue
        activeUuids[u] = true;

        // Activity counters that are derivable from current state
        if (p.isSprinting && p.isSprinting()) W.bumpActivity(p, 'sprint');
        if (p.isCrouching && p.isCrouching()) W.bumpActivity(p, 'sneak');

        // Active-time accumulator for progression
        const root = p.persistentData;
        if (!root.contains('rp_core')) root.put('rp_core', {});
        const c = root.getCompound('rp_core');
        const seconds = (c.contains('activeSeconds') ? c.getLong('activeSeconds') : 0) + 1;
        c.putLong('activeSeconds', seconds);
        if (seconds % 600 === 0) W.rollProgression(p); // every 10 minutes of active play
    }

    W.tickBusinessAccrual(event.server, activeUuids);
});

// ─────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────

ServerEvents.commandRegistry(event => {
    const Commands  = event.commands;
    const Arguments = event.arguments;
    const W         = global.RPWorld;

    const safePlayer    = (ctx) => { try { return ctx.source.player; } catch (e) { return null; } };
    const requirePlayer = (ctx, fn) => { const p = safePlayer(ctx); return p ? fn(p) : 0; };

    // /faction ...
    event.register(
        Commands.literal('faction')
            .then(Commands.literal('create')
                .then(Commands.argument('name', Arguments.GREEDY_STRING.create(event))
                    .executes(ctx => requirePlayer(ctx, p =>
                        W.factionCreate(p, Arguments.GREEDY_STRING.getResult(ctx, 'name'))))))
            .then(Commands.literal('invite')
                .then(Commands.argument('target', Arguments.PLAYER.create(event))
                    .executes(ctx => requirePlayer(ctx, p =>
                        W.factionInvite(p, Arguments.PLAYER.getResult(ctx, 'target'))))))
            .then(Commands.literal('accept')
                .then(Commands.argument('name', Arguments.GREEDY_STRING.create(event))
                    .executes(ctx => requirePlayer(ctx, p =>
                        W.factionAccept(p, Arguments.GREEDY_STRING.getResult(ctx, 'name'))))))
            .then(Commands.literal('promote')
                .then(Commands.argument('target', Arguments.PLAYER.create(event))
                    .executes(ctx => requirePlayer(ctx, p =>
                        W.factionPromote(p, Arguments.PLAYER.getResult(ctx, 'target'))))))
            .then(Commands.literal('war')
                .then(Commands.argument('name', Arguments.GREEDY_STRING.create(event))
                    .executes(ctx => requirePlayer(ctx, p =>
                        W.factionWar(p, Arguments.GREEDY_STRING.getResult(ctx, 'name'))))))
            .then(Commands.literal('peace')
                .then(Commands.argument('name', Arguments.GREEDY_STRING.create(event))
                    .executes(ctx => requirePlayer(ctx, p =>
                        W.factionPeace(p, Arguments.GREEDY_STRING.getResult(ctx, 'name'))))))
            .then(Commands.literal('info')
                .executes(ctx => requirePlayer(ctx, p => W.factionInfo(p, null)))
                .then(Commands.argument('name', Arguments.GREEDY_STRING.create(event))
                    .executes(ctx => requirePlayer(ctx, p =>
                        W.factionInfo(p, Arguments.GREEDY_STRING.getResult(ctx, 'name'))))))
    );

    // /bounty ...
    event.register(
        Commands.literal('bounty')
            .then(Commands.literal('place')
                .then(Commands.argument('target', Arguments.PLAYER.create(event))
                    .then(Commands.argument('amount', Arguments.INTEGER.create(event))
                        .executes(ctx => requirePlayer(ctx, p =>
                            W.bountyPlace(p,
                                Arguments.PLAYER.getResult(ctx, 'target'),
                                Arguments.INTEGER.getResult(ctx, 'amount'))))))
            )
            .then(Commands.literal('list').executes(ctx => requirePlayer(ctx, p => W.bountyList(p))))
            .then(Commands.literal('info')
                .then(Commands.argument('target', Arguments.PLAYER.create(event))
                    .executes(ctx => requirePlayer(ctx, p =>
                        W.bountyInfo(p, Arguments.PLAYER.getResult(ctx, 'target'))))))
    );

    // /business ...
    event.register(
        Commands.literal('business')
            .then(Commands.literal('register')
                .then(Commands.argument('name', Arguments.GREEDY_STRING.create(event))
                    .executes(ctx => requirePlayer(ctx, p =>
                        W.businessRegister(p, Arguments.GREEDY_STRING.getResult(ctx, 'name'))))))
            .then(Commands.literal('hire')
                .then(Commands.argument('target', Arguments.PLAYER.create(event))
                    .executes(ctx => requirePlayer(ctx, p =>
                        W.businessHire(p, Arguments.PLAYER.getResult(ctx, 'target'))))))
            .then(Commands.literal('fire')
                .then(Commands.argument('target', Arguments.PLAYER.create(event))
                    .executes(ctx => requirePlayer(ctx, p =>
                        W.businessFire(p, Arguments.PLAYER.getResult(ctx, 'target'))))))
            .then(Commands.literal('setwage')
                .then(Commands.argument('amount', Arguments.INTEGER.create(event))
                    .executes(ctx => requirePlayer(ctx, p =>
                        W.businessSetWage(p, Arguments.INTEGER.getResult(ctx, 'amount'))))))
            .then(Commands.literal('pay').executes(ctx => requirePlayer(ctx, p => W.businessPay(p))))
            .then(Commands.literal('info').executes(ctx => requirePlayer(ctx, p => W.businessInfo(p))))
    );
});
