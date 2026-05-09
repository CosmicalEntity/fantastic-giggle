// 00_items.js — RP Engine custom items
// Registered at startup; referenced by name from server scripts.

StartupEvents.registry('item', event => {
    event.create('kubejs:medkit')
        .displayName('Medical Kit')
        .maxStackSize(8)
        .tooltip('§7Use §f/treat <player>§7 while holding this.')
        .tooltip('§oRevives a downed ally and inflicts a temporary Injury.');

    // Ison — the engine's controlled currency. No recipe, no loot, no
    // natural source. It enters the economy only via systems we own
    // (admin grants, business payroll, bounty payouts, war rewards).
    // Fire-resistant so a lava death doesn't wipe a player's wealth;
    // glow-marked so it's visually distinct from common drops.
    event.create('kubejs:ison')
        .displayName('Ison')
        .maxStackSize(64)
        .rarity('uncommon')
        .glow(true)
        .fireResistant(true)
        .tooltip('§7The realm’s standard currency.');
});

