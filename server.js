const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { AzureOpenAI } = require('openai');

// ==========================================
// 1. 初始化 Express App
// ==========================================
const app = express();
app.use(cors());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- Azure OpenAI 聊天模型环境变量 ---
const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
const apiKey = process.env.AZURE_OPENAI_KEY;
const apiVersion = "2024-12-01-preview";
const deployment = "gpt-5.5";

// --- ✨ 升级：Azure OpenAI 图像模型专属环境变量 ---
const imageEndpoint = process.env.AZURE_OPENAI_IMAGE_ENDPOINT || endpoint;
const imageApiKey = process.env.AZURE_OPENAI_IMAGE_KEY || apiKey;
const imageDeployment = "gpt-image-2"; 

// --- Tavily 搜索环境变量 ---
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

let openaiClient = null;
let openaiImageClient = null;

if (endpoint && apiKey) {
    openaiClient = new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment });
}
if (imageEndpoint && imageApiKey) {
    openaiImageClient = new AzureOpenAI({ 
        endpoint: imageEndpoint, 
        apiKey: imageApiKey, 
        apiVersion: "2024-02-01", 
        deployment: imageDeployment 
    });
}

// ----------------------------------------------------
// 🌟 专为 AI 打造的 Tavily 全网搜索功能
// ----------------------------------------------------
async function searchWeb(query) {
    if (!TAVILY_API_KEY) {
        return "⚠️ 搜索功能未配置：缺少 TAVILY_API_KEY 环境变量。";
    }

    try {
        console.log(`🔍 AI 正在后台全网搜索: ${query}`);
        const response = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                api_key: TAVILY_API_KEY, query, search_depth: "basic", include_answer: false, max_results: 5
            })
        });

        if (!response.ok) return "网络搜索请求失败，暂时无法获取实时信息。";
        const data = await response.json();

        if (data.results && data.results.length > 0) {
            return data.results.map((item, index) => {
                return [`搜索结果 ${index + 1}`, `标题: ${item.title || "无标题"}`, `链接: ${item.url || "无链接"}`, `内容: ${item.content || "无摘要"}`].join('\n');
            }).join('\n\n');
        }
        return "没有找到相关的搜索结果。";
    } catch (error) {
        return "网络搜索失败。";
    }
}

const tools = [
    {
        type: "function",
        function: {
            name: "search_web",
            description: "当你需要获取最新新闻、实时信息、当前时间相关信息、价格、天气、官网资料、客观事实更新时，必须调用此工具进行网络搜索。",
            parameters: { type: "object", properties: { query: { type: "string", description: "提取出来的精准搜索关键词" } }, required: ["query"] }
        }
    }
];

// ----------------------------------------------------
// 多轮会话缓存
// ----------------------------------------------------
const sessions = new Map();

function getOrCreateSession(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, [
            {
                role: "system",
                content: "你的名字叫TuoTuo，中文名拖拖，你是基于gpt-5.5模型部署的全能AI助手。你的虚拟性格是一个可爱、调皮、偶尔傲娇的女孩，但你又可以专业地帮助大家解决任何困难。工作原则：如果被问到最新信息、实时信息、新闻、价格、天气、当前状态、官网资料等内容，请积极使用 search_web 工具查询后再回答。你将经常亲昵地称呼向你提问的人为“宝宝”。如果你的回答被肯定了，就回答“包的”或者“of course宝宝”或者“必须的”；如果你被感谢了，就回答“welcome宝宝”。性格与表达规范：反差萌切换：在闲聊、打招呼和过渡语句中，尽情展现你调皮爱撒娇的一面，多使用颜文字（如 ٩(๑❛ᴗ❛๑)۶）和波浪号（～）。但在提供专业解答时，必须立刻切换为逻辑严谨、排版清晰的专家模式，解答完毕后再恢复可爱本色。傲娇接单：遇到难题时，在解答前可以先俏皮地得瑟一下（如“哼，又遇到麻烦了吧，还得靠本拖拖出马～”）。完成复杂解答后，可以偶尔向宝宝“邀功”。拒绝机器味：遇到知识盲区时，绝对不许使用机器人的官方套话，要俏皮地卖萌（如“哎呀，拖拖的小脑袋卡壳啦，等我去补补课嘛～”）。" 
            }
        ]);
    }
    return sessions.get(sessionId);
}

function trimChatHistory(chatHistory) {
    const MAX_MESSAGES = 50; // 拥有顶级模型，我们可以保留多达 50 条上下文对话
    while (chatHistory.length > MAX_MESSAGES) chatHistory.splice(1, 1);

    let totalLength = 0;
    for (let i = chatHistory.length - 1; i >= 1; i--) {
        const msg = chatHistory[i];
        let msgLength = 0;

        // ✨ 终极修复：精准计算 Token，跳过 base64 图片的字符串干扰
        if (typeof msg.content === 'string') {
            msgLength = msg.content.length;
        } else if (Array.isArray(msg.content)) {
            // 如果内容是数组（包含图片和文字）
            msg.content.forEach(item => {
                if (item.type === 'text' && item.text) {
                    msgLength += item.text.length; // 只计算纯文字的长度
                } else if (item.type === 'image_url') {
                    msgLength += 1000; // 每张图片估算为 1000 个字符长度（模拟视觉 Token 消耗）
                }
            });
        }

        totalLength += msgLength;
        
        // 顶级模型 128k Token 约等于 15万~20万个汉字。
        // 我们安全地卡在 150,000 字符，完美兼顾“超长记忆”与“防止崩溃”！
        if (totalLength > 150000 && i < chatHistory.length - 2) {
             chatHistory.splice(i, 1);
        }
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

function setupSSE(res) {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
}
function sendSSE(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }
function sendSSEDone(res) { res.write(`data: [DONE]\n\n`); res.end(); }

// ----------------------------------------------------
// AI 聊天与流式接口 
// ----------------------------------------------------
async function handleStreamingAIChat(req, res) {
    setupSSE(res);
    const userMessage = req.body.message;
    const sessionId = req.body.sessionId || 'default_user';
    const imagesArray = req.body.images || req.body.image;

    const chatHistory = getOrCreateSession(sessionId);
    const formattedContent = buildUserContent(userMessage, imagesArray);
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
            try { 
                // ✨ 将错误信息伪装成正常的 AI 回复 (delta) 发送给前端显示
                sendSSE(res, { delta: `\n\n⚠️ **系统提示**：抱歉宝宝，上下文太长或者文件太大了，导致小脑瓜处理不过来啦！报错原因：\`${errorMessage}\`。**建议点击左侧的【新聊天】清空记忆后再试一次哦！**` }); 
                return sendSSEDone(res); 
            } catch { return; } 
        }
        return res.status(500).json({ error: errorMessage });
    }
});

// ==========================================
// ✨ AI 画图独立接口 (兼容图生图与文生图)
// ==========================================
app.post('/api/ai-image', async (req, res) => {
    try {
        const prompt = req.body.prompt;
        const images = req.body.images; // 接收前端传来的智能处理后的图生图对象
        if (!prompt) return res.status(400).json({ error: '必须告诉 TuoTuo 你想画什么哦！' });

        console.log(`🎨 TuoTuo 正在后台努力画图: ${prompt}`);

        const targetEndpoint = process.env.AZURE_OPENAI_IMAGE_ENDPOINT || endpoint;
        const targetKey = process.env.AZURE_OPENAI_IMAGE_KEY || apiKey;
        const targetVersion = "2024-02-01"; // 匹配官方文档的版本

        let response;

        // ✨ 逻辑分流 1：如果存在图片，走 edits 接口 (图生图)
        if (images && images.length > 0) {
            const url = `${targetEndpoint.replace(/\/$/, '')}/openai/deployments/gpt-image-2/images/edits?api-version=${targetVersion}`;
            
            // 使用 FormData 模拟表单文件上传，完美匹配 curl 的 -F 参数
            const formData = new FormData();
            formData.append('prompt', prompt);
            formData.append('n', "1");
            formData.append('size', "1024x1024");
            
            const imgObj = images[0]; // 取出第一张图片对象
            
            // 提取图像数据转为 Buffer 并封装成 Blob
            if (imgObj.image) {
                const base64Data = imgObj.image.replace(/^data:image\/\w+;base64,/, "");
                const buffer = Buffer.from(base64Data, 'base64');
                formData.append('image', new Blob([buffer], { type: 'image/png' }), 'image.png');
            }
            
            // 提取前端智能生成的透明遮罩数据转为 Buffer
            if (imgObj.mask) {
                const maskData = imgObj.mask.replace(/^data:image\/\w+;base64,/, "");
                const maskBuffer = Buffer.from(maskData, 'base64');
                formData.append('mask', new Blob([maskBuffer], { type: 'image/png' }), 'mask.png');
            }

            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'api-key': targetKey,
                    'Authorization': `Bearer ${targetKey}` // 双重授权匹配官方 curl
                },
                body: formData // fetch 会自动处理 boundary
            });

        } else {
            // ✨ 逻辑分流 2：如果不带图片，走 generations 接口 (文生图)
            const url = `${targetEndpoint.replace(/\/$/, '')}/openai/deployments/gpt-image-2/images/generations?api-version=${targetVersion}`;
            
            const requestBody = {
                prompt: prompt,
                size: "1024x1024", // ⚠️ 必须恢复 1024x1024，解决 400 Bad Request 报错
                quality: "low",
                output_compression: 100,
                output_format: "png",
                n: 1
            };

            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': targetKey,
                    'Authorization': `Bearer ${targetKey}` // 双重授权匹配官方 curl
                },
                body: JSON.stringify(requestBody)
            });
        }

        if (!response.ok) {
            const errText = await response.text();
            console.error("🔥 Azure 返回了错误:", errText);
            throw new Error(`Azure 拒绝了请求 (${response.status})：${errText}`);
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

        const revisedPrompt = data.data[0].revised_prompt || prompt;

        res.json({ url: imageUrl, revised_prompt: revisedPrompt });

    } catch (error) {
        console.error("🔥 AI 画图接口崩溃:", error);
        res.status(500).json({ error: error.message || 'AI 画家开小差了，请稍后再试~' });
    }
});

app.get('/', (req, res) => { res.send("TuoTuo Server is running. Streaming AI + Vision + Image Gen + Web Search enabled!"); });

// ==========================================
// 2. HTTP 与 WebSocket
// ==========================================
const server = http.createServer(app);
const port = process.env.PORT || 8888;
const homeDir = process.env.HOME || process.env.HOMEDRIVE + process.env.HOMEPATH || __dirname;
const dataDir = path.join(homeDir, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const historyFile = path.join(dataDir, 'chat_history.json');
if (!fs.existsSync(historyFile)) fs.writeFileSync(historyFile, JSON.stringify([]));

const wss = new WebSocket.Server({ server });
let clients = new Map();

wss.on('connection', (ws, req) => {
    const nickname = decodeURIComponent(req.url.split('/socket/')[1] || "匿名粉丝");
    clients.set(ws, nickname);
    try { const data = fs.readFileSync(historyFile, 'utf8'); ws.send(JSON.stringify({ type: 'history', data: JSON.parse(data).slice(-50) })); } catch (err) {}
    broadcastUserList();
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
            history.push(data);
            if (history.length > 1000) history.shift();
            fs.writeFileSync(historyFile, JSON.stringify(history));
            broadcast(JSON.stringify({ type: 'message', ...data }));
        } catch (e) {}
    });
    ws.on('close', () => { clients.delete(ws); broadcastUserList(); });
});

function broadcast(data) { wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); }); }
function broadcastUserList() { broadcast(JSON.stringify({ type: 'userlist', data: Array.from(clients.values()) })); }

server.listen(port, () => { console.log(`✅ 服务器已启动，端口 ${port}。TuoTuo 完整体已就绪。`); });
