const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { toFile } = require('openai');
const { DefaultAzureCredential } = require('@azure/identity');
const { AIProjectClient } = require('@azure/ai-projects');
const mongoose = require('mongoose');
const { BlobServiceClient } = require('@azure/storage-blob');

const app = express();
const allowedOrigins = String(process.env.APP_ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        // Non-browser operational checks have no Origin header. Browser calls must come from an explicitly allowed site.
        if (!origin) return callback(null, true);
        return callback(null, allowedOrigins.includes(String(origin).replace(/\/+$/, '')));
    },
    credentials: false,
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-ID']
}));
app.use(express.json({ limit: '35mb' }));
app.use(express.urlencoded({ limit: '35mb', extended: true }));

// ==========================================
// 1. 初始化数据库和对象存储
// ==========================================
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
        .then(() => console.log('✅ MongoDB 数据库连接成功！'))
        .catch(err => console.error('🔥 MongoDB 连接失败:', err));
} else {
    console.error('❌ 警告：服务器没有读到 MONGODB_URI 环境变量！');
}

const wsMsgSchema = new mongoose.Schema({
    msgType: String, name: String, avatar: String, msg: String, imgs: [String],
    time: String, dateKey: String, author: String, text: String, img: String,
    albumType: String, imgId: String, isLike: Boolean, likes: Number,
    likedBy: [String], entryId: String
}, { strict: false, timestamps: true });
const WsMessage = mongoose.model('WsMessage', wsMsgSchema, 'chat_history');

const aiSessionSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true },
    title: { type: String, default: '新聊天' },
    pinned: { type: Boolean, default: false },
    foundryConversationId: { type: String, default: '' },
    summary: { type: String, default: '' },
    clientUpdatedAt: { type: Number, default: 0 },
    parentSessionId: { type: String, default: '' },
    rootSessionId: { type: String, default: '' },
    branchDepth: { type: Number, default: 0 },
    lastActiveAt: { type: Date, default: Date.now }
}, { timestamps: true });
aiSessionSchema.index({ userId: 1, sessionId: 1 }, { unique: true });

const aiMessageSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    messageId: { type: String, required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, default: '' },
    userText: { type: String, default: '' },
    mediaHtml: { type: String, default: '' },
    sources: { type: [mongoose.Schema.Types.Mixed], default: [] },
    generatedFiles: { type: [mongoose.Schema.Types.Mixed], default: [] },
    sessionFiles: { type: [mongoose.Schema.Types.Mixed], default: [] },
    clientCreatedAt: { type: Number, default: 0 }
}, { timestamps: true });
aiMessageSchema.index({ userId: 1, sessionId: 1, messageId: 1 }, { unique: true });
aiMessageSchema.index({ userId: 1, sessionId: 1, createdAt: -1 });

const aiFileSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    downloadTokenHash: { type: String, required: true, unique: true, index: true },
    downloadId: { type: String, required: true, unique: true, select: false },
    filename: { type: String, required: true },
    mimeType: { type: String, default: 'application/octet-stream' },
    size: { type: Number, default: 0 },
    sha256: { type: String, default: '' },
    blobName: { type: String, required: true },
    source: { type: String, enum: ['upload', 'agent'], required: true },
    lastAccessAt: { type: Date, default: Date.now }
}, { timestamps: true });

const AiSession = mongoose.model('AiSession', aiSessionSchema, 'ai_sessions');
const AiMessage = mongoose.model('AiMessage', aiMessageSchema, 'ai_messages');
const AiFile = mongoose.model('AiFile', aiFileSchema, 'ai_files');

let containerClient = null;
if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
        containerClient = blobServiceClient.getContainerClient('tuotuo-files');
        containerClient.createIfNotExists().catch(e => console.error('创建对象存储容器失败', e));
    } catch(e) { console.error('存储连接错误', e); }
}

function canUsePersistentAiStorage() {
    return !!containerClient && mongoose.connection.readyState === 1;
}

function hashDownloadToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function normalizeIdentityPart(value, maxLength = 160) {
    return String(value || '').trim().slice(0, maxLength);
}

function buildAiUserId(clientId, sessionId, req) {
    const stableClientId = normalizeIdentityPart(clientId);
    const legacyScope = [
        'legacy',
        normalizeIdentityPart(sessionId) || 'no-session',
        req?.ip || req?.socket?.remoteAddress || '',
        req?.get?.('user-agent') || ''
    ].join(':');
    return crypto.createHash('sha256').update(stableClientId || legacyScope).digest('base64url');
}

async function uploadBufferToBlob(buffer, { userId, sessionId, filename, mimeType }) {
    if (!containerClient) throw new Error('Azure Blob Storage 尚未配置。');
    const safeSession = crypto.createHash('sha256').update(String(sessionId || 'no-session')).digest('hex').slice(0, 20);
    const blobName = `ai/${String(userId).slice(0, 20)}/${safeSession}/${crypto.randomUUID()}-${safeFileName(filename)}`;
    const client = containerClient.getBlockBlobClient(blobName);
    await client.uploadData(buffer, {
        blobHTTPHeaders: { blobContentType: mimeType || 'application/octet-stream' }
    });
    return blobName;
}

async function downloadBlobBuffer(blobName) {
    if (!containerClient || !blobName) throw new Error('持久文件存储不可用。');
    return containerClient.getBlockBlobClient(blobName).downloadToBuffer();
}

async function uploadBase64ToBlob(base64Str) {
    if (!containerClient || typeof base64Str !== 'string' || !base64Str.startsWith('data:image')) return base64Str;
    try {
        const matches = base64Str.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) return base64Str;
        const type = matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const extension = type.split('/')[1] || 'png';
        const blobName = `img_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${extension}`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.uploadData(buffer, { blobHTTPHeaders: { blobContentType: type } });
        return blockBlobClient.url;
    } catch (err) {
        console.error('图片上传 Blob 失败:', err);
        return base64Str;
    }
}

// ==========================================
// 2. AI 接口和搜索逻辑
// ==========================================
const foundryProjectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT
    || process.env.AZURE_AI_PROJECT_ENDPOINT
    || process.env.AZURE_FOUNDRY_PROJECT_ENDPOINT;
const foundryAgentName = process.env.FOUNDRY_AGENT_NAME
    || process.env.AZURE_AI_AGENT_NAME
    || "tuo-agent";
const foundryAgentVersion = process.env.FOUNDRY_AGENT_VERSION
    || process.env.AZURE_AI_AGENT_VERSION
    || "";
const foundryFileInputSlots = String(process.env.FOUNDRY_CODE_INTERPRETER_FILE_SLOTS
    || "attachment_file_1,attachment_file_2,attachment_file_3")
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .slice(0, 8);
const foundryUseConversations = String(process.env.FOUNDRY_USE_CONVERSATIONS || 'true').toLowerCase() === 'true';
const aiContextMessageLimit = Math.min(80, Math.max(12, Number(process.env.AI_CONTEXT_MESSAGE_LIMIT || 40)));
const aiContextCharacterBudget = Math.min(200_000, Math.max(24_000, Number(process.env.AI_CONTEXT_CHARACTER_BUDGET || 90_000)));
const aiSessionFileLimit = Math.min(200, Math.max(12, Number(process.env.AI_SESSION_FILE_LIMIT || 80)));
const aiSessionStorageMaxBytes = Math.min(10 * 1024 ** 3, Math.max(100 * 1024 ** 2, Number(process.env.AI_SESSION_STORAGE_MAX_BYTES || 1024 ** 3)));
const foundryStreamMaxMs = Math.max(60_000, Number(process.env.FOUNDRY_STREAM_MAX_MS || 20 * 60 * 1000));
const foundryStreamHeartbeatMs = Math.max(5_000, Number(process.env.FOUNDRY_STREAM_HEARTBEAT_MS || 15_000));
const foundryAgentConversations = new Map();
const foundryGeneratedFiles = new Map();
const imageEndpoint = process.env.AZURE_OPENAI_IMAGE_ENDPOINT || process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_OPENAI_API_BASE;
const imageApiKey = process.env.AZURE_OPENAI_IMAGE_KEY || process.env.AZURE_OPENAI_IMAGE_API_KEY;
const imageDeployment = process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT || process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT_NAME || "gpt-image-2";
const imageApiVersion = process.env.AZURE_OPENAI_IMAGE_API_VERSION || "2025-04-01-preview";
const imageQuality = process.env.AZURE_OPENAI_IMAGE_QUALITY || "medium";
const imageMaxRetries = Math.max(0, Number(process.env.AZURE_OPENAI_IMAGE_MAX_RETRIES || 2));
const azureCredential = new DefaultAzureCredential();
let foundryProjectClient = null;
let foundryOpenAIClient = null;

function getFoundryClients() {
    assertFoundryAgentReady();
    if (!foundryProjectClient) {
        foundryProjectClient = new AIProjectClient(foundryProjectEndpoint, azureCredential);
        foundryOpenAIClient = foundryProjectClient.getOpenAIClient();
    }
    return { project: foundryProjectClient, openai: foundryOpenAIClient };
}

function getImageBaseUrl() {
    if (!imageEndpoint || !imageApiKey) {
        throw new Error('后端未配置正确的 Azure 图片模型 endpoint 或 key。');
    }
    return normalizeResourceBaseUrl(imageEndpoint);
}

function isSupportedImageQuality(value) {
    return ["low", "medium", "high"].includes(String(value || "").toLowerCase());
}

function isValidGptImage2Size(width, height) {
    const pixels = width * height;
    const longEdge = Math.max(width, height);
    const shortEdge = Math.min(width, height);
    return width % 16 === 0
        && height % 16 === 0
        && longEdge <= 3840
        && longEdge / shortEdge <= 3
        && pixels >= 655360
        && pixels <= 8294400;
}

function parseSizeString(value) {
    const match = String(value || "").match(/^(\d{3,4})\s*x\s*(\d{3,4})$/i);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!isValidGptImage2Size(width, height)) return null;
    return `${width}x${height}`;
}

function resolveImageSize(ratio, prompt, requestedSize) {
    const explicitSize = parseSizeString(requestedSize) || parseSizeString(ratio);
    if (explicitSize) return explicitSize;

    const source = `${ratio || ""} ${prompt || ""}`;
    if (/(9\s*:\s*16|竖屏|竖图|手机壁纸|story|portrait|vertical)/i.test(source)) return "1008x1792";
    if (/(3\s*:\s*4)/i.test(source)) return "1152x1536";
    if (/(16\s*:\s*9|横屏|横图|电脑壁纸|宽屏|landscape|wide)/i.test(source)) return "1792x1008";
    if (/(4\s*:\s*3)/i.test(source)) return "1536x1152";
    return "1024x1024";
}

function roundToMultipleOf16(value) {
    return Math.max(16, Math.round(Number(value || 0) / 16) * 16);
}

function sizeFromReferenceDimensions(width, height) {
    width = Number(width);
    height = Number(height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

    const maxLongEdge = 2048;
    const minLongEdge = 1024;
    const ratio = width / height;
    let targetLongEdge = Math.min(maxLongEdge, Math.max(minLongEdge, Math.max(width, height)));
    let outWidth;
    let outHeight;

    if (ratio >= 1) {
        outWidth = roundToMultipleOf16(targetLongEdge);
        outHeight = roundToMultipleOf16(targetLongEdge / ratio);
    } else {
        outHeight = roundToMultipleOf16(targetLongEdge);
        outWidth = roundToMultipleOf16(targetLongEdge * ratio);
    }

    const pixels = outWidth * outHeight;
    if (pixels < 655360) {
        const scale = Math.sqrt(655360 / pixels);
        outWidth = roundToMultipleOf16(outWidth * scale);
        outHeight = roundToMultipleOf16(outHeight * scale);
    }

    if (outWidth * outHeight > 8294400) {
        const scale = Math.sqrt(8294400 / (outWidth * outHeight));
        outWidth = roundToMultipleOf16(outWidth * scale);
        outHeight = roundToMultipleOf16(outHeight * scale);
    }

    if (!isValidGptImage2Size(outWidth, outHeight)) return null;
    return `${outWidth}x${outHeight}`;
}

function resolveEditImageSize(ratio, prompt, requestedSize, referenceImage) {
    if (requestedSize || (ratio && ratio !== "auto")) return resolveImageSize(ratio, prompt, requestedSize);
    return sizeFromReferenceDimensions(referenceImage && referenceImage.width, referenceImage && referenceImage.height);
}

function parseDataImage(input, fallbackName = "image") {
    const imageData = typeof input === "string" ? input : input && input.image;
    if (!imageData || typeof imageData !== "string") {
        throw new Error("参考图数据格式不正确。");
    }

    const match = imageData.match(/^data:(image\/(?:png|jpe?g));base64,([\s\S]+)$/i);
    if (!match) {
        throw new Error("参考图必须是 PNG 或 JPG 格式。");
    }

    const mimeType = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
    const extension = mimeType === "image/jpeg" ? "jpg" : "png";
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length) throw new Error("参考图内容为空。");

    const safeName = String((input && input.name) || fallbackName).replace(/[^\w.-]+/g, "_").slice(0, 80) || fallbackName;
    const fileName = /\.[a-z0-9]+$/i.test(safeName) ? safeName : `${safeName}.${extension}`;
    return { buffer, mimeType, fileName };
}

function appendImageBlob(formData, fieldName, image) {
    formData.append(fieldName, new Blob([image.buffer], { type: image.mimeType }), image.fileName);
}

async function readAzureImageError(response) {
    const text = await response.text();
    if (!text) return `Azure 图片接口请求失败：HTTP ${response.status}`;
    try {
        const parsed = JSON.parse(text);
        return parsed.error?.message || parsed.message || (typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error || parsed));
    } catch {
        return text;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfterMs(response) {
    const retryAfter = response.headers.get("retry-after");
    if (!retryAfter) return null;

    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, 30000);
    }

    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
        return Math.min(Math.max(retryAt - Date.now(), 0), 30000);
    }

    return null;
}

function shouldBackoffImageRequest(response, message) {
    const text = String(message || "");
    return [408, 409, 425, 429, 500, 502, 503, 504].includes(response.status)
        || /too many requests|currently servicing too many requests|rate limit|temporarily unavailable|server busy|overloaded|try again later/i.test(text);
}

function formatAzureImageBusyMessage(message, label) {
    const detail = String(message || "").trim();
    return `Azure 图片模型当前比较拥堵（${label}）。系统已经自动重试过，但这次还是没抢到算力。请过一会儿再试，或先把图片质量改低一点再试。原始提示：${detail}`;
}

function shouldRetryImageRequest(response, message) {
    const text = String(message || "");
    return response.status === 404
        || /deploymentnotfound|resource not found|not found|route/i.test(text)
        || (response.status === 400 && /(model.*(required|missing)|missing.*model|image.*(required|missing)|missing.*image|invalid multipart|unrecognized.*model|unknown.*model)/i.test(text));
}

async function requestAzureImage(builders) {
    let lastError = null;
    for (let i = 0; i < builders.length; i++) {
        for (let attempt = 0; attempt <= imageMaxRetries; attempt++) {
            const { url, options, label } = builders[i]();
            console.log(`🖼️ Azure 图片请求通道: ${label}（尝试 ${attempt + 1}/${imageMaxRetries + 1}）`);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 210000);
            let response;
            try {
                response = await fetch(url, { ...options, signal: controller.signal });
            } catch (error) {
                clearTimeout(timeout);
                if (error.name === "AbortError") {
                    throw new Error("Azure 图片编辑超过 210 秒未返回，已主动停止。请稍后再试，或换一张更简单的参考图。");
                }
                if (attempt < imageMaxRetries) {
                    const waitMs = Math.min(2000 * (attempt + 1), 8000);
                    console.error(`⚠️ Azure 图片请求网络波动，${waitMs}ms 后重试:`, error.message || error);
                    await sleep(waitMs);
                    continue;
                }
                throw error;
            }
            clearTimeout(timeout);

            if (response.ok) return response.json();

            const message = await readAzureImageError(response);
            lastError = new Error(message);
            console.error(`🔥 Azure 图片接口 ${label} 返回错误:`, response.status, message);

            if (shouldBackoffImageRequest(response, message) && attempt < imageMaxRetries) {
                const waitMs = parseRetryAfterMs(response) || Math.min(3000 * (attempt + 1), 12000);
                console.log(`⏳ Azure 图片接口繁忙，等待 ${waitMs}ms 后重试...`);
                await sleep(waitMs);
                continue;
            }

            if (shouldBackoffImageRequest(response, message) && attempt >= imageMaxRetries) {
                throw new Error(formatAzureImageBusyMessage(message, label));
            }

            if (i < builders.length - 1 && shouldRetryImageRequest(response, message)) {
                console.log("↪️ 当前图片 API 路径不可用，尝试兼容路径...");
                break;
            }

            throw lastError;
        }
    }
    throw lastError || new Error("Azure 图片接口请求失败。");
}

function getImageUrlFromResponse(data) {
    const imageItem = data && data.data && data.data[0];
    if (!imageItem) return null;
    if (imageItem.b64_json) return `data:image/png;base64,${imageItem.b64_json}`;
    if (imageItem.url) return imageItem.url;
    return null;
}

async function persistGeneratedImage(data) {
    const imageUrl = getImageUrlFromResponse(data);
    if (!imageUrl) return null;
    if (!imageUrl.startsWith('data:image')) return imageUrl;
    const storedUrl = await uploadBase64ToBlob(imageUrl);
    if (storedUrl.startsWith('data:image')) {
        throw new Error('图片接口返回了内嵌图片，但未配置 Azure Blob Storage，无法安全保存到聊天记录。');
    }
    return storedUrl;
}

function stripTrailingSlash(value) {
    return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeResourceBaseUrl(base) {
    return stripTrailingSlash(base)
        .replace(/\/openai\/v1$/i, "")
        .replace(/\/openai$/i, "");
}

function setupSSE(res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
    });
    res.socket?.setNoDelay?.(true);
    res.socket?.setKeepAlive?.(true, foundryStreamHeartbeatMs);
    if (typeof res.flushHeaders === "function") res.flushHeaders();
}
function sendSSE(res, data) {
    if (res.writableEnded || res.destroyed) return false;
    const accepted = res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === "function") res.flush();
    return accepted;
}
function sendSSEDone(res) {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: [DONE]\n\n`);
    if (typeof res.flush === "function") res.flush();
    res.end();
}

function getTextFromMessage(message) {
    return String(message && (message.content || message.text || message.userText || message.message) || "").trim();
}

function assertFoundryAgentReady() {
    if (!foundryProjectEndpoint || !foundryAgentName) {
        throw new Error('Foundry Agent 尚未配置完成。聊天不会降级到普通模型，请检查 FOUNDRY_PROJECT_ENDPOINT 和 FOUNDRY_AGENT_NAME。');
    }
}

function buildFoundryAgentUserMessage(userMessage, documents, reasoningMode) {
    const modePrefix = reasoningMode === "research"
        ? "请对下面的问题进行深入研究，并给出可核验的依据。\n\n"
        : reasoningMode === "think" ? "请仔细分析后回答。\n\n" : "";
    return `${modePrefix}${userMessage || ""}${buildAttachmentText(documents)}`.trim() || "你好";
}

function isInlineInputFileDocument(doc) {
    return !!(doc && typeof doc.fileData === "string" && /^data:[^;]+;base64,/i.test(doc.fileData));
}

async function buildFoundryAgentUserContent(userMessage, documents, images, reasoningMode, sessionFiles, userId, attachmentNames = []) {
    const docs = Array.isArray(documents) ? documents : [];
    const fileDocs = docs.filter(isInlineInputFileDocument).slice(0, 5);
    const contentDocs = docs.filter(doc => doc && doc.content && !isInlineInputFileDocument(doc));
    const names = (attachmentNames.length ? attachmentNames : fileDocs.map(doc => safeFileName(doc.name || "attachment")))
        .slice(0, foundryFileInputSlots.length);
    const fileSummary = names.length
        ? `\n\n本轮已附加文件：\n${names.map(name => `- ${name}`).join('\n')}`
        : '';
    const parts = [{
        type: "input_text",
        text: `${buildFoundryAgentUserMessage(userMessage, contentDocs, reasoningMode)}${fileSummary}`
    }];

    const normalizedImages = (Array.isArray(images) ? images : [images])
        .map(normalizeChatImage)
        .filter(image => typeof image === 'string' && image.length > 0)
        .slice(0, 4);
    normalizedImages.forEach(imageUrl => parts.push({ type: 'input_image', image_url: imageUrl, detail: 'auto' }));
    return parts;
}

const MAX_AGENT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_AGENT_TOTAL_FILE_BYTES = 20 * 1024 * 1024;

function parseDataUrlFile(doc) {
    const match = String(doc && doc.fileData || "").match(/^data:([^;]+);base64,(.+)$/i);
    if (!match) return null;
    const filename = safeFileName(doc.name || "attachment");
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > MAX_AGENT_FILE_BYTES) return null;
    return {
        filename,
        mimeType: doc.mimeType || match[1] || "application/octet-stream",
        buffer
    };
}

function selectRelevantSessionFiles(sessionFiles, userMessage, limit) {
    const message = String(userMessage || '').toLowerCase();
    return normalizeSessionFileReferences(sessionFiles)
        .map((file, index) => {
            const lowerName = file.filename.toLowerCase();
            const stem = lowerName.replace(/\.[^.]+$/, '');
            const extension = lowerName.split('.').pop();
            let score = index;
            if (stem.length >= 2 && message.includes(stem)) score += 10_000;
            if (extension && message.includes(extension)) score += 1_000;
            return { file, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(item => item.file);
}

function shouldAttachHistoricalFiles(userMessage) {
    return /(文件|附件|文档|表格|数据|刚才|之前|上次|生成的|上传的|修改|编辑|转换|导出|下载|继续处理|word|docx?|pdf|excel|xlsx?|csv|pptx?|zip)/i
        .test(String(userMessage || ''));
}

async function collectFoundryCodeInterpreterFiles(documents, sessionFiles, userId, sessionId, userMessage) {
    const files = [];
    const rawDocs = (Array.isArray(documents) ? documents : [])
        .filter(isInlineInputFileDocument)
        .slice(0, foundryFileInputSlots.length);

    for (const doc of rawDocs) {
        const parsed = parseDataUrlFile(doc);
        if (parsed) files.push({ ...parsed, persistent: true, isNewSessionFile: true });
    }

    const remaining = foundryFileInputSlots.length - files.length;
    if (remaining > 0 && shouldAttachHistoricalFiles(userMessage)) {
        let candidates = normalizeSessionFileReferences(sessionFiles);
        if (mongoose.connection.readyState === 1 && sessionId) {
            const stored = (await AiFile.find({ userId, sessionId }).sort({ updatedAt: -1 }).limit(aiSessionFileLimit).lean()).reverse();
            const storedRefs = stored.map(record => ({
                filename: record.filename,
                downloadId: '',
                storageId: String(record._id),
                type: 'file',
                _storedRecord: record
            }));
            candidates = [...candidates, ...storedRefs];
        }
        const selected = selectRelevantSessionFiles(candidates, userMessage, remaining);
        for (const file of selected) {
            try {
                const grant = file._storedRecord || await resolveStoredFile(file.downloadId, userId, sessionId);
                if (!grant) throw new Error('文件记录不存在或不属于当前会话。');
                if (grant.blobName) {
                    files.push({
                        filename: file.filename,
                        mimeType: grant.mimeType || contentTypeForFileName(file.filename),
                        buffer: await downloadBlobBuffer(grant.blobName),
                        persistent: false,
                        isNewSessionFile: false
                    });
                    continue;
                }
                if (grant?.source === "files_api" && grant.fileId) {
                    files.push({
                        filename: file.filename,
                        mimeType: contentTypeForFileName(file.filename),
                        existingFileId: grant.fileId,
                        persistent: true,
                        isNewSessionFile: false
                    });
                } else {
                    files.push(await downloadSessionGeneratedFile({ ...file, sessionId }, userId));
                }
            } catch (error) {
                console.error("重新附加历史文件失败:", file.filename || file.downloadId, error.message || error);
            }
        }
    }
    return files;
}

async function uploadFoundryCodeInterpreterFiles(openai, files) {
    const uploaded = [];
    try {
        for (const file of files) {
            if (file.existingFileId) {
                uploaded.push({
                    id: file.existingFileId,
                    filename: file.filename,
                    persistent: true,
                    isNewSessionFile: false
                });
                continue;
            }
            const uploadable = await toFile(file.buffer, file.filename, { type: file.mimeType });
            // Microsoft Foundry's project-scoped Files API currently rejects
            // the OpenAI SDK's optional expires_after field. Access is bounded
            // by our 24-hour download/session grant instead.
            const result = await openai.files.create({ file: uploadable, purpose: "assistants" });
            if (!result?.id) throw new Error(`附件 ${file.filename} 上传后没有返回 file id。`);
            uploaded.push({
                id: result.id,
                filename: file.filename,
                persistent: file.persistent === true,
                isNewSessionFile: file.isNewSessionFile === true
            });
        }
        return uploaded;
    } catch (error) {
        await Promise.allSettled(uploaded
            .filter(file => !file.persistent)
            .map(file => openai.files.delete(file.id)));
        throw error;
    }
}

function registerFoundryInputSessionFiles(uploadedFiles, userId) {
    return (Array.isArray(uploadedFiles) ? uploadedFiles : [])
        .filter(file => file?.persistent && file?.isNewSessionFile && file?.id)
        .map(file => {
            const filename = getFileNameFromPath(file.filename, "attachment");
            const downloadId = crypto.randomBytes(24).toString('base64url');
            foundryGeneratedFiles.set(downloadId, {
                userId,
                fileId: String(file.id),
                containerId: "",
                filename,
                source: "files_api",
                expiresAt: Date.now() + 24 * 60 * 60 * 1000
            });
            return {
                filename,
                type: "file",
                downloadId,
                url: `/api/ai-agent-file/${encodeURIComponent(downloadId)}`
            };
        });
}

function buildDurableFileResponse(record, downloadId) {
    return {
        filename: record.filename,
        type: 'file',
        downloadId,
        storageId: String(record._id || ''),
        url: `/api/ai-agent-file/${encodeURIComponent(downloadId)}`,
        persistent: true
    };
}

async function persistFileBuffer({ buffer, filename, mimeType, source, userId, sessionId }) {
    if (!canUsePersistentAiStorage() || !buffer?.length || !sessionId) return null;
    const [fileCount, sizeRows] = await Promise.all([
        AiFile.countDocuments({ userId, sessionId }),
        AiFile.aggregate([
            { $match: { userId, sessionId } },
            { $group: { _id: null, total: { $sum: '$size' } } }
        ])
    ]);
    const usedBytes = Number(sizeRows[0]?.total || 0);
    if (fileCount >= aiSessionFileLimit) throw new Error(`当前会话最多长期保存 ${aiSessionFileLimit} 个文件。`);
    if (usedBytes + buffer.length > aiSessionStorageMaxBytes) throw new Error('当前会话的长期文件存储空间已达到上限。');
    const downloadId = crypto.randomBytes(24).toString('base64url');
    const blobName = await uploadBufferToBlob(buffer, { userId, sessionId, filename, mimeType });
    try {
        const record = await AiFile.create({
            userId,
            sessionId,
            downloadTokenHash: hashDownloadToken(downloadId),
            downloadId,
            filename: getFileNameFromPath(filename, 'agent-output'),
            mimeType: mimeType || contentTypeForFileName(filename),
            size: buffer.length,
            sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
            blobName,
            source
        });
        return buildDurableFileResponse(record, downloadId);
    } catch (error) {
        await containerClient.getBlockBlobClient(blobName).deleteIfExists().catch(() => {});
        throw error;
    }
}

async function persistNewInputSessionFiles(attachmentFiles, uploadedFiles, userId, sessionId) {
    const remembered = [];
    for (let index = 0; index < attachmentFiles.length; index += 1) {
        const file = attachmentFiles[index];
        if (!file?.isNewSessionFile || !file.buffer) continue;
        try {
            const saved = await persistFileBuffer({
                buffer: file.buffer,
                filename: file.filename,
                mimeType: file.mimeType,
                source: 'upload',
                userId,
                sessionId
            });
            if (saved) {
                remembered.push(saved);
                if (uploadedFiles[index]) uploadedFiles[index].persistent = false;
                continue;
            }
        } catch (error) {
            console.error('持久化用户附件失败，将使用临时授权:', error.message || error);
        }
        remembered.push(...registerFoundryInputSessionFiles(uploadedFiles[index] ? [uploadedFiles[index]] : [], userId));
    }
    return remembered;
}

function buildFoundryFileStructuredInputs(uploadedFiles) {
    const values = {};
    foundryFileInputSlots.forEach((slot, index) => {
        values[slot] = uploadedFiles[index]?.id || "";
    });
    return values;
}

async function cleanupFoundryInputFiles(invocation) {
    const files = (invocation?.uploadedInputFiles || []).filter(file => !file.persistent);
    if (!files.length) return;
    const results = await Promise.allSettled(files.map(file => invocation.openai.files.delete(file.id)));
    results.forEach(result => {
        if (result.status === 'rejected') console.error('清理 Foundry 输入文件失败:', result.reason?.message || result.reason);
    });
}

function pruneGeneratedFileGrants() {
    const now = Date.now();
    for (const [downloadId, file] of foundryGeneratedFiles) {
        if (!file || file.expiresAt <= now) foundryGeneratedFiles.delete(downloadId);
    }
}

function getDownloadIdFromUrl(value) {
    const match = String(value || '').match(/\/api\/ai-agent-file\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : '';
}

function normalizeSessionFileReferences(sessionFiles) {
    const seen = new Set();
    return (Array.isArray(sessionFiles) ? sessionFiles : [])
        .map(file => {
            if (!file || typeof file !== "object") return null;
            const filename = getFileNameFromPath(file.filename || file.name || file.fileName || "agent-output", "agent-output");
            const url = String(file.url || file.downloadUrl || "").trim();
            const downloadId = String(file.downloadId || getDownloadIdFromUrl(url) || '').trim();
            const storageId = String(file.storageId || file.fileId || '').trim();
            const key = `${downloadId || storageId}:${filename}`;
            if ((!downloadId && !storageId && !file._storedRecord) || seen.has(key)) return null;
            seen.add(key);
            return {
                filename,
                downloadId,
                storageId,
                url,
                type: file.type || "file",
                ...(file._storedRecord ? { _storedRecord: file._storedRecord } : {})
            };
        })
        .filter(Boolean);
}

async function resolveStoredFile(downloadId, userId, sessionId = '') {
    pruneGeneratedFileGrants();
    if (mongoose.connection.readyState === 1 && downloadId) {
        const query = { downloadTokenHash: hashDownloadToken(downloadId), userId };
        if (sessionId) query.sessionId = sessionId;
        const record = await AiFile.findOne(query).lean();
        if (record) return { ...record, durable: true };
    }
    const grant = downloadId && foundryGeneratedFiles.get(downloadId);
    if (grant && grant.userId === userId && grant.expiresAt > Date.now()) return grant;
    return null;
}

async function downloadSessionGeneratedFile(file, userId) {
    const grant = file && await resolveStoredFile(file.downloadId, userId, file.sessionId || '');
    if (!grant) {
        throw new Error('历史文件的安全访问已过期，请重新上传该文件。');
    }
    if (grant.blobName) {
        const buffer = await downloadBlobBuffer(grant.blobName);
        return {
            filename: getFileNameFromPath(file.filename || grant.filename, 'agent-output'),
            mimeType: grant.mimeType || contentTypeForFileName(grant.filename),
            buffer
        };
    }
    const downloaded = await downloadFoundryAgentFile(grant.containerId, grant.fileId);
    const filename = getFileNameFromPath(file.filename || grant.filename, "agent-output");
    return {
        filename,
        mimeType: contentTypeForFileName(filename, downloaded.contentType || "application/octet-stream"),
        buffer: downloaded.buffer
    };
}

function buildFoundryAgentReference() {
    const reference = {
        name: foundryAgentName,
        type: "agent_reference"
    };
    if (foundryAgentVersion) reference.version = String(foundryAgentVersion);
    return reference;
}

function getFileNameFromPath(value, fallback = "agent-output") {
    const raw = String(value || fallback).split(/[\\/]/).pop() || fallback;
    return safeFileName(raw, fallback).slice(0, 160) || fallback;
}

function normalizeAgentFileRecord(file, index = 0, userId) {
    if (!file || !file.fileId) return null;
    const fallbackName = guessAgentFileName(file, index);
    const filename = getFileNameFromPath(file.filename || file.path || file.fileName || file.text, fallbackName);
    const fileId = String(file.fileId);
    const containerId = file.containerId ? String(file.containerId) : "";
    const downloadId = crypto.randomBytes(24).toString('base64url');
    const record = {
        filename,
        type: file.type || "file",
        downloadId,
        url: `/api/ai-agent-file/${encodeURIComponent(downloadId)}`
    };
    foundryGeneratedFiles.set(downloadId, {
        userId,
        fileId,
        containerId,
        filename,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000
    });
    return record;
}

function extractGeneratedFiles(response, userId) {
    const found = [];
    const seen = new Set();
    for (const item of response?.output || []) {
        if (item?.type !== "message") continue;
        for (const content of item.content || []) {
            for (const annotation of content.annotations || []) {
                if (annotation?.type !== "container_file_citation") continue;
                const fileId = annotation.file_id || annotation.fileId;
                const containerId = annotation.container_id || annotation.containerId;
                const filename = annotation.filename || annotation.file_name;
                if (!fileId || !containerId) continue;
                const key = `${containerId}:${fileId}`;
                if (seen.has(key)) continue;
                seen.add(key);
                found.push(normalizeAgentFileRecord({ fileId, containerId, filename, type: "file" }, found.length, userId));
            }
        }
    }
    return found.filter(Boolean).slice(0, 12);
}

function extractGeneratedFileCitations(response) {
    const found = [];
    const seen = new Set();
    for (const item of response?.output || []) {
        if (item?.type !== 'message') continue;
        for (const content of item.content || []) {
            for (const annotation of content.annotations || []) {
                if (annotation?.type !== 'container_file_citation') continue;
                const fileId = annotation.file_id || annotation.fileId;
                const containerId = annotation.container_id || annotation.containerId;
                if (!fileId || !containerId) continue;
                const key = `${containerId}:${fileId}`;
                if (seen.has(key)) continue;
                seen.add(key);
                found.push({
                    fileId: String(fileId),
                    containerId: String(containerId),
                    filename: getFileNameFromPath(annotation.filename || annotation.file_name || guessAgentFileName({ fileId }, found.length))
                });
            }
        }
    }
    return found.slice(0, 12);
}

async function materializeGeneratedFiles(response, userId, sessionId) {
    const citations = extractGeneratedFileCitations(response);
    if (!citations.length) return [];
    const files = [];
    for (const citation of citations) {
        if (canUsePersistentAiStorage() && sessionId) {
            try {
                const downloaded = await downloadFoundryAgentFile(citation.containerId, citation.fileId);
                const durable = await persistFileBuffer({
                    buffer: downloaded.buffer,
                    filename: citation.filename,
                    mimeType: contentTypeForFileName(citation.filename, downloaded.contentType),
                    source: 'agent',
                    userId,
                    sessionId
                });
                if (durable) {
                    files.push(durable);
                    continue;
                }
            } catch (error) {
                console.error('持久化 Agent 生成文件失败，将返回临时链接:', error.message || error);
            }
        }
        files.push(normalizeAgentFileRecord(citation, files.length, userId));
    }
    return files.filter(Boolean);
}

function guessAgentFileName(file, index = 0) {
    const hint = `${file && (file.filename || file.path || file.fileName || file.text || file.type || "") || ""}`.toLowerCase();
    const id = String(file && file.fileId || "");
    if (/\.png\b|png|image|chart|plot|图/.test(hint)) return `agent-output-${index + 1}.png`;
    if (/\.pdf\b|pdf/.test(hint)) return `agent-output-${index + 1}.pdf`;
    if (/\.xlsx\b|excel|spreadsheet|表/.test(hint)) return `agent-output-${index + 1}.xlsx`;
    if (/\.csv\b|csv/.test(hint)) return `agent-output-${index + 1}.csv`;
    if (/\.zip\b|zip/.test(hint)) return `agent-output-${index + 1}.zip`;
    if (/^c?file[_-]/i.test(id)) return `agent-output-${index + 1}`;
    return `agent-output-${index + 1}`;
}

function buildConversationSeed(historyMessages) {
    const reversed = [];
    let remainingCharacters = aiContextCharacterBudget;
    const history = Array.isArray(historyMessages) ? historyMessages.slice(-aiContextMessageLimit) : [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const msg = history[index];
        const role = msg && msg.role === "assistant" ? "assistant" : (msg && msg.role === "user" ? "user" : null);
        const raw = getTextFromMessage(msg);
        const content = raw.slice(Math.max(0, raw.length - Math.min(32000, remainingCharacters)));
        if (role && content) {
            reversed.push({ type: "message", role, content });
            remainingCharacters -= content.length;
        }
        if (remainingCharacters <= 0) break;
    }
    return reversed.reverse();
}

function sanitizeStoredMediaHtml(value) {
    // mediaHtml comes from the browser and is rendered as HTML. Never persist
    // arbitrary markup; attachment names already remain in the message text.
    return '';
}

function sanitizeStoredMessage(message, fallbackId = '') {
    if (!message || !['user', 'assistant'].includes(message.role)) return null;
    const content = String(message.content || message.userText || '').slice(0, 32000);
    if (!content) return null;
    const messageId = normalizeIdentityPart(message.id || message.messageId || fallbackId, 180)
        || crypto.createHash('sha256').update(`${message.role}:${content}`).digest('base64url');
    return {
        messageId,
        role: message.role,
        content,
        userText: String(message.userText || '').slice(0, 16000),
        mediaHtml: sanitizeStoredMediaHtml(message.mediaHtml),
        sources: Array.isArray(message.sources) ? message.sources.slice(0, 20) : [],
        generatedFiles: Array.isArray(message.generatedFiles || message.files) ? (message.generatedFiles || message.files).slice(0, 30) : [],
        sessionFiles: Array.isArray(message.sessionFiles) ? message.sessionFiles.slice(0, 30) : [],
        clientCreatedAt: Number(message.createdAt) || 0
    };
}

async function ensureAiSession(userId, sessionId, metadata = {}) {
    if (mongoose.connection.readyState !== 1 || !sessionId) return null;
    return AiSession.findOneAndUpdate(
        { userId, sessionId },
        {
            $set: {
                lastActiveAt: new Date(),
                ...(metadata.title ? { title: String(metadata.title).slice(0, 120) } : {}),
                ...(typeof metadata.pinned === 'boolean' ? { pinned: metadata.pinned } : {}),
                ...(Number(metadata.clientUpdatedAt) ? { clientUpdatedAt: Number(metadata.clientUpdatedAt) } : {}),
                ...(metadata.parentSessionId ? { parentSessionId: normalizeIdentityPart(metadata.parentSessionId) } : {}),
                ...(metadata.rootSessionId ? { rootSessionId: normalizeIdentityPart(metadata.rootSessionId) } : {}),
                ...(Number.isFinite(metadata.branchDepth) ? { branchDepth: Math.max(0, Math.min(12, Number(metadata.branchDepth))) } : {})
            },
            $setOnInsert: { userId, sessionId }
        },
        { upsert: true, new: true }
    );
}

async function upsertStoredMessages(userId, sessionId, messages) {
    if (mongoose.connection.readyState !== 1 || !sessionId) return;
    const sanitized = (Array.isArray(messages) ? messages : [])
        .slice(-300)
        .map(message => sanitizeStoredMessage(message))
        .filter(Boolean);
    if (!sanitized.length) return;
    await AiMessage.bulkWrite(sanitized.map(message => ({
        updateOne: {
            filter: { userId, sessionId, messageId: message.messageId },
            update: { $set: { ...message, userId, sessionId } },
            upsert: true
        }
    })), { ordered: false });
}

async function loadStoredConversationHistory(userId, sessionId, fallbackHistory) {
    if (mongoose.connection.readyState !== 1 || !sessionId) return fallbackHistory;
    const stored = await AiMessage.find({ userId, sessionId })
        .sort({ clientCreatedAt: -1, createdAt: -1, _id: -1 })
        .limit(aiContextMessageLimit)
        .lean();
    if (!stored.length) return fallbackHistory;
    return stored.reverse().map(message => ({ role: message.role, content: message.content }));
}

async function persistCompletedChatTurn({ userId, sessionId, userMessage, reply, sources, files, requestId }) {
    if (mongoose.connection.readyState !== 1 || !sessionId) return;
    await ensureAiSession(userId, sessionId);
    const baseId = normalizeIdentityPart(requestId, 140) || crypto.randomUUID();
    await upsertStoredMessages(userId, sessionId, [
        { id: `${baseId}:user`, role: 'user', content: userMessage, createdAt: Date.now() - 1 },
        { id: `${baseId}:assistant`, role: 'assistant', content: reply, sources, generatedFiles: files, createdAt: Date.now() }
    ]);
}

function validateAgentRequest({ userMessage, documents, images, historyMessages, sessionFiles }) {
    if (!String(userMessage || '').trim() && !(Array.isArray(documents) && documents.length) && !(Array.isArray(images) && images.length)) {
        throw new Error('请输入消息或添加附件。');
    }
    if (Array.isArray(documents) && documents.length > 3) throw new Error('一次最多处理 3 个文件。');
    if (Array.isArray(images) && images.length > 4) throw new Error('一次最多处理 4 张聊天图片。');
    if (Array.isArray(historyMessages) && historyMessages.length > 300) throw new Error('历史消息数量超出限制。');
    if (Array.isArray(sessionFiles) && sessionFiles.length > aiSessionFileLimit) throw new Error('历史文件数量超出限制。');
    const rawFiles = (Array.isArray(documents) ? documents : [])
        .filter(doc => doc && Object.prototype.hasOwnProperty.call(doc, 'fileData'));
    const totalBytes = rawFiles.reduce((sum, doc) => {
        const parsed = parseDataUrlFile(doc);
        if (!parsed) throw new Error(`附件 ${safeFileName(doc && doc.name || '未命名文件')} 无效或超过 10MB。`);
        return sum + parsed.buffer.length;
    }, 0);
    if (totalBytes > MAX_AGENT_TOTAL_FILE_BYTES) throw new Error('单次原始附件合计不能超过 20MB。');
}

async function getActiveFoundryConversation(conversationKey, userId, sessionId) {
    if (!conversationKey) return null;
    const record = foundryAgentConversations.get(conversationKey);
    if (typeof record === 'string') return record;
    if (record?.id) return record.id;
    if (mongoose.connection.readyState === 1 && userId && sessionId) {
        const session = await AiSession.findOne({ userId, sessionId }).select('foundryConversationId').lean();
        if (session?.foundryConversationId) {
            foundryAgentConversations.set(conversationKey, session.foundryConversationId);
            return session.foundryConversationId;
        }
    }
    return null;
}

function buildFoundryResponseRequestBody({ conversationId, history, currentMessage }) {
    return {
        ...(conversationId ? { conversation: conversationId } : {}),
        input: conversationId ? [currentMessage] : [...history, currentMessage]
    };
}

async function prepareFoundryAgentInvocation({ userMessage, documents, images, historyMessages, reasoningMode, sessionId, sessionFiles, userId }) {
    assertFoundryAgentReady();
    validateAgentRequest({ userMessage, documents, images, historyMessages, sessionFiles });
    const { openai } = getFoundryClients();
    const conversationKey = sessionId ? `${userId}:${sessionId}` : '';
    await ensureAiSession(userId, sessionId);
    let conversationId = await getActiveFoundryConversation(conversationKey, userId, sessionId);
    const resolvedHistory = await loadStoredConversationHistory(userId, sessionId, historyMessages);
    const history = buildConversationSeed(resolvedHistory);

    // Conversation mode is enabled by default for durable multi-turn context.
    // MongoDB remains the recovery source if the Foundry conversation expires.
    if (foundryUseConversations && !conversationId) {
        try {
            const conversation = await openai.conversations.create(history.length ? { items: history } : {});
            conversationId = conversation && conversation.id;
            if (conversationKey && conversationId) {
                foundryAgentConversations.set(conversationKey, conversationId);
                if (mongoose.connection.readyState === 1) {
                    await AiSession.updateOne({ userId, sessionId }, { $set: { foundryConversationId: conversationId } });
                }
            }
        } catch (error) {
            // Conversation state is an optimization. The request can still be completed
            // statelessly with the browser-provided history if that API is unavailable.
            console.error("创建 Foundry conversation 失败，将使用无状态历史:", error.message || error);
        }
    }

    const attachmentFiles = await collectFoundryCodeInterpreterFiles(
        documents,
        sessionFiles,
        userId,
        sessionId,
        userMessage
    );
    const uploadedInputFiles = await uploadFoundryCodeInterpreterFiles(openai, attachmentFiles);
    const rememberedInputFiles = await persistNewInputSessionFiles(attachmentFiles, uploadedInputFiles, userId, sessionId);
    const content = await buildFoundryAgentUserContent(
        userMessage,
        documents,
        images,
        reasoningMode,
        [],
        userId,
        attachmentFiles.map(file => file.filename)
    );
    const currentMessage = { type: "message", role: "user", content };
    const agentBody = { agent_reference: buildFoundryAgentReference() };
    if (uploadedInputFiles.length) {
        agentBody.structured_inputs = buildFoundryFileStructuredInputs(uploadedInputFiles);
    }
    return {
        openai,
        uploadedInputFiles,
        rememberedInputFiles,
        conversationId,
        conversationKey,
        userId,
        sessionId,
        // Agent 版本是工具选择的唯一配置源。Foundry 不允许请求级
        // tool_choice 覆盖与 Agent 自身的 tool_choice 不同；附件只通过
        // structured_inputs 挂载，是否调用 Code Interpreter 由 Agent 决定。
        requestBody: buildFoundryResponseRequestBody({ conversationId, history, currentMessage }),
        requestOptions: {
            body: agentBody
        }
    };
}

async function runFoundryAgentChat(args) {
    const invocation = await prepareFoundryAgentInvocation(args);
    try {
        const response = await invocation.openai.responses.create(
            { ...invocation.requestBody, stream: false },
            invocation.requestOptions
        );
        const reply = extractResponseText(response);
        const sources = extractCitationSources(response);
        const files = await materializeGeneratedFiles(response, args.userId, args.sessionId);
        await persistCompletedChatTurn({
            userId: args.userId,
            sessionId: args.sessionId,
            userMessage: args.userMessage,
            reply,
            sources,
            files,
            requestId: args.requestId
        });
        return {
            reply,
            sources,
            files,
            sessionFiles: invocation.rememberedInputFiles,
            conversationId: invocation.conversationId,
            rawResponseId: response && response.id,
        };
    } catch (error) {
        forgetInvalidConversation(invocation, error);
        throw error;
    } finally {
        await cleanupFoundryInputFiles(invocation);
    }
}

function forgetInvalidConversation(invocation, error) {
    if (invocation?.conversationKey && [400, 404, 410].includes(Number(error?.status)) && /conversation/i.test(String(error.message || ''))) {
        foundryAgentConversations.delete(invocation.conversationKey);
        if (mongoose.connection.readyState === 1 && invocation.userId && invocation.sessionId) {
            AiSession.updateOne(
                { userId: invocation.userId, sessionId: invocation.sessionId },
                { $set: { foundryConversationId: '' } }
            ).catch(dbError => console.error('清除失效 Conversation 记录失败:', dbError.message || dbError));
        }
    }
}

function formatFoundryIncompleteResponse(response) {
    const reason = String(response?.incomplete_details?.reason || response?.status || "unknown");
    const labels = {
        max_output_tokens: "达到最大输出长度",
        content_filter: "触发内容过滤",
        tool_timeout: "工具执行超时"
    };
    return `Foundry Agent 没有完成本次回答（${labels[reason] || reason}）。已生成的内容会保留，请重试或把复杂任务拆成更小步骤。`;
}

async function handleFoundryAgentChatSSE(args, res, abortSignal) {
    const hasAttachments = Array.isArray(args.documents) && args.documents.length > 0;
    const startedAt = Date.now();
    const elapsedSeconds = () => Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    let invocation = null;
    let lastStatus = "";
    let lastTool = "agent";
    const sendProgress = (status, tool = "agent") => {
        if (!status || (status === lastStatus && tool === lastTool)) return;
        lastStatus = status;
        lastTool = tool;
        const elapsed = elapsedSeconds();
        console.log(`[Foundry SSE +${elapsed}s] ${tool}: ${status}`);
        sendSSE(res, { status, tool, agent: foundryAgentName, elapsedSeconds: elapsed });
    };
    const heartbeat = setInterval(() => {
        sendSSE(res, {
            ping: Date.now(),
            status: lastStatus || "仍在处理中",
            tool: lastTool,
            agent: foundryAgentName,
            elapsedSeconds: elapsedSeconds()
        });
    }, foundryStreamHeartbeatMs);
    heartbeat.unref?.();

    sendProgress(hasAttachments ? "正在读取并准备附件" : "正在理解你的问题");
    try {
        invocation = await prepareFoundryAgentInvocation(args);
        if (invocation.uploadedInputFiles.length) {
            sendProgress("附件已挂载，正在启动代码解释器", "code_interpreter");
        }
        let stream;
        try {
            stream = await invocation.openai.responses.create(
                { ...invocation.requestBody, stream: true },
                {
                    ...invocation.requestOptions,
                    signal: abortSignal,
                    // Keep the SDK's own request timeout slightly above our explicit
                    // stream limit, otherwise a client default could end a long tool run first.
                    timeout: foundryStreamMaxMs + 60_000
                }
            );
        } catch (error) {
            forgetInvalidConversation(invocation, error);
            throw error;
        }
        let response = null;
        let streamedText = "";

        for await (const event of stream) {
            if (event.type === "response.output_text.delta" && event.delta) {
                streamedText += event.delta;
                lastStatus = "正在生成回答";
                lastTool = "agent";
                sendSSE(res, { delta: event.delta });
            } else if (event.type === "response.in_progress") {
                sendProgress("正在分析并组织回答");
            } else if (event.type === "response.web_search_call.in_progress") {
                sendProgress("正在启动网页搜索", "web_search");
            } else if (event.type === "response.web_search_call.searching") {
                sendProgress("正在搜索并核对相关资料", "web_search");
            } else if (event.type === "response.web_search_call.completed") {
                sendProgress("检索完成，正在整理来源", "web_search");
            } else if (event.type === "response.code_interpreter_call.in_progress") {
                sendProgress("正在用代码解释器读取文件", "code_interpreter");
            } else if (event.type === "response.code_interpreter_call.interpreting") {
                sendProgress("正在运行分析并生成结果", "code_interpreter");
            } else if (event.type === "response.code_interpreter_call.completed") {
                sendProgress("文件处理完成，正在整理回答", "code_interpreter");
            } else if (event.type === "response.completed") {
                response = event.response;
            } else if (event.type === "response.incomplete") {
                response = event.response;
                throw new Error(formatFoundryIncompleteResponse(response));
            } else if (event.type === "response.failed") {
                const message = event.response?.error?.message || "Foundry Agent 响应失败。";
                throw new Error(message);
            } else if (event.type === "error") {
                throw new Error(event.message || "Foundry Agent 流式响应失败。");
            }
        }

        if (!response) {
            throw new Error(streamedText
                ? "Foundry Agent 的流式连接在完成事件到达前中断。已保留部分内容，请重试。"
                : "Foundry Agent 的流式连接提前中断，未收到有效回答。请重试。");
        }

        const reply = extractResponseText(response);
        const sources = extractCitationSources(response);
        const files = await materializeGeneratedFiles(response, args.userId, args.sessionId);
        await persistCompletedChatTurn({
            userId: args.userId,
            sessionId: args.sessionId,
            userMessage: args.userMessage,
            reply,
            sources,
            files,
            requestId: args.requestId
        });
        if (sources.length) sendSSE(res, { sources });
        if (files.length) sendSSE(res, { files });
        if (invocation.rememberedInputFiles.length) {
            sendSSE(res, { sessionFiles: invocation.rememberedInputFiles });
        }
        if (!streamedText && reply) sendSSE(res, { delta: reply });
        if (!streamedText && !reply) sendSSE(res, { delta: "我没有收到有效回复，请稍后再试。" });
        const completedInSeconds = elapsedSeconds();
        console.log(`[Foundry SSE +${completedInSeconds}s] completed response=${response && response.id || 'unknown'}`);
        sendSSE(res, {
            done: true,
            foundryConversationId: invocation.conversationId || null,
            foundryResponseId: response && response.id || null,
            elapsedSeconds: completedInSeconds
        });
        return sendSSEDone(res);
    } catch (error) {
        const effectiveError = abortSignal?.aborted && abortSignal.reason instanceof Error
            ? abortSignal.reason
            : error;
        console.error(`[Foundry SSE +${elapsedSeconds()}s] failed:`, effectiveError?.message || effectiveError);
        if (effectiveError !== error) throw effectiveError;
        forgetInvalidConversation(invocation, error);
        throw error;
    } finally {
        clearInterval(heartbeat);
        if (invocation) await cleanupFoundryInputFiles(invocation);
    }
}

async function downloadFoundryAgentFile(containerId, fileId) {
    if (!fileId && containerId) {
        fileId = containerId;
        containerId = "";
    }
    if (!fileId) throw new Error("缺少 fileId，无法下载 Agent 生成文件。");
    const { openai } = getFoundryClients();
    const response = containerId
        ? await openai.containers.files.content.retrieve(fileId, { container_id: containerId })
        : await openai.files.content(fileId);
    return {
        buffer: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") || "application/octet-stream"
    };
}


function safeFileName(name, fallback = "attachment.txt") {
    const cleaned = String(name || fallback)
        .replace(/[^\w.\-()\u4e00-\u9fa5]+/g, "_")
        .slice(0, 120);
    return cleaned || fallback;
}

function contentTypeForFileName(filename, fallback = "application/octet-stream") {
    const ext = String(filename || "").split(".").pop().toLowerCase();
    const types = {
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        pdf: "application/pdf",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        csv: "text/csv; charset=utf-8",
        txt: "text/plain; charset=utf-8",
        json: "application/json; charset=utf-8",
        zip: "application/zip"
    };
    return types[ext] || fallback;
}

function buildAttachmentText(documents) {
    const docs = Array.isArray(documents) ? documents.filter(doc => doc && doc.content) : [];
    if (!docs.length) return "";
    return docs.slice(0, 5)
        .map(doc => `\n\n【用户上传的附件：${safeFileName(doc.name)}】\n${String(doc.content || "").slice(0, 60000)}`)
        .join("");
}

function normalizeChatImage(input) {
    if (!input) return null;
    if (typeof input === "string") return input;
    return input.image || input.url || input.dataUrl || input.src || null;
}

function extractResponseText(response) {
    if (!response) return "";
    if (typeof response.output_text === "string") return response.output_text;
    const parts = [];
    for (const item of response.output || response.output_items || []) {
        for (const content of item.content || []) {
            if (typeof content.text === "string") parts.push(content.text);
            else if (typeof content.output_text === "string") parts.push(content.output_text);
        }
    }
    return parts.join("");
}

function extractCitationSources(response) {
    const sources = [];
    const seen = new Set();
    const addSource = value => {
        if (!value || typeof value !== "object") return;
        const citation = value.url_citation || value.urlCitation || value;
        const url = citation.url || citation.uri;
        const title = citation.title || citation.name || url;
        if (url && /^https?:\/\//i.test(String(url))) {
            const key = String(url);
            if (!seen.has(key)) {
                seen.add(key);
                sources.push({ title: String(title || url).slice(0, 180), url: key });
            }
        }
    };
    for (const item of response?.output || []) {
        if (item?.type === "message") {
            for (const content of item.content || []) {
                for (const annotation of content.annotations || []) {
                    if (annotation?.type === "url_citation") addSource(annotation);
                }
            }
        } else if (item?.type === "web_search_call") {
            for (const source of item.action?.sources || item.sources || []) addSource(source);
        }
    }
    return sources.slice(0, 12);
}

function formatAIError(error) {
    const rawMessage = String(error?.message || '');
    if (/ToolChoice must match|tool[_ ]choice/i.test(rawMessage)) {
        return "Foundry Agent 的工具选择配置与请求冲突。请确认后端没有覆盖 Agent 版本中的 tool_choice。";
    }
    if (/unsupported_file/i.test(rawMessage)) {
        return "附件没有成功挂载到 Foundry Code Interpreter。请确认当前 Agent 版本已配置 attachment_file_1～3 结构化输入槽；不要把 Excel 作为模型原生 input_file 发送。";
    }
    if (/structured[_ ]inputs?|attachment_file_[123]|handlebar|placeholder/i.test(rawMessage)) {
        return "Foundry Agent 的运行时文件槽尚未配置或名称不一致。请在 Agent 的 Code Interpreter 中配置 attachment_file_1、attachment_file_2、attachment_file_3，并发布新版本后同步 FOUNDRY_AGENT_VERSION。";
    }
    if (error?.status === 429 || error?.code === 'rate_limit_exceeded') {
        const retryAfter = Number(error.headers?.get?.('retry-after'));
        const retryText = Number.isFinite(retryAfter) && retryAfter > 0
            ? `建议 ${Math.ceil(retryAfter)} 秒后再试。`
            : "建议稍等几十秒再试。";
        const detail = [
            error.status ? `HTTP ${error.status}` : null,
            error.message,
            error.request_id ? `request_id=${error.request_id}` : null
        ].filter(Boolean).join(" | ");
        return `Foundry Agent 暂时触发限流。${retryText}${detail ? `\n${detail}` : ""}`;
    }
    const parts = [];
    if (error.status) parts.push(`HTTP ${error.status}`);
    if (error.code) parts.push(`code=${error.code}`);
    if (error.message) parts.push(error.message);
    if (error.requestId) parts.push(`request_id=${error.requestId}`);
    if (error.request_id) parts.push(`request_id=${error.request_id}`);
    if (error.error) {
        try { parts.push(typeof error.error === "string" ? error.error : JSON.stringify(error.error)); } catch {}
    }
    return parts.filter(Boolean).join(" | ") || "AI 思考时出错了，请稍后再试~";
}

async function prepareAgentImages(images) {
    const processed = [];
    for (const img of (Array.isArray(images) ? images : [images])) {
        const image = normalizeChatImage(img);
        if (image) processed.push(await uploadBase64ToBlob(image));
    }
    return processed;
}

function buildAgentRequestFromHttp(req, images) {
    const sessionId = String(req.body.sessionId || '').slice(0, 160) || null;
    const clientId = String(req.body.clientId || '').slice(0, 160);
    return {
        userMessage: String(req.body.message || '').trim(),
        documents: Array.isArray(req.body.documents) ? req.body.documents : [],
        images,
        historyMessages: Array.isArray(req.body.historyMessages) ? req.body.historyMessages : [],
        reasoningMode: ['normal', 'think', 'research'].includes(req.body.reasoningMode) ? req.body.reasoningMode : 'normal',
        sessionId,
        requestId: normalizeIdentityPart(req.body.requestId, 140) || crypto.randomUUID(),
        sessionFiles: Array.isArray(req.body.sessionFiles) ? req.body.sessionFiles : [],
        userId: buildAiUserId(clientId, sessionId, req)
    };
}

app.post('/api/ai-chat', async (req, res) => {
    const wantsStream = req.body.stream === true || req.body.stream === 'true';
    try {
        const images = await prepareAgentImages(req.body.images || req.body.image || []);
        const agentRequest = buildAgentRequestFromHttp(req, images);
        if (wantsStream) {
            setupSSE(res);
            const controller = new AbortController();
            res.once('close', () => {
                if (!res.writableEnded) controller.abort();
            });
            const streamTimeout = setTimeout(() => {
                if (!controller.signal.aborted) {
                    const minutes = Math.max(1, Math.ceil(foundryStreamMaxMs / 60000));
                    controller.abort(new Error(`Foundry Agent 处理超过 ${minutes} 分钟，已停止本次流式连接。已生成内容会保留，请重试或把任务拆成更小步骤。`));
                }
            }, foundryStreamMaxMs);
            streamTimeout.unref?.();
            try {
                return await handleFoundryAgentChatSSE(agentRequest, res, controller.signal);
            } finally {
                clearTimeout(streamTimeout);
            }
        }

        const result = await runFoundryAgentChat(agentRequest);
        return res.json({
            reply: result.reply,
            sources: result.sources,
            files: result.files,
            sessionFiles: result.sessionFiles,
            foundryConversationId: result.conversationId || null,
            foundryResponseId: result.rawResponseId || null,
            usedAgent: true,
            agentName: foundryAgentName
        });
    } catch (error) {
        console.error('🔥 Foundry Agent 聊天失败:', error);
        const errorMessage = formatAIError(error);
        if (res.headersSent) {
            try {
                sendSSE(res, { error: errorMessage });
                return sendSSEDone(res);
            } catch { return; }
        }
        return res.status(500).json({ error: errorMessage });
    }
});

app.post('/api/ai-image', async (req, res) => {
    try {
        const prompt = String(req.body.prompt || '').trim();
        const images = Array.isArray(req.body.images) ? req.body.images : (req.body.images ? [req.body.images] : []);
        const ratio = req.body.ratio || "auto";

        if (!prompt) return res.status(400).json({ error: '必须告诉 TuoTuo 你想画什么哦！' });
        if (prompt.length > 8000) return res.status(400).json({ error: '绘图提示词不能超过 8000 个字符。' });
        if (images.length > 5) return res.status(400).json({ error: '一次最多使用 5 张参考图。' });

        console.log(`🎨 TuoTuo 正在后台努力画图: [${prompt}], 比例设定: [${ratio}]`);

        const baseUrl = getImageBaseUrl();
        const targetSize = resolveImageSize(ratio, prompt, req.body.size);
        const requestedQuality = isSupportedImageQuality(req.body.quality) ? String(req.body.quality).toLowerCase() : null;
        const configuredQuality = isSupportedImageQuality(imageQuality) ? String(imageQuality).toLowerCase() : "medium";

        if (images && images.length > 0) {
            console.log("👀 检测到参考图，启动原生 edits 接口进行图像编辑...");
            const parsedImages = images.slice(0, 5).map((img, index) => parseDataImage(img, `reference_${index + 1}`));
            const firstMask = images[0] && images[0].mask ? parseDataImage({ image: images[0].mask, name: "mask.png" }, "mask") : null;
            const editSize = resolveEditImageSize(ratio, prompt, req.body.size, images[0]);
            const editQuality = requestedQuality || "medium";
            const editPrompt = [
                "Edit the uploaded reference image instead of creating a new unrelated image.",
                "Preserve the main subject, identity, pose, composition, camera angle, and important background details unless the user explicitly asks to change them.",
                `User request: ${prompt}`
            ].join("\n");

            const buildEditForm = (imageFieldName, includeModel) => {
                const formData = new FormData();
                parsedImages.forEach(img => appendImageBlob(formData, imageFieldName, img));
                if (firstMask && firstMask.mimeType === "image/png" && firstMask.buffer.length <= 4 * 1024 * 1024) {
                    appendImageBlob(formData, "mask", firstMask);
                }
                formData.append("prompt", editPrompt);
                if (includeModel) formData.append("model", imageDeployment);
                formData.append("n", "1");
                if (editSize) formData.append("size", editSize);
                formData.append("quality", editQuality);
                return formData;
            };

            const data = await requestAzureImage([
                () => ({
                    label: `deployments/${imageDeployment}/images/edits image[]`,
                    url: `${baseUrl}/openai/deployments/${encodeURIComponent(imageDeployment)}/images/edits?api-version=${encodeURIComponent(imageApiVersion)}`,
                    options: { method: "POST", headers: { "api-key": imageApiKey }, body: buildEditForm("image[]", true) }
                }),
                () => ({
                    label: "openai/v1/images/edits",
                    url: `${baseUrl}/openai/v1/images/edits?api-version=preview`,
                    options: { method: "POST", headers: { "api-key": imageApiKey }, body: buildEditForm("image[]", true) }
                })
            ]);

            const imageItem = data.data && data.data[0];
            const imageUrl = await persistGeneratedImage(data);
            if (!imageUrl) throw new Error("模型没有返回有效的图片数据");
            return res.json({
                url: imageUrl,
                revised_prompt: imageItem.revised_prompt || prompt,
                ratio,
                size: editSize || "auto"
            });

        } else {
            console.log("✨ 纯文字描述，启动原生 generations 接口...");
            const buildGenerationBody = (includeModel) => {
                const body = {
                    prompt,
                    size: targetSize,
                    n: 1,
                    quality: requestedQuality || configuredQuality
                };
                if (includeModel) body.model = imageDeployment;
                return body;
            };

            const data = await requestAzureImage([
                () => ({
                    label: "openai/v1/images/generations",
                    url: `${baseUrl}/openai/v1/images/generations?api-version=preview`,
                    options: {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "api-key": imageApiKey },
                        body: JSON.stringify(buildGenerationBody(true))
                    }
                }),
                () => ({
                    label: `deployments/${imageDeployment}/images/generations`,
                    url: `${baseUrl}/openai/deployments/${encodeURIComponent(imageDeployment)}/images/generations?api-version=${encodeURIComponent(imageApiVersion)}`,
                    options: {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "api-key": imageApiKey },
                        body: JSON.stringify(buildGenerationBody(false))
                    }
                })
            ]);

            const imageItem = data.data && data.data[0];
            const imageUrl = await persistGeneratedImage(data);
            if (!imageUrl) throw new Error("模型没有返回有效的图片数据");
            return res.json({
                url: imageUrl,
                revised_prompt: imageItem.revised_prompt || prompt,
                ratio,
                size: targetSize
            });
        }

    } catch (error) {
        console.error("🔥 AI 画图接口崩溃:", error);
        res.status(500).json({ error: error.message || 'AI 画家开小差了，请稍后再试~' });
    }
});

function requireSessionIdentity(req) {
    const clientId = normalizeIdentityPart(req.body?.clientId || req.get?.('X-Client-ID') || req.query?.clientId);
    if (!clientId || clientId.length < 16) throw new Error('缺少有效的客户端标识。');
    return buildAiUserId(clientId, req.body?.session?.id || req.body?.sessionId || req.params?.sessionId, req);
}

app.get('/api/sessions', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: '聊天历史数据库暂时不可用。' });
        const userId = requireSessionIdentity(req);
        const sessions = await AiSession.find({ userId }).sort({ pinned: -1, clientUpdatedAt: -1, updatedAt: -1 }).limit(80).lean();
        const result = await Promise.all(sessions.map(async session => {
            const [recentMessages, files] = await Promise.all([
                AiMessage.find({ userId, sessionId: session.sessionId }).sort({ clientCreatedAt: -1, createdAt: -1, _id: -1 }).limit(300).lean(),
                AiFile.find({ userId, sessionId: session.sessionId }).select('+downloadId').sort({ createdAt: 1 }).limit(aiSessionFileLimit).lean()
            ]);
            const messages = recentMessages.reverse();
            return {
                id: session.sessionId,
                title: session.title,
                pinned: session.pinned,
                parentSessionId: session.parentSessionId || null,
                rootSessionId: session.rootSessionId || session.sessionId,
                branchDepth: session.branchDepth || 0,
                createdAt: session.createdAt?.getTime?.() || Date.now(),
                updatedAt: Math.max(session.clientUpdatedAt || 0, session.updatedAt?.getTime?.() || 0),
                messages: messages.map(message => ({
                    id: message.messageId,
                    role: message.role,
                    content: message.content,
                    userText: message.userText,
                    mediaHtml: message.mediaHtml,
                    sources: message.sources,
                    generatedFiles: message.generatedFiles,
                    sessionFiles: message.sessionFiles,
                    createdAt: message.clientCreatedAt || message.createdAt?.getTime?.() || 0
                })),
                fileRefs: files.map(file => buildDurableFileResponse(file, file.downloadId))
            };
        }));
        res.json({ sessions: result });
    } catch (error) {
        res.status(400).json({ error: error.message || '读取聊天历史失败。' });
    }
});

app.post('/api/sessions/sync', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: '聊天历史数据库暂时不可用。' });
        const userId = requireSessionIdentity(req);
        const session = req.body?.session;
        const sessionId = normalizeIdentityPart(session?.id);
        if (!sessionId) return res.status(400).json({ error: '缺少会话 ID。' });
        await ensureAiSession(userId, sessionId, {
            title: session.title,
            pinned: !!session.pinned,
            clientUpdatedAt: session.updatedAt,
            parentSessionId: session.parentSessionId,
            rootSessionId: session.rootSessionId,
            branchDepth: session.branchDepth
        });
        await upsertStoredMessages(userId, sessionId, session.messages);
        res.json({ ok: true });
    } catch (error) {
        console.error('同步 AI 历史失败:', error);
        res.status(400).json({ error: error.message || '同步聊天历史失败。' });
    }
});

app.delete('/api/sessions/:sessionId', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: '聊天历史数据库暂时不可用。' });
        const userId = requireSessionIdentity(req);
        const sessionId = normalizeIdentityPart(req.params.sessionId);
        const files = await AiFile.find({ userId, sessionId }).lean();
        await Promise.allSettled(files.map(file => containerClient?.getBlockBlobClient(file.blobName).deleteIfExists()));
        await Promise.all([
            AiFile.deleteMany({ userId, sessionId }),
            AiMessage.deleteMany({ userId, sessionId }),
            AiSession.deleteOne({ userId, sessionId })
        ]);
        res.json({ ok: true });
    } catch (error) {
        res.status(400).json({ error: error.message || '删除聊天失败。' });
    }
});

app.get('/api/ai-agent-file/:downloadId', async (req, res) => {
    try {
        pruneGeneratedFileGrants();
        const downloadId = String(req.params.downloadId || '');
        const stored = mongoose.connection.readyState === 1
            ? await AiFile.findOne({ downloadTokenHash: hashDownloadToken(downloadId) }).lean()
            : null;
        if (stored?.blobName) {
            const filename = getFileNameFromPath(stored.filename, 'agent-output');
            const buffer = await downloadBlobBuffer(stored.blobName);
            AiFile.updateOne({ _id: stored._id }, { $set: { lastAccessAt: new Date() } }).catch(() => {});
            res.setHeader('Content-Type', stored.mimeType || contentTypeForFileName(filename));
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
            return res.send(buffer);
        }
        const grant = foundryGeneratedFiles.get(downloadId);
        if (!grant) {
            return res.status(404).json({ error: '文件不存在或安全访问已过期。请重新生成或上传该文件。' });
        }
        const filename = getFileNameFromPath(grant.filename, 'agent-output');
        const file = await downloadFoundryAgentFile(grant.containerId, grant.fileId);
        res.setHeader('Content-Type', contentTypeForFileName(filename, file.contentType || 'application/octet-stream'));
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
        res.send(file.buffer);
    } catch (err) {
        console.error('下载 Foundry Agent 生成文件失败:', err);
        res.status(500).json({ error: err.message || '下载文件失败' });
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        "数据库是否连接": mongoose.connection.readyState === 1 ? "✅ 正常" : "❌ 未连接",
        "MONGODB_URI 是否已读到": !!process.env.MONGODB_URI ? "✅ 是" : "❌ 否",
        "云存储是否配置": !!process.env.AZURE_STORAGE_CONNECTION_STRING ? "✅ 是" : "❌ 否",
        "AI 历史持久化": mongoose.connection.readyState === 1 ? "✅ MongoDB" : "❌ 不可用",
        "AI 文件持久化": canUsePersistentAiStorage() ? "✅ MongoDB + Blob" : "⚠️ 临时模式",
        "公共 AI 访问": "✅ 已启用",
        "Foundry Project Endpoint": !!foundryProjectEndpoint ? "✅ 是" : "❌ 否",
        "Foundry Agent 是否可用": !!foundryProjectEndpoint && !!foundryAgentName ? "✅ 是" : "❌ 否",
        "Foundry Agent 名称": foundryAgentName,
        "Foundry Agent 版本": foundryAgentVersion || "默认最新版",
        "Foundry 流式最大时长（分钟）": Number((foundryStreamMaxMs / 60000).toFixed(2)),
        "Foundry SSE 心跳间隔（秒）": Number((foundryStreamHeartbeatMs / 1000).toFixed(2)),
        "Code Interpreter 运行时附件槽": foundryFileInputSlots.join(', '),
        "AI 近期上下文消息上限": aiContextMessageLimit,
        "AI 会话文件索引上限": aiSessionFileLimit,
        "GPT Image 2 部署名": imageDeployment,
        "图片专用 API key": imageApiKey ? "✅ 是" : "❌ 否"
    });
});

app.all('/api/test-db', (req, res) => {
    res.status(404).json({ error: 'Not found' });
});

app.get('/', (req, res) => { res.send("TuoTuo Server is running!"); });

// ==========================================
// 4. WebSocket (聊天室、日记、留言) 
// ==========================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
let clients = new Map();

wss.on('connection', async (ws, req) => {
    const nickname = decodeURIComponent(req.url.split('/socket/')[1] || "匿名粉丝");
    clients.set(ws, nickname);
    
    try {
        if(process.env.MONGODB_URI) {
            const history = await WsMessage.find().sort({ _id: -1 }).limit(800).lean();
            history.reverse();
            
            history.forEach(item => {
                // 将安全的 entryId 恢复给 id，如果早期数据没有，就用 _id 兜底
                if (item.entryId) {
                    item.id = item.entryId;
                } else if (item._id) {
                    item.id = item._id.toString();
                }
            });

            ws.send(JSON.stringify({ type: 'history', data: history }));
        }
    } catch (err) { console.error("读取历史记录失败", err); }
    
    broadcastUserList();
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            // 👇 保护前端传来的 id，存入 schema 中定义的 entryId 字段
            if (data.id) {
                data.entryId = data.id;
            }
            
            if (data.msg && data.msg.startsWith('data:image')) {
                data.msg = await uploadBase64ToBlob(data.msg);
            }
            if (data.imgs && Array.isArray(data.imgs)) {
                data.imgs = await Promise.all(data.imgs.map(img => uploadBase64ToBlob(img)));
            }

            if(process.env.MONGODB_URI) {
                await WsMessage.create(data);
            }

            broadcast(JSON.stringify({ type: 'message', ...data }));
        } catch (e) { console.error(e); }
    });
    
    ws.on('close', () => { clients.delete(ws); broadcastUserList(); });
});

function broadcast(data) { wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); }); }
function broadcastUserList() { broadcast(JSON.stringify({ type: 'userlist', data: Array.from(clients.values()) })); }

if (require.main === module) {
    server.listen(process.env.PORT || 8888, () => { console.log(`✅ TuoTuo 服务器已启动！`); });
}

module.exports = {
    app,
    server,
    _test: {
        buildConversationSeed,
        buildFoundryFileStructuredInputs,
        buildFoundryResponseRequestBody,
        registerFoundryInputSessionFiles,
        buildFoundryAgentReference,
        buildFoundryAgentUserContent,
        buildFoundryAgentUserMessage,
        selectRelevantSessionFiles,
        shouldAttachHistoricalFiles,
        sanitizeStoredMediaHtml,
        sanitizeStoredMessage,
        hashDownloadToken,
        extractCitationSources,
        extractGeneratedFiles,
        parseDataUrlFile,
        resolveImageSize,
        validateAgentRequest,
        formatFoundryIncompleteResponse
    }
};
