'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');
const { installRealtime, loadHistory, normalizeMessage, HISTORY_GROUPS } = require('../lib/realtime');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const objectId = value => String(value).padStart(24, '0');

function memoryModel(initial = []) {
    const rows = structuredClone(initial);
    return {
        rows, reads: 0,
        find(query) {
            this.reads++;
            let limit;
            return {
                sort() { return this; },
                limit(value) { limit = value; return this; },
                async lean() {
                    return rows.filter(row => typeof query.msgType === 'string'
                        ? row.msgType === query.msgType : !query.msgType.$nin.includes(row.msgType))
                        .sort((a, b) => String(b._id).localeCompare(String(a._id))).slice(0, limit);
                }
            };
        },
        findOne(query) { return { lean: async () => rows.find(row => Object.entries(query).every(([key, value]) => row[key] === value)) }; },
        findOneAndUpdate(query, update) {
            return { lean: async () => {
                let row = rows.find(row => row._id === query._id);
                if (!row) { row = { ...update.$setOnInsert, _id: query._id }; rows.push(row); }
                return row;
            } };
        },
        async create(data) { rows.push({ ...data, _id: objectId(rows.length + 1) }); }
    };
}

async function fixture(t, options = {}) {
    const server = http.createServer((req, res) => res.end());
    const MessageModel = options.MessageModel || memoryModel();
    const aiAccessTokens = new Map();
    const realtime = installRealtime(server, { MessageModel, aiAccessTokens, uploadImage: async image => image,
        databaseReady: () => true, logger: { warn() {}, error() {} }, ...options });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { await realtime.close(); await new Promise(resolve => server.close(resolve)); });
    const base = `ws://127.0.0.1:${server.address().port}`;
    const connect = async (nickname = '访客', clientOptions) => {
        const ws = new WebSocket(`${base}/socket/${encodeURIComponent(nickname)}`, clientOptions);
        ws.on('error', () => {});
        ws.received = [];
        ws.on('message', raw => ws.received.push(JSON.parse(raw)));
        await once(ws, 'open');
        return ws;
    };
    return { MessageModel, aiAccessTokens, realtime, base, connect };
}

function nextMessage(ws, predicate) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for WebSocket message')); }, 3000);
        const listener = raw => { const data = JSON.parse(raw); if (predicate(data)) { cleanup(); resolve(data); } };
        const cleanup = () => { clearTimeout(timer); ws.off('message', listener); };
        ws.on('message', listener);
    });
}

test('messages arriving during the initial history read are saved and AI tokens remain immediately available', async t => {
    const gate = deferred();
    const model = memoryModel();
    const originalFind = model.find;
    let delayFirst = true;
    model.find = function (query) {
        const chain = originalFind.call(this, query);
        const originalLean = chain.lean;
        chain.lean = async () => { if (delayFirst) { delayFirst = false; await gate.promise; } return originalLean(); };
        return chain;
    };
    const { connect, aiAccessTokens, realtime } = await fixture(t, { MessageModel: model });
    const ws = await connect('拖');
    const tokenReceived = nextMessage(ws, data => data.type === 'ai_access');
    const earlyReceived = nextMessage(ws, data => data.type === 'message' && data.msg === 'early');
    ws.send(JSON.stringify({ msgType: 'text', msg: 'early' }));
    ws.send(JSON.stringify({ type: 'ai_access' }));
    const { token } = await tokenReceived;
    assert.equal(token.length, 43);
    assert(aiAccessTokens.has(token));
    assert.equal(model.rows.length, 0);
    gate.resolve();
    assert.equal((await earlyReceived).name, '拖');
    assert.equal(model.rows.length, 1);
    const serverClosed = once([...realtime.wss.clients][0], 'close');
    ws.close(); await serverClosed;
    assert.equal(aiAccessTokens.has(token), false);
});

test('sequential queues keep an image ahead of later text even when upload is slow', async t => {
    const started = deferred(), finish = deferred();
    const { connect, MessageModel } = await fixture(t, {
        uploadImage: async () => { started.resolve(); await finish.promise; return 'https://files.example/image.jpg'; }
    });
    const ws = await connect();
    const second = nextMessage(ws, data => data.type === 'message' && data.msg === 'second');
    ws.send(JSON.stringify({ msgType: 'image', msg: 'data:image/jpeg;base64,YQ==' }));
    ws.send(JSON.stringify({ msgType: 'text', msg: 'second', type: 'userlist', arbitraryField: 'discard' }));
    await started.promise;
    assert.equal(MessageModel.rows.length, 0);
    finish.resolve();
    await second;
    assert.deepEqual(MessageModel.rows.map(row => row.msg), ['https://files.example/image.jpg', 'second']);
    assert.equal(MessageModel.rows[1].arbitraryField, undefined);
    assert.deepEqual(ws.received.filter(message => message.type === 'message').map(message => message.msg), ['https://files.example/image.jpg', 'second']);
});

test('already accepted messages finish saving when their connection closes', async t => {
    const started = deferred(), finish = deferred(), saved = deferred();
    const model = memoryModel();
    const create = model.create.bind(model);
    model.create = async data => { await create(data); if (data.msg === 'second') saved.resolve(); };
    const { connect } = await fixture(t, { MessageModel: model,
        uploadImage: async () => { started.resolve(); await finish.promise; return 'https://files.example/image.jpg'; } });
    const ws = await connect();
    ws.send(JSON.stringify({ msgType: 'image', msg: 'data:image/jpeg;base64,YQ==' }));
    ws.send(JSON.stringify({ msgType: 'text', msg: 'second' }));
    await started.promise;
    ws.ping(); await once(ws, 'pong');
    ws.close(); await once(ws, 'close');
    finish.resolve();
    await saved.promise;
    assert.equal(model.rows.length, 2);
});

test('a connection opened during database startup retries its missing history', async t => {
    let ready = false;
    const model = memoryModel([{ _id: objectId(1), msgType: 'text', msg: 'restored history' }]);
    const { connect } = await fixture(t, { MessageModel: model, databaseReady: () => ready, historyRetryMs: 10 });
    const ws = await connect();
    const restored = nextMessage(ws, data => data.type === 'history');
    ready = true;
    assert.equal((await restored).data[0].msg, 'restored history');
});

test('independent history windows retain old diaries, albums and wishes under heavy chat traffic', async () => {
    const model = memoryModel([
        { _id: objectId(1), msgType: 'diary', entryId: 'diary-1', text: 'old diary' },
        { _id: objectId(2), msgType: 'star', msg: 'old wish' },
        { _id: objectId(3), msgType: 'album_food', msg: 'https://files.example/old.jpg' },
        { _id: objectId(4), msgType: 'diary_like', entryId: 'diary-1', name: 'reader', isLike: true },
        ...Array.from({ length: 900 }, (_, index) => ({ _id: objectId(index + 5), msgType: 'text', msg: `chat-${index}` }))
    ]);
    const history = await loadHistory(model);
    assert.equal(model.reads, HISTORY_GROUPS.length);
    assert.equal(history.filter(row => row.msgType === 'text').length, 300);
    for (const type of ['diary', 'star', 'album_food', 'diary_like']) assert.equal(history.filter(row => row.msgType === type).length, 1);
    assert.equal(history[0].id, 'diary-1');
    assert.equal(history.at(-1).msg, 'chat-899');
});

test('history applies a diary before its later like even when their ObjectId suffixes differ', async () => {
    const history = await loadHistory(memoryModel([
        { _id: '65000000ffffffffff000000', msgType: 'diary', entryId: 'de_entry', text: 'diary', createdAt: new Date('2026-09-17T00:00:00.000Z') },
        { _id: '650000000000000000000001', msgType: 'diary_like', entryId: 'de_entry', isLike: true, createdAt: new Date('2026-09-17T00:00:00.100Z') }
    ]));
    assert.deepEqual(history.map(row => row.msgType), ['diary', 'diary_like']);
});

test('malformed paths and unapproved browser origins cannot create WebSocket connections', async t => {
    const { base } = await fixture(t, { allowedOrigins: ['https://example.com'] });
    const rejected = (path, options) => new Promise(resolve => {
        const ws = new WebSocket(base + path, options);
        ws.on('error', () => {});
        ws.on('unexpected-response', (request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
    });
    assert.equal(await rejected('/socket/%E0%A4%A'), 400);
    assert.equal(await rejected('/wrong/path'), 400);
    assert.equal(await rejected('/socket/guest', { origin: 'https://other.example' }), 403);
});

test('bad messages and failed saves report errors without broadcasting unpersisted data', async t => {
    const model = memoryModel();
    model.create = async () => { throw new Error('database temporarily unavailable'); };
    const { connect } = await fixture(t, { MessageModel: model });
    const ws = await connect();
    const malformed = nextMessage(ws, data => data.code === 'INVALID_MESSAGE');
    ws.send('{broken'); await malformed;
    const failed = nextMessage(ws, data => data.code === 'MESSAGE_SAVE_FAILED');
    ws.send(JSON.stringify({ msgType: 'text', msg: 'not saved' })); await failed;
    assert.equal(ws.received.filter(data => data.type === 'message').length, 0);
});

test('payload and slow-reader limits close only the affected connection', async t => {
    const { connect, realtime } = await fixture(t, { maxPayloadBytes: 1024, maxBacklogBytes: 2048 });
    const large = await connect();
    const tooLarge = once(large, 'close');
    large.send(JSON.stringify({ msgType: 'text', msg: 'a'.repeat(1500) }));
    assert.equal((await tooLarge)[0], 1009);
    const slow = await connect('拖');
    const serverPeer = [...realtime.wss.clients][0];
    Object.defineProperty(serverPeer, 'bufferedAmount', { get: () => 2048 });
    const closed = once(slow, 'close');
    slow.send(JSON.stringify({ type: 'ai_access' }));
    assert.equal((await closed)[0], 1013);
    const healthy = await connect('普通用户');
    const received = nextMessage(healthy, data => data.type === 'message');
    healthy.send(JSON.stringify({ msgType: 'text', msg: 'still available' }));
    assert.equal((await received).msg, 'still available');
});

test('heartbeat removes a half-open connection and invalidates its AI token', async t => {
    const { connect, aiAccessTokens, realtime } = await fixture(t, { heartbeatMs: 30 });
    const ws = await connect('拖', { autoPong: false });
    const tokenMessage = nextMessage(ws, data => data.type === 'ai_access');
    ws.send(JSON.stringify({ type: 'ai_access' }));
    const { token } = await tokenMessage;
    const closed = once([...realtime.wss.clients][0], 'close');
    await closed;
    assert.equal(aiAccessTokens.has(token), false);
});

test('a diary retry with the same ID acknowledges the original without storing or uploading a duplicate', async t => {
    let imageUploads = 0;
    const { connect, MessageModel } = await fixture(t, { uploadImage: async image => { imageUploads++; return image; } });
    const ws = await connect();
    const diary = { msgType: 'diary', id: 'de_retry', dateKey: '2026-09-17', author: '朋友', text: 'original diary', imgs: ['data:image/jpeg;base64,YQ=='] };
    for (let attempt = 0; attempt < 2; attempt++) {
        const ack = nextMessage(ws, data => data.type === 'message' && data.id === 'de_retry');
        ws.send(JSON.stringify(diary));
        assert.equal((await ack).text, 'original diary');
    }
    assert.equal(MessageModel.rows.length, 1);
    assert.equal(imageUploads, 1);
});

test('all existing business types retain their fields while forged protocol fields are removed', () => {
    const diary = normalizeMessage({ msgType: 'diary', dateKey: '2026-09-17', id: 'de_123', author: '朋友', text: '今天很好', imgs: [], time: '2026.09.17 12:30' }, '拖');
    assert.equal(diary.author, '朋友'); assert.equal(diary.entryId, 'de_123');
    const like = normalizeMessage({ msgType: 'diary_like', dateKey: '2026-09-17', entryId: 'de_123', name: '朋友', isLike: false }, '拖');
    assert.equal(like.entryId, 'de_123'); assert.equal(like.isLike, false);
    const albumLike = normalizeMessage({ msgType: 'album_like', albumType: 'album_food', imgId: 'img_123', name: '朋友', isLike: true }, '拖');
    assert.equal(albumLike.imgId, 'img_123');
    assert.throws(() => normalizeMessage({ msgType: 'userlist', data: [] }, '拖'));
});
