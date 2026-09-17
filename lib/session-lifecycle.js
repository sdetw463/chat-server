'use strict';

const active = new Map();
const writes = new Map();
const keyFor = (userId, sessionId) => `${userId}:${sessionId || 'unsaved'}`;

function beginChat(userId, sessionId, controller) {
    const key = keyFor(userId, sessionId);
    if (active.has(key)) {
        throw Object.assign(new Error('这个聊天正在生成回复，请等待完成或先停止。'), { status: 409, code: 'CHAT_IN_PROGRESS' });
    }
    active.set(key, controller);
    return () => { if (active.get(key) === controller) active.delete(key); };
}

function abortChat(userId, sessionId, reason) {
    active.get(keyFor(userId, sessionId))?.abort(reason);
}

// Serialize short durable mutations so a sync/completion cannot resurrect a
// deleted session. The model stream does not hold this storage lock.
async function withSessionWrite(userId, sessionId, work) {
    const key = keyFor(userId, sessionId);
    const previous = writes.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    writes.set(key, current);
    await previous;
    try { return await work(); }
    finally {
        release();
        if (writes.get(key) === current) writes.delete(key);
    }
}

async function mapWithConcurrency(items, limit, work) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await work(items[index], index);
        }
    }));
    return results;
}

module.exports = { beginChat, abortChat, withSessionWrite, mapWithConcurrency };
