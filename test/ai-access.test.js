const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const WebSocket = require('ws');

test('AI routes require a live access token issued only to the qualifying nickname', async () => {
    const { server } = require('../server');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const sockets = [];
    const request = (route, token) => fetch(base + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Access': token || '' }, body: '{}'
    });
    try {
        for (const route of ['/api/ai-chat', '/api/ai-image', '/api/sessions/sync']) {
            const res = await request(route);
            assert.equal(res.status, 503);
            assert.equal((await res.json()).code, 'SERVICE_UNAVAILABLE');
        }
        const connect = async (name) => {
            const ws = new WebSocket(base.replace('http:', 'ws:') + '/socket/' + encodeURIComponent(name));
            sockets.push(ws);
            await once(ws, 'open');
            return ws;
        };
        const ordinary = await connect('普通用户');
        let ordinaryToken = '';
        ordinary.on('message', raw => { const data = JSON.parse(raw); if (data.type === 'ai_access') ordinaryToken = data.token; });
        ordinary.send(JSON.stringify({ type: 'ai_access' }));
        // Ping round trip ensures the preceding request has reached the server.
        ordinary.ping();
        await once(ordinary, 'pong');
        assert.equal(ordinaryToken, '');
        assert.equal((await request('/api/ai-chat', 'forged')).status, 503);
        const qualified = await connect('拖');
        const tokenPromise = new Promise(resolve => qualified.on('message', raw => {
            const data = JSON.parse(raw); if (data.type === 'ai_access') resolve(data.token);
        }));
        qualified.send(JSON.stringify({ type: 'ai_access' }));
        const token = await tokenPromise;
        assert.equal(token.length, 43);
        // Empty input reaches validation, never invokes a paid model.
        assert.equal((await request('/api/ai-image', token)).status, 400);
        qualified.close();
        await once(qualified, 'close');
        assert.equal((await request('/api/ai-chat', token)).status, 503);
    } finally {
        for (const socket of sockets) socket.terminate();
        await new Promise(resolve => server.close(resolve));
    }
});

// The frontend lives in a separate repository; exercise it when both checkouts are present.
test('unqualified frontend sends no request and does not persist or process attachments', {
    skip: !fs.existsSync(path.join(__dirname, '../../js/features/74-gpt-chat.js'))
}, async () => {
    const source = fs.readFileSync(path.join(__dirname, '../../js/features/74-gpt-chat.js'), 'utf8');
    const start = source.indexOf('async function sendGPTMessage()');
    const end = source.indexOf("    if (typeof ensureGPTSessionsLoaded", start);
    let displayed = '';
    const context = vm.createContext({
        document: { getElementById: id => id === 'gpt-input-el' ? { value: '你好' } : {
            querySelector: () => null, insertAdjacentHTML: (_, html) => { displayed = html; }, scrollHeight: 1
        } },
        gptIsSending: false, gptPendingFiles: [{}], aiAccessToken: '', chatNickname: '普通用户',
        localStorage: { getItem: () => '普通用户' },
    });
    // Any call outside this early gate fails because no network/storage helper exists.
    vm.runInContext(source.slice(start, end) + 'throw new Error("gate bypassed");\n}', context);
    await vm.runInContext('sendGPTMessage()', context);
    assert.match(displayed, /当前服务暂时不可用/);
});

test('API wrapper forwards the access header for history queries as well as generation', {
    skip: !fs.existsSync(path.join(__dirname, '../../js/core/00-core-utils.js'))
}, async () => {
    const source = fs.readFileSync(path.join(__dirname, '../../js/core/00-core-utils.js'), 'utf8');
    const start = source.indexOf('async function tuoApiFetch');
    const end = source.indexOf('\n(function()', start);
    const calls = [];
    const context = vm.createContext({ Headers, aiAccessToken: 'test-token', TUOTUO_API_BASE: 'https://example.test',
        fetch: (url, options) => { calls.push({ url, options }); } });
    vm.runInContext(source.slice(start, end), context);
    for (const route of ['/api/ai-chat', '/api/ai-image', '/api/sessions?clientId=abc', '/api/sessions/sync']) {
        await vm.runInContext(`tuoApiFetch(${JSON.stringify(route)})`, context);
        assert.equal(calls.at(-1).options.headers.get('X-AI-Access'), 'test-token');
    }
});
