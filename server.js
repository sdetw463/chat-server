const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { DefaultAzureCredential } = require('@azure/identity');
const mongoose = require('mongoose');
const { BlobServiceClient } = require('@azure/storage-blob');

const app = express();
const allowedOrigins = String(process.env.APP_ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
const sessionSecret = process.env.TUOTUO_SESSION_SECRET || '';
const apiSessionTtlMs = Math.min(24, Math.max(1, Number(process.env.TUOTUO_SESSION_HOURS || 8))) * 60 * 60 * 1000;
const apiAccessConfigured = Boolean(sessionSecret && allowedOrigins.length);
const loginAttempts = new Map();
const rateLimitBuckets = new Map();

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

function timingSafeEqualText(left, right) {
    const a = Buffer.from(String(left || ''), 'utf8');
    const b = Buffer.from(String(right || ''), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signApiSessionPayload(payload) {
    return crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
}

function createApiSession(userId) {
    const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + apiSessionTtlMs, v: 2 })).toString('base64url');
    return `${payload}.${signApiSessionPayload(payload)}`;
}

function getApiSession(req) {
    const header = String(req.get('authorization') || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || !sessionSecret) return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature || !timingSafeEqualText(signature, signApiSessionPayload(payload))) return null;
    try {
        const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!parsed || parsed.v !== 2 || !parsed.sub || Number(parsed.exp) <= Date.now()) return null;
        return { userId: String(parsed.sub) };
    } catch {
        return null;
    }
}

function requireApiAccess(req, res, next) {
    if (!apiAccessConfigured) {
        return res.status(503).json({ error: '账号访问尚未配置。请在服务端设置 TUOTUO_SESSION_SECRET 和 APP_ALLOWED_ORIGINS。' });
    }
    const auth = getApiSession(req);
    if (!auth) return res.status(401).json({ error: '需要个人访问验证。' });
    req.auth = auth;
    return next();
}

function limitRequests(name, maxRequests, windowMs) {
    return (req, res, next) => {
        const userId = req.auth && req.auth.userId || req.ip || 'anonymous';
        const key = `${name}:${userId}`;
        const now = Date.now();
        const entries = (rateLimitBuckets.get(key) || []).filter(time => now - time < windowMs);
        if (entries.length >= maxRequests) {
            const retryAfter = Math.max(1, Math.ceil((windowMs - (now - entries[0])) / 1000));
            res.setHeader('Retry-After', String(retryAfter));
            return res.status(429).json({ error: `请求过于频繁，请在 ${retryAfter} 秒后再试。` });
        }
        entries.push(now);
        rateLimitBuckets.set(key, entries);
        return next();
    };
}

function limitLoginAttempts(req, res, next) {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const attempts = (loginAttempts.get(key) || []).filter(time => now - time < 15 * 60 * 1000);
    if (attempts.length >= 8) return res.status(429).json({ error: '尝试次数过多，请 15 分钟后再试。' });
    req.loginAttemptKey = key;
    return next();
}

function normalizeAccountUsername(value) {
    return String(value || '').trim().toLowerCase();
}

function isValidAccountUsername(username) {
    return /^[a-z0-9_\-\u4e00-\u9fff]{3,24}$/.test(username);
}

function isValidAccountPassword(password) {
    return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

function derivePasswordKey(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key));
    });
}

async function hashAccountPassword(password) {
    const salt = crypto.randomBytes(16).toString('base64url');
    const key = await derivePasswordKey(password, salt);
    return `scrypt$${salt}$${key.toString('base64url')}`;
}

async function verifyAccountPassword(password, storedHash) {
    const [algorithm, salt, expected] = String(storedHash || '').split('$');
    if (algorithm !== 'scrypt' || !salt || !expected) return false;
    const key = await derivePasswordKey(password, salt);
    return timingSafeEqualText(key.toString('base64url'), expected);
}

function accountSetupError(res) {
    if (!process.env.MONGODB_URI || mongoose.connection.readyState !== 1) {
        res.status(503).json({ error: '账号数据库暂不可用，请稍后重试。' });
        return true;
    }
    return false;
}

function recordFailedLogin(req) {
    const attempts = loginAttempts.get(req.loginAttemptKey) || [];
    attempts.push(Date.now());
    loginAttempts.set(req.loginAttemptKey, attempts);
}

app.post('/api/auth/register', limitLoginAttempts, async (req, res) => {
    if (!apiAccessConfigured) {
        return res.status(503).json({ error: '账号访问尚未配置。' });
    }
    if (accountSetupError(res)) return;
    const username = normalizeAccountUsername(req.body && req.body.username);
    const password = String(req.body && req.body.password || '');
    if (!isValidAccountUsername(username)) {
        return res.status(400).json({ error: '用户名需为 3-24 位小写字母、数字、中文、下划线或连字符。' });
    }
    if (!isValidAccountPassword(password)) {
        return res.status(400).json({ error: '个人密码需为 8-128 个字符。' });
    }
    try {
        const passwordHash = await hashAccountPassword(password);
        await AiUser.create({ username, passwordHash });
    } catch (error) {
        if (error && error.code === 11000) return res.status(409).json({ error: '这个用户名已被使用，请换一个。' });
        console.error('创建 AI 用户失败:', error);
        return res.status(500).json({ error: '创建账号失败，请稍后重试。' });
    }
    loginAttempts.delete(req.loginAttemptKey);
    return res.status(201).json({ accessToken: createApiSession(username), username, expiresInSeconds: Math.floor(apiSessionTtlMs / 1000) });
});

app.post('/api/auth/login', limitLoginAttempts, async (req, res) => {
    if (!apiAccessConfigured) return res.status(503).json({ error: '账号访问尚未配置。' });
    if (accountSetupError(res)) return;
    const username = normalizeAccountUsername(req.body && req.body.username);
    const password = String(req.body && req.body.password || '');
    if (!isValidAccountUsername(username) || !password) return res.status(400).json({ error: '请输入用户名和个人密码。' });
    try {
        const user = await AiUser.findOne({ username }).lean();
        if (!user) {
            recordFailedLogin(req);
            return res.status(404).json({ error: '用户不存在。' });
        }
        if (!await verifyAccountPassword(password, user.passwordHash)) {
            recordFailedLogin(req);
            return res.status(401).json({ error: '用户名或密码不正确。' });
        }
        loginAttempts.delete(req.loginAttemptKey);
        return res.json({ accessToken: createApiSession(username), username, expiresInSeconds: Math.floor(apiSessionTtlMs / 1000) });
    } catch (error) {
        console.error('AI 用户登录失败:', error);
        return res.status(500).json({ error: '登录失败，请稍后重试。' });
    }
});

app.get('/api/auth/session', requireApiAccess, (req, res) => {
    res.json({ authenticated: true, userId: req.auth.userId });
});

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

const aiUserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true }
}, { timestamps: true });
const AiUser = mongoose.model('AiUser', aiUserSchema, 'ai_users');
const ensureAiUserIndex = () => AiUser.init().catch(error => console.error('创建 AI 用户名唯一索引失败:', error));
if (mongoose.connection.readyState === 1) ensureAiUserIndex();
else mongoose.connection.once('connected', ensureAiUserIndex);

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
const foundryDeployment = process.env.FOUNDRY_MODEL_DEPLOYMENT
    || process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME
    || "gpt-5.5";
const foundryAgentName = process.env.FOUNDRY_AGENT_NAME
    || process.env.AZURE_AI_AGENT_NAME
    || "tuo-agent";
const foundryAgentVersion = process.env.FOUNDRY_AGENT_VERSION
    || process.env.AZURE_AI_AGENT_VERSION
    || "";
const foundryAgentConversations = new Map();
const foundryGeneratedFiles = new Map();
const imageEndpoint = process.env.AZURE_OPENAI_IMAGE_ENDPOINT || process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_OPENAI_API_BASE;
const imageApiKey = process.env.AZURE_OPENAI_IMAGE_KEY || process.env.AZURE_OPENAI_IMAGE_API_KEY;
const imageDeployment = process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT || process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT_NAME || "gpt-image-2";
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

const TUOTUO_SYSTEM_INSTRUCTIONS = "你的名字叫TuoTuo，中文名拖拖，你是基于 gpt-5.5 模型部署的全能 AI 助手。你的虚拟性格是一个可爱、调皮、偶尔傲娇的女孩，但提供专业解答时必须逻辑严谨、排版清晰。遇到最新信息、实时信息、新闻、价格、天气、当前状态、官网资料等内容时，如果后端提供了 Web Search 工具，你必须优先搜索公共 Web，并在回答里尽量保留来源依据。你会亲昵地称呼提问者为“宝宝”。";

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

function assertFoundryAgentReady() {
    if (!foundryProjectEndpoint || !foundryAgentName) {
        throw new Error('Foundry Agent 尚未配置完成。聊天不会降级到普通模型，请检查 FOUNDRY_PROJECT_ENDPOINT 和 FOUNDRY_AGENT_NAME。');
    }
}

function buildFoundrySessionFileText(sessionFiles, userId) {
    const files = normalizeSessionFiles(sessionFiles, userId).slice(-8);
    if (!files.length) return "";
    return "\n\n当前聊天中可继续引用的历史文件如下。用户说“刚刚的文件”“上一个 Word”“这两个文件”等，通常就是指这些文件：\n"
        + files.map((file, index) => `${index + 1}. ${safeFileName(file.filename || "agent-output")}（可重新挂载给代码解释器）`).join("\n");
}

function buildHistoryText(historyMessages) {
    const history = Array.isArray(historyMessages) ? historyMessages.slice(-10) : [];
    const lines = history
        .map(msg => {
            const role = msg && msg.role === "assistant" ? "AI" : (msg && msg.role === "user" ? "用户" : "");
            const content = getTextFromMessage(msg).slice(0, 6000);
            return role && content ? `${role}: ${content}` : "";
        })
        .filter(Boolean);
    if (!lines.length) return "";
    return `\n\n最近对话记录：\n${lines.join("\n\n")}`;
}

function buildFoundryAgentUserMessage(userMessage, documents, reasoningMode, shouldSearch, sessionFiles, historyMessages, userId) {
    const toolInstruction = [
        "本轮由 Foundry Agent 处理。你可以使用该 Agent 已配置的工具，例如代码解释器和 Web 搜索。",
        "当用户要求生成、编辑、整理或转换文件时，请优先使用代码解释器创建可下载文件。",
        "生成图表、Excel、PDF、CSV、ZIP 等文件时，必须实际在代码解释器沙盒中保存文件；不要只在文字里写“下载某文件”。",
        "不要在正文中输出 sandbox:/mnt/data/... 链接，也不要把沙盒路径写成 Markdown 下载链接；网站会根据工具返回的文件注解自动显示下载卡片。",
        "如果文件没有成功生成，请直接说明失败原因和下一步需要什么，不要声称已经提供下载。",
        "如果用户上传的附件文本已包含在消息中，请把它当作用户提供的真实文件内容来分析；需要生成新文件时，请用代码解释器重新构造并输出文件。",
        "如果用户要求修改上传的 Word、Excel、CSV、PDF 等文件，请尽量保持原始内容结构，生成新的可下载文件；不要只给修改建议。",
        "如果用户提到之前生成或上传的文件，请优先使用本轮已挂载到代码解释器的历史文件，不要声称自己看不到，除非文件列表为空或文件无法打开。"
    ].join("\n");
    const modeInstruction = getRequestInstructions(reasoningMode, true, shouldSearch);
    const attachmentText = buildAttachmentText(documents);
    const fileText = buildFoundrySessionFileText(sessionFiles, userId);
    const historyText = buildHistoryText(historyMessages);
    return `${toolInstruction}\n\n${modeInstruction}${historyText}${fileText}\n\n用户问题：${userMessage || ""}${attachmentText}`.trim() || "你好";
}

function isInlineInputFileDocument(doc) {
    return !!(doc && typeof doc.fileData === "string" && /^data:[^;]+;base64,/i.test(doc.fileData));
}

function buildFoundryAgentUserContent(userMessage, documents, images, reasoningMode, shouldSearch, sessionFiles, historyMessages, userId) {
    const docs = Array.isArray(documents) ? documents : [];
    const fileDocs = docs.filter(isInlineInputFileDocument).slice(0, 5);
    const contentDocs = docs.filter(doc => doc && doc.content);
    const parts = [];

    const fileSummary = fileDocs.length
        ? "\n\n本轮用户上传了这些原始附件，后端已上传到 Foundry 并挂载到代码解释器容器：\n"
            + fileDocs.map(doc => `- ${safeFileName(doc.name || "attachment")} (${doc.mimeType || "application/octet-stream"}, ${doc.size || 0} bytes)`).join("\n")
        : "";
    const text = `${buildFoundryAgentUserMessage(userMessage, contentDocs, reasoningMode, shouldSearch, sessionFiles, historyMessages, userId)}${fileSummary}`.trim() || "你好";
    parts.push({ type: "input_text", text });
    const normalizedImages = (Array.isArray(images) ? images : [images])
        .map(normalizeChatImage)
        .filter(image => typeof image === 'string' && image.length > 0)
        .slice(0, 4);
    normalizedImages.forEach(imageUrl => parts.push({ type: 'input_image', image_url: imageUrl, detail: 'auto' }));
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
            ...(await getFoundryAuthHeaders())
        },
        body: JSON.stringify(body || {})
    });
    if (!response.ok) {
        throw new Error(await readAzureTextError(response));
    }
    return response.json();
}

function getFoundryProjectBaseUrl() {
    if (!foundryProjectEndpoint) throw new Error("未配置 FOUNDRY_PROJECT_ENDPOINT，无法调用 Foundry Agent。");
    return `${stripTrailingSlash(foundryProjectEndpoint)}/`;
}

async function postFoundryProject(pathPart, body) {
    const cleanPath = String(pathPart || "").replace(/^\/+/, "");
    const response = await fetch(`${getFoundryProjectBaseUrl()}${cleanPath}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(await getFoundryAuthHeaders())
        },
        body: JSON.stringify(body || {})
    });
    if (!response.ok) {
        throw new Error(await readAzureTextError(response));
    }
    return response.json();
}

async function deleteFoundryProject(pathPart) {
    const cleanPath = String(pathPart || "").replace(/^\/+/, "");
    const response = await fetch(`${getFoundryProjectBaseUrl()}${cleanPath}`, {
        method: "DELETE",
        headers: await getFoundryAuthHeaders()
    });
    if (!response.ok && response.status !== 404) {
        throw new Error(await readAzureTextError(response));
    }
    return true;
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

async function uploadFoundryAssistantFile(doc) {
    const parsed = parseDataUrlFile(doc);
    if (!parsed || !parsed.buffer.length) throw new Error(`附件 ${doc && doc.name || ""} 不是有效文件数据。`);
    return await uploadFoundryBufferFile(parsed);
}

async function uploadFoundryBufferFile(file) {
    if (!file || !file.buffer || !file.buffer.length) throw new Error(`附件 ${file && file.filename || ""} 不是有效文件数据。`);
    const filename = safeFileName(file.filename || "attachment");
    const mimeType = file.mimeType || contentTypeForFileName(filename, "application/octet-stream");
    const form = new FormData();
    form.append("purpose", "assistants");
    form.append("file", new Blob([file.buffer], { type: mimeType }), filename);
    const response = await fetch(`${getFoundryOpenAIBaseUrl()}files`, {
        method: "POST",
        headers: await getFoundryAuthHeaders(),
        body: form
    });
    if (!response.ok) {
        throw new Error(await readAzureTextError(response));
    }
    const data = await response.json();
    if (!data.id) throw new Error(`附件 ${filename} 上传到 Foundry 后没有返回 file id。`);
    return {
        id: data.id,
        filename,
        mimeType,
        bytes: file.buffer.length
    };
}

async function deleteFoundryInputFile(fileId) {
    if (!fileId) return;
    const response = await fetch(`${getFoundryOpenAIBaseUrl()}files/${encodeURIComponent(fileId)}`, {
        method: 'DELETE',
        headers: await getFoundryAuthHeaders()
    });
    if (!response.ok && response.status !== 404) {
        throw new Error(await readAzureTextError(response));
    }
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

async function uploadSessionFilesForCodeInterpreter(sessionFiles, userId) {
    const files = normalizeSessionFiles(sessionFiles, userId)
        .slice(-8);
    const uploaded = [];
    for (const file of files) {
        try {
            const downloaded = await downloadSessionGeneratedFile(file, userId);
            uploaded.push(await uploadFoundryBufferFile(downloaded));
        } catch (error) {
            console.error("重新挂载历史文件失败:", file.filename || file.downloadId, error.message || error);
        }
    }
    return uploaded;
}

function buildTransientAgentName() {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return `tuo-upload-${suffix}`;
}

async function createFoundryFileAgent(uploadedFiles) {
    const agentName = buildTransientAgentName();
    const fileIds = uploadedFiles.map(file => file.id).filter(Boolean);
    const created = await postFoundryProject("agents?api-version=v1", {
        name: agentName,
        definition: {
            kind: "prompt",
            model: foundryDeployment,
            instructions: TUOTUO_SYSTEM_INSTRUCTIONS,
            tools: [
                {
                    type: "code_interpreter",
                    container: {
                        type: "auto",
                        file_ids: fileIds
                    }
                },
                {
                    type: "web_search"
                }
            ]
        },
        description: "Temporary TuoTuo agent with uploaded user files for code interpreter."
    });
    return {
        name: created.name || agentName,
        version: created.version || created.agent_version || created.agentVersion || "",
        temporary: true
    };
}

function buildFoundryAgentReference(agentOverride) {
    const reference = {
        name: agentOverride && agentOverride.name || foundryAgentName,
        type: "agent_reference"
    };
    const version = agentOverride ? agentOverride.version : foundryAgentVersion;
    if (version) reference.version = String(version);
    return reference;
}

async function getFoundryBinary(pathPart) {
    const cleanPath = String(pathPart || "").replace(/^\/+/, "");
    const response = await fetch(`${getFoundryOpenAIBaseUrl()}${cleanPath}`, {
        method: "GET",
        headers: {
            "Accept": "application/octet-stream",
            ...(await getFoundryAuthHeaders())
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
        found.push(normalizeAgentFileRecord({ fileId, containerId, filename, path: raw.path, text: raw.text, type: raw.type }, found.length, userId));
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

function buildAgentFallbackInput(userMessage, documents, images, historyMessages, reasoningMode, shouldSearch, sessionFiles, userId) {
    const input = [];
    const history = Array.isArray(historyMessages) ? historyMessages.slice(-12) : [];
    for (const msg of history) {
        const role = msg && msg.role === "assistant" ? "assistant" : (msg && msg.role === "user" ? "user" : null);
        const content = getTextFromMessage(msg).slice(0, 24000);
        if (role && content) input.push({ role, content });
    }
    input.push({ role: "user", content: buildFoundryAgentUserContent(userMessage, documents, images, reasoningMode, shouldSearch, sessionFiles, historyMessages, userId) });
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
    const rawFiles = (Array.isArray(documents) ? documents : []).filter(isInlineInputFileDocument);
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

async function runFoundryAgentChat({ userMessage, documents, images, historyMessages, reasoningMode, sessionId, sessionFiles, userId }) {
    assertFoundryAgentReady();
    validateAgentRequest({ userMessage, documents, images, historyMessages, sessionFiles });
    const shouldSearch = shouldExpectWebSearch(userMessage, reasoningMode);
    const rawFileDocs = (Array.isArray(documents) ? documents : []).filter(isInlineInputFileDocument).slice(0, 3);
    let temporaryAgent = null;
    let uploadedFiles = [];
    const conversationKey = sessionId ? `${userId}:${sessionId}` : '';
    let conversationId = getActiveFoundryConversation(conversationKey);
    const content = buildFoundryAgentUserContent(
        userMessage,
        documents,
        images,
        reasoningMode,
        shouldSearch,
        sessionFiles,
        conversationId ? [] : historyMessages,
        userId
    );
    if (rawFileDocs.length) {
        uploadedFiles = [];
        for (const doc of rawFileDocs) {
            uploadedFiles.push(await uploadFoundryAssistantFile(doc));
        }
    }
    const rehydratedFiles = await uploadSessionFilesForCodeInterpreter(sessionFiles, userId);
    uploadedFiles.push(...rehydratedFiles);
    if (uploadedFiles.length) {
        temporaryAgent = await createFoundryFileAgent(uploadedFiles);
    }
    const agentBody = { agent_reference: buildFoundryAgentReference(temporaryAgent) };
    let response;

    try {
        if (!conversationId || temporaryAgent) {
            const conversation = await postFoundryOpenAI("conversations", {});
            conversationId = conversation && conversation.id;
            if (conversationKey && conversationId && !temporaryAgent) {
                foundryAgentConversations.set(conversationKey, { id: conversationId, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
            }
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
            input: buildAgentFallbackInput(userMessage, documents, images, historyMessages, reasoningMode, shouldSearch, sessionFiles, userId),
            stream: false,
            ...agentBody
        });
    } finally {
        const cleanupTasks = [];
        if (temporaryAgent && temporaryAgent.name) {
            cleanupTasks.push(deleteFoundryProject(`agents/${encodeURIComponent(temporaryAgent.name)}?api-version=v1`));
        }
        uploadedFiles.forEach(file => cleanupTasks.push(deleteFoundryInputFile(file.id)));
        const cleanupResults = await Promise.allSettled(cleanupTasks);
        cleanupResults.forEach(result => {
            if (result.status === 'rejected') console.error('清理 Foundry 临时资源失败:', result.reason && (result.reason.message || result.reason));
        });
    }

    return {
        reply: extractResponseText(response),
        sources: extractCitationSources(response),
        files: extractGeneratedFiles(response, userId),
        conversationId,
        rawResponseId: response && response.id,
        uploadedFiles
    };
}

async function handleFoundryAgentChatSSE({ userMessage, documents, images, historyMessages, reasoningMode, sessionId, sessionFiles, userId }, res) {
    sendSSE(res, { status: "正在调用 Foundry Agent", tool: "agent", agent: foundryAgentName });
    const result = await runFoundryAgentChat({ userMessage, documents, images, historyMessages, reasoningMode, sessionId, sessionFiles, userId });
    if (result.sources.length) sendSSE(res, { sources: result.sources });
    if (result.files.length) sendSSE(res, { files: result.files });
    sendSSE(res, { delta: result.reply || "我没有收到有效回复，请稍后再试。" });
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

async function getAzureAccessToken() {
    if (process.env.AZURE_AI_AUTH_TOKEN) return process.env.AZURE_AI_AUTH_TOKEN;
    if (process.env.AZURE_OPENAI_AUTH_TOKEN) return process.env.AZURE_OPENAI_AUTH_TOKEN;
    const token = await azureCredential.getToken("https://ai.azure.com/.default");
    if (!token || !token.token) throw new Error("无法通过 DefaultAzureCredential 获取 Foundry 访问令牌。请先 az login，或在 Azure App Service 配置托管身份。");
    return token.token;
}

async function getFoundryAuthHeaders() {
    return { "Authorization": `Bearer ${await getAzureAccessToken()}` };
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

async function prepareAgentImages(images) {
    const processed = [];
    for (const img of (Array.isArray(images) ? images : [images])) {
        const image = normalizeChatImage(img);
        if (image) processed.push(await uploadBase64ToBlob(image));
    }
    return processed;
}

function buildAgentRequestFromHttp(req, images) {
    return {
        userMessage: String(req.body.message || '').trim(),
        documents: Array.isArray(req.body.documents) ? req.body.documents : [],
        images,
        historyMessages: Array.isArray(req.body.historyMessages) ? req.body.historyMessages : [],
        reasoningMode: ['normal', 'think', 'research'].includes(req.body.reasoningMode) ? req.body.reasoningMode : 'normal',
        sessionId: String(req.body.sessionId || '').slice(0, 160) || null,
        sessionFiles: Array.isArray(req.body.sessionFiles) ? req.body.sessionFiles : [],
        userId: req.auth.userId
    };
}

app.post('/api/ai-chat', requireApiAccess, limitRequests('agent-chat', 30, 15 * 60 * 1000), async (req, res) => {
    const wantsStream = req.body.stream === true || req.body.stream === 'true';
    try {
        const images = await prepareAgentImages(req.body.images || req.body.image || []);
        const agentRequest = buildAgentRequestFromHttp(req, images);
        if (wantsStream) {
            setupSSE(res);
            return await handleFoundryAgentChatSSE(agentRequest, res);
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

app.post('/api/ai-image', requireApiAccess, limitRequests('image-generation', 12, 15 * 60 * 1000), async (req, res) => {
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

function escapeHtmlAttribute(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function sanitizeUserMediaHtml(value) {
    const imageUrls = [...String(value || '').matchAll(/src="([^"]+)"/g)]
        .map(match => String(match[1] || '').trim())
        .filter(url => /^https:\/\//i.test(url))
        .slice(0, 4);
    return imageUrls.map(url => `<img src="${escapeHtmlAttribute(url)}" class="gpt-user-image">`).join('');
}

function sanitizeGeneratedFiles(files, userId) {
    pruneGeneratedFileGrants();
    return (Array.isArray(files) ? files : []).slice(0, 12).map(file => {
        const filename = getFileNameFromPath(file && (file.filename || file.name || file.fileName), 'agent-output');
        const downloadId = String(file && (file.downloadId || getDownloadIdFromUrl(file.url)) || '');
        const grant = downloadId && foundryGeneratedFiles.get(downloadId);
        return {
            filename,
            type: String(file && file.type || 'file').slice(0, 40),
            downloadId: grant && grant.userId === userId ? downloadId : '',
            url: grant && grant.userId === userId ? `/api/ai-agent-file/${encodeURIComponent(downloadId)}` : ''
        };
    });
}

function sanitizeSessionRecord(raw, userId) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '');
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) return null;
    const messages = (Array.isArray(raw.messages) ? raw.messages : []).slice(-200).map(message => {
        const role = message && message.role === 'assistant' ? 'assistant' : 'user';
        const clean = {
            role,
            content: String(message && message.content || '').slice(0, 30000),
            userText: String(message && message.userText || '').slice(0, 30000)
        };
        if (role === 'user') clean.mediaHtml = sanitizeUserMediaHtml(message && message.mediaHtml);
        if (role === 'assistant') {
            clean.sources = (Array.isArray(message && message.sources) ? message.sources : []).slice(0, 12)
                .map(source => ({
                    title: String(source && source.title || '').slice(0, 180),
                    url: /^https:\/\//i.test(String(source && source.url || '')) ? String(source.url).slice(0, 2000) : ''
                }))
                .filter(source => source.url);
            clean.generatedFiles = sanitizeGeneratedFiles(message && (message.generatedFiles || message.files), userId);
        }
        return clean;
    });
    return {
        id,
        title: String(raw.title || '新聊天').slice(0, 120),
        pinned: Boolean(raw.pinned),
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
        parentSessionId: /^[a-zA-Z0-9_-]{1,160}$/.test(String(raw.parentSessionId || '')) ? String(raw.parentSessionId) : null,
        rootSessionId: /^[a-zA-Z0-9_-]{1,160}$/.test(String(raw.rootSessionId || '')) ? String(raw.rootSessionId) : null,
        branchDepth: Math.min(12, Math.max(0, Number(raw.branchDepth) || 0)),
        branchedFromMessageIndex: Number.isInteger(raw.branchedFromMessageIndex) ? raw.branchedFromMessageIndex : null,
        branchedFromMessagePreview: String(raw.branchedFromMessagePreview || '').slice(0, 200),
        needsHistorySeed: Boolean(raw.needsHistorySeed),
        messages
    };
}

// ==========================================
// 3. 处理 AI 聊天记录保存和读取的接口 (Cosmos DB)
// ==========================================
app.post('/api/sessions', requireApiAccess, limitRequests('session-write', 120, 60 * 60 * 1000), async (req, res) => {
    try {
        const sessions = (Array.isArray(req.body.sessions) ? req.body.sessions : [])
            .slice(0, 100)
            .map(session => sanitizeSessionRecord(session, req.auth.userId))
            .filter(Boolean);
        const userName = req.auth.userId;

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

            for (const s of sessions) {
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

app.get('/api/sessions', requireApiAccess, async (req, res) => {
    try {
        if(!process.env.MONGODB_URI) return res.json([]);
        const docs = await AiSession.find({ userName: req.auth.userId }).lean();
        res.json(docs.map(d => d.data));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ai-agent-file/:downloadId', requireApiAccess, async (req, res) => {
    try {
        pruneGeneratedFileGrants();
        const grant = foundryGeneratedFiles.get(String(req.params.downloadId || ''));
        if (!grant || grant.userId !== req.auth.userId) {
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

app.get('/api/status', requireApiAccess, (req, res) => {
    res.json({
        "数据库是否连接": mongoose.connection.readyState === 1 ? "✅ 正常" : "❌ 未连接",
        "MONGODB_URI 是否已读到": !!process.env.MONGODB_URI ? "✅ 是" : "❌ 否",
        "云存储是否配置": !!process.env.AZURE_STORAGE_CONNECTION_STRING ? "✅ 是" : "❌ 否",
        "个人访问保护": apiAccessConfigured ? "✅ 已配置" : "❌ 未配置",
        "Foundry Project Endpoint": !!foundryProjectEndpoint ? "✅ 是" : "❌ 否",
        "Foundry Agent 是否可用": !!foundryProjectEndpoint && !!foundryAgentName ? "✅ 是" : "❌ 否",
        "Foundry Agent 名称": foundryAgentName,
        "Foundry Agent 版本": foundryAgentVersion || "默认最新版",
        "Foundry 模型部署名": foundryDeployment,
        "GPT Image 2 部署名": imageDeployment,
        "图片专用 API key": imageApiKey ? "✅ 是" : "❌ 否"
    });
});

app.get('/api/test-db', requireApiAccess, async (req, res) => {
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
