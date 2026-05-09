// priority: 900
// 01_social_module.js — Social & Immersion Module
// Depends on global.RPCore (00_core_engine.js)

(function () {
    'use strict';

    const RP = global.RPCore;
    if (!RP) {
        console.error('[RPSocial] global.RPCore missing — load order: 00_core_engine.js must run first.');
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────

    const RANGE = {
        WHISPER: 5,
        SAY:     20,
        YELL:    60
    };

    const C = {
        WHISPER: '#7A7A8C', // dim cool gray
        SAY:     '#E8E8E8', // off-white
        YELL:    '#FF8855', // bright orange
        ME:      '#FFB7C5', // soft pink
        DO:      '#A0A0A0', // neutral gray
        ROLL:    '#FFD479', // soft gold
        CRIT:    '#FFD700', // gold
        FUMBLE:  '#FF5555', // red
        LOOK:    '#88DDFF', // pale cyan
        ERROR:   '#FF5555',
        AMBIENT: '#707070'  // muted parenthetical
    };

    const MAX_RP_NAME_LEN     = 32;   // also written-book title limit
    const MAX_DESCRIPTION_LEN = 500;
    const MAX_JOURNAL_ENTRY   = 2000;
    const MAX_JOURNAL_ENTRIES = 200;
    const PAGE_CHARS          = 240;  // ~14 lines × ~19 chars
    const BOOK_PAGE_LIMIT     = 100;  // vanilla written-book ceiling

    // ─────────────────────────────────────────────────────────────
    // Utilities
    // ─────────────────────────────────────────────────────────────

    const stripFmt  = (s) => String(s == null ? '' : s).replace(/§./g, '');
    const trimRight = (s) => s.replace(/\s+$/, '');
    const truncate  = (s, n) => (s.length > n ? s.substring(0, n) : s);
    const isStat    = (s) => RP.STATS.indexOf(s) !== -1;

    function sameLevel(a, b) {
        if (!a || !b || !a.level || !b.level) return false;
        return a.level === b.level || a.level.dimension === b.level.dimension;
    }

    function broadcastInRange(speaker, rangeBlocks, build) {
        const rangeSq = rangeBlocks * rangeBlocks;
        const players = speaker.server.players;
        let heard = 0;
        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            if (!sameLevel(p, speaker)) continue;
            if (p.distanceToSqr(speaker) > rangeSq) continue;
            const msg = build(p);
            if (msg) p.tell(msg);
            heard++;
        }
        return heard;
    }

    function findPlayerByName(server, name) {
        const lower = String(name || '').toLowerCase();
        if (!lower) return null;
        const players = server.players;
        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            if (p.username.toLowerCase() === lower) return p;
            if (RP.getRPName(p).toLowerCase() === lower) return p;
        }
        return null;
    }

    function err(player, message) {
        if (player && player.tell) player.tell(Text.string(message).color(C.ERROR));
    }

    // Lightweight typed access to the rp_core compound (matches core_engine's namespace).
    function pdataCompound(player) {
        const root = player.persistentData;
        if (!root.contains('rp_core')) root.put('rp_core', {});
        return root.getCompound('rp_core');
    }

    // ─────────────────────────────────────────────────────────────
    // Tiered Chat
    // ─────────────────────────────────────────────────────────────

    const TIER = {
        WHISPER: { range: RANGE.WHISPER, color: C.WHISPER, verb: 'whispers', italic: true,  bold: false },
        SAY:     { range: RANGE.SAY,     color: C.SAY,     verb: 'says',     italic: false, bold: false },
        YELL:    { range: RANGE.YELL,    color: C.YELL,    verb: 'yells',    italic: false, bold: true  }
    };

    function tieredChat(speaker, message, tierKey) {
        const text = stripFmt(message).trim();
        if (!text) { err(speaker, 'You must say something.'); return 0; }
        const t = TIER[tierKey];
        if (!t) { err(speaker, 'Unknown chat tier.'); return 0; }

        const rpName = RP.getRPName(speaker);
        const heard = broadcastInRange(speaker, t.range, () =>
            Text.string(rpName + ' ' + t.verb + ': ').color(t.color).bold(t.bold)
                .append(Text.string(text).color(t.color).italic(t.italic).bold(t.bold))
        );

        if (heard <= 1) {
            speaker.tell(Text.string('(no one nearby hears you)').color(C.AMBIENT).italic(true));
        }
        return 1;
    }

    // ─────────────────────────────────────────────────────────────
    // RP Actions
    // ─────────────────────────────────────────────────────────────

    function emoteMe(speaker, action) {
        const text = stripFmt(action).trim();
        if (!text) { err(speaker, 'Describe what you are doing.'); return 0; }
        const rpName = RP.getRPName(speaker);
        broadcastInRange(speaker, RANGE.SAY, () =>
            Text.string('* ' + rpName + ' ' + text + ' *').color(C.ME).italic(true)
        );
        return 1;
    }

    function emoteDo(speaker, description) {
        const text = stripFmt(description).trim();
        if (!text) { err(speaker, 'Describe the scene.'); return 0; }
        broadcastInRange(speaker, RANGE.SAY, () =>
            Text.string('( ' + text + ' )').color(C.DO).italic(true)
        );
        return 1;
    }

    function rollD20() {
        return 1 + Math.floor(Math.random() * 20);
    }

    function tryRoll(speaker, statRaw, action) {
        const stat = String(statRaw || '').toUpperCase();
        if (!isStat(stat)) {
            err(speaker, 'Invalid stat. Use one of: ' + RP.STATS.join(', ') + '.');
            return 0;
        }
        const text = stripFmt(action).trim();
        if (!text) { err(speaker, 'Describe the attempt.'); return 0; }

        const roll  = rollD20();
        const mod   = RP.getStatModifier(speaker, stat);
        const total = roll + mod;
        const isCrit   = roll === 20;
        const isFumble = roll === 1;
        const sign  = mod >= 0 ? '+' : '';
        const tag   = isCrit ? ' [Critical!]' : isFumble ? ' [Fumble!]' : '';
        const tagColor = isCrit ? C.CRIT : isFumble ? C.FUMBLE : C.ROLL;
        const rpName = RP.getRPName(speaker);

        const line = Text.string('* ' + rpName + ' attempts to ' + text + ' *  ').color(C.ME).italic(true)
            .append(Text.string('[d20=' + roll + ' ' + sign + mod + ' ' + stat + ' = ' + total + ']' + tag)
                .color(tagColor).bold(isCrit || isFumble).italic(false));

        broadcastInRange(speaker, RANGE.SAY, () => line);
        return 1;
    }

    // ─────────────────────────────────────────────────────────────
    // Identity
    // ─────────────────────────────────────────────────────────────

    function setRPName(player, name) {
        const clean = truncate(stripFmt(name).trim(), MAX_RP_NAME_LEN);
        if (!clean) { err(player, 'Name cannot be empty.'); return 0; }
        RP.setRPName(player, clean);
        RP.rpNotify(player, 'You are now known as ' + clean, 'Success');
        return 1;
    }

    function setDescription(player, desc) {
        const clean = truncate(stripFmt(desc).trim(), MAX_DESCRIPTION_LEN);
        if (!clean) { err(player, 'Description cannot be empty.'); return 0; }
        pdataCompound(player).putString('description', clean);
        RP.rpNotify(player, 'Your description has been updated.', 'Success');
        return 1;
    }

    function getDescription(player) {
        const c = pdataCompound(player);
        return c.contains('description') ? c.getString('description') : '';
    }

    function lookAt(viewer, target) {
        const rpName = RP.getRPName(target);
        const desc   = getDescription(target) || 'No description set.';
        const faction = RP.getFaction(target);
        const factionLine = faction ? '\n\nFaction: ' + faction : '';

        const hover = Text.string(rpName).color(C.LOOK).bold(true)
            .append(Text.string('\n\n' + desc + factionLine).color('#FFFFFF').italic(false).bold(false));

        const line = Text.string('You see ').color(C.LOOK)
            .append(Text.string(rpName).color(C.LOOK).bold(true).hover(hover))
            .append(Text.string('. ').color(C.LOOK))
            .append(Text.string('(hover for details)').color(C.AMBIENT).italic(true));
        viewer.tell(line);
        return 1;
    }

    // ─────────────────────────────────────────────────────────────
    // Journal
    // ─────────────────────────────────────────────────────────────
    // Stored as a JSON-encoded array of {t: ms, text: string} on persistentData.
    // JSON keeps the data trivially portable and avoids ListTag/CompoundTag bookkeeping.

    function getJournal(player) {
        const c = pdataCompound(player);
        if (!c.contains('journal')) return [];
        try {
            const arr = JSON.parse(c.getString('journal'));
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            console.warn('[RPSocial] Journal decode failed for ' + player.username + ': ' + e);
            return [];
        }
    }

    function setJournal(player, arr) {
        pdataCompound(player).putString('journal', JSON.stringify(arr));
    }

    function journalWrite(player, text) {
        const clean = stripFmt(text).trim();
        if (!clean) { err(player, 'Cannot write an empty entry.'); return 0; }
        const entries = getJournal(player);
        if (entries.length >= MAX_JOURNAL_ENTRIES) {
            err(player, 'Your journal is full. Use /journal read to print the existing entries first.');
            return 0;
        }
        entries.push({ t: Date.now(), text: truncate(clean, MAX_JOURNAL_ENTRY) });
        setJournal(player, entries);
        RP.rpNotify(player, 'Entry recorded (' + entries.length + ').', 'Success');
        return 1;
    }

    function paginate(text, perPage) {
        const pages = [];
        const len = text.length;
        let i = 0;
        while (i < len) {
            let end = Math.min(i + perPage, len);
            if (end < len) {
                const lastSpace = text.lastIndexOf(' ', end);
                if (lastSpace > i + Math.floor(perPage / 2)) end = lastSpace;
            }
            pages.push(trimRight(text.substring(i, end)));
            i = end;
            while (i < len && text.charAt(i) === ' ') i++;
        }
        return pages;
    }

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    function formatDate(ms) {
        const d = new Date(ms);
        return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
               ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ' UTC';
    }

    function journalRead(player) {
        const entries = getJournal(player);
        if (entries.length === 0) {
            err(player, 'Your journal is empty. Use /journal write <text>.');
            return 0;
        }

        const pages = [];
        for (let i = 0; i < entries.length && pages.length < BOOK_PAGE_LIMIT; i++) {
            const e = entries[i];
            const body = '§l' + formatDate(e.t) + '§r\n\n' + (e.text || '');
            const chunks = paginate(body, PAGE_CHARS);
            for (let j = 0; j < chunks.length && pages.length < BOOK_PAGE_LIMIT; j++) {
                pages.push(JSON.stringify(chunks[j]));
            }
        }

        const rpName = RP.getRPName(player);
        const title  = truncate(rpName + "'s Journal", MAX_RP_NAME_LEN);
        const book   = Item.of('minecraft:written_book', {
            title:      title,
            author:     rpName,
            pages:      pages,
            resolved:   1,
            generation: 0
        });
        player.give(book);
        RP.rpNotify(player, 'Journal printed (' + pages.length + ' page' + (pages.length === 1 ? '' : 's') + ').', 'Success');
        return 1;
    }

    // ─────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────

    global.RPSocial = {
        RANGE:            RANGE,
        broadcastInRange: broadcastInRange,
        findPlayerByName: findPlayerByName,
        tieredChat:       tieredChat,
        emoteMe:          emoteMe,
        emoteDo:          emoteDo,
        tryRoll:          tryRoll,
        setRPName:        setRPName,
        setDescription:   setDescription,
        getDescription:   getDescription,
        lookAt:           lookAt,
        journalWrite:     journalWrite,
        journalRead:      journalRead,
        getJournal:       getJournal
    };

})();

// ─────────────────────────────────────────────────────────────────
// Command Registration
// ─────────────────────────────────────────────────────────────────

ServerEvents.commandRegistry(event => {
    const Commands  = event.commands;
    const Arguments = event.arguments;
    const RPSocial  = global.RPSocial;

    const safePlayer = (ctx) => {
        try { return ctx.source.player; } catch (e) { return null; }
    };
    const requirePlayer = (ctx, fn) => {
        const p = safePlayer(ctx);
        if (!p) return 0;
        return fn(p);
    };
    const errSrc = (player, msg) => player.tell(Text.string(msg).color('#FF5555'));

    // /whisper, /say, /yell — tiered proximity chat.
    // IIFE per iteration: KubeJS's Rhino flattens `const` inside a plain
    // for-body into function scope, so reusing the names cmd/tier across
    // iterations triggers "redeclaration of var". A function call gives
    // each registration its own captured binding.
    function registerTier(cmd, tier) {
        event.register(
            Commands.literal(cmd)
                .then(Commands.argument('message', Arguments.GREEDY_STRING.create(event))
                    .executes(ctx => requirePlayer(ctx, p =>
                        RPSocial.tieredChat(p, Arguments.GREEDY_STRING.getResult(ctx, 'message'), tier)
                    ))
                )
        );
    }
    registerTier('whisper', 'WHISPER');
    registerTier('say',     'SAY');
    registerTier('yell',    'YELL');

    // /me <action>
    event.register(
        Commands.literal('me')
            .then(Commands.argument('action', Arguments.GREEDY_STRING.create(event))
                .executes(ctx => requirePlayer(ctx, p =>
                    RPSocial.emoteMe(p, Arguments.GREEDY_STRING.getResult(ctx, 'action'))
                ))
            )
    );

    // /do <description>
    event.register(
        Commands.literal('do')
            .then(Commands.argument('description', Arguments.GREEDY_STRING.create(event))
                .executes(ctx => requirePlayer(ctx, p =>
                    RPSocial.emoteDo(p, Arguments.GREEDY_STRING.getResult(ctx, 'description'))
                ))
            )
    );

    // /try <STAT> <action> — d20 + stat modifier
    event.register(
        Commands.literal('try')
            .then(Commands.argument('stat', Arguments.STRING.create(event))
                .then(Commands.argument('action', Arguments.GREEDY_STRING.create(event))
                    .executes(ctx => requirePlayer(ctx, p =>
                        RPSocial.tryRoll(p,
                            Arguments.STRING.getResult(ctx, 'stat'),
                            Arguments.GREEDY_STRING.getResult(ctx, 'action')
                        )
                    ))
                )
            )
    );

    // /rpname <name>
    event.register(
        Commands.literal('rpname')
            .then(Commands.argument('name', Arguments.GREEDY_STRING.create(event))
                .executes(ctx => requirePlayer(ctx, p =>
                    RPSocial.setRPName(p, Arguments.GREEDY_STRING.getResult(ctx, 'name'))
                ))
            )
    );

    // /description <text>
    event.register(
        Commands.literal('description')
            .then(Commands.argument('text', Arguments.GREEDY_STRING.create(event))
                .executes(ctx => requirePlayer(ctx, p =>
                    RPSocial.setDescription(p, Arguments.GREEDY_STRING.getResult(ctx, 'text'))
                ))
            )
    );

    // /look [target] — STRING arg accepts both Minecraft username and RP name
    event.register(
        Commands.literal('look')
            .executes(ctx => requirePlayer(ctx, p => RPSocial.lookAt(p, p)))
            .then(Commands.argument('target', Arguments.STRING.create(event))
                .executes(ctx => requirePlayer(ctx, p => {
                    const name = Arguments.STRING.getResult(ctx, 'target');
                    const target = RPSocial.findPlayerByName(p.server, name);
                    if (!target) { errSrc(p, 'No one by that name is online.'); return 0; }
                    return RPSocial.lookAt(p, target);
                }))
            )
    );

    // /journal write|read
    event.register(
        Commands.literal('journal')
            .then(Commands.literal('write')
                .then(Commands.argument('text', Arguments.GREEDY_STRING.create(event))
                    .executes(ctx => requirePlayer(ctx, p =>
                        RPSocial.journalWrite(p, Arguments.GREEDY_STRING.getResult(ctx, 'text'))
                    ))
                )
            )
            .then(Commands.literal('read')
                .executes(ctx => requirePlayer(ctx, p => RPSocial.journalRead(p)))
            )
    );
});

// ─────────────────────────────────────────────────────────────────
// Vanilla chat → tiered "say" with RP name
// Plain chat (no slash command) becomes a 20-block proximity message
// rendered with the player's RP name. Cancelling here suppresses the
// vanilla broadcast cleanly.
// ─────────────────────────────────────────────────────────────────

PlayerEvents.chat(event => {
    const player  = event.player;
    const message = String(event.message || '');
    if (!player || !message) return;
    event.cancel();
    global.RPSocial.tieredChat(player, message, 'SAY');
});
