const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');

test('direct HTTP chat mounts uploads, serves generated files from the resource, and never references an Agent', async () => {
    process.env.AI_CHAT_BACKEND = 'direct-responses';
    process.env.AZURE_RESPONSES_ENDPOINT = 'https://example.openai.azure.com';
    const direct = require('../lib/direct-responses');
    const calls = [];
    const uploads = [];
    const uploadedBytes = new Map();
    let downloads = 0;
    direct.createDirectClient = () => ({
        files: {
            create: async ({ file }) => {
                uploads.push(file);
                const id = uploads.length === 1 ? 'file-upload' : `file-upload-${uploads.length}`;
                uploadedBytes.set(id, Buffer.from(await file.arrayBuffer()));
                return { id };
            },
            content: async id => new Response(uploadedBytes.get(id)),
            delete: async () => ({ deleted: true })
        },
        containers: { files: { content: { retrieve: async (id, args) => {
            assert.equal(id, 'cfile-test');
            assert.equal(args.container_id, 'cntr-test');
            downloads++;
            return new Response('generated-file', { headers: { 'Content-Type': 'text/plain' } });
        } } } },
        responses: { create: async (body, options) => {
            calls.push({ body, options });
            return { id: 'resp-test', status: 'completed', output: [{ type: 'message', content: [{
                type: 'output_text', text: '已生成文件', annotations: [{ type: 'container_file_citation', container_id: 'cntr-test', file_id: 'cfile-test', filename: 'result.txt' }]
            }] }] };
        } }
    });
    const { server } = require('../server');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/socket/' + encodeURIComponent('拖'));
    try {
        const tokenPromise = new Promise(resolve => ws.on('message', raw => {
            const data = JSON.parse(raw);
            if (data.type === 'ai_access') resolve(data.token);
        }));
        await once(ws, 'open');
        ws.send(JSON.stringify({ type: 'ai_access' }));
        const token = await tokenPromise;
        const res = await fetch(base + '/api/ai-chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Access': token },
            body: JSON.stringify({ clientId: 'direct-test', message: '处理这个 CSV', historyMessages: [{ role: 'assistant', content: '前一轮' }], documents: [{ name: 'input.csv', fileData: 'data:text/csv;base64,eCx5CjEsMgo=' }] })
        });
        assert.equal(res.status, 200);
        const result = await res.json();
        assert.equal(result.backend, 'direct-responses');
        assert.equal(result.usedAgent, false);
        assert.equal(result.foundryConversationId, null);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].options, {});
        assert.equal(calls[0].body.model, 'gpt-6-astra');
        assert.deepEqual(calls[0].body.tools[1].container.file_ids, ['file-upload']);
        assert.equal(calls[0].body.input[0].content, '前一轮');
        const file = await fetch(base + result.files[0].url);
        assert.equal(await file.text(), 'generated-file');
        assert.equal(downloads, 1);
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>中文图</text></svg>';
        const svgRes = await fetch(base + '/api/ai-chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Access': token },
            body: JSON.stringify({ clientId: 'direct-test', message: '检查 SVG', documents: [{ name: '框架.svg', fileData: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') }] })
        });
        assert.equal(svgRes.status, 200);
        const svgResult = await svgRes.json();
        assert.equal(uploads.at(-1).name, '框架.svg.zip');
        assert.match(JSON.stringify(calls.at(-1).body.input), /附件传输说明/);
        assert.equal(svgResult.sessionFiles[0].filename, '框架.svg');
        const original = await fetch(base + svgResult.sessionFiles[0].url);
        assert.equal(original.headers.get('content-type'), 'image/svg+xml');
        assert.equal(await original.text(), svg);
        const uploadCount = uploads.length;
        const reuse = await fetch(base + '/api/ai-chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Access': token },
            body: JSON.stringify({ clientId: 'direct-test', message: '继续编辑 SVG', sessionFiles: svgResult.sessionFiles })
        });
        assert.equal(reuse.status, 200);
        await reuse.json();
        assert.equal(uploads.length, uploadCount);
        assert.match(JSON.stringify(calls.at(-1).body.input), /框架.svg.zip/);
    } finally {
        ws.terminate();
        await new Promise(resolve => server.close(resolve));
    }
});
