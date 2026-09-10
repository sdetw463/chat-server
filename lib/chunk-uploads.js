'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MAX_FILE_BYTES, MAX_TOTAL_BYTES } = require('./file-limits');
const { withFileMemory } = require('./file-memory');
const CHUNK_BYTES = 4 * 1024 * 1024;

// Temporary chunks stay on disk, never in a giant JSON/Base64 body. State is
// deliberately instance-local: after a restart the browser must upload again.
function installChunkUploads(app, express, { identity, ready, active, persist }) {
    const uploads = new Map();
    const remove = async (id, item) => {
        uploads.delete(id);
        await fs.rm(item.dir, { recursive: true, force: true });
    };
    const timer = setInterval(() => {
        for (const [id, item] of uploads) if (!item.busy && Date.now() - item.touched > 30 * 60000)
            remove(id, item).catch(() => {});
    }, 60000);
    timer.unref();
    const route = fn => async (req, res) => {
        try { await fn(req, res); }
        catch (e) { res.status(e.status || 400).json({ error: e.message }); }
    };
    const get = req => {
        const item = uploads.get(req.params.id);
        if (!item || item.userId !== identity(req)) throw new Error('上传已失效或不属于当前用户，请重新选择文件上传。');
        if (item.busy) throw Object.assign(new Error('文件正在处理，请稍后重试。'), { status: 409 });
        item.touched = Date.now();
        return item;
    };
    app.post('/api/ai-chat/uploads', route(async (req, res) => {
        if (!ready()) throw new Error('持久文件存储暂不可用，无法上传大文件。');
        const userId = identity(req), { sessionId, name, size, mimeType } = req.body;
        if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 160 || typeof name !== 'string' || !name.trim()) throw new Error('缺少会话或文件名。');
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_BYTES) throw new Error('单文件必须大于0且不超过200MB。');
        await active(userId, sessionId);
        const pending = [...uploads.values()].filter(item => !item.saved);
        const reserved = pending.reduce((n, u) => n + u.size, 0);
        if (reserved + size > MAX_TOTAL_BYTES || pending.length >= 20 || uploads.size >= 200) throw new Error('上传通道繁忙，请等待其他文件完成后重试。');
        const id = crypto.randomUUID();
        const item = { userId, sessionId, filename: name.slice(0, 240), mimeType: String(mimeType || 'application/octet-stream').slice(0, 120), size, received: 0, touched: Date.now(), busy: true };
        uploads.set(id, item);
        try {
            item.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tuotuo-upload-'));
            item.path = path.join(item.dir, 'data');
            await fs.writeFile(item.path, Buffer.alloc(0));
            item.busy = false;
            res.json({ uploadId: id, chunkBytes: CHUNK_BYTES });
        } catch (e) { uploads.delete(id); if (item.dir) await fs.rm(item.dir, { recursive: true, force: true }); throw e; }
    }));
    app.post('/api/ai-chat/uploads/:id/chunks', express.raw({ type: 'application/octet-stream', limit: CHUNK_BYTES }), route(async (req, res) => {
        const item = get(req), offset = Number(req.query.offset);
        if (item.saved || !Buffer.isBuffer(req.body) || !req.body.length || !Number.isSafeInteger(offset) || offset < 0 || offset + req.body.length > item.size) throw new Error('分块大小或顺序不正确，请重新上传。');
        item.busy = true;
        try {
            // The acknowledgement can be lost after a successful append.
            // Validate a replay byte-for-byte rather than appending it twice.
            if (offset + req.body.length <= item.received) {
                const handle = await fs.open(item.path, 'r');
                try {
                    const prior = Buffer.alloc(req.body.length);
                    const read = await handle.read(prior, 0, prior.length, offset);
                    if (read.bytesRead !== prior.length || !prior.equals(req.body)) throw new Error('重试分块内容不一致。');
                } finally { await handle.close(); }
                return res.json({ received: item.received });
            }
            if (offset !== item.received) throw new Error('分块大小或顺序不正确，请重新上传。');
            await fs.appendFile(item.path, req.body);
            item.received += req.body.length;
            res.json({ received: item.received });
        } finally { item.busy = false; }
    }));
    app.post('/api/ai-chat/uploads/:id/complete', route(async (req, res) => {
        const item = get(req);
        if (item.saved) return res.json(item.saved);
        if (item.received !== item.size) throw new Error('文件尚未完整上传。');
        item.busy = true;
        try {
            await active(item.userId, item.sessionId);
            const saved = await withFileMemory(() => persist({ ...item, source: 'upload' }));
            if (!saved) throw new Error('无法持久保存文件，请重试。');
            item.saved = { ...saved, size: item.size };
            await fs.rm(item.dir, { recursive: true, force: true });
            res.json(item.saved);
        } finally { item.busy = false; }
    }));
    app.delete('/api/ai-chat/uploads/:id', route(async (req, res) => { const item = get(req); await remove(req.params.id, item); res.json({ ok: true }); }));
    app.use('/api/ai-chat/uploads', (error, req, res, next) => {
        if (error?.type === 'entity.too.large') return res.status(413).json({ error: '上传分块不能超过4MB，请刷新网页后重新上传。' });
        next(error);
    });
    return { close: async () => { clearInterval(timer); await Promise.all([...uploads].map(([id, item]) => remove(id, item))); } };
}
module.exports = { installChunkUploads, CHUNK_BYTES };
