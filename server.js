const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { DefaultAzureCredential } = require('@azure/identity');
const mongoose = require('mongoose');
const { BlobServiceClient } = require('@azure/storage-blob');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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
    sessionId: String,
    userName: String,
    data: Object,
    foundryConversationId: String,
    foundryVectorStoreId: String,
    foundryFileIds: [String]
}, { strict: false, timestamps: true });
const AiSession = mongoose.model('AiSession', aiSessionSchema, 'ai_sessions');

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
const endpoint = process.env.AZURE_OPENAI_CHAT_ENDPOINT
    || process.env.AZURE_OPENAI_ENDPOINT
    || process.env.AZURE_OPENAI_API_BASE;
const apiKey = process.env.AZURE_OPENAI_KEY || process.env.AZURE_OPENAI_API_KEY;
const deployment = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT
    || process.env.AZURE_OPENAI_DEPLOYMENT
    || process.env.AZURE_OPENAI_DEPLOYMENT_NAME
    || "gpt-5.5";
const foundryProjectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT
    || process.env.AZURE_AI_PROJECT_ENDPOINT
    || process.env.AZURE_FOUNDRY_PROJECT_ENDPOINT;
const foundryDeployment = process.env.FOUNDRY_MODEL_DEPLOYMENT
    || process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME
    || deployment;
const foundryAgentName = process.env.FOUNDRY_AGENT_NAME
    || process.env.AZURE_AI_AGENT_NAME
    || "tuo-agent";
const foundryAgentVersion = process.env.FOUNDRY_AGENT_VERSION
    || process.env.AZURE_AI_AGENT_VERSION
    || "";
const foundryAgentEnabled = String(process.env.FOUNDRY_AGENT_ENABLED || "true").toLowerCase() !== "false";
const foundryAgentConversations = new Map();
const imageEndpoint = process.env.AZURE_OPENAI_IMAGE_ENDPOINT || process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_OPENAI_API_BASE;
const imageApiKey = process.env.AZURE_OPENAI_IMAGE_KEY || process.env.AZURE_OPENAI_IMAGE_API_KEY || apiKey;
const imageDeployment = process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT || process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT_NAME || process.env.DEPLOYMENT_NAME || "gpt-image-2";
const imageApiVersion = process.env.AZURE_OPENAI_IMAGE_API_VERSION || "2025-04-01-preview";
const imageQuality = process.env.AZURE_OPENAI_IMAGE_QUALITY || "medium";
const imageMaxRetries = Math.max(0, Number(process.env.AZURE_OPENAI_IMAGE_MAX_RETRIES || 2));
const azureCredential = new DefaultAzureCredential();

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
                console.log("↪️ 当前路径不可用，尝试兼容 /openai/v1 图片接口...");
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

const TUOTUO_SYSTEM_INSTRUCTIONS = "你的名字叫TuoTuo，中文名拖拖，你是基于 gpt-5.5 模型部署的全能 AI 助手。你的虚拟性格是一个可爱、调皮、偶尔傲娇的女孩，但提供专业解答时必须逻辑严谨、排版清晰。遇到最新信息、实时信息、新闻、价格、天气、当前状态、官网资料等内容时，如果后端提供了 Web Search 工具，你必须优先搜索公共 Web，并在回答里尽量保留来源依据。你会亲昵地称呼提问者为“宝宝”。";
const sessions = new Map();

function stripTrailingSlash(value) {
    return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeOpenAIBaseUrl(base) {
    const cleaned = stripTrailingSlash(base);
    if (!cleaned) return null;
    if (/\/openai\/v1$/i.test(cleaned)) return `${cleaned}/`;
    if (/\/openai$/i.test(cleaned)) return `${cleaned}/v1/`;
    return `${cleaned}/openai/v1/`;
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

function shouldExpectWebSearch(message, reasoningMode) {
    const text = String(message || "");
    return reasoningMode === "research"
        || /最新|今天|现在|实时|新闻|搜索|联网|查一下|查找|检索|资料|价格|天气|官网|当前|最近|来源|出处|引用|recent|latest|today|now|search|web|news|price|weather/i.test(text)
        || /文献|论文|文章|期刊|参考文献|DOI|PMID|CNKI|知网|万方|维普|中国农村观察|类型学|paper|article|journal|literature|citation/i.test(text)
        || /推荐.{0,12}(几篇|一些|相关).{0,20}(文章|论文|文献|期刊)/i.test(text);
}

function getRequestInstructions(reasoningMode, canUseWebSearch, shouldSearch) {
    let searchInstruction = "";
    if (shouldSearch && canUseWebSearch) {
        searchInstruction = "本轮问题需要外部检索，请调用 Web Search 工具核对公开网页信息；回答必须先给出整理后的正文结论或推荐清单，再给来源依据，不能只输出参考来源链接。";
    } else if (shouldSearch && !canUseWebSearch) {
        searchInstruction = "本轮问题需要外部检索，但当前后端没有可用的 Web Search 工具；请明确说明无法即时核对，并不要编造来源。";
    } else {
        searchInstruction = "按已有知识回答；如果涉及具体文献、期次、最新目录、价格、新闻等需要核对的信息，请主动说明需要联网检索，避免声称已经查证。";
    }
    if (reasoningMode === "research") {
        return `本轮是深度研究模式。${searchInstruction}回答要综合、可靠、结构清晰。`;
    }
    if (reasoningMode === "think") {
        return `本轮请更仔细地分析问题。${searchInstruction}`;
    }
    return searchInstruction;
}

function getTextFromMessage(message) {
    return String(message && (message.content || message.text || message.userText || message.message) || "").trim();
}

function shouldUseFoundryAgentForChat(processedImages) {
    return foundryAgentEnabled
        && !!foundryProjectEndpoint
        && !!foundryAgentName
        && (!processedImages || processedImages.length === 0);
}

function buildFoundryAgentUserMessage(userMessage, documents, reasoningMode, shouldSearch) {
    const toolInstruction = [
        "本轮由 Foundry Agent 处理。你可以使用该 Agent 已配置的工具，例如代码解释器和 Web 搜索。",
        "当用户要求生成、编辑、整理或转换文件时，请优先使用代码解释器创建可下载文件。",
        "生成图表、Excel、PDF、CSV、ZIP 等文件时，必须实际在代码解释器沙盒中保存文件；不要只在文字里写“下载某文件”。",
        "如果文件没有成功生成，请直接说明失败原因和下一步需要什么，不要声称已经提供下载。",
        "如果用户上传的附件文本已包含在消息中，请把它当作用户提供的真实文件内容来分析；需要生成新文件时，请用代码解释器重新构造并输出文件。"
    ].join("\n");
    const modeInstruction = getRequestInstructions(reasoningMode, true, shouldSearch);
    const attachmentText = buildAttachmentText(documents);
    return `${toolInstruction}\n\n${modeInstruction}\n\n用户问题：${userMessage || ""}${attachmentText}`.trim() || "你好";
}

function isInlineInputFileDocument(doc) {
    return !!(doc && typeof doc.fileData === "string" && /^data:[^;]+;base64,/i.test(doc.fileData));
}

function buildFoundryAgentUserContent(userMessage, documents, reasoningMode, shouldSearch) {
    const docs = Array.isArray(documents) ? documents : [];
    const fileDocs = docs.filter(isInlineInputFileDocument).slice(0, 5);
    const contentDocs = docs.filter(doc => doc && doc.content);
    const parts = [];

    for (const doc of fileDocs) {
        parts.push({
            type: "input_file",
            filename: safeFileName(doc.name || "attachment"),
            file_data: doc.fileData
        });
    }

    const fileSummary = fileDocs.length
        ? "\n\n本轮用户上传了这些原始附件，已作为 input_file 提供给你和代码解释器：\n"
            + fileDocs.map(doc => `- ${safeFileName(doc.name || "attachment")} (${doc.mimeType || "application/octet-stream"}, ${doc.size || 0} bytes)`).join("\n")
        : "";
    const text = `${buildFoundryAgentUserMessage(userMessage, contentDocs, reasoningMode, shouldSearch)}${fileSummary}`.trim() || "你好";
    parts.push({ type: "input_text", text });
    return parts;
}

function getFoundryOpenAIBaseUrl() {
    if (!foundryProjectEndpoint) throw new Error("未配置 FOUNDRY_PROJECT_ENDPOINT，无法调用 Foundry Agent。");
    return normalizeOpenAIBaseUrl(foundryProjectEndpoint);
}

async function postFoundryOpenAI(pathPart, body) {
    const cleanPath = String(pathPart || "").replace(/^\/+/, "");
    const response = await fetch(`${getFoundryOpenAIBaseUrl()}${cleanPath}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(await getResponsesAuthHeaders("entra"))
        },
        body: JSON.stringify(body || {})
    });
    if (!response.ok) {
        throw new Error(await readAzureTextError(response));
    }
    return response.json();
}

function buildFoundryAgentReference() {
    const reference = { name: foundryAgentName, type: "agent_reference" };
    if (foundryAgentVersion) reference.version = String(foundryAgentVersion);
    return reference;
}

async function getFoundryBinary(pathPart) {
    const cleanPath = String(pathPart || "").replace(/^\/+/, "");
    const response = await fetch(`${getFoundryOpenAIBaseUrl()}${cleanPath}`, {
        method: "GET",
        headers: {
            "Accept": "application/octet-stream",
            ...(await getResponsesAuthHeaders("entra"))
        }
    });
    if (!response.ok) {
        throw new Error(await readAzureTextError(response));
    }
    return {
        buffer: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") || "application/octet-stream"
    };
}

function getFileNameFromPath(value, fallback = "agent-output") {
    const raw = String(value || fallback).split(/[\\/]/).pop() || fallback;
    return safeFileName(raw, fallback).slice(0, 160) || fallback;
}

function normalizeAgentFileRecord(file, index = 0) {
    if (!file || !file.fileId) return null;
    const fallbackName = guessAgentFileName(file, index);
    const filename = getFileNameFromPath(file.filename || file.path || file.fileName || file.text, fallbackName);
    const record = {
        fileId: String(file.fileId),
        containerId: file.containerId ? String(file.containerId) : "",
        filename,
        type: file.type || "file"
    };
    if (record.containerId) {
        record.url = `/api/ai-agent-file/${encodeURIComponent(record.containerId)}/${encodeURIComponent(record.fileId)}?filename=${encodeURIComponent(filename)}`;
    }
    return record;
}

function extractGeneratedFiles(response) {
    const found = [];
    const seen = new Set();

    function addFile(raw, inheritedContainerId) {
        if (!raw || typeof raw !== "object") return;
        const filePath = raw.file_path || raw.filePath || {};
        const file = raw.file || raw.container_file || raw.containerFile || {};
        const fileId = raw.file_id
            || raw.fileId
            || raw.id
            || raw.container_file_id
            || raw.containerFileId
            || filePath.file_id
            || filePath.fileId
            || filePath.id
            || file.file_id
            || file.fileId
            || file.id;
        const filename = raw.filename
            || raw.file_name
            || raw.name
            || raw.path
            || raw.text
            || filePath.filename
            || filePath.file_name
            || filePath.path
            || filePath.text
            || file.filename
            || file.file_name
            || file.name
            || file.path;
        const containerId = raw.container_id
            || raw.containerId
            || filePath.container_id
            || filePath.containerId
            || file.container_id
            || file.containerId
            || inheritedContainerId
            || "";
        if (!fileId) return;
        const key = `${containerId}:${fileId}:${filename}`;
        if (seen.has(key)) return;
        seen.add(key);
        found.push(normalizeAgentFileRecord({ fileId, containerId, filename, path: raw.path, text: raw.text, type: raw.type }, found.length));
    }

    function visit(value, inheritedContainerId = "") {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
            value.forEach(item => visit(item, inheritedContainerId));
            return;
        }
        const containerId = value.container_id || value.containerId || inheritedContainerId || "";

        if (Array.isArray(value.files)) value.files.forEach(file => addFile(file, containerId));
        if (Array.isArray(value.annotations)) value.annotations.forEach(annotation => addFile(annotation, containerId));
        if (Array.isArray(value.output_text_annotations)) value.output_text_annotations.forEach(annotation => addFile(annotation, containerId));
        if (Array.isArray(value.outputTextAnnotations)) value.outputTextAnnotations.forEach(annotation => addFile(annotation, containerId));
        if (value.file_id || value.fileId || value.container_file_id || value.containerFileId || value.file_path || value.filePath) {
            addFile(value, containerId);
        }

        for (const child of Object.values(value)) {
            visit(child, containerId);
        }
    }

    visit(response);
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

function buildAgentFallbackInput(userMessage, documents, historyMessages, reasoningMode, shouldSearch) {
    const input = [];
    const history = Array.isArray(historyMessages) ? historyMessages.slice(-12) : [];
    for (const msg of history) {
        const role = msg && msg.role === "assistant" ? "assistant" : (msg && msg.role === "user" ? "user" : null);
        const content = getTextFromMessage(msg).slice(0, 24000);
        if (role && content) input.push({ role, content });
    }
    input.push({ role: "user", content: buildFoundryAgentUserContent(userMessage, documents, reasoningMode, shouldSearch) });
    return input;
}

async function runFoundryAgentChat({ userMessage, documents, historyMessages, reasoningMode, sessionId }) {
    const shouldSearch = shouldExpectWebSearch(userMessage, reasoningMode);
    const content = buildFoundryAgentUserContent(userMessage, documents, reasoningMode, shouldSearch);
    const agentBody = { agent_reference: buildFoundryAgentReference() };
    let conversationId = sessionId ? foundryAgentConversations.get(sessionId) : null;
    let response;

    try {
        if (!conversationId) {
            const conversation = await postFoundryOpenAI("conversations", {});
            conversationId = conversation && conversation.id;
            if (sessionId && conversationId) foundryAgentConversations.set(sessionId, conversationId);
        }

        response = await postFoundryOpenAI("responses", {
            conversation: conversationId,
            input: [{ role: "user", content }],
            stream: false,
            ...agentBody
        });
    } catch (conversationError) {
        console.error("Foundry Agent conversation 模式失败，回退为单次 responses 调用:", conversationError.message || conversationError);
        response = await postFoundryOpenAI("responses", {
            input: buildAgentFallbackInput(userMessage, documents, historyMessages, reasoningMode, shouldSearch),
            stream: false,
            ...agentBody
        });
    }

    return {
        reply: extractResponseText(response),
        sources: extractCitationSources(response),
        files: extractGeneratedFiles(response),
        conversationId,
        rawResponseId: response && response.id
    };
}

async function handleFoundryAgentChatSSE({ userMessage, documents, historyMessages, reasoningMode, sessionId }, res) {
    sendSSE(res, { status: "正在调用 Foundry Agent", tool: "agent", agent: foundryAgentName });
    const result = await runFoundryAgentChat({ userMessage, documents, historyMessages, reasoningMode, sessionId });
    if (result.sources.length) sendSSE(res, { sources: result.sources });
    if (result.files.length) sendSSE(res, { files: result.files });
    await streamTextToSSE(res, result.reply || "我没有收到有效回复，请稍后再试。");
    if (result.files.length) sendSSE(res, { files: result.files });
    sendSSE(res, { done: true, foundryConversationId: result.conversationId || null, foundryResponseId: result.rawResponseId || null });
    return sendSSEDone(res);
}

async function downloadFoundryAgentFile(containerId, fileId) {
    if (!fileId && containerId) {
        fileId = containerId;
        containerId = "";
    }
    if (!fileId) throw new Error("缺少 fileId，无法下载 Agent 生成文件。");
    const encodedFile = encodeURIComponent(fileId);
    const candidates = [];
    if (containerId) {
        const encodedContainer = encodeURIComponent(containerId);
        candidates.push(
            `containers/${encodedContainer}/files/${encodedFile}/content`,
            `containers/${encodedContainer}/files/${encodedFile}/content?api-version=preview`
        );
    }
    candidates.push(`files/${encodedFile}/content`);
    let lastError = null;
    for (const candidate of candidates) {
        try {
            return await getFoundryBinary(candidate);
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error("下载 Agent 生成文件失败。");
}


function safeFileName(name, fallback = "attachment.txt") {
    const cleaned = String(name || fallback)
        .replace(/[^\w.\-()\u4e00-\u9fa5]+/g, "_")
        .slice(0, 120);
    return cleaned || fallback;
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

function buildResponsesInput(userMessage, images, documents, historyMessages, reasoningMode, canUseWebSearch, shouldSearch) {
    const input = [];
    const history = Array.isArray(historyMessages) ? historyMessages.slice(-18) : [];
    for (const msg of history) {
        const role = msg && msg.role === "assistant" ? "assistant" : (msg && msg.role === "user" ? "user" : null);
        const content = getTextFromMessage(msg).slice(0, 24000);
        if (role && content) input.push({ role, content });
    }

    const modeInstruction = getRequestInstructions(reasoningMode, canUseWebSearch, shouldSearch);
    const attachmentText = buildAttachmentText(documents);
    const text = `${modeInstruction}\n\n用户问题：${userMessage || ""}${attachmentText}`.trim();
    const normalizedImages = (Array.isArray(images) ? images : [images]).map(normalizeChatImage).filter(Boolean);

    if (normalizedImages.length) {
        const content = [{ type: "input_text", text: text || "请仔细看看这些图片，并描述一下里面的内容。" }];
        normalizedImages.slice(0, 6).forEach(imageUrl => content.push({ type: "input_image", image_url: imageUrl }));
        input.push({ role: "user", content });
    } else {
        input.push({ role: "user", content: text || "你好" });
    }
    return input;
}

async function getAzureAccessToken() {
    if (process.env.AZURE_AI_AUTH_TOKEN) return process.env.AZURE_AI_AUTH_TOKEN;
    if (process.env.AZURE_OPENAI_AUTH_TOKEN) return process.env.AZURE_OPENAI_AUTH_TOKEN;
    const token = await azureCredential.getToken("https://ai.azure.com/.default");
    if (!token || !token.token) throw new Error("无法通过 DefaultAzureCredential 获取 Azure 访问令牌。请先 az login，或在 Azure App Service 配置托管身份，或改用 AZURE_OPENAI_API_KEY。");
    return token.token;
}

async function getResponsesAuthHeaders(authMode) {
    if (authMode === "api-key") {
        if (!apiKey) throw new Error("未配置 AZURE_OPENAI_API_KEY。请在环境变量里加入 Azure OpenAI API Key。");
        return { "api-key": apiKey };
    }
    return { "Authorization": `Bearer ${await getAzureAccessToken()}` };
}

function selectResponsesTarget(needWebSearch) {
    if (needWebSearch && foundryProjectEndpoint) {
        return {
            baseUrl: normalizeOpenAIBaseUrl(foundryProjectEndpoint),
            model: foundryDeployment,
            authMode: "entra",
            canUseWebSearch: true,
            label: "Foundry Project Responses + Web Search"
        };
    }
    if (endpoint && apiKey) {
        return {
            baseUrl: normalizeOpenAIBaseUrl(endpoint),
            model: deployment,
            authMode: "api-key",
            canUseWebSearch: false,
            label: "Azure OpenAI Responses"
        };
    }
    if (foundryProjectEndpoint) {
        return {
            baseUrl: normalizeOpenAIBaseUrl(foundryProjectEndpoint),
            model: foundryDeployment,
            authMode: "entra",
            canUseWebSearch: false,
            label: "Foundry Project Responses"
        };
    }
    throw new Error("AI 后端未配置：至少需要 AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY，若要联网搜索还需要 FOUNDRY_PROJECT_ENDPOINT 或 AZURE_AI_PROJECT_ENDPOINT。");
}

async function readAzureTextError(response) {
    const text = await response.text();
    const requestId = response.headers.get("x-ms-request-id")
        || response.headers.get("apim-request-id")
        || response.headers.get("x-request-id");
    const detailParts = [`HTTP ${response.status}`];
    if (response.statusText) detailParts.push(response.statusText);
    if (requestId) detailParts.push(`request_id=${requestId}`);
    if (!text) return `Azure Responses API 请求失败：${detailParts.join(" / ")}`;
    try {
        const parsed = JSON.parse(text);
        const message = parsed.error?.message || parsed.message || JSON.stringify(parsed.error || parsed);
        return `Azure Responses API 请求失败：${detailParts.join(" / ")}：${message}`;
    } catch {
        return `Azure Responses API 请求失败：${detailParts.join(" / ")}：${text}`;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function postResponses(target, body) {
    const headers = {
        "Content-Type": "application/json",
        ...(await getResponsesAuthHeaders(target.authMode))
    };
    const response = await fetch(`${target.baseUrl}responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
    });
    if (!response.ok) {
        throw new Error(await readAzureTextError(response));
    }
    return response;
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
    const visit = value => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) return value.forEach(visit);
        const url = value.url || value.uri;
        const title = value.title || value.name || value.text || value.file_name || url;
        if (url && /^https?:\/\//i.test(String(url))) {
            const key = String(url);
            if (!seen.has(key)) {
                seen.add(key);
                sources.push({ title: String(title || url).slice(0, 180), url: key });
            }
        }
        for (const child of Object.values(value)) visit(child);
    };
    visit(response);
    return sources.slice(0, 12);
}

function handleResponseStreamEvent(event, state, res) {
    if (!event || typeof event !== "object") return;
    const type = event.type || "";

    if (type === "response.output_text.delta" && event.delta) {
        state.hasStreamedText = true;
        state.fullText += event.delta;
        sendSSE(res, { delta: event.delta });
        return;
    }

    if ((type === "response.output_text.done" || type === "response.text.done") && event.text && !state.hasStreamedText) {
        state.hasStreamedText = true;
        state.fullText = event.text;
        sendSSE(res, { delta: event.text });
        return;
    }

    if (/web_search/i.test(type)) {
        state.usedWebSearch = true;
        sendSSE(res, { status: "正在搜索网络", tool: "search" });
    } else if (type === "response.output_item.done" && event.item) {
        state.sources.push(...extractCitationSources(event.item));
    } else if (type === "response.completed" && event.response) {
        state.completedResponse = event.response;
        state.sources.push(...extractCitationSources(event.response));
    } else if (type === "response.failed") {
        throw new Error(event.response?.error?.message || event.error?.message || "Azure Responses API 流式返回失败");
    } else if (type === "error") {
        throw new Error(event.message || event.error?.message || "Azure Responses API 流式返回错误");
    }
}

async function streamResponsesToSSE(response, res) {
    const decoder = new TextDecoder();
    let buffer = "";
    const state = { fullText: "", hasStreamedText: false, usedWebSearch: false, completedResponse: null, sources: [] };

    for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const rawEvent = buffer.slice(0, boundary).trim();
            buffer = buffer.slice(boundary + 2);
            if (!rawEvent) continue;
            const dataLines = rawEvent.split(/\r?\n/)
                .filter(line => line.startsWith("data:"))
                .map(line => line.slice(5).trim());
            if (!dataLines.length) continue;
            const data = dataLines.join("\n");
            if (data === "[DONE]") continue;
            try {
                handleResponseStreamEvent(JSON.parse(data), state, res);
            } catch (eventError) {
                throw eventError;
            }
        }
    }

    if (buffer.trim()) {
        const dataLines = buffer.split(/\r?\n/)
            .filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).trim());
        const data = dataLines.join("\n");
        if (data && data !== "[DONE]") handleResponseStreamEvent(JSON.parse(data), state, res);
    }

    const finalText = state.fullText || extractResponseText(state.completedResponse);
    if (!state.hasStreamedText && finalText) {
        state.hasStreamedText = true;
        state.fullText = finalText;
        sendSSE(res, { delta: finalText });
    }
    const uniqueSources = [];
    const seen = new Set();
    for (const source of state.sources) {
        const key = source.url || source.title;
        if (key && !seen.has(key)) {
            seen.add(key);
            uniqueSources.push(source);
        }
    }
    return { finalText, sources: uniqueSources.slice(0, 12), usedWebSearch: state.usedWebSearch };
}

function formatAIError(error) {
    if (error?.isRateLimit) {
        const retryText = error.retryAfterMs ? `建议 ${Math.ceil(error.retryAfterMs / 1000)} 秒后再试。` : "建议稍等几十秒再试。";
        const remainTokens = error.rateLimit?.remainingTokens;
        const resetTokens = error.rateLimit?.resetTokens;
        const detail = [
            error.status ? `HTTP ${error.status}` : null,
            error.message,
            remainTokens ? `remaining_tokens=${remainTokens}` : null,
            resetTokens ? `reset_tokens=${resetTokens}` : null,
            error.requestId ? `request_id=${error.requestId}` : null
        ].filter(Boolean).join(" | ");
        return `Azure 模型部署暂时触发限流。${retryText}${detail ? `\n${detail}` : ""}`;
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

async function streamTextToSSE(res, text) {
    const chars = Array.from(text || "");
    const chunkSize = 18;
    for (let i = 0; i < chars.length; i += chunkSize) {
        sendSSE(res, { delta: chars.slice(i, i + chunkSize).join("") });
        await new Promise(resolve => setTimeout(resolve, 8));
    }
}

async function handleStreamingAIChat(req, res) {
    setupSSE(res);
    const userMessage = String(req.body.message || "").trim();
    const imagesArray = req.body.images || req.body.image || [];
    const documents = Array.isArray(req.body.documents) ? req.body.documents : [];
    const historyMessages = Array.isArray(req.body.historyMessages) ? req.body.historyMessages : [];
    const reasoningMode = req.body.reasoningMode || "normal";
    const shouldSearch = shouldExpectWebSearch(userMessage, reasoningMode);
    const target = selectResponsesTarget(shouldSearch);

    const processedImages = [];
    for (const img of (Array.isArray(imagesArray) ? imagesArray : [imagesArray])) {
        const image = normalizeChatImage(img);
        if (image) processedImages.push(await uploadBase64ToBlob(image));
    }

    if (shouldUseFoundryAgentForChat(processedImages)) {
        return await handleFoundryAgentChatSSE({
            userMessage,
            documents,
            historyMessages,
            reasoningMode,
            sessionId: req.body.sessionId || null
        }, res);
    }

    sendSSE(res, { status: "正在理解你的问题" });
    if (shouldSearch && target.canUseWebSearch) {
        sendSSE(res, { status: "正在调用 Foundry Web Search 搜索网络", tool: "search", query: userMessage || "实时信息" });
    }
    if (shouldSearch && !target.canUseWebSearch) {
        sendSSE(res, { status: "未配置 Foundry Web Search，本轮会按普通模型回答", tool: "search_unavailable" });
    }
    if (documents.length) sendSSE(res, { status: "正在把上传附件交给 Agent", tool: "document_file" });

    const requestBody = {
        model: target.model,
        instructions: TUOTUO_SYSTEM_INSTRUCTIONS,
        input: buildResponsesInput(userMessage, processedImages, documents, historyMessages, reasoningMode, target.canUseWebSearch, shouldSearch),
        stream: true,
        store: false
    };

    if (shouldSearch && target.canUseWebSearch) {
        requestBody.tools = [{ type: "web_search" }];
        requestBody.tool_choice = "required";
    }

    try {
        console.log(`🤖 AI 聊天请求通道: ${target.label} / model=${target.model} / search=${!!requestBody.tools}`);
        const response = await postResponses(target, requestBody);
        const result = await streamResponsesToSSE(response, res);
        if (shouldSearch && target.canUseWebSearch) sendSSE(res, { status: "已经找到相关资料，正在整理回答" });
        if (result.sources.length) sendSSE(res, { sources: result.sources });
        sendSSE(res, { done: true });
        return sendSSEDone(res);
    } catch (streamError) {
        console.error("Responses 流式失败:", streamError.message || streamError);
        if (res.writableEnded) return;
        console.error("尝试回退为非流式响应...");
        const fallbackBody = { ...requestBody, stream: false };
        const response = await postResponses(target, fallbackBody);
        const data = await response.json();
        const finalReply = extractResponseText(data);
        await streamTextToSSE(res, finalReply);
        const sources = extractCitationSources(data);
        if (sources.length) sendSSE(res, { sources });
        sendSSE(res, { done: true });
        return sendSSEDone(res);
    }
}

app.post('/api/ai-chat', async (req, res) => {
    try {
        if (req.body.stream === true || req.body.stream === "true") return await handleStreamingAIChat(req, res);

        const userMessage = String(req.body.message || "").trim();
        const imagesArray = req.body.images || req.body.image || [];
        const shouldSearch = shouldExpectWebSearch(userMessage, req.body.reasoningMode || "normal");
        const target = selectResponsesTarget(shouldSearch);
        const processedImages = [];
        for (const img of (Array.isArray(imagesArray) ? imagesArray : [imagesArray])) {
            const image = normalizeChatImage(img);
            if (image) processedImages.push(await uploadBase64ToBlob(image));
        }

        if (shouldUseFoundryAgentForChat(processedImages)) {
            const result = await runFoundryAgentChat({
                userMessage,
                documents: Array.isArray(req.body.documents) ? req.body.documents : [],
                historyMessages: Array.isArray(req.body.historyMessages) ? req.body.historyMessages : [],
                reasoningMode: req.body.reasoningMode || "normal",
                sessionId: req.body.sessionId || null
            });
            return res.json({
                reply: result.reply,
                sources: result.sources,
                files: result.files,
                foundryConversationId: result.conversationId || null,
                foundryResponseId: result.rawResponseId || null,
                usedAgent: true,
                agentName: foundryAgentName
            });
        }

        const requestBody = {
            model: target.model,
            instructions: TUOTUO_SYSTEM_INSTRUCTIONS,
            input: buildResponsesInput(userMessage, processedImages, req.body.documents, req.body.historyMessages, req.body.reasoningMode || "normal", target.canUseWebSearch, shouldSearch),
            stream: false,
            store: false,
        };
        if (shouldSearch && target.canUseWebSearch) {
            requestBody.tools = [{ type: "web_search" }];
            requestBody.tool_choice = "required";
        }
        const response = await postResponses(target, requestBody);
        const data = await response.json();
        return res.json({
            reply: extractResponseText(data),
            sources: extractCitationSources(data),
            usedWebSearch: !!requestBody.tools
        });
    } catch (error) {
        console.error("🔥 AI 对话接口崩溃:", error);
        const errorMessage = formatAIError(error);
        if (res.headersSent) {
            try {
                sendSSE(res, { delta: `\n\n⚠️ **系统提示**：抱歉宝宝，AI 后端报错：\`${errorMessage}\`。` });
                return sendSSEDone(res);
            } catch { return; }
        }
        return res.status(500).json({ error: errorMessage });
    }
});

app.post('/api/ai-image', async (req, res) => {
    try {
        const prompt = req.body.prompt;
        const images = Array.isArray(req.body.images) ? req.body.images : (req.body.images ? [req.body.images] : []);
        const ratio = req.body.ratio || "auto";

        if (!prompt) return res.status(400).json({ error: '必须告诉 TuoTuo 你想画什么哦！' });

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
                    label: `deployments/${imageDeployment}/images/edits`,
                    url: `${baseUrl}/openai/deployments/${encodeURIComponent(imageDeployment)}/images/edits?api-version=${encodeURIComponent(imageApiVersion)}`,
                    options: { method: "POST", headers: { "api-key": imageApiKey }, body: buildEditForm("image", false) }
                }),
                () => ({
                    label: `deployments/${imageDeployment}/images/edits image[]`,
                    url: `${baseUrl}/openai/deployments/${encodeURIComponent(imageDeployment)}/images/edits?api-version=${encodeURIComponent(imageApiVersion)}`,
                    options: { method: "POST", headers: { "api-key": imageApiKey }, body: buildEditForm("image[]", false) }
                }),
                () => ({
                    label: `deployments/${imageDeployment}/images/edits model`,
                    url: `${baseUrl}/openai/deployments/${encodeURIComponent(imageDeployment)}/images/edits?api-version=${encodeURIComponent(imageApiVersion)}`,
                    options: { method: "POST", headers: { "api-key": imageApiKey }, body: buildEditForm("image", true) }
                }),
                () => ({
                    label: "openai/v1/images/edits",
                    url: `${baseUrl}/openai/v1/images/edits?api-version=preview`,
                    options: { method: "POST", headers: { "api-key": imageApiKey }, body: buildEditForm("image", true) }
                })
            ]);

            const imageItem = data.data && data.data[0];
            const imageUrl = getImageUrlFromResponse(data);
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
                    label: `deployments/${imageDeployment}/images/generations`,
                    url: `${baseUrl}/openai/deployments/${encodeURIComponent(imageDeployment)}/images/generations?api-version=${encodeURIComponent(imageApiVersion)}`,
                    options: {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "api-key": imageApiKey },
                        body: JSON.stringify(buildGenerationBody(false))
                    }
                }),
                () => ({
                    label: `deployments/${imageDeployment}/images/generations model`,
                    url: `${baseUrl}/openai/deployments/${encodeURIComponent(imageDeployment)}/images/generations?api-version=${encodeURIComponent(imageApiVersion)}`,
                    options: {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "api-key": imageApiKey },
                        body: JSON.stringify(buildGenerationBody(true))
                    }
                }),
                () => ({
                    label: "openai/v1/images/generations",
                    url: `${baseUrl}/openai/v1/images/generations?api-version=preview`,
                    options: {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "api-key": imageApiKey },
                        body: JSON.stringify(buildGenerationBody(true))
                    }
                })
            ]);

            const imageItem = data.data && data.data[0];
            const imageUrl = getImageUrlFromResponse(data);
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

// ==========================================
// 3. 处理 AI 聊天记录保存和读取的接口 (Cosmos DB)
// ==========================================
app.post('/api/sessions', async (req, res) => {
    try {
        const sessions = Array.isArray(req.body.sessions) ? req.body.sessions : [];
        const { userName } = req.body; 
        if (!userName) return res.json({ success: false, msg: "缺少用户身份" });

        if(process.env.MONGODB_URI) {
            const currentSessionIds = sessions.map(s => s.id);
            const canReplaceSessionList = req.body.clientLoadedAllSessions === true;

            // 【增加安全保护】：只有当前端确实传了有效会话时，才执行差异化删除
            // 防止前端因网络延迟还未拉取到数据时，发生意外的"清库"惨剧
            if (canReplaceSessionList && currentSessionIds.length > 0) {
                await AiSession.deleteMany({ 
                    userName: userName, 
                    sessionId: { $nin: currentSessionIds } 
                });
            } else if (canReplaceSessionList && sessions.length === 0 && req.body.forceDeleteAll === true) {
                // 如果以后需要做"清空所有记录"的功能，可以靠这个显式字段来控制
                await AiSession.deleteMany({ userName: userName });
            }

            // 第三步：再执行原有的循环保存逻辑
            for (const s of sessions) {
                // 处理图片链接（保持你原有的逻辑不变）
                for (const msg of s.messages) {
                    if (msg.mediaHtml && msg.mediaHtml.includes('data:image')) {
                        const matches = msg.mediaHtml.match(/src="(data:image[^"]+)"/g);
                        if (matches) {
                            for (const match of matches) {
                                const b64 = match.replace('src="', '').replace('"', '');
                                const url = await uploadBase64ToBlob(b64);
                                msg.mediaHtml = msg.mediaHtml.replace(b64, url);
                            }
                        }
                    }
                }
                
                // 更新或插入
                await AiSession.findOneAndUpdate(
                    { sessionId: s.id, userName: userName }, 
                    { $set: { sessionId: s.id, userName: userName, data: s } }, 
                    { upsert: true }
                );
            }
        }
        res.json({ success: true });
    } catch (err) { 
        console.error("同步 AI 会话失败:", err);
        res.status(500).json({ error: err.message }); 
    }
});

app.get('/api/sessions', async (req, res) => {
    try {
        if(!process.env.MONGODB_URI) return res.json([]);
        const userName = req.query.userName; 
        const docs = await AiSession.find(userName ? { userName: userName } : {}).lean();
        res.json(docs.map(d => d.data));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ai-agent-file/:containerId/:fileId', async (req, res) => {
    try {
        const filename = getFileNameFromPath(req.query.filename || req.params.fileId, 'agent-output');
        const file = await downloadFoundryAgentFile(req.params.containerId, req.params.fileId);
        res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
        res.send(file.buffer);
    } catch (err) {
        console.error('下载 Foundry Agent 生成文件失败:', err);
        res.status(500).json({ error: err.message || '下载文件失败' });
    }
});

app.get('/api/ai-agent-file/:fileId', async (req, res) => {
    try {
        const filename = getFileNameFromPath(req.query.filename || req.params.fileId, 'agent-output');
        const file = await downloadFoundryAgentFile("", req.params.fileId);
        res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
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
        "Azure OpenAI 聊天 endpoint": !!endpoint ? "✅ 是" : "❌ 否",
        "Azure OpenAI API key": !!apiKey ? "✅ 是" : "❌ 否",
        "Foundry Project Endpoint/Web Search": !!foundryProjectEndpoint ? "✅ 是" : "❌ 否",
        "Foundry Agent 是否启用": shouldUseFoundryAgentForChat([]) ? "✅ 是" : "❌ 否",
        "Foundry Agent 名称": foundryAgentName,
        "Foundry Agent 版本": foundryAgentVersion || "默认最新版",
        "聊天模型部署名": deployment,
        "Foundry 模型部署名": foundryDeployment,
        "图片模型部署名": imageDeployment
    });
});

app.get('/api/test-db', async (req, res) => {
    try {
        const testData = { msgType: 'sys_test', msg: 'Hello Azure Cosmos DB!', time: new Date().toISOString() };
        const created = await WsMessage.create(testData);
        const history = await WsMessage.find().sort({ _id: -1 }).limit(5).lean();
        res.json({ success: true, message: "完美！读写测试全通！", data_written: created, recent_data: history });
    } catch (err) {
        res.json({ success: false, error_message: err.message, stack: err.stack });
    }
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

server.listen(process.env.PORT || 8888, () => { console.log(`✅ TuoTuo 服务器已启动！`); });
