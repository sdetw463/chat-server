const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { uploadAIFile, getCachedAIFile, upstreamRequestId, PART_BYTES } = require('../lib/ai-file-upload');
const { prepareFileTransportFromPath, unwrapFile } = require('../lib/file-transport');
const { withFileMemory } = require('../lib/file-memory');

async function fixture(t, size, filename = 'source.zip') {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tuotuo-upload-test-'));
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, 'input');
    const handle = await fs.promises.open(filePath, 'w');
    try {
        for (let offset = 0; offset < size; offset += 1024 ** 2) await handle.write(Buffer.alloc(Math.min(1024 ** 2, size - offset), 42));
    } finally { await handle.close(); }
    return { path: filePath, size, filename, mimeType: 'application/zip' };
}

test('large AI uploads use ordered 8MB parts and verify the assembled size', async t => {
    const file = await fixture(t, 17 * 1024 ** 2 + 19);
    const sizes = [], progress = [], parts = [];
    const client = { files: { create: () => assert.fail('large file must not use one-shot upload') }, uploads: {
        create: async (body, options) => {
            assert.equal(body.bytes, file.size); assert.equal(body.purpose, 'assistants');
            assert.equal(body.expires_after, undefined, 'Azure rejects this optional SDK parameter');
            assert.equal(options.maxRetries, 2); return { id: 'upload-1' };
        }, parts: { create: async (id, { data }, options) => {
            assert.equal(id, 'upload-1'); assert(options.timeout > 0);
            const bytes = Buffer.from(await data.arrayBuffer());
            assert(bytes.every(b => b === 42)); assert(bytes.length <= PART_BYTES);
            sizes.push(bytes.length); const part = 'part-' + sizes.length; parts.push(part); return { id: part };
        } }, complete: async (id, body) => {
            assert.deepEqual(body.part_ids, parts); return { file: { id: 'file-1', bytes: file.size } };
        }, cancel: () => assert.fail('completed upload should not be cancelled')
    } };
    const result = await uploadAIFile(client, file, { onProgress: (done, total) => { assert.equal(total, file.size); progress.push(done); } });
    assert.equal(result.id, 'file-1'); assert.equal(sizes.length, 3); assert.equal(progress.at(-1), file.size);
});

test('small AI uploads use a disk-backed Blob with original bytes and filename', async t => {
    const file = await fixture(t, 53, '原文件.csv');
    await uploadAIFile({ files: { create: async ({ file: blob }, options) => {
        assert.equal(blob.name, '原文件.csv'); assert.equal(blob.size, 53);
        assert(Buffer.from(await blob.arrayBuffer()).every(b => b === 42)); assert.equal(options.maxRetries, 2);
        return { id: 'small' };
    } } }, file);
});

test('failed upload parts cancel the upload, retain request ID and never call Responses', async t => {
    const file = await fixture(t, 17 * 1024 ** 2);
    let cancelled = 0;
    const failure = Object.assign(new Error('500 status code (no body)'), { status: 500, headers: new Headers({ 'apim-request-id': 'azure-request' }) });
    await assert.rejects(uploadAIFile({ uploads: {
        create: async () => ({ id: 'upload' }), parts: { create: async () => { throw failure; } },
        cancel: async id => { assert.equal(id, 'upload'); cancelled++; }
    } }, file), error => error === failure && error.fileStage === 'azure_upload' && error.upstreamRequestId === 'azure-request');
    assert.equal(cancelled, 1); assert.equal(upstreamRequestId(failure), 'azure-request');
});

test('abort interrupts multipart preparation and cleans only its own unfinished upload', async t => {
    const file = await fixture(t, 17 * 1024 ** 2), controller = new AbortController();
    let cancelled = 0, calls = 0;
    await assert.rejects(uploadAIFile({ uploads: {
        create: async () => ({ id: 'mine' }), parts: { create: async () => { calls++; controller.abort(); return { id: 'part' }; } },
        cancel: async id => { assert.equal(id, 'mine'); cancelled++; }
    } }, file, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls, 1); assert.equal(cancelled, 1);
});

test('cached files are scoped, checked before reuse, and expire without deleting Blob originals', async () => {
    let lookups = 0;
    const client = { files: { retrieve: async () => { lookups++; return { id: 'f', status: 'processed' }; } } };
    const cache = { id: 'f', scope: 's', expiresAt: Date.now() + 3600000, transport: { wrapper: 'zip-store-v1' } };
    assert.equal(await getCachedAIFile(client, cache, 'other'), null);
    assert.equal(await getCachedAIFile(client, { ...cache, expiresAt: undefined }, 's'), null);
    assert.equal(await getCachedAIFile(client, { ...cache, expiresAt: 1 }, 's'), null);
    assert.equal(lookups, 0);
    assert.equal((await getCachedAIFile(client, cache, 's')).transport.wrapper, 'zip-store-v1');
    client.files.retrieve = async () => { throw { status: 404 }; };
    assert.equal(await getCachedAIFile(client, cache, 's'), null);
    client.files.retrieve = async () => { throw { status: 500 }; };
    await assert.rejects(getCachedAIFile(client, cache, 's'));
});

test('disk ZIP wrapping preserves bytes/CRC/name without extracting untrusted archives', async t => {
    const file = await fixture(t, 1024, '中文.vsdx');
    const output = await prepareFileTransportFromPath(file, path.join(path.dirname(file.path), 'wrapped.zip'));
    const bytes = await fs.promises.readFile(output.path);
    assert.equal(bytes.length, output.size); assert.equal(output.transport.originalFilename, file.filename);
    assert(unwrapFile(bytes, file.filename).every(b => b === 42));
    const zip = { ...file, filename: 'original.zip' };
    assert.equal(await prepareFileTransportFromPath(zip, 'unused'), zip);
});

test('cancelled queue waiters leave immediately and never start work later', async () => {
    let release;
    const first = withFileMemory(() => new Promise(resolve => { release = resolve; }));
    const controller = new AbortController();
    const second = withFileMemory(() => assert.fail('cancelled work ran'), { signal: controller.signal });
    controller.abort();
    await assert.rejects(second, { name: 'AbortError' });
    release(); await first;
    assert.equal(await withFileMemory(() => 42), 42);
});

test('incomplete assembly is rejected and any incorrect output file is removed', async t => {
    const file = await fixture(t, 17 * 1024 ** 2);
    const deleted = [], cancelled = [];
    await assert.rejects(uploadAIFile({
        files: { delete: async id => deleted.push(id) },
        uploads: {
            create: async () => ({ id: 'upload' }), parts: { create: async () => ({ id: 'part' }) },
            complete: async () => ({ file: { id: 'bad-file', bytes: 1 } }), cancel: async id => cancelled.push(id)
        }
    }, file), /合并结果不完整/);
    assert.deepEqual(deleted, ['bad-file']); assert.deepEqual(cancelled, ['upload']);
});
