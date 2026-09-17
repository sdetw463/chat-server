'use strict';
const crypto = require('node:crypto');
const { retryDatabase } = require('./history-persistence');
const { withSessionWrite, mapWithConcurrency } = require('./session-lifecycle');

function createSessionGarbageCollector({ getCollection, databaseReady, getStorage, getFoundry,
    projectEndpoint, logger = console, intervalMs = 60000 }) {
    let running = null;
    let closed = false;
    const scopeFor = openai => crypto.createHash('sha256').update(`foundry-agent:${openai.baseURL}`).digest('hex');
    const filterFor = record => ({ _id: record._id, docType: record.docType, userId: record.userId, sessionId: record.sessionId });
    const update = (filter, body, options) => retryDatabase(() => getCollection().updateOne(filter, body, options));
    const safeRemoteDelete = async work => {
        try { await work(); }
        catch (error) { if (![404, 410].includes(Number(error.status || error.statusCode))) throw error; }
    };
    const reschedule = async (record, error) => {
        const attempts = (Number(record.cleanupAttempts) || 0) + 1;
        const delay = error.code === 'PREVIOUS_BACKEND_SCOPE' ? 86400000 : Math.min(3600000, 30000 * 2 ** Math.min(attempts - 1, 7));
        await update(filterFor(record), { $set: {
            cleanupAttempts: attempts,
            cleanupNextAttemptAt: new Date(Date.now() + delay),
            cleanupLastError: String(error.code || error.status || error.name || 'CLEANUP_FAILED').slice(0, 80)
        } });
        logger.warn?.('会话资源将在后台重试清理:', error.code || error.status || error.name);
    };
    // This function runs only under the same short session write lock as chat
    // persistence. Every step is idempotent so a crash can resume from the tombstone.
    const hideSession = async tombstone => {
        const collection = getCollection();
        const owner = { userId: tombstone.userId, sessionId: tombstone.sessionId };
        const session = await retryDatabase(() => collection.findOne({ docType: 'session', ...owner }));
        let conversationId = tombstone.cleanupConversationId || session?.foundryConversationId || '';
        if (conversationId && !tombstone.cleanupConversationId) {
            await update(filterFor(tombstone), { $set: {
                cleanupConversationId: conversationId,
                cleanupProjectEndpoint: projectEndpoint
            } });
        }
        await retryDatabase(() => collection.updateMany({ docType: 'file', ...owner }, {
            $set: { docType: 'deleted_file', deletedAt: new Date() }
        }));
        await retryDatabase(() => collection.deleteOne({ docType: 'session', ...owner }));
        await retryDatabase(() => collection.deleteMany({ docType: 'message', ...owner }));
        await update(filterFor(tombstone), { $set: { cleanupPending: false } });
        return { ...tombstone, cleanupPending: false, cleanupConversationId: conversationId,
            cleanupProjectEndpoint: tombstone.cleanupProjectEndpoint || projectEndpoint };
    };
    const cleanSession = async tombstone => {
        if (tombstone.cleanupPending) {
            tombstone = await withSessionWrite(tombstone.userId, tombstone.sessionId, () => hideSession(tombstone));
        }
        if (!tombstone.cleanupConversationId) return;
        if (tombstone.cleanupProjectEndpoint && tombstone.cleanupProjectEndpoint !== projectEndpoint) {
            throw Object.assign(new Error('Conversation belongs to the previous project'), { code: 'PREVIOUS_BACKEND_SCOPE' });
        }
        const openai = getFoundry();
        await safeRemoteDelete(() => openai.conversations.delete(tombstone.cleanupConversationId, { timeout: 15000, maxRetries: 1 }));
        await update(filterFor(tombstone), { $unset: {
            cleanupConversationId: 1, cleanupProjectEndpoint: 1, cleanupNextAttemptAt: 1, cleanupLastError: 1, cleanupAttempts: 1
        } });
    };
    const cleanFile = async record => {
        if (record.blobName && !record.cleanupBlobDeleted) {
            const storage = getStorage();
            if (!storage) throw Object.assign(new Error('Storage unavailable'), { code: 'STORAGE_UNAVAILABLE' });
            await storage.getBlockBlobClient(record.blobName).deleteIfExists({ abortSignal: AbortSignal.timeout(15000) });
            await update(filterFor(record), { $set: { cleanupBlobDeleted: true } });
        }
        if (record.upstreamFile?.id) {
            const openai = getFoundry();
            if (record.upstreamFile.scope !== scopeFor(openai)) {
                // A migration may leave copies in an older resource. Retain
                // their provenance instead of attempting deletion in this one.
                throw Object.assign(new Error('File belongs to the previous backend'), { code: 'PREVIOUS_BACKEND_SCOPE' });
            }
            await safeRemoteDelete(() => openai.files.delete(record.upstreamFile.id, { timeout: 15000, maxRetries: 1 }));
        }
        await retryDatabase(() => getCollection().deleteOne(filterFor(record)));
    };
    const due = () => ({ $or: [{ cleanupNextAttemptAt: { $exists: false } }, { cleanupNextAttemptAt: { $lte: new Date() } }] });
    const run = () => {
        if (running) return running;
        if (!databaseReady()) return Promise.resolve();
        running = (async () => {
            const sessions = await retryDatabase(() => getCollection().find({
                docType: 'deleted_session',
                $and: [due(), { $or: [{ cleanupPending: true }, { cleanupConversationId: { $exists: true, $ne: '' } }] }]
            }).sort({ _id: 1 }).limit(10).toArray());
            await mapWithConcurrency(sessions, 2, async record => {
                try { await cleanSession(record); }
                catch (error) { await reschedule(record, error); }
            });
            const files = await retryDatabase(() => getCollection().find({ docType: 'deleted_file', ...due() })
                .sort({ _id: 1 }).limit(20).toArray());
            await mapWithConcurrency(files, 2, async record => {
                try { await cleanFile(record); }
                catch (error) { await reschedule(record, error); }
            });
        })().finally(() => { running = null; });
        return running;
    };
    const schedule = () => { if (!closed) void run().catch(error => logger.warn?.('后台会话回收暂时失败:', error.code || error.name)); };
    const timer = setInterval(schedule, intervalMs);
    timer.unref();
    return {
        run,
        close: () => { closed = true; clearInterval(timer); },
        async deleteSession(userId, sessionId) {
            try {
                await withSessionWrite(userId, sessionId, async () => {
                    const filter = { docType: 'deleted_session', userId, sessionId };
                    await update(filter, {
                        $set: { deletedAt: new Date(), reason: 'user_deleted', cleanupPending: true },
                        $setOnInsert: { ...filter, createdAt: new Date() }
                    }, { upsert: true });
                    const tombstone = await retryDatabase(() => getCollection().findOne(filter));
                    await hideSession(tombstone);
                });
            } finally { setImmediate(schedule); }
        }
    };
}

module.exports = { createSessionGarbageCollector };
