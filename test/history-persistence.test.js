const test = require('node:test');
const assert = require('node:assert/strict');
const { changedMessageOperations, retryDatabase } = require('../lib/history-persistence');

test('history sync skips unchanged messages and keeps updates scoped to user/session', () => {
    const old = Array.from({ length: 300 }, (_, i) => ({ messageId: String(i), role: 'user', content: 'old', sessionFiles: [] }));
    assert.deepEqual(changedMessageOperations('u', 's', old, structuredClone(old)), []);
    const operations = changedMessageOperations('u', 's', [...old.slice(1), { messageId: 'new', role: 'assistant', content: 'new' }], old);
    assert.equal(operations.length, 1);
    assert.deepEqual(operations[0].updateOne.filter, { docType: 'message', userId: 'u', sessionId: 's', messageId: 'new' });
    const changed = [{ ...old[0], progress: { status: 'completed' } }];
    assert.equal(changedMessageOperations('u', 's', changed, old).length, 1);
});

test('database retry is bounded, honors Cosmos backoff, and rejects other errors immediately', async () => {
    let calls = 0; const delays = [];
    const result = await retryDatabase(async () => { if (++calls < 3) throw { code: 16500, message: 'RetryAfterMs=300' }; return 'ok'; }, { sleep: async ms => delays.push(ms) });
    assert.equal(result, 'ok'); assert.equal(calls, 3); assert(delays.every(ms => ms >= 300 && ms < 400));
    calls = 0;
    await assert.rejects(retryDatabase(async () => { calls++; throw new Error('unrelated'); }, { sleep: async () => {} }));
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(retryDatabase(async () => { calls++; throw { code: 16500 }; }, { sleep: async () => {} }));
    assert.equal(calls, 4);
});
