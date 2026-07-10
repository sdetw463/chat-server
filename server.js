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
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
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

let containerClient = null;
if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
        containerClient = blobServiceClient.getContainerClient('tuotuo-files');
    } catch(e) { console.error('存储连接错误', e); }
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
    if (typeof res.flushHeaders === "function") res.flushHeaders();
}
function sendSSE(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }
function sendSSEDone(res) { res.write(`data: [DONE]\n\n`); res.end(); }

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

async function collectFoundryCodeInterpreterFiles(documents, sessionFiles, userId) {
    const files = [];
    const rawDocs = (Array.isArray(documents) ? documents : [])
        .filter(isInlineInputFileDocument)
        .slice(0, foundryFileInputSlots.length);

    for (const doc of rawDocs) {
        const parsed = parseDataUrlFile(doc);
        if (parsed) files.push(parsed);
    }

    const remaining = foundryFileInputSlots.length - files.length;
    if (remaining > 0) {
        for (const file of normalizeSessionFiles(sessionFiles, userId).slice(-remaining)) {
            try {
                files.push(await downloadSessionGeneratedFile(file, userId));
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
            const uploadable = await toFile(file.buffer, file.filename, { type: file.mimeType });
            const result = await openai.files.create({ file: uploadable, purpose: "assistants" });
            if (!result?.id) throw new Error(`附件 ${file.filename} 上传后没有返回 file id。`);
            uploaded.push({ id: result.id, filename: file.filename });
        }
        return uploaded;
    } catch (error) {
        await Promise.allSettled(uploaded.map(file => openai.files.delete(file.id)));
        throw error;
    }
}

function buildFoundryFileStructuredInputs(uploadedFiles) {
    const values = {};
    foundryFileInputSlots.forEach((slot, index) => {
        values[slot] = uploadedFiles[index]?.id || "";
    });
    return values;
}

async function cleanupFoundryInputFiles(invocation) {
    const files = invocation?.uploadedInputFiles || [];
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

function normalizeSessionFiles(sessionFiles, userId) {
    pruneGeneratedFileGrants();
    const seen = new Set();
    return (Array.isArray(sessionFiles) ? sessionFiles : [])
        .map(file => {
            if (!file || typeof file !== "object") return null;
            const filename = getFileNameFromPath(file.filename || file.name || file.fileName || "agent-output", "agent-output");
            const url = String(file.url || file.downloadUrl || "").trim();
            const downloadId = String(file.downloadId || getDownloadIdFromUrl(url) || '').trim();
            const grant = downloadId && foundryGeneratedFiles.get(downloadId);
            const key = `${downloadId}:${filename}`;
            if (!grant || grant.userId !== userId || seen.has(key)) return null;
            seen.add(key);
            return {
                filename,
                downloadId,
                url,
                type: file.type || "file"
            };
        })
        .filter(Boolean);
}

async function downloadSessionGeneratedFile(file, userId) {
    const grant = file && foundryGeneratedFiles.get(file.downloadId);
    if (!grant || grant.userId !== userId || grant.expiresAt <= Date.now()) {
        throw new Error('历史文件的安全访问已过期，请重新上传该文件。');
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
    const input = [];
    const history = Array.isArray(historyMessages) ? historyMessages.slice(-12) : [];
    for (const msg of history) {
        const role = msg && msg.role === "assistant" ? "assistant" : (msg && msg.role === "user" ? "user" : null);
        const content = getTextFromMessage(msg).slice(0, 24000);
        if (role && content) input.push({ type: "message", role, content });
    }
    return input;
}

function validateAgentRequest({ userMessage, documents, images, historyMessages, sessionFiles }) {
    if (!String(userMessage || '').trim() && !(Array.isArray(documents) && documents.length) && !(Array.isArray(images) && images.length)) {
        throw new Error('请输入消息或添加附件。');
    }
    if (Array.isArray(documents) && documents.length > 3) throw new Error('一次最多处理 3 个文件。');
    if (Array.isArray(images) && images.length > 4) throw new Error('一次最多处理 4 张聊天图片。');
    if (Array.isArray(historyMessages) && historyMessages.length > 18) throw new Error('历史消息数量超出限制。');
    if (Array.isArray(sessionFiles) && sessionFiles.length > 12) throw new Error('历史文件数量超出限制。');
    const rawFiles = (Array.isArray(documents) ? documents : [])
        .filter(doc => doc && Object.prototype.hasOwnProperty.call(doc, 'fileData'));
    const totalBytes = rawFiles.reduce((sum, doc) => {
        const parsed = parseDataUrlFile(doc);
        if (!parsed) throw new Error(`附件 ${safeFileName(doc && doc.name || '未命名文件')} 无效或超过 10MB。`);
        return sum + parsed.buffer.length;
    }, 0);
    if (totalBytes > MAX_AGENT_TOTAL_FILE_BYTES) throw new Error('单次原始附件合计不能超过 20MB。');
}

function getActiveFoundryConversation(conversationKey) {
    if (!conversationKey) return null;
    const record = foundryAgentConversations.get(conversationKey);
    if (!record) return null;
    if (typeof record === 'string') return record;
    if (record.expiresAt > Date.now()) return record.id;
    foundryAgentConversations.delete(conversationKey);
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
    let conversationId = getActiveFoundryConversation(conversationKey);
    const shouldReattachSessionFiles = !conversationId;
    const history = buildConversationSeed(historyMessages);

    if (!conversationId) {
        try {
            const conversation = await openai.conversations.create(history.length ? { items: history } : {});
            conversationId = conversation && conversation.id;
            if (conversationKey && conversationId) {
                foundryAgentConversations.set(conversationKey, { id: conversationId, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
            }
        } catch (error) {
            // Conversation state is an optimization. The request can still be completed
            // statelessly with the browser-provided history if that API is unavailable.
            console.error("创建 Foundry conversation 失败，将使用无状态历史:", error.message || error);
        }
    }

    const attachmentFiles = await collectFoundryCodeInterpreterFiles(
        documents,
        shouldReattachSessionFiles ? sessionFiles : [],
        userId
    );
    const uploadedInputFiles = await uploadFoundryCodeInterpreterFiles(openai, attachmentFiles);
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
        conversationId,
        conversationKey,
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
        return {
            reply: extractResponseText(response),
            sources: extractCitationSources(response),
            files: extractGeneratedFiles(response, args.userId),
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
    if (invocation?.conversationKey && error?.status === 404 && /conversation/i.test(String(error.message || ''))) {
        foundryAgentConversations.delete(invocation.conversationKey);
    }
}

async function handleFoundryAgentChatSSE(args, res, abortSignal) {
    const hasAttachments = Array.isArray(args.documents) && args.documents.length > 0;
    sendSSE(res, {
        status: hasAttachments ? "正在读取并准备附件" : "正在理解你的问题",
        tool: "agent",
        agent: foundryAgentName
    });
    const invocation = await prepareFoundryAgentInvocation(args);
    try {
        if (invocation.uploadedInputFiles.length) {
            sendSSE(res, { status: "附件已挂载，正在启动代码解释器", tool: "code_interpreter" });
        }
        let stream;
        try {
            stream = await invocation.openai.responses.create(
                { ...invocation.requestBody, stream: true },
                { ...invocation.requestOptions, signal: abortSignal }
            );
        } catch (error) {
            forgetInvalidConversation(invocation, error);
            throw error;
        }
        let response = null;
        let streamedText = "";
        let lastStatus = "";
        const sendProgress = (status, tool = "agent") => {
            if (!status || status === lastStatus) return;
            lastStatus = status;
            sendSSE(res, { status, tool });
        };
        const heartbeat = setInterval(() => {
            if (!res.writableEnded && !res.destroyed) sendSSE(res, { ping: Date.now() });
        }, 15000);
        heartbeat.unref?.();

        try {
            for await (const event of stream) {
                if (event.type === "response.output_text.delta" && event.delta) {
                    streamedText += event.delta;
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
                } else if (event.type === "response.failed") {
                    const message = event.response?.error?.message || "Foundry Agent 响应失败。";
                    throw new Error(message);
                } else if (event.type === "error") {
                    throw new Error(event.message || "Foundry Agent 流式响应失败。");
                }
            }
        } finally {
            clearInterval(heartbeat);
        }

        const reply = extractResponseText(response);
        const sources = extractCitationSources(response);
        const files = extractGeneratedFiles(response, args.userId);
        if (sources.length) sendSSE(res, { sources });
        if (files.length) sendSSE(res, { files });
        if (!streamedText && reply) sendSSE(res, { delta: reply });
        if (!streamedText && !reply) sendSSE(res, { delta: "我没有收到有效回复，请稍后再试。" });
        sendSSE(res, {
            done: true,
            foundryConversationId: invocation.conversationId || null,
            foundryResponseId: response && response.id || null
        });
        return sendSSEDone(res);
    } finally {
        await cleanupFoundryInputFiles(invocation);
    }
}

async function downloadFoundryAgentFile(containerId, fileId) {
    if (!fileId && containerId) {
        fileId = containerId;
        containerId = "";
    }
    if (!fileId) throw new Error("缺少 fileId，无法下载 Agent 生成文件。");
    if (!containerId) throw new Error("缺少 containerId，无法下载 Agent 生成文件。");
    const { openai } = getFoundryClients();
    const response = await openai.containers.files.content.retrieve(fileId, { container_id: containerId });
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
    const anonymousScope = clientId || [
        'legacy',
        sessionId || 'no-session',
        req.ip || req.socket?.remoteAddress || '',
        req.get('user-agent') || ''
    ].join(':');
    return {
        userMessage: String(req.body.message || '').trim(),
        documents: Array.isArray(req.body.documents) ? req.body.documents : [],
        images,
        historyMessages: Array.isArray(req.body.historyMessages) ? req.body.historyMessages : [],
        reasoningMode: ['normal', 'think', 'research'].includes(req.body.reasoningMode) ? req.body.reasoningMode : 'normal',
        sessionId,
        sessionFiles: Array.isArray(req.body.sessionFiles) ? req.body.sessionFiles : [],
        userId: crypto.createHash('sha256').update(anonymousScope).digest('base64url')
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
            return await handleFoundryAgentChatSSE(agentRequest, res, controller.signal);
        }

        const result = await runFoundryAgentChat(agentRequest);
        return res.json({
            reply: result.reply,
            sources: result.sources,
            files: result.files,
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

// AI 聊天记录只保存在访问者自己的浏览器中，不再写入或读取云端数据库。
app.all('/api/sessions', (req, res) => {
    res.status(410).json({ error: '云端 AI 聊天记录已停用；记录仅保存在当前浏览器。' });
});

app.get('/api/ai-agent-file/:downloadId', async (req, res) => {
    try {
        pruneGeneratedFileGrants();
        const grant = foundryGeneratedFiles.get(String(req.params.downloadId || ''));
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
        "公共 AI 访问": "✅ 已启用",
        "Foundry Project Endpoint": !!foundryProjectEndpoint ? "✅ 是" : "❌ 否",
        "Foundry Agent 是否可用": !!foundryProjectEndpoint && !!foundryAgentName ? "✅ 是" : "❌ 否",
        "Foundry Agent 名称": foundryAgentName,
        "Foundry Agent 版本": foundryAgentVersion || "默认最新版",
        "Code Interpreter 运行时附件槽": foundryFileInputSlots.join(', '),
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
        buildFoundryAgentReference,
        buildFoundryAgentUserContent,
        buildFoundryAgentUserMessage,
        extractCitationSources,
        extractGeneratedFiles,
        parseDataUrlFile,
        resolveImageSize,
        validateAgentRequest
    }
};
