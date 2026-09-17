const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installChunkUploads, CHUNK_BYTES, pruneAbandonedUploads } = require('../lib/chunk-uploads');
const { MAX_FILE_BYTES } = require('../lib/file-limits');

test('chunk HTTP upload: exact 200MB, integrity, ownership, order, cancellation and 500MB reservations', async t => {
    const app = express();
    app.use(express.json());
    let persisted;
    const state = installChunkUploads(app, express, {
        identity: req => req.get('X-Client-ID'), ready: () => true, active: async () => {},
        persist: async item => {
            assert.equal(item.buffer, undefined, 'large uploads must not be materialized in memory');
            let size = 0;
            for await (const chunk of require('node:fs').createReadStream(item.path)) {
                size += chunk.length;
                assert(chunk.every(value => value === 42));
            }
            persisted = { size, filename: item.filename, sessionId: item.sessionId };
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
    assert.equal((await request(`/${one.uploadId}/chunks?offset=0`, bytes)).status, 200);
    assert.equal((await request(`/${one.uploadId}/chunks?offset=0`, Buffer.from('wrong'))).status, 400);
    assert.equal((await request(`/${one.uploadId}/chunks?offset=${MAX_FILE_BYTES}`, Buffer.from('*'))).status, 400);
    const result = await request(`/${one.uploadId}/complete`, {});
    assert.equal(result.status, 200);
    assert.equal((await result.json()).downloadId, 'saved');
    assert.deepEqual(persisted, { size: MAX_FILE_BYTES, filename: 'sample.zip', sessionId: 'session' });
    assert.equal((await request(`/${one.uploadId}/complete`, {})).status, 200);
});

test('failed persistence retains completed chunks for retry without duplicate file creation', async t => {
    const app = express(); app.use(express.json());
    let calls = 0;
    const state = installChunkUploads(app, express, {
        identity: () => 'owner', ready: () => true, active: async () => {},
        persist: async item => {
            assert.equal(await require('node:fs/promises').readFile(item.path, 'utf8'), 'test');
            if (++calls === 1) throw Object.assign(new Error('temporary storage failure'), { status: 503 });
            return { downloadId: 'saved-once' };
        }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { await state.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}/api/ai-chat/uploads`;
    const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const { uploadId } = await (await fetch(base, json({ sessionId: 's', name: 'a.txt', size: 4 }))).json();
    await fetch(`${base}/${uploadId}/chunks?offset=0`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'test' });
    assert.equal((await fetch(`${base}/${uploadId}/complete`, json({}))).status, 503);
    for (let n = 0; n < 2; n++) {
        const response = await fetch(`${base}/${uploadId}/complete`, json({}));
        assert.equal(response.status, 200); assert.equal((await response.json()).downloadId, 'saved-once');
    }
    assert.equal(calls, 2);
});

test('restart cleanup removes dead-worker and expired legacy uploads without touching live workers or unrelated files', async t => {
    const fs = require('node:fs/promises');
    const os = require('node:os');
    const path = require('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tuotuo-cleanup-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const now = Date.now();
    const make = async (name, { owner, stale = false, freshData = false } = {}) => {
        const dir = path.join(root, name); await fs.mkdir(dir);
        await fs.writeFile(path.join(dir, 'data'), 'test');
        if (owner) await fs.writeFile(path.join(dir, '.upload-owner.json'), JSON.stringify(owner));
        if (stale) {
            const old = new Date(now - 60 * 60000);
            await fs.utimes(dir, old, old);
            if (!freshData) await fs.utimes(path.join(dir, 'data'), old, old);
        }
    };
    await make('tuotuo-upload-dead01', { owner: { pid: 40001, hostname: os.hostname() } });
    await make('tuotuo-upload-live01', { owner: { pid: 40002, hostname: os.hostname() }, stale: true });
    await make('tuotuo-upload-legacy', { stale: true });
    await make('tuotuo-upload-recent');
    await make('tuotuo-upload-active', { stale: true, freshData: true });
    await make('tuotuo-upload-remote', { owner: { pid: 40001, hostname: 'another-worker-host' }, stale: true });
    await make('other-upload-legacy', { stale: true });
    await fs.symlink(path.join(root, 'other-upload-legacy'), path.join(root, 'tuotuo-upload-linked'));
    await pruneAbandonedUploads({ tempRoot: root, now, processAlive: pid => pid === 40002 });
    const remaining = await fs.readdir(root);
    assert(!remaining.includes('tuotuo-upload-dead01'));
    assert(!remaining.includes('tuotuo-upload-legacy'));
    for (const name of ['tuotuo-upload-live01', 'tuotuo-upload-recent', 'tuotuo-upload-active', 'tuotuo-upload-remote', 'other-upload-legacy', 'tuotuo-upload-linked']) {
        assert(remaining.includes(name), `must preserve ${name}`);
    }
});
