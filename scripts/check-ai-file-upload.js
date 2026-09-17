'use strict';
// Explicit opt-in integration check. Generates synthetic bytes only, invokes
// no model, and removes its own remote file and local scratch data afterwards.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DefaultAzureCredential } = require('@azure/identity');
const { createFoundryClients } = require('../lib/foundry-agent');
const { prepareFileTransportFromPath } = require('../lib/file-transport');
const { uploadAIFile } = require('../lib/ai-file-upload');

async function main() {
    if (!process.argv.includes('--live') || !process.env.FOUNDRY_PROJECT_ENDPOINT) throw new Error('需要 --live 和 FOUNDRY_PROJECT_ENDPOINT；只运行合成文件传输验证，不调用模型。');
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tuotuo-large-probe-'));
    const { openai: client } = createFoundryClients(process.env.FOUNDRY_PROJECT_ENDPOINT, new DefaultAzureCredential());
    let remote;
    try {
        const input = path.join(dir, 'payload');
        const megabytes = process.argv.includes('--small') ? 1 : 110;
        const handle = await fs.promises.open(input, 'w');
        const block = Buffer.alloc(1024 ** 2, 42);
        try { for (let n = 0; n < megabytes; n++) await handle.write(block); } finally { await handle.close(); }
        const file = await prepareFileTransportFromPath({ path: input, size: megabytes * 1024 ** 2, filename: 'synthetic-upload-check.probe' }, path.join(dir, 'probe.zip'));
        const before = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(file.path)) before.update(chunk);
        const started = Date.now();
        remote = await uploadAIFile(client, file, { multipart: false, onProgress: (done, total) => console.log(`Azure 接收：${done}/${total}`) });
        console.log('Azure 已生成可用文件，开始下载校验。');
        const response = await client.files.content(remote.id, { timeout: 180000, maxRetries: 2, signal: AbortSignal.timeout(180000) });
        const after = crypto.createHash('sha256'); let bytes = 0;
        for await (const chunk of response.body) { bytes += chunk.length; after.update(chunk); }
        if (bytes !== file.size || before.digest('hex') !== after.digest('hex')) throw new Error('文件下载校验不一致。');
        console.log(JSON.stringify({ verifiedBytes: bytes, sha256Matches: true, seconds: Math.round((Date.now() - started) / 1000), modelCalls: 0 }));
    } finally {
        try { if (remote) console.log({ removedSyntheticFile: (await client.files.delete(remote.id, { timeout: 30000, maxRetries: 2 })).deleted }); }
        finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
