'use strict';
const fs = require('node:fs');
const { toFile } = require('openai');

const PART_BYTES = 8 * 1024 * 1024;
const MULTIPART_THRESHOLD = 16 * 1024 * 1024;
const CACHE_SECONDS = 24 * 60 * 60;

function upstreamRequestId(error) {
    return error?.request_id || error?.requestID || error?.requestId
        || error?.headers?.get?.('apim-request-id') || error?.headers?.get?.('x-request-id') || '';
}

// Only file transport is retried. Responses/tool execution must not be retried
// automatically, since a retry could repeat a billable task or a side effect.
async function uploadAIFile(client, file, { signal, onProgress, onPhase, multipart = true } = {}) {
    signal?.throwIfAborted();
    const options = { signal, timeout: 180000, maxRetries: 2 };
    let upload;
    try {
        if (!multipart || file.size <= MULTIPART_THRESHOLD) {
            const blob = await fs.openAsBlob(file.path, { type: file.mimeType || 'application/octet-stream' });
            Object.defineProperty(blob, 'name', { value: file.filename });
            const result = await client.files.create({ file: blob, purpose: 'assistants' }, options);
            if (!result?.id) throw new Error('Azure 未返回文件 ID。');
            onProgress?.(file.size, file.size);
            return result;
        }
        upload = await client.uploads.create({ filename: file.filename, bytes: file.size,
            mime_type: file.mimeType || 'application/octet-stream', purpose: 'assistants' }, options);
        if (!upload?.id) throw new Error('Azure 未返回分块上传 ID。');
        const partIds = [];
        const handle = await fs.promises.open(file.path, 'r');
        try {
            for (let offset = 0; offset < file.size;) {
                signal?.throwIfAborted();
                const length = Math.min(PART_BYTES, file.size - offset);
                const buffer = Buffer.allocUnsafe(length);
                let received = 0;
                while (received < length) {
                    const { bytesRead } = await handle.read(buffer, received, length - received, offset + received);
                    if (!bytesRead) throw new Error('本地附件长度不匹配，已停止上传。');
                    received += bytesRead;
                }
                const part = await client.uploads.parts.create(upload.id, { data: await toFile(buffer, 'part') }, options);
                if (!part?.id) throw new Error('Azure 未确认当前文件分块。');
                partIds.push(part.id);
                offset += length;
                onProgress?.(offset, file.size);
            }
        } finally { await handle.close(); }
        onPhase?.('assembling');
        const completed = await client.uploads.complete(upload.id, { part_ids: partIds }, options);
        if (!completed.file?.id || (completed.file.bytes != null && completed.file.bytes !== file.size)) {
            if (completed.file?.id) await client.files.delete(completed.file.id, { timeout: 15000, maxRetries: 0 }).catch(() => {});
            throw new Error('Azure 文件合并结果不完整，已停止本轮请求。');
        }
        return completed.file;
    } catch (error) {
        if (upload?.id) await client.uploads.cancel(upload.id, { timeout: 15000, maxRetries: 0 }).catch(() => {});
        if (signal?.aborted) throw signal.reason;
        error.fileStage = 'azure_upload';
        error.upstreamRequestId = upstreamRequestId(error);
        throw error;
    }
}

async function getCachedAIFile(client, cached, scope, signal) {
    if (!cached?.id || cached.scope !== scope || !Number.isFinite(Number(cached.expiresAt)) || Number(cached.expiresAt) < Date.now() + 60000) return null;
    try {
        const file = await client.files.retrieve(cached.id, { signal, timeout: 30000, maxRetries: 2 });
        if (file.id !== cached.id || ['error', 'deleted', 'deleting'].includes(file.status)) return null;
        return { ...file, transport: cached.transport };
    } catch (error) {
        if ([404, 410].includes(error.status)) return null;
        throw error; // An outage is not evidence that the file expired.
    }
}

module.exports = { uploadAIFile, getCachedAIFile, upstreamRequestId, PART_BYTES, MULTIPART_THRESHOLD, CACHE_SECONDS };
