'use strict';
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { retryDatabase } = require('./history-persistence');

const MiB = 1024 * 1024;
const MAX_PAYLOAD_BYTES = 24 * MiB;
const MAX_BACKLOG_BYTES = 32 * MiB;
const ALBUM_TYPES = ['album_food', 'album_scenery', 'album_portrait'];
const SPECIAL_TYPES = ['star', ...ALBUM_TYPES, 'album_like', 'diary', 'diary_like'];
const MESSAGE_TYPES = new Set(['text', 'image', ...SPECIAL_TYPES]);
// These independent windows prevent chat traffic from evicting every diary,
// photo and wish. They only bound the initial snapshot; no records are deleted.
const HISTORY_GROUPS = [
    { query: { msgType: { $nin: SPECIAL_TYPES } }, limit: 300 },
    { query: { msgType: 'star' }, limit: 1000 },
    ...ALBUM_TYPES.map(msgType => ({ query: { msgType }, limit: 500 })),
    { query: { msgType: 'diary' }, limit: 1000 },
    { query: { msgType: 'album_like' }, limit: 3000 },
    { query: { msgType: 'diary_like' }, limit: 3000 }
];
const PUBLIC_FIELDS = ['msgType', 'name', 'avatar', 'msg', 'imgs', 'time', 'dateKey',
    'author', 'text', 'img', 'albumType', 'imgId', 'isLike', 'likes', 'likedBy', 'entryId'];

function publicMessage(record) {
    const result = {};
    for (const key of PUBLIC_FIELDS) if (record[key] !== undefined) result[key] = record[key];
    const id = record.id || record.entryId || record._id;
    if (id) result.id = String(id);
    return result;
}

function normalizeMessage(raw, nickname) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !MESSAGE_TYPES.has(raw.msgType)) {
        throw new Error('消息格式不正确，请刷新网页后重试。');
    }
    const text = (value, limit, fallback = '') => typeof value === 'string'
        ? value.replace(/\u0000/g, '').slice(0, limit) : fallback;
    const id = value => typeof value === 'string' && /^[\w:.-]{1,180}$/.test(value) ? value : '';
    const data = {
        msgType: raw.msgType,
        name: text(raw.name, 80, nickname),
        avatar: text(raw.avatar, 40),
        // Some existing diary views insert their timestamp as markup.
        time: /^[\d .:/-]{1,40}$/.test(raw.time || '') ? raw.time : new Date().toISOString().slice(11, 16)
    };
    if (raw.msgType === 'diary' || raw.msgType === 'diary_like') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.dateKey || '')) throw new Error('日记日期格式不正确。');
        data.dateKey = raw.dateKey;
    }
    if (raw.msgType.endsWith('_like')) {
        if (typeof raw.isLike !== 'boolean') throw new Error('点赞状态格式不正确。');
        data.isLike = raw.isLike;
        if (raw.msgType === 'diary_like') {
            data.entryId = id(raw.entryId);
            if (!data.entryId) throw new Error('缺少有效的日记编号。');
        } else {
            if (!ALBUM_TYPES.includes(raw.albumType) || !id(raw.imgId)) throw new Error('缺少有效的相册图片编号。');
            data.albumType = raw.albumType;
            data.imgId = raw.imgId;
        }
        // A like event's entryId identifies its target, not the event itself.
        data.id = id(raw.id) || crypto.randomUUID();
    } else {
        data.id = id(raw.id) || crypto.randomUUID();
        data.entryId = data.id;
        if (raw.msgType === 'diary') {
            data.author = text(raw.author, 80, nickname);
            data.text = text(raw.text, 10000);
            if (raw.imgs !== undefined && (!Array.isArray(raw.imgs) || raw.imgs.length > 10 || raw.imgs.some(img => typeof img !== 'string'))) {
                throw new Error('日记最多可包含10张图片。');
            }
            data.imgs = (raw.imgs || []).slice();
            data.likes = 0;
            data.likedBy = [];
            if (!data.text.trim() && !data.imgs.length) throw new Error('请填写日记或添加图片。');
        } else {
            if (typeof raw.msg !== 'string' || !raw.msg.trim()) throw new Error('消息不能为空。');
            if (raw.msgType === 'text' || raw.msgType === 'star') {
                if (raw.msg.length > 16000) throw new Error('消息太长，请分成几段发送。');
                data.msg = raw.msg.replace(/\u0000/g, '');
            } else {
                data.msg = raw.msg;
            }
        }
    }
    return data;
}

function parseNickname(requestUrl) {
    const pathname = String(requestUrl || '').split('?')[0];
    if (!pathname.startsWith('/socket/')) throw new Error('Unknown WebSocket path');
    const name = decodeURIComponent(pathname.slice('/socket/'.length));
    if (!name.trim() || name.length > 80 || /[\u0000-\u001f\u007f/]/.test(name)) throw new Error('Invalid nickname');
    return name;
}

async function loadHistory(MessageModel) {
    const rows = [];
    // Cosmos DB has a small shared RU budget: do not fan these reads out for
    // every connection, and retry only safe database operations on throttling.
    for (const group of HISTORY_GROUPS) {
        const records = await retryDatabase(() => MessageModel.find(group.query).sort({ _id: -1 }).limit(group.limit).lean());
        rows.push(...records);
    }
    return rows.sort((a, b) => {
        const timestamp = record => new Date(record.createdAt || 0).getTime()
            || parseInt(String(record._id).slice(0, 8), 16) * 1000 || 0;
        return timestamp(a) - timestamp(b) || String(a._id).localeCompare(String(b._id));
    }).map(publicMessage);
}

function installRealtime(server, {
    MessageModel,
    aiAccessTokens,
    uploadImage,
    databaseReady,
    allowedOrigins = [],
    logger = console,
    heartbeatMs = 30000,
    historyRetryMs = 3000,
    maxPayloadBytes = MAX_PAYLOAD_BYTES,
    maxBacklogBytes = MAX_BACKLOG_BYTES
}) {
    const origins = new Set(allowedOrigins.map(origin => String(origin).replace(/\/+$/, '')));
    const wss = new WebSocket.Server({
        server,
        maxPayload: maxPayloadBytes,
        perMessageDeflate: false,
        verifyClient({ req }, done) {
            try {
                parseNickname(req.url);
                const origin = req.headers.origin;
                if (origin && origins.size && !origins.has(String(origin).replace(/\/+$/, ''))) return done(false, 403, 'Origin not allowed');
                done(true);
            } catch { done(false, 400, 'Invalid WebSocket request'); }
        }
    });
    const clients = new Map();
    const diarySaves = new Map();
    let historyCache = null;
    let historyInFlight = null;
    let historyRevision = 0;
    let userListScheduled = false;

    const send = (ws, payload) => new Promise(resolve => {
        if (ws.readyState !== WebSocket.OPEN) return resolve(false);
        const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
        if (ws.bufferedAmount + Buffer.byteLength(serialized) > maxBacklogBytes) {
            ws.close(1013, 'Connection is too slow; please reconnect');
            return resolve(false);
        }
        ws.send(serialized, error => {
            if (error) { logger.warn?.('WebSocket发送失败:', error.message); ws.terminate(); }
            resolve(!error);
        });
    });
    const report = (ws, code, message, details = {}) => { void send(ws, { type: 'error', code, error: message, message, ...details }); };
    const broadcast = payload => {
        const serialized = JSON.stringify(payload);
        const bytes = Buffer.byteLength(serialized);
        for (const [ws, state] of clients) {
            if (!state.initialized && payload.type === 'message') {
                if (state.outboundBytes + bytes > maxBacklogBytes || state.outbound.length >= 200) {
                    ws.close(1013, 'History is loading; please reconnect');
                    continue;
                }
                state.outbound.push(serialized);
                state.outboundBytes += bytes;
            } else void send(ws, serialized);
        }
    };
    const broadcastUserList = () => {
        if (userListScheduled) return;
        userListScheduled = true;
        setImmediate(() => {
            userListScheduled = false;
            broadcast({ type: 'userlist', data: [...clients.values()].map(state => state.nickname) });
        });
    };
    const getHistory = async () => {
        if (!databaseReady()) throw new Error('历史数据库尚未连接。');
        if (historyCache && historyCache.expiresAt > Date.now()) return historyCache.messages;
        if (!historyInFlight) {
            const revision = historyRevision;
            historyInFlight = loadHistory(MessageModel).then(messages => {
                if (revision === historyRevision) historyCache = { messages, expiresAt: Date.now() + 15000 };
                return messages;
            }).finally(() => { historyInFlight = null; });
        }
        return historyInFlight;
    };
    const sendHistory = async (ws, messages) => {
        let batch = [], bytes = 0;
        for (const message of messages) {
            const size = Buffer.byteLength(JSON.stringify(message));
            if (batch.length && bytes + size > 256 * 1024) {
                if (!await send(ws, { type: 'history', data: batch })) return;
                batch = []; bytes = 0;
            }
            batch.push(message); bytes += size;
        }
        if (batch.length) await send(ws, { type: 'history', data: batch });
    };
    const retryHistory = (ws, state, attempts = 0) => {
        if (attempts >= 10 || ws.readyState !== WebSocket.OPEN) return;
        state.historyRetry = setTimeout(async () => {
            try { await sendHistory(ws, await getHistory()); }
            catch { retryHistory(ws, state, attempts + 1); }
        }, historyRetryMs);
        state.historyRetry.unref();
    };
    const prepareImages = async data => {
        if (data.msg?.startsWith('data:image')) data.msg = await uploadImage(data.msg);
        // Avoid allocating and uploading all ten full-sized images at once.
        if (data.imgs) for (let i = 0; i < data.imgs.length; i++) data.imgs[i] = await uploadImage(data.imgs[i]);
    };
    const saveDiary = data => {
        if (!diarySaves.has(data.entryId)) {
            const save = (async () => {
                // Preserve already-published legacy diaries that used a random
                // Mongo _id. A retry must acknowledge the original, not replace it.
                const existing = await retryDatabase(() => MessageModel.findOne({ msgType: 'diary', entryId: data.entryId }).lean());
                if (existing) return publicMessage(existing);
                await prepareImages(data);
                // The default _id unique index makes retries safe across App
                // Service workers too, without requiring a new Cosmos index.
                const digest = crypto.createHash('sha256').update(`diary:${data.entryId}`).digest('hex');
                const clientTimestamp = Number(data.entryId.match(/^de_(\d{13})_/)?.[1]);
                // Keep the normal ObjectId timestamp prefix for browser IDs so
                // the existing _id history ordering remains chronological.
                const _id = Number.isFinite(clientTimestamp) && clientTimestamp > 0
                    ? Math.floor(clientTimestamp / 1000).toString(16).padStart(8, '0').slice(-8) + digest.slice(0, 16)
                    : digest.slice(0, 24);
                let stored;
                try {
                    stored = await retryDatabase(() => MessageModel.findOneAndUpdate(
                        { _id }, { $setOnInsert: data }, { upsert: true, new: true }
                    ).lean());
                } catch (error) {
                    if (Number(error.code) !== 11000) throw error;
                    stored = await retryDatabase(() => MessageModel.findOne({ _id }).lean());
                    if (!stored) throw error;
                }
                return publicMessage(stored);
            })().finally(() => { diarySaves.delete(data.entryId); });
            diarySaves.set(data.entryId, save);
        }
        return diarySaves.get(data.entryId);
    };
    const processMessage = async (ws, data) => {
        if (!databaseReady()) throw new Error('消息存储暂时不可用，请稍后重试。');
        if (data.msgType === 'diary') data = await saveDiary(data);
        else { await prepareImages(data); await MessageModel.create(data); }
        historyRevision++;
        historyCache = null;
        broadcast({ ...publicMessage(data), type: 'message' });
    };
    const drain = async (ws, state) => {
        if (state.processing || !state.initialized) return;
        state.processing = true;
        try {
            while (state.inbound.length) {
                const { data, bytes } = state.inbound.shift();
                try { await processMessage(ws, data); }
                catch (error) { logger.error?.('保存实时消息失败:', error.message); report(ws, 'MESSAGE_SAVE_FAILED', '消息未能保存，请稍后重新发送。', { requestId: data.id, msgType: data.msgType }); }
                finally { state.inboundBytes -= bytes; }
            }
        } finally { state.processing = false; }
    };

    wss.on('connection', (ws, req) => {
        const nickname = parseNickname(req.url); // Already validated during the upgrade.
        const state = { nickname, initialized: false, processing: false, inbound: [], inboundBytes: 0,
            outbound: [], outboundBytes: 0, alive: true, credits: 40, creditAt: Date.now() };
        clients.set(ws, state);
        // Every listener is registered before the first asynchronous history read.
        ws.on('error', error => logger.warn?.('WebSocket连接异常:', error.message));
        ws.on('pong', () => { state.alive = true; });
        ws.on('close', () => {
            if (ws.aiAccessToken) aiAccessTokens.delete(ws.aiAccessToken);
            clients.delete(ws);
            clearTimeout(state.historyRetry);
            // Already accepted messages still finish saving after navigation or
            // a network disconnect; the bounded queue cannot grow after close.
            state.outbound.length = 0;
            broadcastUserList();
        });
        ws.on('message', (raw, isBinary) => {
            const now = Date.now();
            state.credits = Math.min(40, state.credits + (now - state.creditAt) / 250);
            state.creditAt = now;
            if (state.credits < 1) { report(ws, 'RATE_LIMITED', '发送太快，请稍等片刻。'); return; }
            state.credits--;
            try {
                if (isBinary) throw new Error('请使用网页支持的消息格式。');
                const parsed = JSON.parse(raw.toString());
                if (parsed?.type === 'ai_access') {
                    if (nickname !== '拖') return;
                    if (!ws.aiAccessToken) {
                        ws.aiAccessToken = crypto.randomBytes(32).toString('base64url');
                        aiAccessTokens.set(ws.aiAccessToken, ws);
                    }
                    void send(ws, { type: 'ai_access', token: ws.aiAccessToken });
                    return;
                }
                const data = normalizeMessage(parsed, nickname);
                const bytes = raw.byteLength;
                if (state.inbound.length >= 32 || state.inboundBytes + bytes > maxBacklogBytes) {
                    report(ws, 'QUEUE_FULL', '消息正在保存，请稍后再发送。');
                    return;
                }
                state.inbound.push({ data, bytes });
                state.inboundBytes += bytes;
                void drain(ws, state);
            } catch (error) { report(ws, 'INVALID_MESSAGE', error.message); }
        });
        broadcastUserList();
        void (async () => {
            try { await sendHistory(ws, await getHistory()); }
            catch (error) {
                logger.error?.('读取实时历史失败:', error.message);
                report(ws, 'HISTORY_UNAVAILABLE', '历史记录暂时加载失败，正在重试。');
                retryHistory(ws, state);
            }
            // Flush live broadcasts after the snapshot so likes follow their entries.
            while (state.outbound.length && ws.readyState === WebSocket.OPEN) {
                const payload = state.outbound.shift();
                state.outboundBytes -= Buffer.byteLength(payload);
                if (!await send(ws, payload)) break;
            }
            state.initialized = true;
            await drain(ws, state);
        })().catch(error => { logger.error?.('初始化实时连接失败:', error.message); ws.terminate(); });
    });
    const heartbeat = setInterval(() => {
        for (const [ws, state] of clients) {
            if (!state.alive) { ws.terminate(); continue; }
            state.alive = false;
            if (ws.readyState === WebSocket.OPEN) ws.ping();
        }
    }, heartbeatMs);
    heartbeat.unref();
    wss.on('close', () => clearInterval(heartbeat));
    server.once('close', () => { clearInterval(heartbeat); });
    return { wss, close: async () => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        await new Promise(resolve => wss.close(resolve));
    } };
}

module.exports = { installRealtime, normalizeMessage, parseNickname, loadHistory, HISTORY_GROUPS, MAX_PAYLOAD_BYTES };
