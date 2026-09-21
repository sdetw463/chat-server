const test = require('node:test');
const assert = require('node:assert/strict');
const { beginChat, abortChat, withSessionWrite, mapWithConcurrency } = require('../lib/session-lifecycle');
const { buildDefinition } = require('../scripts/configure-foundry-agent');
test('active requests reject overlap, isolate owners and release safely after cancellation', () => {
    const first = new AbortController(), other = new AbortController();
    const release = beginChat('u', 's', first), releaseOther = beginChat('other', 's', other);
    assert.throws(() => beginChat('u', 's', new AbortController()), { code: 'CHAT_IN_PROGRESS', status: 409 });
    abortChat('u', 's', new Error('deleted'));
    assert(first.signal.aborted); assert(!other.signal.aborted);
    release(); const next = beginChat('u', 's', new AbortController()); release();
    assert.throws(() => beginChat('u', 's', new AbortController())); next(); releaseOther();
});
test('deletion finishes before a late completion can write, and rejected writes release the lock', async () => {
    let finish, deleted = false;
    const deletion = withSessionWrite('u', 's', async () => { await new Promise(r => finish = r); deleted = true; });
    await Promise.resolve();
    const late = withSessionWrite('u', 's', async () => { assert(deleted); throw Error('deleted'); });
    finish(); await deletion; await assert.rejects(late, /deleted/);
    assert.equal(await withSessionWrite('u', 's', () => 'released'), 'released');
});
test('history retrieval limits concurrent queries and preserves order', async () => {
    let active = 0, max = 0;
    const results = await mapWithConcurrency([1,2,3,4,5], 2, async v => {
        max = Math.max(max, ++active); await new Promise(r => setTimeout(r, 2)); active--; return v * 2;
    });
    assert.equal(max, 2); assert.deepEqual(results, [2,4,6,8,10]);
});
test('Agent definition pins Astra high, public summaries, native tools and 10 attachment slots', () => {
    const source = { kind: 'prompt', model: 'old', tools: [{ type: 'web_search' }, { type: 'code_interpreter', container: { type: 'auto' } }] };
    const d = buildDefinition(source);
    assert.equal(d.model, 'gpt-6-astra'); assert.deepEqual(d.reasoning, { effort: 'high', summary: 'auto' });
    assert.equal(d.tools[0].search_context_size, 'high');
    assert.equal(Object.keys(d.structured_inputs).length, 10);
    assert.equal(d.tools[1].container.file_ids[9], '{{attachment_file_10}}'); assert.equal(source.model, 'old');
});
