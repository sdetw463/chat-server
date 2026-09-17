'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSessionGarbageCollector } = require('../lib/session-gc');

const scope = crypto.createHash('sha256').update('foundry-agent:https://project.example/openai/v1').digest('hex');
function matches(row, filter) {
    return Object.entries(filter).every(([key, value]) => {
        if (key === '$and') return value.every(part => matches(row, part));
        if (key === '$or') return value.some(part => matches(row, part));
        if (value && typeof value === 'object' && !(value instanceof Date)) return Object.entries(value).every(([operator, expected]) => {
            if (operator === '$exists') return (row[key] !== undefined) === expected;
            if (operator === '$ne') return row[key] !== expected;
            if (operator === '$lte') return row[key] <= expected;
            throw new Error(`Unexpected test query operator: ${operator}`);
        });
        return row[key] === value;
    });
}

function collectionFixture(initial) {
    const rows = structuredClone(initial);
    const modify = (row, update) => {
        Object.assign(row, update.$set || {});
        for (const key of Object.keys(update.$unset || {})) delete row[key];
    };
    return {
        rows,
        find(filter) { let limit = Infinity; return {
            sort() { return this; }, limit(n) { limit = n; return this; },
            async toArray() { return rows.filter(row => matches(row, filter)).slice(0, limit).map(row => structuredClone(row)); }
        }; },
        async findOne(filter) { return structuredClone(rows.find(row => matches(row, filter)) || null); },
        async updateOne(filter, update, options) {
            let row = rows.find(row => matches(row, filter));
            if (!row && options?.upsert) {
                row = { ...filter, ...update.$setOnInsert, _id: `generated-${rows.length}` }; rows.push(row);
            }
            if (row) modify(row, update);
        },
        async updateMany(filter, update) { for (const row of rows) if (matches(row, filter)) modify(row, update); },
        async deleteOne(filter) { const index = rows.findIndex(row => matches(row, filter)); if (index >= 0) rows.splice(index, 1); },
        async deleteMany(filter) { for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], filter)) rows.splice(i, 1); }
    };
}

function fixture(t, initial, overrides = {}) {
    const collection = collectionFixture(initial);
    const calls = { files: [], blobs: [], conversations: [] };
    const openai = { baseURL: 'https://project.example/openai/v1',
        files: { delete: async id => { calls.files.push(id); } },
        conversations: { delete: async id => { calls.conversations.push(id); } }
    };
    const gc = createSessionGarbageCollector({ getCollection: () => collection, databaseReady: () => true,
        getStorage: () => ({ getBlockBlobClient: name => ({ deleteIfExists: async () => { calls.blobs.push(name); } }) }),
        getFoundry: () => openai, projectEndpoint: 'https://project.example', logger: { warn() {} }, ...overrides });
    t.after(() => gc.close());
    return { gc, collection, calls, openai };
}

const sessionRows = () => [
    { _id: 's1', docType: 'session', userId: 'owner', sessionId: 'deleted', foundryConversationId: 'conv-owner' },
    { _id: 'm1', docType: 'message', userId: 'owner', sessionId: 'deleted', content: 'history' },
    { _id: 'f1', docType: 'file', userId: 'owner', sessionId: 'deleted', blobName: 'owner/file', upstreamFile: { id: 'file-owner', scope } },
    { _id: 's2', docType: 'session', userId: 'other', sessionId: 'deleted', foundryConversationId: 'conv-other' },
    { _id: 'f2', docType: 'file', userId: 'other', sessionId: 'deleted', blobName: 'other/file', upstreamFile: { id: 'file-other', scope } },
    { _id: 's3', docType: 'session', userId: 'owner', sessionId: 'retained' }
];

test('logical deletion hides the exact session immediately and retries remote failures without affecting other owners', async t => {
    const { gc, collection, calls, openai } = fixture(t, sessionRows());
    openai.files.delete = async id => { calls.files.push(id); throw Object.assign(new Error('upstream outage'), { status: 503 }); };
    openai.conversations.delete = async id => { calls.conversations.push(id); throw Object.assign(new Error('upstream outage'), { status: 503 }); };
    await gc.deleteSession('owner', 'deleted');
    assert.equal(calls.files.length + calls.blobs.length + calls.conversations.length, 0, 'delete must not wait on any remote resource');
    assert(!collection.rows.some(row => row.userId === 'owner' && row.sessionId === 'deleted' && ['session', 'message', 'file'].includes(row.docType)));
    assert.equal(collection.rows.find(row => row._id === 'f1').docType, 'deleted_file');
    await gc.run();
    const failedFile = collection.rows.find(row => row._id === 'f1');
    assert.equal(failedFile.cleanupBlobDeleted, true);
    assert(failedFile.cleanupNextAttemptAt > new Date());
    assert(collection.rows.some(row => row.docType === 'deleted_session' && row.cleanupConversationId === 'conv-owner'));
    assert.deepEqual(calls.files, ['file-owner']);
    assert.deepEqual(calls.blobs, ['owner/file']);
    assert.deepEqual(calls.conversations, ['conv-owner']);
    assert(collection.rows.some(row => row._id === 's2'));
    assert.equal(collection.rows.find(row => row._id === 'f2').docType, 'file');
    assert(collection.rows.some(row => row._id === 's3'));
    // Simulate the persisted retry deadline after a process restart.
    for (const row of collection.rows) delete row.cleanupNextAttemptAt;
    openai.files.delete = async id => { calls.files.push(id); };
    openai.conversations.delete = async id => { calls.conversations.push(id); };
    await gc.run();
    assert(!collection.rows.some(row => row._id === 'f1'));
    const tombstone = collection.rows.find(row => row.docType === 'deleted_session');
    assert(tombstone); assert.equal(tombstone.cleanupConversationId, undefined);
    assert.deepEqual(calls.blobs, ['owner/file'], 'already deleted Blob is not downloaded or deleted repeatedly');
});

test('a tombstone left by a interrupted database deletion completes local cleanup on a later GC run', async t => {
    const initial = [...sessionRows(), { _id: 't1', docType: 'deleted_session', userId: 'owner', sessionId: 'deleted', cleanupPending: true }];
    const { gc, collection, calls } = fixture(t, initial);
    await gc.run();
    assert(!collection.rows.some(row => row.userId === 'owner' && row.sessionId === 'deleted' && row.docType !== 'deleted_session'));
    assert.deepEqual(calls.conversations, ['conv-owner']);
    assert.deepEqual(calls.files, ['file-owner']);
    assert(collection.rows.some(row => row._id === 's2'));
});

test('older backend scopes retain cleanup provenance and never delete from the current Foundry resource', async t => {
    const { gc, collection, calls } = fixture(t, [{ _id: 'old-file', docType: 'deleted_file', userId: 'owner', sessionId: 's',
        blobName: 'old/blob', upstreamFile: { id: 'old-id', scope: 'previous-direct-resource' } }]);
    await gc.run();
    assert.deepEqual(calls.files, []);
    assert.deepEqual(calls.blobs, ['old/blob']);
    assert.equal(collection.rows[0].cleanupLastError, 'PREVIOUS_BACKEND_SCOPE');
});

test('expired upstream resources count as cleaned and concurrent run calls share one sweep', async t => {
    const { gc, collection, openai, calls } = fixture(t, [{ _id: 'f', docType: 'deleted_file', userId: 'owner', sessionId: 's', upstreamFile: { id: 'expired', scope } }]);
    openai.files.delete = async id => { calls.files.push(id); throw Object.assign(new Error('not found'), { status: 404 }); };
    await Promise.all([gc.run(), gc.run(), gc.run()]);
    assert.equal(collection.rows.length, 0);
    assert.deepEqual(calls.files, ['expired']);
});
