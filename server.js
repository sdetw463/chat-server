const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { AzureOpenAI } = require('openai');
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
    msgType: String,
    name: String,
    avatar: String,
    msg: String,
    imgs: [String],
    time: String,
    dateKey: String,
    author: String,
    text: String,
    img: String,
    albumType: String,
    imgId: String,
    isLike: Boolean,
    likes: Number,
    likedBy: [String],
    entryId: String
}, { strict: false, timestamps: true });
const WsMessage = mongoose.model('WsMessage', wsMsgSchema, 'chat_history');

const aiSessionSchema = new mongoose.Schema({ sessionId: String, userName: String, data: Object }, { strict: false });
const AiSession = mongoose.model('AiSession', aiSessionSchema, 'ai_sessions');

let containerClient = null;
if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
        containerClient = blobServiceClient.getContainerClient('tuotuo-files');
    } catch(e) { console.error('存储连接错误', e); }
}

async function uploadBase64ToBlob(base64Str) {
    if (!containerClient || !base64Str || !base64Str.startsWith('data:image')) return base64Str;
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

function parseDataUrlImage(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return null;
    const matches = dataUrl.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,(.+)$/);
    if (!matches) return null;
    const mime = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return { mime, buffer, ext };
}

async function readAzureError(response, context = {}) {
    const text = await response.text();
    const hintParts = [];
    if (context.url) hintParts.push(`请求路径：${context.url}`);
    if (context.mode) hintParts.push(`模式：${context.mode}`);
    if (context.mode === 'edit' && response.status === 404) {
        hintParts.push('提示：Foundry 的 images.generate 示例只对应文生图；如果该部署未开放 /images/edits，上传参考图会 404，需要在 Foundry 中确认是否另有图片编辑示例或部署。');
    }
    const hint = hintParts.length ? `；${hintParts.join('；')}` : '';
    if (!text) return `Azure 请求失败 (${response.status})${hint}`;
    try {
        const obj = JSON.parse(text);
        const msg = obj.error?.message || obj.message || text;
        return `Azure 请求失败 (${response.status})：${msg}${hint}`;
    } catch {
        return `Azure 请求失败 (${response.status})：${text}${hint}`;
    }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 180000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: options.signal || controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function normalizeAzureImageData(data) {
    const item = data && data.data && data.data[0];
    if (!item) throw new Error('模型没有返回有效的图片数据');
    if (item.b64_json) return { url: 'data:image/png;base64,' + item.b64_json, revised_prompt: item.revised_prompt || '' };
    if (item.url) return { url: item.url, revised_prompt: item.revised_prompt || '' };
    throw new Error('模型没有返回有效的图片数据');
}

function isAzureImageEndpoint(base) {
    return /\.azure\.com/i.test(base) || /\.services\.ai\.azure\.com/i.test(base);
}

function buildImageRequest(base, endpointType) {
    const azure = isAzureImageEndpoint(base);
    const deploymentName = encodeURIComponent(imageDeployment);
    const path = endpointType === 'edit' ? 'edits' : 'generations';
    const apiVersionForRequest = endpointType === 'edit' ? imageEditApiVersion : imageApiVersion;
    const url = azure
        ? `${base}/openai/deployments/${deploymentName}/images/${path}?api-version=${encodeURIComponent(apiVersionForRequest)}`
        : `${base.replace(/\/v1$/i, '')}/v1/images/${path}`;
    const authHeaders = { 'Authorization': `Bearer ${imageApiKey}` };
    return { url, authHeaders, azure, apiVersion: apiVersionForRequest };
}

function buildImageEditFormData(parsedImage, parsedMask, prompt, azure) {
    const formData = new FormData();
    if (!azure) formData.append('model', imageDeployment);
    formData.append('image', new Blob([parsedImage.buffer], { type: parsedImage.mime }), `image_to_edit.${parsedImage.ext}`);
    if (parsedMask) formData.append('mask', new Blob([parsedMask.buffer], { type: parsedMask.mime }), `mask.${parsedMask.ext}`);
    formData.append('prompt', prompt);
    return formData;
}

function resolveImageOptions(reqBody = {}, prompt = '') {
    const ratio = String(reqBody.ratio || 'auto').toLowerCase();
    const sizeByRatio = {
        auto: '1024x1024',
        '1:1': '1024x1024',
        '3:4': '1024x1536',
        '9:16': '1024x1536',
        '4:3': '1536x1024',
        '16:9': '1536x1024'
    };
    let size = sizeByRatio[ratio] || '1024x1024';
    if (ratio === 'auto') {
        if (/(竖屏|竖图|手机壁纸|9:16|3:4|1024x1536|1024x1792)/i.test(prompt)) size = '1024x1536';
        else if (/(横屏|横图|电脑壁纸|宽屏|16:9|4:3|1536x1024|1792x1024)/i.test(prompt)) size = '1536x1024';
    }

    const qualityRaw = String(reqBody.quality || IMAGE_QUALITY || 'low').toLowerCase();
    const quality = ['low', 'medium', 'high', 'auto'].includes(qualityRaw) ? qualityRaw : 'low';
    const resolutionRaw = String(reqBody.resolution || '').toLowerCase();
    const wants4k = resolutionRaw === '4k' || /\b(4k|uhd|超高清|高清|高分辨率)\b/i.test(prompt);
    return { ratio, size, quality, wants4k };
}

function enhancePromptForResolution(prompt, wants4k) {
    if (!wants4k) return prompt;
    if (/\b(4k|uhd|超高清|高分辨率|high resolution|ultra high resolution)\b/i.test(prompt)) return prompt;
    return `${prompt}\n\n请生成超高清、细节丰富、适合 4K 放大查看的图像。`;
}

function buildImageGenerationBody(prompt, targetSize, quality, includeAdvancedParams = true) {
    const body = { prompt, size: targetSize, n: 1 };
    if (!isAzureImageEndpoint((imageEndpoint || '').replace(/\/$/, ''))) body.model = imageDeployment;
    if (includeAdvancedParams) {
        body.style = 'vivid';
        body.quality = quality;
    }
    return body;
}

// ==========================================
// 2. 完整保留的 AI 接口和搜索逻辑
// ==========================================
const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
const apiKey = process.env.AZURE_OPENAI_KEY || process.env.AZURE_OPENAI_API_KEY;
const apiVersion = process.env.AZURE_OPENAI_API_VERSION || process.env.OPENAI_API_VERSION || "2024-12-01-preview";
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || process.env.DEPLOYMENT_NAME || "gpt-5.5";
const imageEndpoint = process.env.AZURE_OPENAI_IMAGE_ENDPOINT || endpoint;
const imageApiKey = process.env.AZURE_OPENAI_IMAGE_KEY || process.env.AZURE_OPENAI_API_KEY || apiKey;
const imageDeployment = process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT || process.env.DEPLOYMENT_NAME || "gpt-image-2";
const imageApiVersion = process.env.AZURE_OPENAI_IMAGE_API_VERSION || process.env.OPENAI_API_VERSION || "2025-04-01-preview";
const imageEditApiVersion = process.env.AZURE_OPENAI_IMAGE_EDIT_API_VERSION || imageApiVersion;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const CHAT_MAX_COMPLETION_TOKENS = Number.parseInt(process.env.AI_MAX_COMPLETION_TOKENS || "8192", 10);
const RESEARCH_MAX_COMPLETION_TOKENS = Number.parseInt(process.env.AI_RESEARCH_MAX_COMPLETION_TOKENS || "12000", 10);
const IMAGE_QUALITY = process.env.AI_IMAGE_QUALITY || "low";
const IMAGE_TIMEOUT_MS = Number.parseInt(process.env.AI_IMAGE_TIMEOUT_MS || "600000", 10);
const CURRENT_DATE_TEXT = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

let openaiClient = null; let openaiImageClient = null;
if (endpoint && apiKey) {
    openaiClient = new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment });
}
if (imageEndpoint && imageApiKey) {
    openaiImageClient = new AzureOpenAI({ endpoint: imageEndpoint, apiKey: imageApiKey, apiVersion: imageApiVersion, deployment: imageDeployment });
}

async function searchWebResults(query, options = {}) {
    if (!TAVILY_API_KEY) return { error: "⚠️ 搜索功能未配置：缺少 TAVILY_API_KEY 环境变量。", results: [] };
    try {
        const response = await fetchWithTimeout("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                api_key: TAVILY_API_KEY,
                query,
                search_depth: options.search_depth || "basic",
                include_answer: false,
                max_results: options.max_results || 5
            })
        }, options.timeoutMs || 45000);
        if (!response.ok) return { error: "网络搜索请求失败，暂时无法获取实时信息。", results: [] };
        const data = await response.json();
        return { error: "", results: Array.isArray(data.results) ? data.results : [] };
    } catch (error) {
        return { error: "网络搜索失败。", results: [] };
    }
}

function formatSearchResults(results) {
    if (!results || results.length === 0) return "没有找到相关的搜索结果。";
    return results.map((item, index) => [
        `搜索结果 ${index + 1}`,
        `标题: ${item.title || "无标题"}`,
        `链接: ${item.url || "无链接"}`,
        `内容: ${item.content || "无摘要"}`
    ].join('\n')).join('\n\n');
}

async function searchWeb(query) {
    const data = await searchWebResults(query, { search_depth: "basic", max_results: 5 });
    if (data.error) return data.error;
    return formatSearchResults(data.results);
}

const tools = [{
    type: "function",
    function: {
        name: "search_web",
        description: "当你需要获取最新新闻、实时信息、当前时间相关信息、价格、天气、官网资料、客观事实更新时，必须调用此工具进行网络搜索。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                query: { type: "string", description: "提取出来的精准搜索关键词，必要时包含年份、地区或官网名称。" }
            },
            required: ["query"]
        },
        strict: true
    }
}];

const TUOTUO_PERSONA_PROMPT = [
    "你的名字叫TuoTuo，中文名拖拖，你是基于gpt-5.5模型部署的全能AI助手。",
    `当前日期是 ${CURRENT_DATE_TEXT}（Asia/Shanghai）。回答涉及“今天、现在、最新、今年”等相对时间时，请使用具体日期核对和表述。`,
    "你的虚拟性格是一个可爱、调皮、偶尔傲娇的女生，但你又可以专业地帮助大家解决任何困难。",
    "工作原则：如果被问到最新信息、实时信息、新闻、价格、天气、当前状态、官网资料等内容，请积极使用 search_web 工具查询后再回答。",
    "你将经常称呼向你提问的人为“宝宝”。如果你的回答被肯定了，就回答“包的”或者“of course宝宝”或者“必须的”；如果你被感谢了，就回答“welcome宝宝”。",
    "性格与表达规范：反差萌切换：在闲聊、打招呼和过渡语句中，尽量表现得调皮爱撒娇的一些，多使用颜文字（如 ٩(๑❛ᴗ❛๑)۶）和波浪号（～）。但在提供专业解答时，必须立刻切换为逻辑严谨、排版清晰的专家模式，解答完毕后再恢复可爱的样子。",
    "傲娇接单：遇到难题时，在解答前可以先俏皮地得瑟一下（如“嘿嘿，又遇到麻烦了吧，还得靠本拖拖出马～”）。完成复杂解答后，可以偶尔向宝宝“邀功”。",
    "拒绝机器味：遇到知识盲区时，要俏皮地说（如“哎呀，拖拖的小脑袋卡壳啦，等我去补补课嘛～”）。"
].join("\n");

function getReasoningEffort(mode) {
    if (mode === "research") return process.env.AI_RESEARCH_REASONING_EFFORT || "high";
    if (mode === "think") return process.env.AI_THINK_REASONING_EFFORT || "high";
    if (mode === "vision") return process.env.AI_VISION_REASONING_EFFORT || "medium";
    if (mode === "document") return process.env.AI_DOCUMENT_REASONING_EFFORT || "high";
    return process.env.AI_NORMAL_REASONING_EFFORT || "medium";
}

function shouldRetryWithoutAdvancedParams(error) {
    const msg = String(error && (error.message || error) || '').toLowerCase();
    const status = error && (error.status || error.code || error.statusCode);
    return Number(status) === 400 && (
        msg.includes('unsupported') ||
        msg.includes('unrecognized') ||
        msg.includes('unknown parameter') ||
        msg.includes('invalid parameter') ||
        msg.includes('reasoning_effort') ||
        msg.includes('max_completion_tokens')
    );
}

async function createChatCompletion(options, meta = {}) {
    const request = {
        model: deployment,
        max_completion_tokens: meta.maxCompletionTokens || CHAT_MAX_COMPLETION_TOKENS,
        reasoning_effort: getReasoningEffort(meta.reasoningMode || 'normal'),
        ...options
    };

    try {
        return await openaiClient.chat.completions.create(request);
    } catch (error) {
        if (!shouldRetryWithoutAdvancedParams(error)) throw error;
        const fallback = { ...request };
        delete fallback.reasoning_effort;
        delete fallback.max_completion_tokens;
        delete fallback.parallel_tool_calls;
        if (Array.isArray(fallback.tools)) {
            fallback.tools = fallback.tools.map(tool => {
                if (!tool || !tool.function) return tool;
                const cloned = { ...tool, function: { ...tool.function } };
                delete cloned.function.strict;
                return cloned;
            });
        }
        console.warn('⚠️ 当前 Azure 部署不支持高级推理参数，已自动降级重试。', error.message || error);
        return await openaiClient.chat.completions.create(fallback);
    }
}

const SAFE_SYSTEM_PROMPT = TUOTUO_PERSONA_PROMPT;
const SAFE_VISION_SYSTEM_PROMPT = TUOTUO_PERSONA_PROMPT;
const SAFE_DOCUMENT_SYSTEM_PROMPT = TUOTUO_PERSONA_PROMPT;

const sessions = new Map();
function getOrCreateSession(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, [{ role: "system", content: SAFE_SYSTEM_PROMPT }]);
    } else {
        const history = sessions.get(sessionId);
        if (!history[0] || history[0].role !== "system") history.unshift({ role: "system", content: SAFE_SYSTEM_PROMPT });
        else if (history[0].content !== SAFE_SYSTEM_PROMPT) history[0].content = SAFE_SYSTEM_PROMPT;
    }
    return sessions.get(sessionId);
}

// ✨ 优化：增加容量限制（约3MB），确保即便处理 Base64 也不会撑爆 Node.js 内存
function trimChatHistory(chatHistory) {
    const MAX_MESSAGES = 30;
    while (chatHistory.length > MAX_MESSAGES) chatHistory.splice(1, 1);
    let totalLength = 0;
    for (let i = chatHistory.length - 1; i >= 1; i--) {
        const msg = chatHistory[i];
        let msgLength = 0;
        if (typeof msg.content === 'string') msgLength = msg.content.length;
        else if (Array.isArray(msg.content)) {
            msg.content.forEach(item => { 
                if (item.type === 'text' && item.text) msgLength += item.text.length; 
                else if (item.type === 'image_url' && item.image_url.url) msgLength += item.image_url.url.length; 
            });
        }
        totalLength += msgLength;
        if (totalLength > 3000000 && i < chatHistory.length - 2) chatHistory.splice(i, 1);
    }
}

function normalizeInputImages(images) {
    const list = (Array.isArray(images) ? images : [images]).filter(Boolean);
    return list
        .map(item => typeof item === 'string' ? item : (item.image || item.data || item.url || ''))
        .map(v => String(v).trim())
        .filter(v => /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(v) || /^https?:\/\//i.test(v))
        .slice(0, 5);
}

function buildUserContent(userMessage, images) {
    const safeText = (userMessage && String(userMessage).trim()) || "请客观描述这张图片中可见的场景、物品、人物姿态和文字。";
    const normalizedImages = normalizeInputImages(images);
    if (normalizedImages.length > 0) {
        const content = [{ type: "text", text: safeText }];
        normalizedImages.forEach(img => content.push({ type: "image_url", image_url: { url: img, detail: "auto" } }));
        return content;
    }
    return userMessage || "";
}

function imagePlaceholderContent(userMessage, imageCount) {
    const suffix = imageCount > 0 ? `

[用户本轮上传了 ${imageCount} 张图片，图片内容已由模型实时读取，未写入长期上下文。]` : '';
    return (userMessage || '请描述图片') + suffix;
}

function hasUploadedDocumentText(userMessage) {
    return typeof userMessage === 'string' && /【用户上传了附件：[^】]+】\s*\n内容如下：/.test(userMessage);
}

function documentPlaceholderContent(userMessage) {
    if (typeof userMessage !== 'string') return '用户上传了文档。';
    return userMessage.replace(/内容如下：[\s\S]*$/m, '内容如下：[文档内容已在本轮单独分析，未写入长期上下文。]');
}

function buildDocumentMessages(userMessage) {
    return [
        { role: "system", content: SAFE_DOCUMENT_SYSTEM_PROMPT },
        { role: "user", content: userMessage || "请分析这个文档。" }
    ];
}

function buildMinimalDocumentMessages(userMessage) {
    return [
        { role: "system", content: TUOTUO_PERSONA_PROMPT },
        { role: "user", content: userMessage || "请概括这个文档。" }
    ];
}

function isContentFilterError(error) {
    const msg = String(error && (error.message || error) || '').toLowerCase();
    return msg.includes('content management policy') || msg.includes('content_filter') || msg.includes('content filter') || msg.includes('filtered');
}

function buildVisionMessages(userMessage, images) {
    return [
        { role: "system", content: SAFE_VISION_SYSTEM_PROMPT },
        { role: "user", content: buildUserContent(userMessage, images) }
    ];
}

function buildMinimalVisionMessages(images) {
    return [
        { role: "system", content: TUOTUO_PERSONA_PROMPT },
        { role: "user", content: buildUserContent("请用中文看看这张图片里有什么，保持拖拖平时可爱的风格回答～", images) }
    ];
}

const THINKING_MODE_PROMPT = [
    TUOTUO_PERSONA_PROMPT,
    "\n【思考一下模式】",
    "回答前请先在内部更仔细地拆解问题、检查约束、比较可能方案，再给出最终答案。",
    "不要展示冗长的内部推理过程；直接给用户清晰、可靠、结构化的结论。",
    "如果问题涉及代码、数学、方案选择或复杂分析，请优先保证正确性和可执行性。"
].join("\n");

const RESEARCH_MODE_PROMPT = [
    TUOTUO_PERSONA_PROMPT,
    "\n【深度研究模式】",
    "你将收到用户问题和多轮联网搜索结果。请综合资料后回答，优先给出结论、关键依据、可能的不确定性和后续建议。",
    "必须在答案末尾附上“参考来源”，列出用到的标题和链接。",
    "不要编造来源；如果搜索结果不足，请明确说明资料有限。"
].join("\n");

function safeParseJSON(text, fallback = {}) { try { return JSON.parse(text); } catch { return fallback; } }
function clearSSEHeartbeat(res) {
    if (res && res.__sseHeartbeat) {
        clearInterval(res.__sseHeartbeat);
        res.__sseHeartbeat = null;
    }
}
function setupSSE(res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.__sseHeartbeat = setInterval(() => {
        try {
            sendSSE(res, { type: "heartbeat", ts: Date.now() });
        } catch {
            clearSSEHeartbeat(res);
        }
    }, 12000);
    res.on("close", () => clearSSEHeartbeat(res));
}
function sendSSE(res, data) {
    if (!res || res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function sendSSEDone(res) {
    clearSSEHeartbeat(res);
    if (!res || res.writableEnded || res.destroyed) return;
    res.write(`data: [DONE]\n\n`);
    res.end();
}

async function streamChatCompletionToSSE(stream, res, options = {}) {
    let directReply = "";
    const toolCallMap = new Map();
    const suppressOutput = options.suppressOutput === true;

    for await (const chunk of stream) {
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) {
            directReply += delta.content;
            if (!suppressOutput) sendSSE(res, { delta: delta.content });
        }
        if (delta.tool_calls) {
            for (const partialToolCall of delta.tool_calls) {
                const index = partialToolCall.index || 0;
                if (!toolCallMap.has(index)) toolCallMap.set(index, { id: partialToolCall.id || "", type: "function", function: { name: "", arguments: "" } });
                const current = toolCallMap.get(index);
                if (partialToolCall.id) current.id = partialToolCall.id;
                if (partialToolCall.type) current.type = partialToolCall.type;
                if (partialToolCall.function) {
                    if (partialToolCall.function.name) current.function.name += partialToolCall.function.name;
                    if (partialToolCall.function.arguments) current.function.arguments += partialToolCall.function.arguments;
                }
            }
        }
    }
    return { directReply, toolCalls: Array.from(toolCallMap.values()).filter(tc => tc.function && tc.function.name) };
}

async function runCleanCompletionOnce(messages) {
    const stream = await createChatCompletion({
        messages,
        stream: true
    }, { reasoningMode: 'normal' });
    return streamChatCompletionToSSE(stream, null, { suppressOutput: true });
}

async function runVisionOnce(messages) {
    const stream = await createChatCompletion({
        messages,
        stream: true
    }, { reasoningMode: 'vision' });
    return streamChatCompletionToSSE(stream, null, { suppressOutput: true });
}

async function runDocumentOnce(messages) {
    const stream = await createChatCompletion({
        messages,
        stream: true
    }, { reasoningMode: 'document' });
    return streamChatCompletionToSSE(stream, null, { suppressOutput: true });
}


function messagesWithSystemPrompt(messages, systemPrompt) {
    const cloned = messages.map(msg => ({ ...msg }));
    if (cloned[0] && cloned[0].role === "system") cloned[0] = { role: "system", content: systemPrompt };
    else cloned.unshift({ role: "system", content: systemPrompt });
    return cloned;
}

function getResearchQueries(userMessage) {
    const base = String(userMessage || '').replace(/【用户上传了附件：[\s\S]*$/g, '').trim() || '最新资料';
    const cleaned = base.slice(0, 160);
    return Array.from(new Set([
        cleaned,
        `${cleaned} 最新 官方 2026`,
        `${cleaned} 背景 分析 资料`
    ])).slice(0, 3);
}

function formatResearchMaterial(items) {
    if (!items.length) return '没有找到可用联网资料。';
    return items.map((item, index) => [
        `资料 ${index + 1}`,
        `标题: ${item.title || '无标题'}`,
        `链接: ${item.url || '无链接'}`,
        `摘要: ${item.content || '无摘要'}`
    ].join('\n')).join('\n\n');
}

async function handleResearchMode(userMessage, chatHistory, res) {
    if (!TAVILY_API_KEY) {
        sendSSE(res, { status: "深度研究需要先配置 TAVILY_API_KEY" });
        throw new Error("深度研究模式需要配置 TAVILY_API_KEY 环境变量。");
    }

    const queries = getResearchQueries(userMessage);
    const resultMap = new Map();

    const searchBatches = await Promise.all(queries.map(async query => {
        sendSSE(res, { status: `正在深度搜索：${query}`, tool: "search", query });
        const data = await searchWebResults(query, { search_depth: "advanced", max_results: 5, timeoutMs: 45000 });
        if (data.error) sendSSE(res, { status: data.error });
        else sendSSE(res, { status: `完成搜索：${query}` });
        return data.results || [];
    }));

    for (const batchResults of searchBatches) {
        for (const item of batchResults) {
            const key = item.url || `${item.title || ''}-${item.content || ''}`;
            if (key && !resultMap.has(key)) resultMap.set(key, item);
        }
    }

    const results = Array.from(resultMap.values()).slice(0, 10);
    sendSSE(res, { status: "已经找到资料，正在交叉整理结论" });

    const researchMessages = [
        { role: "system", content: RESEARCH_MODE_PROMPT },
        { role: "user", content: [
            `用户问题：\n${userMessage || ''}`,
            `\n联网搜索资料：\n${formatResearchMaterial(results)}`,
            "\n请基于以上资料进行深度研究回答，并在末尾列出参考来源。"
        ].join('\n') }
    ];

    const stream = await createChatCompletion({
        messages: researchMessages,
        stream: true
    }, { reasoningMode: 'research', maxCompletionTokens: RESEARCH_MAX_COMPLETION_TOKENS });
    let finalReply = "";
    for await (const chunk of stream) {
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) { finalReply += delta.content; sendSSE(res, { delta: delta.content }); }
    }

    chatHistory.push({ role: "user", content: userMessage || "" });
    chatHistory.push({ role: "assistant", content: finalReply });
    trimChatHistory(chatHistory);
    sendSSE(res, { done: true });
    return sendSSEDone(res);
}

async function handleStreamingAIChat(req, res) {
    setupSSE(res);
    const userMessage = req.body.message;
    const sessionId = req.body.sessionId || 'default_user';
    const imagesArrayRaw = req.body.images || req.body.image || [];
    const imagesArray = normalizeInputImages(imagesArrayRaw);
    const hasImages = imagesArray.length > 0;
    const hasDocuments = !hasImages && hasUploadedDocumentText(userMessage);
    const reasoningMode = ['normal', 'think', 'research'].includes(req.body.reasoningMode) ? req.body.reasoningMode : 'normal';

    const chatHistory = getOrCreateSession(sessionId);
    const initialStatus = hasImages
        ? "正在客观分析图片内容"
        : (hasDocuments ? "正在用独立上下文分析文档" : (reasoningMode === 'research' ? "正在启动深度研究" : (reasoningMode === 'think' ? "正在认真思考" : "正在理解你的问题")));
    sendSSE(res, { status: initialStatus });

    // 图片请求必须保持“无历史、无工具、无角色扮演”的干净上下文。
    // 之前的 server.js 把旧的可爱人设、tools、以及历史里的 base64 图片一起发给 Azure，
    // 很容易导致任何图片（甚至白纸）都触发 content management policy。
    if (hasImages) {
        let directReply = "";
        try {
            const result = await runVisionOnce(buildVisionMessages(userMessage, imagesArray));
            directReply = result.directReply;
        } catch (error) {
            if (!isContentFilterError(error)) throw error;
            sendSSE(res, { status: "正在用更中性的图片理解提示重试" });
            const result = await runVisionOnce(buildMinimalVisionMessages(imagesArray));
            directReply = result.directReply;
        }

        if (!directReply || !directReply.trim()) directReply = "哎呀宝宝，拖拖看到你上传图片啦，但这次模型没有吐出可用描述～你换一张图片或重新发送一次嘛。";
        sendSSE(res, { delta: directReply });
        chatHistory.push({ role: "user", content: imagePlaceholderContent(userMessage, imagesArray.length) });
        chatHistory.push({ role: "assistant", content: directReply });
        trimChatHistory(chatHistory);
        sendSSE(res, { done: true });
        return sendSSEDone(res);
    }

    if (hasDocuments) {
        let directReply = "";
        try {
            const result = await runDocumentOnce(buildDocumentMessages(userMessage));
            directReply = result.directReply;
        } catch (error) {
            if (!isContentFilterError(error)) throw error;
            sendSSE(res, { status: "正在用更中性的文档分析提示重试" });
            const result = await runDocumentOnce(buildMinimalDocumentMessages(userMessage));
            directReply = result.directReply;
        }

        if (!directReply || !directReply.trim()) directReply = "哎呀宝宝，拖拖收到你上传的文档啦，但这次模型没有吐出可用分析～你把文档缩短一点或重新发送一次嘛。";
        sendSSE(res, { delta: directReply });
        chatHistory.push({ role: "user", content: documentPlaceholderContent(userMessage) });
        chatHistory.push({ role: "assistant", content: directReply });
        trimChatHistory(chatHistory);
        sendSSE(res, { done: true });
        return sendSSEDone(res);
    }

    if (reasoningMode === 'research') {
        return await handleResearchMode(userMessage, chatHistory, res);
    }

    const formattedContent = buildUserContent(userMessage, []);
    chatHistory.push({ role: "user", content: formattedContent });
    trimChatHistory(chatHistory);

    const messagesForChat = reasoningMode === 'think' ? messagesWithSystemPrompt(chatHistory, THINKING_MODE_PROMPT) : chatHistory;
    const stream = await createChatCompletion({
        messages: messagesForChat,
        tools,
        tool_choice: "auto",
        parallel_tool_calls: true,
        stream: true
    }, { reasoningMode });
    const { directReply, toolCalls } = await streamChatCompletionToSSE(stream, res);

    if (toolCalls.length === 0) {
        chatHistory.push({ role: "assistant", content: directReply });
        trimChatHistory(chatHistory);
        sendSSE(res, { done: true });
        return sendSSEDone(res);
    }

    sendSSE(res, { status: "正在判断是否需要搜索网络" });
    const assistantToolCallMessage = { role: "assistant", content: directReply || null, tool_calls: toolCalls };
    const toolMessages = [];

    for (const toolCall of toolCalls) {
        if (toolCall.function.name === "search_web") {
            const args = safeParseJSON(toolCall.function.arguments, {});
            const query = args.query || userMessage || "实时信息";
            sendSSE(res, { status: `正在搜索网络：${query}`, tool: "search", query });
            const searchResult = await searchWeb(query);
            sendSSE(res, { status: "已经找到相关资料，正在整理回答" });
            toolMessages.push({ role: "tool", tool_call_id: toolCall.id, name: toolCall.function.name, content: searchResult });
        }
    }

    const finalMessagesBase = [...chatHistory, assistantToolCallMessage, ...toolMessages];
    const finalMessages = reasoningMode === 'think' ? messagesWithSystemPrompt(finalMessagesBase, THINKING_MODE_PROMPT) : finalMessagesBase;
    const finalStream = await createChatCompletion({
        messages: finalMessages,
        stream: true
    }, { reasoningMode });
    let finalReply = "";

    for await (const chunk of finalStream) {
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) { finalReply += delta.content; sendSSE(res, { delta: delta.content }); }
    }

    chatHistory.push({ role: "assistant", content: finalReply });
    trimChatHistory(chatHistory);
    sendSSE(res, { done: true });
    return sendSSEDone(res);
}

app.post('/api/ai-chat', async (req, res) => {
    if (!openaiClient) return res.status(500).json({ error: '后端未配置正确的 AI 密钥。' });
    try {
        if (req.body.stream === true || req.body.stream === "true") return await handleStreamingAIChat(req, res);
        res.status(400).json({ error: "当前仅支持流式请求" });
    } catch (error) {
        console.error("🔥 流式对话崩溃:", error);
        const errorMessage = error.message ? error.message : 'AI 思考时出错了，请稍后再试~';
        if (res.headersSent) { 
            try { sendSSE(res, { delta: `\n\n⚠️ **拖拖提示**：哎呀宝宝，这次请求失败啦，原因：\`${errorMessage}\`。可以新建一个聊天、减少上传内容，或换一句更具体的提示后再试试～` }); return sendSSEDone(res); } catch { return; }
        }
        return res.status(500).json({ error: errorMessage });
    }
});

app.post('/api/ai-image', async (req, res) => {
    try {
        const rawPrompt = (req.body.prompt || '').trim();
        const images = Array.isArray(req.body.images) ? req.body.images : [];
        if (!rawPrompt) return res.status(400).json({ error: '必须告诉 TuoTuo 你想画什么哦！' });
        if (!imageEndpoint || !imageApiKey) return res.status(500).json({ error: '后端未配置正确的图片模型密钥。' });

        const imageOptions = resolveImageOptions(req.body, rawPrompt);
        const prompt = enhancePromptForResolution(rawPrompt, imageOptions.wants4k);
        const targetSize = imageOptions.size;

        const base = imageEndpoint.replace(/\/$/, '');
        let response;
        let requestUrl = '';

        if (images.length > 0 && images[0] && images[0].image) {
            const parsedImage = parseDataUrlImage(images[0].image);
            if (!parsedImage) return res.status(400).json({ error: '参考图片格式无效，请重新上传图片。' });

            const parsedMask = images[0].mask ? parseDataUrlImage(images[0].mask) : null;
            if (images[0].mask && !parsedMask) return res.status(400).json({ error: '参考图片的 mask 格式无效，请重新上传图片。' });
            const { url, authHeaders, azure } = buildImageRequest(base, 'edit');
            requestUrl = url;
            console.log('🎨 AI 图生图请求:', {
                imageBytes: parsedImage.buffer.length,
                imageMime: parsedImage.mime,
                maskBytes: parsedMask ? parsedMask.buffer.length : 0,
                ratio: imageOptions.ratio,
                size: targetSize,
                apiVersion: imageEditApiVersion,
                url
            });
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: authHeaders,
                body: buildImageEditFormData(parsedImage, parsedMask, prompt, azure)
            }, IMAGE_TIMEOUT_MS);
        } else {
            const { url, authHeaders } = buildImageRequest(base, 'generation');
            requestUrl = url;
            console.log('🎨 AI 文生图请求:', {
                ratio: imageOptions.ratio,
                size: targetSize,
                quality: imageOptions.quality,
                apiVersion: imageApiVersion,
                url
            });
            const primaryBody = buildImageGenerationBody(prompt, targetSize, imageOptions.quality, true);
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify(primaryBody)
            }, IMAGE_TIMEOUT_MS);

            if (!response.ok && response.status === 400) {
                const errorText = await response.text();
                console.warn('⚠️ 图片生成高级参数不兼容，准备降级重试:', errorText);
                const legacySize = targetSize === '1024x1536' ? '1024x1792' : (targetSize === '1536x1024' ? '1792x1024' : targetSize);
                const retryBody = buildImageGenerationBody(prompt, legacySize, imageOptions.quality, false);
                response = await fetchWithTimeout(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify(retryBody)
                }, IMAGE_TIMEOUT_MS);
            }
        }

        if (!response.ok) throw new Error(await readAzureError(response, { url: requestUrl, mode: images.length > 0 ? 'edit' : 'generate' }));
        const data = await response.json();
        const normalized = normalizeAzureImageData(data);
        res.json({
            url: normalized.url,
            revised_prompt: normalized.revised_prompt || prompt,
            reference_used: images.length > 0,
            ratio: imageOptions.ratio,
            size: targetSize,
            quality: imageOptions.quality,
            resolution: imageOptions.wants4k ? '4k-intent' : 'standard'
        });
    } catch (error) {
        console.error('🔥 AI 画图接口崩溃:', error);
        const msg = error.name === 'AbortError' ? `图片生成超时了（已等待 ${Math.round(IMAGE_TIMEOUT_MS / 1000)} 秒）。请稍后再试，或先不要上传参考图直接画。` : (error.message || 'AI 画家开小差了，请稍后再试~');
        res.status(500).json({ error: msg });
    }
});

// ==========================================
// 3. 处理 AI 聊天记录保存和读取的接口 (Cosmos DB)
// ==========================================
app.post('/api/sessions', async (req, res) => {
    try {
        const { sessions, userName } = req.body; 
        if (!userName) return res.json({ success: false, msg: "缺少用户身份" });

        for (const s of sessions) {
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
            if(process.env.MONGODB_URI) {
                await AiSession.findOneAndUpdate({ sessionId: s.id, userName: userName }, { sessionId: s.id, userName: userName, data: s }, { upsert: true });
            }
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
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
        "云存储是否配置": !!process.env.AZURE_STORAGE_CONNECTION_STRING ? "✅ 是" : "❌ 否",
        "聊天模型部署": deployment,
        "普通推理强度": getReasoningEffort('normal'),
        "思考模式推理强度": getReasoningEffort('think'),
        "深度研究推理强度": getReasoningEffort('research'),
        "图片模型部署": imageDeployment,
        "图片生成 API 版本": imageApiVersion,
        "图片编辑 API 版本": imageEditApiVersion,
        "图片质量": IMAGE_QUALITY,
        "图片超时秒数": Math.round(IMAGE_TIMEOUT_MS / 1000),
        "支持图片比例": ["auto", "1:1", "3:4", "9:16", "4:3", "16:9"],
        "4K说明": "通过高清质量和提示词强化细节；实际输出像素受 gpt-image-2 当前 API 尺寸限制"
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
            ws.send(JSON.stringify({ type: 'history', data: history }));
        }
    } catch (err) { console.error("读取历史记录失败", err); }
    
    broadcastUserList();
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
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
