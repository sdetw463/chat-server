const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installChunkUploads, CHUNK_BYTES } = require('../lib/chunk-uploads');
const { MAX_FILE_BYTES } = require('../lib/file-limits');

test('chunk HTTP upload: exact 200MB, integrity, ownership, order, cancellation and 500MB reservations', async t => {
    const app = express();
    app.use(express.json());
    let persisted;
    const state = installChunkUploads(app, express, {
        identity: req => req.get('X-Client-ID'), ready: () => true, active: async () => {},
        persist: async item => {
            persisted = { size: item.buffer.length, filename: item.filename, sessionId: item.sessionId };
            assert(item.buffer.every(value => value === 42));
            return { downloadId: 'saved', persistent: true };
        }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { await state.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}/api/ai-chat/uploads`;
    const request = (suffix, body, user = 'owner', method = 'POST') => fetch(base + suffix, {
        method, headers: { 'X-Client-ID': user, 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)
    });
    const start = size => request('', { sessionId: 'session', name: 'sample.zip', size });
    assert.equal((await start(MAX_FILE_BYTES + 1)).status, 400);
    const one = await (await start(MAX_FILE_BYTES)).json();
    const two = await (await start(MAX_FILE_BYTES)).json();
    const three = await (await start(100 * 1024 ** 2)).json();
    assert.equal((await start(1)).status, 400);
    assert.equal((await request(`/${two.uploadId}`, undefined, 'other', 'DELETE')).status, 400);
    assert.equal((await request(`/${two.uploadId}`, undefined, 'owner', 'DELETE')).status, 200);
    assert.equal((await request(`/${three.uploadId}`, undefined, 'owner', 'DELETE')).status, 200);
    assert.equal((await request(`/${one.uploadId}/complete`, {})).status, 400);
    const bytes = Buffer.alloc(CHUNK_BYTES, 42);
    assert.equal((await request(`/${one.uploadId}/chunks?offset=1`, bytes)).status, 400);
    for (let offset = 0; offset < MAX_FILE_BYTES; offset += bytes.length) {
        const response = await request(`/${one.uploadId}/chunks?offset=${offset}`, bytes);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).received, offset + bytes.length);
    }
    assert.equal((await request(`/${one.uploadId}/chunks?offset=${MAX_FILE_BYTES}`, Buffer.from('*'))).status, 400);
    const result = await request(`/${one.uploadId}/complete`, {});
    assert.equal(result.status, 200);
    assert.equal((await result.json()).downloadId, 'saved');
    assert.deepEqual(persisted, { size: MAX_FILE_BYTES, filename: 'sample.zip', sessionId: 'session' });
    assert.equal((await request(`/${one.uploadId}/complete`, {})).status, 400);
});
