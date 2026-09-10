'use strict';
// Serialize memory-heavy file saves/mounts within an App Service process.
// Network chunks themselves remain small and can arrive independently.
let busy = false;
const queue = [];
function release() {
    const next = queue.shift();
    if (next) next();
    else busy = false;
}
async function withFileMemory(work, { signal, onWaiting } = {}) {
    signal?.throwIfAborted();
    if (busy) {
        onWaiting?.();
        await new Promise((resolve, reject) => {
            const start = () => { signal?.removeEventListener('abort', abort); resolve(); };
            const abort = () => {
                const index = queue.indexOf(start);
                if (index >= 0) queue.splice(index, 1);
                reject(signal.reason);
            };
            queue.push(start);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
        });
    } else busy = true;
    try { signal?.throwIfAborted(); return await work(); } finally { release(); }
}
module.exports = { withFileMemory };
