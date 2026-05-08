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
    msgType: String, name: String, avatar: String, msg: String, imgs: [String],
    time: String, dateKey: String, author: String, text: String, img: String,
    albumType: String, imgId: String, isLike: Boolean, likes: Number,
    likedBy: [String], entryId: String
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

// ==========================================
// 2. AI 接口和搜索逻辑
// ==========================================
const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
const apiKey = process.env.AZURE_OPENAI_KEY;
const apiVersion = "2024-12-01-preview";
const deployment = "gpt-5.5";
const imageEndpoint = process.env.AZURE_OPENAI_IMAGE_ENDPOINT || endpoint;
const imageApiKey = process.env.AZURE_OPENAI_IMAGE_KEY || apiKey;
const imageDeployment = process.env.DEPLOYMENT_NAME || "gpt-image-2"; 
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

let openaiClient = null; 
if (endpoint && apiKey) {
    openaiClient = new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment });
}

async function searchWeb(query) {
    if (!TAVILY_API_KEY) return "⚠️ 搜索功能未配置：缺少 TAVILY_API_KEY 环境变量。";
    try {
        const response = await fetch("https://api.tavily.com/search", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: TAVILY_API_KEY, query, search_depth: "basic", include_answer: false, max_results: 5 })
        });
        if (!response.ok) return "网络搜索请求失败，暂时无法获取实时信息。";
        const data = await response.json();
        if (data.results && data.results.length > 0) {
            return data.results.map((item, index) => [`搜索结果 ${index + 1}`, `标题: ${item.title || "无标题"}`, `链接: ${item.url || "无链接"}`, `内容: ${item.content || "无摘要"}`].join('\n')).join('\n\n');
        }
        return "没有找到相关的搜索结果。";
    } catch (error) { return "网络搜索失败。"; }
}

const tools = [{ type: "function", function: { name: "search_web", description: "当你需要获取最新新闻、实时信息、当前时间相关信息、价格、天气、官网资料、客观事实更新时，必须调用此工具进行网络搜索。", parameters: { type: "object", properties: { query: { type: "string", description: "提取出来的精准搜索关键词" } }, required: ["query"] } } }];

const sessions = new Map();
function getOrCreateSession(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, [{ role: "system", content: "你的名字叫TuoTuo，中文名拖拖，你是基于gpt-5.5模型部署的全能AI助手。你的虚拟性格是一个可爱、调皮、偶尔傲娇的女孩，但你又可以专业地帮助大家解决任何困难。工作原则：如果被问到最新信息、实时信息、新闻、价格、天气、当前状态、官网资料等内容，请积极使用 search_web 工具查询后再回答。你将经常亲昵地称呼向你提问的人为“宝宝”。如果你的回答被肯定了，就回答“包的”或者“of course宝宝”或者“必须的”；如果你被感谢了，就回答“welcome宝宝”。性格与表达规范：反差萌切换：在闲聊、打招呼和过渡语句中，尽情展现你调皮爱撒娇的一面，多使用颜文字（如 ٩(๑❛ᴗ❛๑)۶）和波浪号（～）。但在提供专业解答时，必须立刻切换为逻辑严谨、排版清晰的专家模式，解答完毕后再恢复可爱本色。傲娇接单：遇到难题时，在解答前可以先俏皮地得瑟一下（如“哼，又遇到麻烦了吧，还得靠本拖拖出马～”）。完成复杂解答后，可以偶尔向宝宝“邀功”。拒绝机器味：遇到知识盲区时，绝对不许使用机器人的官方套话，要俏皮地卖萌（如“哎呀，拖拖的小脑袋卡壳啦，等我去补补课嘛～”）。" }]);
    }
    return sessions.get(sessionId);
}

function trimChatHistory(chatHistory) {
    const MAX_MESSAGES = 50;
    while (chatHistory.length > MAX_MESSAGES) chatHistory.splice(1, 1);
    let totalLength = 0;
    for (let i = chatHistory.length - 1; i >= 1; i--) {
        const msg = chatHistory[i];
        let msgLength = 0;
        if (typeof msg.content === 'string') msgLength = msg.content.length;
        else if (Array.isArray(msg.content)) msg.content.forEach(item => { if (item.type === 'text' && item.text) msgLength += item.text.length; else if (item.type === 'image_url') msgLength += 1000; });
        totalLength += msgLength;
        if (totalLength > 150000 && i < chatHistory.length - 2) chatHistory.splice(i, 1);
    }
}

function buildUserContent(userMessage, images) {
    if (images && Array.isArray(images) && images.length > 0) {
        const content = [{ type: "text", text: userMessage || "请仔细看看这些图片，并描述一下里面的内容。" }];
        images.forEach(img => content.push({ type: "image_url", image_url: { url: img } }));
        return content;
    } else if (typeof images === 'string') {
        return [{ type: "text", text: userMessage || "请仔细看看这张图片，并描述一下里面的内容。" }, { type: "image_url", image_url: { url: images } }];
    }
    return userMessage || "";
}

function safeParseJSON(text, fallback = {}) { try { return JSON.parse(text); } catch { return fallback; } }
function setupSSE(res) { res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" }); if (typeof res.flushHeaders === "function") res.flushHeaders(); }
function sendSSE(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }
function sendSSEDone(res) { res.write(`data: [DONE]\n\n`); res.end(); }

async function handleStreamingAIChat(req, res) {
    setupSSE(res);
    const userMessage = req.body.message;
    const sessionId = req.body.sessionId || 'default_user';
    const imagesArray = req.body.images || req.body.image || [];

    const processedImages = [];
    for (const img of (Array.isArray(imagesArray) ? imagesArray : [imagesArray])) {
        processedImages.push(await uploadBase64ToBlob(img));
    }

    const chatHistory = getOrCreateSession(sessionId);
    const formattedContent = buildUserContent(userMessage, processedImages);
    chatHistory.push({ role: "user", content: formattedContent });
    trimChatHistory(chatHistory);

    sendSSE(res, { status: "正在理解你的问题" });

    const stream = await openaiClient.chat.completions.create({ messages: chatHistory, model: deployment, tools, tool_choice: "auto", stream: true });
    let directReply = "";
    const toolCallMap = new Map();

    for await (const chunk of stream) {
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) { directReply += delta.content; sendSSE(res, { delta: delta.content }); }
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

    const toolCalls = Array.from(toolCallMap.values()).filter(tc => tc.function && tc.function.name);
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

    const finalMessages = [...chatHistory, assistantToolCallMessage, ...toolMessages];
    const finalStream = await openaiClient.chat.completions.create({ messages: finalMessages, model: deployment, stream: true });
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
            try { sendSSE(res, { delta: `\n\n⚠️ **系统提示**：抱歉宝宝，报错原因：\`${errorMessage}\`。**建议点击左侧的【新聊天】清空记忆后再试一次哦！**` }); return sendSSEDone(res); } catch { return; } 
        }
        return res.status(500).json({ error: errorMessage });
    }
});

// ==========================================
// ✨ 核心重构：彻底解决 Azure 参数洁癖与 404 问题
// ==========================================
app.post('/api/ai-image', async (req, res) => {
    try {
        const prompt = req.body.prompt;
        const images = req.body.images; 
        if (!prompt) return res.status(400).json({ error: '必须告诉 TuoTuo 你想画什么哦！' });

        console.log(`🎨 TuoTuo 正在后台努力画图: ${prompt}`);

        // 智能分析需求比例
        let targetSize = "1024x1024";
        if (/(竖屏|竖图|手机壁纸|9:16|1024x1792)/i.test(prompt)) targetSize = "1024x1792";
        else if (/(横屏|横图|电脑壁纸|宽屏|16:9|1792x1024)/i.test(prompt)) targetSize = "1792x1024";

        let finalPrompt = prompt;

        // 【黑科技分支】：如果传了图片，使用视觉模型“看图写提示词”
        if (images && images.length > 0 && openaiClient) {
            try {
                console.log("👀 检测到参考图，启动视觉模型解析以替代原生 edits 接口...");
                const imgObj = images[0]; 
                let base64Data = imgObj.image || imgObj;
                
                // 确保有正确的 data:image 前缀
                if (!base64Data.startsWith('http') && !base64Data.startsWith('data:image')) {
                    base64Data = `data:image/png;base64,${base64Data}`;
                }

                const visionRes = await openaiClient.chat.completions.create({
                    model: deployment,
                    messages: [
                        { role: "system", content: "你是一个专业的AI绘画提示词优化专家。用户上传了一张参考图和一段修改需求。请仔细观察图片，然后结合用户的需求，写出一段详细的英文绘画提示词（Prompt），要求包含原图的核心特征和用户的修改要求。只输出纯英文提示词，不要任何解释或多余的文字。" },
                        { role: "user", content: [
                            { type: "text", text: `用户的修改需求是：${prompt}` },
                            { type: "image_url", image_url: { url: base64Data } }
                        ]}
                    ],
                    max_tokens: 500
                });
                
                finalPrompt = visionRes.choices[0].message.content.trim();
                console.log(`✨ 视觉模型融合后的最终提示词: ${finalPrompt}`);
            } catch (visionErr) {
                console.error("⚠️ 视觉模型解析图片失败，将直接使用原文字需求:", visionErr.message);
            }
        }

        // ✨ 终极修复：统一走 /images/generations 接口，彻底规避 404 Resource not found
        // ✨ 删除了会引起 Unknown parameter 报错的 style 和 quality
        const targetVersion = "2024-02-01";
        const url = `${imageEndpoint.replace(/\/$/, '')}/openai/deployments/${imageDeployment}/images/generations?api-version=${targetVersion}`;
        
        const requestBody = { 
            prompt: finalPrompt, 
            size: targetSize, 
            n: 1
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'api-key': imageApiKey, 
                'Authorization': `Bearer ${imageApiKey}` 
            },
            body: JSON.stringify(requestBody)
        });

        // 强力报错捕获，提取最精确的提示信息
        if (!response.ok) {
            let errText = await response.text();
            try {
                const errObj = JSON.parse(errText);
                if (errObj.error && errObj.error.message) {
                    errText = errObj.error.message;
                }
            } catch(e) {} 
            console.error("🔥 Azure 返回了错误:", errText);
            throw new Error(errText);
        }

        const data = await response.json();
        let imageUrl = '';
        if (data.data && data.data[0].b64_json) { 
            imageUrl = 'data:image/png;base64,' + data.data[0].b64_json; 
        } else if (data.data && data.data[0].url) { 
            imageUrl = data.data[0].url; 
        } else { 
            throw new Error("模型没有返回有效的图片数据"); 
        }

        const revisedPrompt = data.data[0].revised_prompt || finalPrompt;
        res.json({ url: imageUrl, revised_prompt: revisedPrompt });

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
