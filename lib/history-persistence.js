'use strict';
const { isDeepStrictEqual } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');

function changedMessageOperations(userId, sessionId, messages, existing) {
    const previous = new Map(existing.map(message => [message.messageId, message]));
    const unique = new Map(messages.map(message => [message.messageId, message]));
    return [...unique.values()].filter(message => {
        const prior = previous.get(message.messageId);
        return !prior || Object.entries(message).some(([key, value]) => !isDeepStrictEqual(value, prior[key]));
    }).map(message => ({ updateOne: {
        filter: { docType: 'message', userId, sessionId, messageId: message.messageId },
        update: { $set: { ...message, docType: 'message', userId, sessionId } }, upsert: true
    } }));
}

// Only reads and idempotent upserts use this helper, never model calls.
async function retryDatabase(work, { attempts = 4, sleep = delay } = {}) {
    for (let attempt = 0; ; attempt++) {
        try { return await work(); }
        catch (error) {
            if (Number(error.code) !== 16500 || attempt >= attempts - 1) throw error;
            const retryAfter = Number(String(error.message).match(/RetryAfterMs[=:]\s*(\d+)/i)?.[1]) || 100;
            await sleep(Math.min(2000, Math.max(retryAfter, 100 * 2 ** attempt)) + Math.floor(Math.random() * 100));
        }
    }
}

module.exports = { changedMessageOperations, retryDatabase };
