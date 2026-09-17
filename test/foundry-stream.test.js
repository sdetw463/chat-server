const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
process.env.FOUNDRY_PROJECT_ENDPOINT = 'https://test.services.ai.azure.com/api/projects/test';
process.env.FOUNDRY_AGENT_VERSION = '17';
process.env.FOUNDRY_USE_CONVERSATIONS = 'false';
let pending = false, aborted;
require('../lib/foundry-agent').createFoundryClients = () => ({ openai: {
    responses: { create: async (body, options) => {
        assert(options.signal instanceof AbortSignal);
        assert.equal(options.body.agent_reference.version, '17');
        return (async function* () {
            yield { type: 'response.output_text.delta', item_id: 'intro', delta: '正在处理' };
            if (pending) await new Promise((_, reject) => options.signal.addEventListener('abort', () => { aborted?.(); reject(options.signal.reason); }, { once: true }));
            yield { type: 'response.output_text.delta', item_id: 'answer', delta: '结果是42' };
            yield { type: 'response.completed', response: { id: 'resp-test', status: 'completed', output: ['正在处理', '结果是42'].map(text => ({ type: 'message', content: [{ type: 'output_text', text }] })) } };
        })();
    } }, files: { delete: async () => ({ deleted: true }) }
} });
const { server } = require('../server');
test('SSE preserves paragraphs/final text, rejects duplicate generation, and aborts upstream when stopped', async () => {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/socket/' + encodeURIComponent('拖'));
    const tokenPromise = new Promise(resolve => ws.on('message', raw => { const d = JSON.parse(raw); if (d.type === 'ai_access') resolve(d.token); }));
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'ai_access' })); const token = await tokenPromise;
    const request = signal => fetch(base + '/api/ai-chat', { method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'X-AI-Access': token },
        body: JSON.stringify({ clientId: 'stream-test-client', sessionId: 'chat', message: 'test', stream: true }) });
    try {
        const content = await (await request()).text();
        const events = content.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
        assert.equal(events.filter(e => e.delta).map(e => e.delta).join(''), '正在处理\n\n结果是42');
        assert.match(events.find(e => e.done).finalText, /结果是42/); assert.match(content, /data: \[DONE\]/);
        pending = true; const controller = new AbortController(), stopped = new Promise(resolve => aborted = resolve);
        const reader = (await request(controller.signal)).body.getReader();
        while (true) { const { value } = await reader.read(); if (new TextDecoder().decode(value).includes('delta')) break; }
        const duplicate = await request(); assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).code, 'CHAT_IN_PROGRESS');
        controller.abort(); await stopped; await reader.cancel().catch(() => {}); pending = false;
    } finally { ws.terminate(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
