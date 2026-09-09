const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const frontend = path.join(root, 'js/features/74-gpt-chat.js');

test('browser retains raw files with 200MB/500MB/10 guards, without Base64 allocation', { skip: !fs.existsSync(frontend) }, async () => {
    const source = fs.readFileSync(frontend, 'utf8');
    const helper = source.slice(source.indexOf('function shouldSendAsRawInputFile'), source.indexOf('async function extractPdfText'));
    const handler = source.slice(source.indexOf('async function handleGPTFileSelect'), source.indexOf('\nfunction ', source.indexOf('async function handleGPTFileSelect')));
    const pending = [], alerts = [];
    const context = vm.createContext({ currentGPTMode: 'normal', gptPendingFiles: pending,
        alert: s => alerts.push(s), showGPTTransientStatus: () => {}, renderGPTFilePreview: () => {},
        readFileAsDataUrl: async () => 'data:application/octet-stream;base64,QQ==',
        processImageAsync: () => { throw new Error('Non-raster file must not be rasterized'); }, console });
    vm.runInContext(helper + '\n' + handler, context);
    const send = async files => { context.event = { target: { type: 'file', value: 'selected', files } }; await vm.runInContext('handleGPTFileSelect(event)', context); };
    await send([{ name: 'large.zip', size: 49 * 1024 ** 2, type: '' }, { name: 'drawing.svg', size: 10, type: 'image/svg+xml' }, { name: 'data.custom', size: 10, type: '' }]);
    assert.equal(pending.length, 3);
    assert(pending.every(f => f.type === 'document' && f.rawFile && !f.fileData));
    assert.equal(pending[0].mimeType, 'application/octet-stream');
    assert.equal(alerts.length, 0);
    pending.length = 0;
    await send([{ name: 'too-big.zip', size: 200 * 1024 ** 2 + 1, type: '' }]);
    assert.equal(pending.length, 0);
    assert.match(alerts.pop(), /200MB/);
    await send([{ name: 'a.zip', size: 200 * 1024 ** 2, type: '' }, { name: 'b.zip', size: 200 * 1024 ** 2, type: '' }, { name: 'c.zip', size: 100 * 1024 ** 2, type: '' }, { name: 'd.zip', size: 1, type: '' }]);
    assert.equal(pending.length, 3);
    assert.match(alerts.pop(), /合计/);
    pending.length = 0;
    await send(Array.from({ length: 11 }, (_, i) => ({ name: `${i}.zip`, size: 1, type: '' })));
    assert.equal(pending.length, 10);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.doesNotMatch(html.match(/<input[^>]*id="gpt-image-upload"[^>]*>/)[0], /accept=/);
    assert.match(fs.readFileSync(path.join(root, 'js/features/72-gpt-ui.js'), 'utf8'), /uploadInput.accept = ''/);
});
