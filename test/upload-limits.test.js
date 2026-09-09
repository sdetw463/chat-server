const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../server');
const { MAX_FILE_BYTES, MAX_TOTAL_BYTES } = require('../lib/file-limits');
const { prepareFileTransport } = require('../lib/file-transport');

function dataUrl(bytes) {
    const remainder = bytes % 3;
    return 'data:application/zip;base64,' + 'AAAA'.repeat(Math.floor(bytes / 3)) + (remainder === 1 ? 'AA==' : remainder === 2 ? 'AAA=' : '');
}
test('200MB/500MB policy retains old inline uploads and rejects malformed Base64', () => {
    assert.equal(MAX_FILE_BYTES, 200 * 1024 ** 2);
    assert.equal(MAX_TOTAL_BYTES, 500 * 1024 ** 2);
    const atLimit = dataUrl(50 * 1024 ** 2);
    assert.equal(_test.dataUrlFileSize(atLimit), 50 * 1024 ** 2);
    assert.doesNotThrow(() => _test.validateAgentRequest({ userMessage: '读取ZIP', documents: [{ name: 'big.zip', fileData: atLimit }] }));
    for (const invalid of ['data:x;base64,!!!!', 'data:x;base64,AAAA=', 'data:x;base64,', 'plain text']) assert.equal(_test.dataUrlFileSize(invalid), -1);
});
test('raw ZIP and wrapped unknown formats above old 10MB/20MB limits survive intact', () => {
    const buffer = Buffer.alloc(21 * 1024 ** 2, 42);
    assert.equal(prepareFileTransport({ filename: 'bundle.zip', buffer }).buffer, buffer);
    const wrapped = prepareFileTransport({ filename: 'drawing.vsdx', buffer });
    assert(wrapped.buffer.length > buffer.length);
    assert.equal(wrapped.filename, 'drawing.vsdx.zip');
});
