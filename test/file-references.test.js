const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
process.env.AI_CHAT_BACKEND = 'direct-responses';
const { _test } = require('../server');
const mongoose = require('mongoose');

test('durable references: 10 mounts, 500MB boundary, strict owner/session, old history remains readable', async t => {
    const model = mongoose.model('AiFile');
    const oldFind = model.find, oldFindOne = model.findOne;
    const state = mongoose.connection.readyState;
    mongoose.connection.readyState = 1;
    t.after(() => { model.find = oldFind; model.findOne = oldFindOne; mongoose.connection.readyState = state; });
    const records = Array.from({ length: 10 }, (_, i) => ({
        filename: `f${i}.zip`, sessionId: 'session', userId: 'owner',
        downloadId: `token${i}`, downloadTokenHash: crypto.createHash('sha256').update(`token${i}`).digest('hex'),
        blobName: `private/${i}`, size: 50 * 1024 ** 2
    }));
    model.findOne = query => ({ lean: async () => records.find(r => r.downloadTokenHash === query.downloadTokenHash && r.userId === query.userId && (!query.sessionId || query.sessionId === r.sessionId)) });
    model.find = () => ({ limit: () => ({ lean: async () => [] }) });
    const documents = records.map(r => ({ name: r.filename, uploadToken: r.downloadId, size: 1 }));
    _test.validateAgentRequest({ userMessage: 'read', documents });
    assert.throws(() => _test.validateAgentRequest({ userMessage: 'read', documents: [...documents, documents[0]] }), /10/);
    const collect = (docs, user = 'owner', session = 'session', history = [], message = 'read') => _test.collectFoundryCodeInterpreterFiles(docs, history, user, session, message);
    const mounted = await collect(documents);
    assert.equal(mounted.length, 10);
    assert(mounted.every(f => f.blobName && !f.buffer));
    records[9].size++;
    await assert.rejects(collect(documents), /500MB/);
    records[9].size--;
    await assert.rejects(collect([documents[0]], 'other'), /不属于/);
    await assert.rejects(collect([documents[0]], 'owner', 'other-session'), /不属于/);
    await assert.rejects(collect([documents[0], documents[0]]), /重复/);
    const previous = await collect([], 'owner', 'session', [{ filename: 'f0.zip', downloadId: 'token0' }], '继续读取之前的文件');
    assert.equal(previous[0].blobName, 'private/0');
});
