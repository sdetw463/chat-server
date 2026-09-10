'use strict';
const { MAX_FILE_BYTES } = require('./file-limits');

// Azure Files API allowlist observed on the resource-level assistants upload
// route. Unknown extensions travel as a single-entry ZIP, not renamed content.
const supported = new Set('c cpp css csv doc docx gif go html java jpeg jpg js json md pdf php pkl png pptx py rb tar tex ts txt webp xlsx xml zip'.split(' '));
const crcTable = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
    return n >>> 0;
});
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    return (crc ^ 0xffffffff) >>> 0;
}

// A bounded ZIP32 archive with one UTF-8 entry using STORE (no compression).
// Never unpack user-provided ZIPs here; only our own transport wrapper is read.
function zipParts(filename, length, crc) {
    if (!filename || /[\\/\x00-\x1f]/.test(filename) || ['.', '..'].includes(filename)) throw new Error('文件名不安全。');
    const name = Buffer.from(filename, 'utf8');
    if (name.length > 65535 || length > MAX_FILE_BYTES) throw new Error('文件超过传输包装上限（200MB）。');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(33, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(length, 18);
    local.writeUInt32LE(length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4, 30);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(local.length + name.length + length, 16);
    return { head: Buffer.concat([local, name]), tail: Buffer.concat([central, name, end]) };
}

function wrapFile(filename, buffer) {
    const { head, tail } = zipParts(filename, buffer.length, crc32(buffer));
    return Buffer.concat([head, buffer, tail]);
}

function unwrapFile(archive, filename) {
    if (archive.length < 30 || archive.readUInt32LE(0) !== 0x04034b50 || archive.readUInt16LE(8) !== 0) throw new Error('附件传输包装损坏。');
    const nameEnd = 30 + archive.readUInt16LE(26);
    const start = nameEnd + archive.readUInt16LE(28);
    const size = archive.readUInt32LE(22);
    if (archive.subarray(30, nameEnd).toString('utf8') !== filename || start + size > archive.length) throw new Error('附件传输文件名或长度不匹配。');
    const bytes = archive.subarray(start, start + size);
    if (crc32(bytes) !== archive.readUInt32LE(14)) throw new Error('附件传输内容校验失败。');
    return bytes;
}

function prepareFileTransport(file) {
    const extension = String(file.filename).split('.').pop().toLowerCase();
    if (supported.has(extension)) return { buffer: file.buffer, filename: file.filename, mimeType: file.mimeType };
    const filename = `${file.filename}.zip`;
    return { buffer: wrapFile(file.filename, file.buffer), filename, mimeType: 'application/zip',
        transport: { wrapper: 'zip-store-v1', filename, originalFilename: file.filename, originalMimeType: file.mimeType || 'application/octet-stream' } };
}

// Disk-backed transport: unknown formats keep their original bytes without
// allocating another 200MB Buffer. User archives are never extracted here.
async function prepareFileTransportFromPath(file, destination, signal) {
    const fs = require('node:fs');
    const { pipeline } = require('node:stream/promises');
    const extension = String(file.filename).split('.').pop().toLowerCase();
    if (supported.has(extension)) return file;
    let crc = 0xffffffff;
    for await (const chunk of fs.createReadStream(file.path, { signal })) {
        for (const byte of chunk) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    }
    const { head, tail } = zipParts(file.filename, file.size, (crc ^ 0xffffffff) >>> 0);
    await pipeline((async function* () {
        yield head;
        yield* fs.createReadStream(file.path, { signal });
        yield tail;
    })(), fs.createWriteStream(destination, { flags: 'wx' }), { signal });
    const filename = `${file.filename}.zip`;
    return { ...file, path: destination, filename, size: file.size + head.length + tail.length, mimeType: 'application/zip',
        transport: { wrapper: 'zip-store-v1', filename, originalFilename: file.filename, originalMimeType: file.mimeType || 'application/octet-stream' } };
}

function transportNote(files) {
    const wrapped = files.filter(file => file.transport?.wrapper === 'zip-store-v1');
    if (!wrapped.length) return '';
    return '附件传输说明：以下原文件因上传接口扩展名限制被无损包装为 ZIP，内容未转换。请先用代码解释器打开对应 ZIP 并读取其中的原文件，再执行用户任务；ZIP 包装不是原文件格式。\n'
        + wrapped.map(file => JSON.stringify({ archive: file.transport.filename, originalFile: file.transport.originalFilename })).join('\n');
}

module.exports = { prepareFileTransport, prepareFileTransportFromPath, transportNote, unwrapFile, wrapFile };
