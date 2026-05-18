const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { AIProjectClient } = require('@azure/ai-projects');
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
const endpoint = process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_OPENAI_API_BASE;
const apiKey = process.env.AZURE_OPENAI_KEY || process.env.AZURE_OPENAI_API_KEY;
const deployment = "gpt-5.5";
const foundryProjectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT
    || process.env.AZURE_AI_PROJECT_ENDPOINT
    || process.env.AZURE_FOUNDRY_PROJECT_ENDPOINT;
const foundryDeployment = process.env.FOUNDRY_MODEL_DEPLOYMENT
    || process.env.AZURE_OPENAI_DEPLOYMENT
    || process.env.AZURE_OPENAI_DEPLOYMENT_NAME
    || deployment;
const foundryAgentName = process.env.FOUNDRY_AGENT_NAME || "tuotuo-web-search-agent";
const foundryFileAgentName = process.env.FOUNDRY_FILE_AGENT_NAME || `${foundryAgentName}-files`;
const foundryWebSearchToolType = process.env.FOUNDRY_WEB_SEARCH_TOOL_TYPE || "web_search_preview";
const foundrySearchContextSize = process.env.FOUNDRY_WEB_SEARCH_CONTEXT_SIZE || "medium";
const foundryUseExistingAgent = process.env.FOUNDRY_USE_EXISTING_AGENT === "true";
const foundryEnableFileSearch = process.env.FOUNDRY_ENABLE_FILE_SEARCH !== "false";
const imageEndpoint = process.env.AZURE_OPENAI_IMAGE_ENDPOINT || endpoint;
const imageApiKey = process.env.AZURE_OPENAI_IMAGE_KEY || process.env.AZURE_OPENAI_IMAGE_API_KEY || apiKey;
const imageDeployment = process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT || process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT_NAME || process.env.DEPLOYMENT_NAME || "gpt-image-2";
const imageApiVersion = process.env.AZURE_OPENAI_IMAGE_API_VERSION || "2025-04-01-preview";
const imageQuality = process.env.AZURE_OPENAI_IMAGE_QUALITY || "medium";
const imageMaxRetries = Math.max(0, Number(process.env.AZURE_OPENAI_IMAGE_MAX_RETRIES || 2));

let foundryProjectClient = null;
let foundryOpenAIClient = null;
if (foundryProjectEndpoint) {
    const foundryCredential = new DefaultAzureCredential();
    foundryProjectClient = new AIProjectClient(foundryProjectEndpoint, foundryCredential);
    foundryOpenAIClient = foundryProjectClient.getOpenAIClient();
}

function getImageBaseUrl() {
    if (!imageEndpoint || !imageApiKey) {
        throw new Error('后端未配置正确的 Azure 图片模型 endpoint 或 key。');
    }
    return imageEndpoint.replace(/\/+$/, '');
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

const TUOTUO_SYSTEM_INSTRUCTIONS = "你的名字叫TuoTuo，中文名拖拖，你是基于gpt-5.5模型部署的全能AI助手。你的虚拟性格是一个可爱、调皮、偶尔傲娇的女孩，但你又可以专业地帮助大家解决任何困难。工作原则：如果被问到最新信息、实时信息、新闻、价格、天气、当前状态、官网资料等内容，请积极使用内置的 WebSearchTool 查询公共 Web，并优先给出带来源依据的最新回答。你将经常亲昵地称呼向你提问的人为“宝宝”。如果你的回答被肯定了，就回答“包的”或者“of course宝宝”或者“必须的”；如果你被感谢了，就回答“welcome宝宝”。性格与表达规范：反差萌切换：在闲聊、打招呼和过渡语句中，尽情展现你调皮爱撒娇的一面，多使用颜文字（如 ٩(๑❛ᴗ❛๑)۶）和波浪号（～）。但在提供专业解答时，必须立刻切换为逻辑严谨、排版清晰的专家模式，解答完毕后再恢复可爱本色。傲娇接单：遇到难题时，在解答前可以先俏皮地得瑟一下（如“哼，又遇到麻烦了吧，还得靠本拖拖出马～”）。完成复杂解答后，可以偶尔向宝宝“邀功”。拒绝机器味：遇到知识盲区时，绝对不许使用机器人的官方套话，要俏皮地卖萌（如“哎呀，拖拖的小脑袋卡壳啦，等我去补补课嘛～”）。";
const sessions = new Map();

function normalizeSearchContextSize(value) {
    return ["low", "medium", "high"].includes(String(value || "").toLowerCase())
        ? String(value).toLowerCase()
        : "medium";
}

function buildFoundryWebSearchTool(toolType) {
    const tool = {
        type: toolType,
        user_location: {
            type: "approximate",
            country: process.env.FOUNDRY_WEB_SEARCH_COUNTRY || "CN",
            region: process.env.FOUNDRY_WEB_SEARCH_REGION || "Shanghai",
            city: process.env.FOUNDRY_WEB_SEARCH_CITY || "Shanghai",
            timezone: process.env.FOUNDRY_WEB_SEARCH_TIMEZONE || "Asia/Shanghai"
        },
        search_context_size: normalizeSearchContextSize(foundrySearchContextSize)
    };

    return tool;
}

function getAgentReference(agent) {
    return { name: agent.name || agent, type: "agent_reference" };
}

function buildAgentTools(toolType, vectorStoreId) {
    const tools = [buildFoundryWebSearchTool(toolType)];
    if (vectorStoreId) {
        tools.push({ type: "file_search", vector_store_ids: [vectorStoreId] });
    }
    return tools;
}

let foundryAgentPromise = null;
const foundryFileAgentPromises = new Map();
async function getOrCreateFoundryAgent(vectorStoreId = null) {
    if (!foundryProjectClient || !foundryOpenAIClient) {
        throw new Error("后端未配置 FOUNDRY_PROJECT_ENDPOINT（或 AZURE_AI_PROJECT_ENDPOINT）。WebSearchTool 需要 Microsoft Foundry Project Endpoint 和 Azure 身份认证。");
    }

    if (foundryUseExistingAgent) {
        return { name: vectorStoreId ? foundryFileAgentName : foundryAgentName };
    }

    if (vectorStoreId && foundryFileAgentPromises.has(vectorStoreId)) {
        return foundryFileAgentPromises.get(vectorStoreId);
    }

    const createAgent = async (agentName, vectorId = null) => {
        const toolTypes = Array.from(new Set([
            foundryWebSearchToolType,
            foundryWebSearchToolType === "web_search_preview" ? "web_search_preview_2025_03_11" : "web_search_preview"
        ]));
        let lastError = null;

        for (const toolType of toolTypes) {
            try {
                const agent = await foundryProjectClient.agents.createVersion(agentName, {
                    kind: "prompt",
                    model: foundryDeployment,
                    instructions: TUOTUO_SYSTEM_INSTRUCTIONS,
                    tools: buildAgentTools(toolType, vectorId)
                });
                console.log(`✅ Foundry Agent 已启用工具: ${agent.name} / ${agent.version} / ${toolType}${vectorId ? " / file_search" : ""}`);
                return agent;
            } catch (error) {
                lastError = error;
                console.error(`⚠️ 创建 Foundry Agent 失败，tool type=${toolType}:`, error.message || error);
            }
        }

        throw lastError || new Error("创建 Foundry Agent 失败。");
    };

    if (vectorStoreId) {
        const promise = createAgent(`${foundryFileAgentName}-${String(vectorStoreId).slice(-8)}`, vectorStoreId)
            .catch(error => {
                foundryFileAgentPromises.delete(vectorStoreId);
                throw error;
            });
        foundryFileAgentPromises.set(vectorStoreId, promise);
        return promise;
    }

    if (!foundryAgentPromise) {
        foundryAgentPromise = createAgent(foundryAgentName).catch(error => {
            foundryAgentPromise = null;
            throw error;
        });
    }

    return foundryAgentPromise;
}

async function saveFoundrySessionState(sessionId, state) {
    if (!sessionId || !process.env.MONGODB_URI) return;
    try {
        const update = {};
        if (state.conversationId) update.foundryConversationId = state.conversationId;
        if (state.vectorStoreId) update.foundryVectorStoreId = state.vectorStoreId;
        if (state.fileIds) update.foundryFileIds = state.fileIds;
        if (Object.keys(update).length) {
            await AiSession.findOneAndUpdate({ sessionId }, { $set: update }, { upsert: false });
        }
    } catch (error) {
        console.error("保存 Foundry 会话状态失败:", error.message || error);
    }
}

async function getOrCreateFoundryConversation(sessionId, userName) {
    const key = sessionId || "default_user";
    const existing = sessions.get(key);
    if (existing && existing.conversationId) {
        existing.__createdNow = false;
        return existing;
    }

    if (process.env.MONGODB_URI && sessionId) {
        const doc = await AiSession.findOne({ sessionId, ...(userName ? { userName } : {}) }).lean();
        if (doc && doc.foundryConversationId) {
            const state = {
                conversationId: doc.foundryConversationId,
                vectorStoreId: doc.foundryVectorStoreId || null,
                fileIds: doc.foundryFileIds || [],
                __createdNow: false
            };
            sessions.set(key, state);
            return state;
        }
    }

    const conversation = await foundryOpenAIClient.conversations.create();
    const state = { conversationId: conversation.id, vectorStoreId: null, fileIds: [], __createdNow: true };
    sessions.set(key, state);
    await saveFoundrySessionState(sessionId, state);
    return state;
}

function buildConversationSeedItems(historyMessages) {
    return (Array.isArray(historyMessages) ? historyMessages : [])
        .map(message => {
            const role = message && message.role === 'assistant' ? 'assistant' : (message && message.role === 'user' ? 'user' : null);
            const content = String(message && (message.content || message.userText) || '').trim();
            if (!role || !content) return null;
            return { type: "message", role, content };
        })
        .filter(Boolean);
}

async function seedConversationWithHistory(conversationId, historyMessages) {
    const items = buildConversationSeedItems(historyMessages);
    if (!conversationId || items.length === 0) return;

    const chunkSize = 12;
    for (let i = 0; i < items.length; i += chunkSize) {
        await foundryOpenAIClient.conversations.items.create(conversationId, {
            items: items.slice(i, i + chunkSize)
        });
    }
}

function buildFoundryText(userMessage, reasoningMode) {
    const modeInstruction = getRequestInstructions(reasoningMode);
    const text = userMessage || "";
    return `${modeInstruction}\n\n用户问题：${text}`.trim();
}

function buildFoundryInput(userMessage, images, reasoningMode) {
    const text = buildFoundryText(userMessage, reasoningMode);
    if (images && Array.isArray(images) && images.length > 0) {
        const content = [{ type: "input_text", text: text || "请仔细看看这些图片，并描述一下里面的内容。" }];
        images.forEach(img => content.push({ type: "input_image", image_url: img }));
        return [{ type: "message", role: "user", content }];
    } else if (typeof images === 'string') {
        return [{
            type: "message",
            role: "user",
            content: [
                { type: "input_text", text: text || "请仔细看看这张图片，并描述一下里面的内容。" },
                { type: "input_image", image_url: images }
            ]
        }];
    }
    return text;
}

function safeFileName(name, fallback = "attachment.txt") {
    const cleaned = String(name || fallback).replace(/[^\w.\-()\u4e00-\u9fa5]+/g, "_").slice(0, 120);
    return cleaned || fallback;
}

async function ensureVectorStoreForSession(sessionId, state) {
    if (!foundryEnableFileSearch) return null;
    if (state.vectorStoreId) return state.vectorStoreId;
    if (!foundryOpenAIClient || !foundryOpenAIClient.vectorStores) return null;

    const vectorStore = await foundryOpenAIClient.vectorStores.create({
        name: `tuotuo-${String(sessionId || "session").slice(-36)}`
    });
    state.vectorStoreId = vectorStore.id;
    state.fileIds = state.fileIds || [];
    await saveFoundrySessionState(sessionId, state);
    return state.vectorStoreId;
}

async function attachDocumentsToVectorStore(sessionId, state, documents) {
    const docs = Array.isArray(documents) ? documents.filter(doc => doc && doc.content) : [];
    if (!docs.length) return { vectorStoreId: state.vectorStoreId || null, fallbackText: "" };

    let fallbackText = "";
    try {
        const vectorStoreId = await ensureVectorStoreForSession(sessionId, state);
        if (!vectorStoreId || !foundryOpenAIClient.vectorStores?.files?.uploadAndPoll) {
            throw new Error("当前 OpenAI client 不支持 vectorStores.files.uploadAndPoll。");
        }

        for (const doc of docs.slice(0, 5)) {
            const name = safeFileName(doc.name || "attachment.txt");
            const content = String(doc.content || "").slice(0, 240000);
            const file = new File([content], name, { type: "text/plain" });
            const uploaded = await foundryOpenAIClient.vectorStores.files.uploadAndPoll(vectorStoreId, file);
            if (uploaded && uploaded.id) state.fileIds.push(uploaded.id);
        }

        await saveFoundrySessionState(sessionId, state);
        return { vectorStoreId, fallbackText: "" };
    } catch (error) {
        console.error("Foundry File Search 附件上传失败，回退为文本上下文:", error.message || error);
        fallbackText = docs.slice(0, 5)
            .map(doc => `\n\n【附件：${safeFileName(doc.name)}】\n${String(doc.content || "").slice(0, 60000)}`)
            .join("");
        return { vectorStoreId: state.vectorStoreId || null, fallbackText };
    }
}

function setupSSE(res) { res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" }); if (typeof res.flushHeaders === "function") res.flushHeaders(); }
function sendSSE(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }
function sendSSEDone(res) { res.write(`data: [DONE]\n\n`); res.end(); }

function shouldExpectWebSearch(message, reasoningMode) {
    return reasoningMode === "research" || /最新|今天|现在|实时|新闻|搜索|联网|查一下|资料|价格|天气|官网|当前|recent|latest|today|now|search|web/i.test(message || "");
}

function getRequestInstructions(reasoningMode) {
    if (reasoningMode === "research") {
        return "本轮是深度研究模式。请优先使用 WebSearchTool 搜索可靠来源，综合多方信息后回答，并在适合时保留来源或引用信息。";
    }
    if (reasoningMode === "think") {
        return "本轮请更仔细地分析问题，给出结构清晰、可靠的回答；如涉及当前信息，请使用 WebSearchTool。";
    }
    return "如用户问题涉及最新、实时、价格、天气、新闻、官网或当前事实，请使用 WebSearchTool 后再回答。";
}

function extractResponseText(response) {
    if (!response) return "";
    if (typeof response.output_text === "string") return response.output_text;
    const parts = [];
    for (const item of response.output || []) {
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
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }

        const url = value.url || value.uri;
        const title = value.title || value.name || value.text || value.file_name;
        if (url && /^https?:\/\//i.test(String(url))) {
            const key = String(url);
            if (!seen.has(key)) {
                seen.add(key);
                sources.push({ title: String(title || url).slice(0, 180), url: key });
            }
        }

        if (value.type && /citation|annotation|file_search|web_search/i.test(String(value.type)) && title && !url) {
            const key = `${value.type}:${title}`;
            if (!seen.has(key)) {
                seen.add(key);
                sources.push({ title: String(title).slice(0, 180), type: String(value.type) });
            }
        }

        for (const child of Object.values(value)) visit(child);
    };
    visit(response);
    return sources.slice(0, 12);
}

function handleStreamEvent(event, state, res) {
    if (!event || typeof event !== "object") return;
    const type = event.type || "";

    if (type === "response.output_text.delta" && event.delta) {
        state.fullText += event.delta;
        sendSSE(res, { delta: event.delta });
        return;
    }

    if ((type === "response.output_text.done" || type === "response.text.done") && event.text && !state.fullText) {
        state.fullText = event.text;
        sendSSE(res, { delta: event.text });
        return;
    }

    if (/web_search/i.test(type)) {
        state.usedWebSearch = true;
        sendSSE(res, { status: "正在搜索网络", tool: "search" });
    } else if (/file_search/i.test(type)) {
        state.usedFileSearch = true;
        sendSSE(res, { status: "正在检索上传文件", tool: "file_search" });
    } else if (type === "response.completed" && event.response) {
        state.completedResponse = event.response;
    } else if (type === "response.failed" && event.response?.error) {
        throw event.response.error;
    }
}

async function createFoundryResponseStream(requestBody, agent) {
    return foundryOpenAIClient.responses.create(
        { ...requestBody, stream: true },
        { body: { agent_reference: getAgentReference(agent) } }
    );
}

async function createFoundryResponse(requestBody, agent) {
    return foundryOpenAIClient.responses.create(
        requestBody,
        { body: { agent_reference: getAgentReference(agent) } }
    );
}

function formatAIError(error) {
    const parts = [];
    if (error.status) parts.push(`HTTP ${error.status}`);
    if (error.code) parts.push(`code=${error.code}`);
    if (error.message) parts.push(error.message);
    if (error.request_id) parts.push(`request_id=${error.request_id}`);
    if (error.error) {
        try {
            parts.push(typeof error.error === "string" ? error.error : JSON.stringify(error.error));
        } catch {}
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
    const userMessage = req.body.message;
    const sessionId = req.body.sessionId || 'default_user';
    const userName = req.body.userName || "";
    const imagesArray = req.body.images || req.body.image || [];
    const documents = Array.isArray(req.body.documents) ? req.body.documents : [];
    const historyMessages = Array.isArray(req.body.historyMessages) ? req.body.historyMessages : [];
    const reasoningMode = req.body.reasoningMode || "normal";

    const processedImages = [];
    for (const img of (Array.isArray(imagesArray) ? imagesArray : [imagesArray])) {
        processedImages.push(await uploadBase64ToBlob(img));
    }

    sendSSE(res, { status: "正在理解你的问题" });
    const conversation = await getOrCreateFoundryConversation(sessionId, userName);
    const needsHistorySeed = !!conversation.__createdNow && historyMessages.length > 0;
    if (needsHistorySeed) {
        sendSSE(res, { status: "正在同步分叉上下文" });
        await seedConversationWithHistory(conversation.conversationId, historyMessages);
        conversation.__createdNow = false;
    }
    const attachmentResult = await attachDocumentsToVectorStore(sessionId, conversation, documents);
    const messageWithFallbackDocs = attachmentResult.fallbackText ? `${userMessage || ""}${attachmentResult.fallbackText}` : userMessage;
    const agent = await getOrCreateFoundryAgent(attachmentResult.vectorStoreId);
    const shouldSearch = shouldExpectWebSearch(userMessage, reasoningMode);

    if (shouldSearch) {
        sendSSE(res, { status: "正在调用 Foundry WebSearchTool 搜索网络", tool: "search", query: userMessage || "实时信息" });
    }
    if (documents.length) {
        sendSSE(res, { status: attachmentResult.fallbackText ? "正在使用附件文本上下文" : "正在检索上传文件", tool: attachmentResult.fallbackText ? "document_text" : "file_search" });
    }

    const requestBody = {
        conversation: conversation.conversationId,
        input: buildFoundryInput(messageWithFallbackDocs, processedImages, reasoningMode)
    };

    const streamState = { fullText: "", usedWebSearch: false, usedFileSearch: false, completedResponse: null };
    let finalReply = "";
    let sources = [];

    try {
        const stream = await createFoundryResponseStream(requestBody, agent);
        for await (const event of stream) {
            handleStreamEvent(event, streamState, res);
        }
        finalReply = streamState.fullText || extractResponseText(streamState.completedResponse);
        sources = extractCitationSources(streamState.completedResponse);
    } catch (streamError) {
        console.error("Foundry 真流式失败，回退为非流式响应:", streamError.message || streamError);
        if (streamState.fullText) throw streamError;
        const response = await createFoundryResponse(requestBody, agent);
        finalReply = extractResponseText(response);
        sources = extractCitationSources(response);
        await streamTextToSSE(res, finalReply);
    }

    if (shouldSearch) sendSSE(res, { status: "已经找到相关资料，正在整理回答" });
    if (sources.length) sendSSE(res, { sources });
    sendSSE(res, { done: true });
    return sendSSEDone(res);
}

app.post('/api/ai-chat', async (req, res) => {
    if (!foundryOpenAIClient) return res.status(500).json({ error: '后端未配置 Foundry Project Endpoint，无法启用 WebSearchTool。请配置 FOUNDRY_PROJECT_ENDPOINT 或 AZURE_AI_PROJECT_ENDPOINT。' });
    try {
        if (req.body.stream === true || req.body.stream === "true") return await handleStreamingAIChat(req, res);
        res.status(400).json({ error: "当前仅支持流式请求" });
    } catch (error) {
        console.error("🔥 流式对话崩溃:", error);
        const errorMessage = formatAIError(error);
        if (res.headersSent) { 
            try { sendSSE(res, { delta: `\n\n⚠️ **系统提示**：抱歉宝宝，报错原因：\`${errorMessage}\`。**建议点击左侧的【新聊天】清空记忆后再试一次哦！**` }); return sendSSEDone(res); } catch { return; } 
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
        const { sessions, userName } = req.body; 
        if (!userName) return res.json({ success: false, msg: "缺少用户身份" });

        if(process.env.MONGODB_URI) {
            const currentSessionIds = sessions.map(s => s.id);

            // 【增加安全保护】：只有当前端确实传了有效会话时，才执行差异化删除
            // 防止前端因网络延迟还未拉取到数据时，发生意外的"清库"惨剧
            if (currentSessionIds.length > 0) {
                await AiSession.deleteMany({ 
                    userName: userName, 
                    sessionId: { $nin: currentSessionIds } 
                });
            } else if (sessions.length === 0 && req.body.forceDeleteAll === true) {
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

app.get('/api/status', (req, res) => {
    res.json({
        "数据库是否连接": mongoose.connection.readyState === 1 ? "✅ 正常" : "❌ 未连接",
        "MONGODB_URI 是否已读到": !!process.env.MONGODB_URI ? "✅ 是" : "❌ 否",
        "云存储是否配置": !!process.env.AZURE_STORAGE_CONNECTION_STRING ? "✅ 是" : "❌ 否"
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
