const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { prepareFileTransport, unwrapFile, transportNote, wrapFile } = require('../lib/file-transport');

test('SVG, VDX and unknown binary formats preserve original names and bytes in ZIP', () => {
    for (const filename of ['中文 图.svg', 'drawing.vdx', 'drawing.vsdx', 'unknown.bin', 'README']) {
        const bytes = Buffer.from([0, 255, 23, 7, 18]);
        const result = prepareFileTransport({ filename, buffer: bytes });
        assert.equal(result.filename, filename + '.zip');
        assert.equal(result.mimeType, 'application/zip');
        assert.deepEqual(unwrapFile(result.buffer, filename), bytes);
        assert.match(transportNote([result]), /原文件/);
        assert(transportNote([result]).includes(filename));
    }
});

test('supported types including ZIP are never wrapped again', () => {
    for (const filename of ['test.pdf', 'test.XLSX', 'test.zip', 'test.png', 'test.xml']) {
        const buffer = Buffer.from('unchanged');
        const result = prepareFileTransport({ filename, buffer, mimeType: 'original/type' });
        assert.equal(result.buffer, buffer);
        assert.equal(result.filename, filename);
        assert.equal(result.transport, undefined);
    }
    assert.equal(transportNote([{ id: 'normal' }]), '');
});

test('wrapper rejects path traversal and detects altered bytes', () => {
    for (const name of ['../a.svg', '/a.svg', 'a\\b.svg', '..', 'bad\n.svg']) assert.throws(() => wrapFile(name, Buffer.from('x')));
    const result = wrapFile('a.svg', Buffer.from('original'));
    result[35] ^= 1;
    assert.throws(() => unwrapFile(result, 'a.svg'), /校验失败/);
    assert.throws(() => unwrapFile(Buffer.alloc(4), 'a.svg'));
});

test('standard Python ZIP reader verifies CRC and Unicode name independently', t => {
    try { execFileSync('python3', ['--version']); } catch { t.skip('Python unavailable; pure Node tests still run'); return; }
    const bytes = Buffer.from('<svg>中文</svg>');
    const result = wrapFile('框架.svg', bytes);
    const output = execFileSync('python3', ['-c', 'import sys,io,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; assert z.namelist()==["框架.svg"]; sys.stdout.buffer.write(z.read("框架.svg"))'], { input: result });
    assert.deepEqual(output, bytes);
});
