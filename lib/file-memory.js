'use strict';
// Serialize memory-heavy file saves/mounts within an App Service process.
// Network chunks themselves remain small and can arrive independently.
let tail = Promise.resolve();
async function withFileMemory(work) {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
}
module.exports = { withFileMemory };
