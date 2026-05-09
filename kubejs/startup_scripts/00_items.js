// 00_items.js — RP Engine custom items
// Registered at startup; referenced by name from server scripts.

StartupEvents.registry('item', event => {
    event.create('kubejs:medkit')
        .displayName('Medical Kit')
        .maxStackSize(8)
        .tooltip('§7Use §f/treat <player>§7 while holding this.')
        .tooltip('§oRevives a downed ally and inflicts a temporary Injury.');
});
