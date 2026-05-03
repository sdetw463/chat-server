const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { AzureOpenAI } = require('openai');

// ==========================================
// 1. 初始化 Express App (处理 HTTP API)
// ==========================================
const app = express();
app.use(cors());

// 突破传输限制，允许传输大图片
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- Azure OpenAI 环境变量 ---
const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
const apiKey = process.env.AZURE_OPENAI_KEY; 
const apiVersion = "2024-12-01-preview";
const deployment = "gpt-5.5";

// --- ✨ 新增：Google Search 环境变量 ---
const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_SEARCH_CX = process.env.GOOGLE_SEARCH_CX;

let openaiClient = null;
if (endpoint && apiKey) {
    openaiClient = new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment });
} else {
    console.warn("⚠️ 警告: 未检测到 AZURE_OPENAI_ENDPOINT 或 AZURE_OPENAI_KEY 环境变量！");
}

// ----------------------------------------------------
// 🌟 专为 AI 打造的 Tavily 全网搜索功能
async function searchWeb(query) {
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (!tavilyKey) return "⚠️ 搜索功能未配置：缺少 Tavily API 密钥。";
    
    try {
        console.log(`🔍 AI 正在后台偷偷全网搜索: ${query}`);
        const response = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                api_key: tavilyKey,
                query: query,
                search_depth: "basic",
                include_answer: false,
                max_results: 3
            })
        });
        const data = await response.json();
        
        if (data.results && data.results.length > 0) {
            // Tavily 会直接返回非常干净的网页文本，不需要复杂的解析
            return data.results.map(item => `标题: ${item.title}\n内容: ${item.content}`).join('\n\n');
        }
        return "没有找到相关的搜索结果。";
    } catch (error) {
        console.error("搜索请求失败:", error);
        return "网络搜索失败。";
    }
}

// 告诉 AI 它有什么工具可以使用
const tools = [
    {
        type: "function",
        function: {
            name: "search_web",
            description: "当你需要获取最新新闻、实时信息、或者你不知道的客观事实时，必须调用此工具进行网络搜索。",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "提取的精准搜索关键词" }
                },
                required: ["query"]
            }
        }
    }
];

const sessions = new Map();

// AI 聊天接口 (最终究极进化版：多回合 + 视觉 + 联网工具)
app.post('/api/ai-chat', async (req, res) => {
    if (!openaiClient) return res.status(500).json({ error: '后端未配置正确的 AI 密钥。' });

    try {
        const userMessage = req.body.message;
        const sessionId = req.body.sessionId || 'default_user';
        const base64Image = req.body.image; 

        if (!sessions.has(sessionId)) {
            sessions.set(sessionId, [
                { role: "system", content: "你叫TuoTuo，是一个全能型的 AI 助手，你将用可爱的语气帮助大家解决任何困难。如果被问到最新信息，请积极使用 search_web 工具去查询后再回答。" }
            ]);
        }
        const chatHistory = sessions.get(sessionId);

        // 组装用户的消息 (图片或纯文本)
        let formattedContent = userMessage;
        if (base64Image) {
            formattedContent = [
                { type: "text", text: userMessage || "请仔细看看这张图片，并描述一下里面的内容。" },
                { type: "image_url", image_url: { url: base64Image } }
            ];
        }

        chatHistory.push({ role: "user", content: formattedContent });
        if (chatHistory.length > 15) chatHistory.splice(1, 2); // 稍微放大点记忆容量

        // ✨ 第一次请求：带着工具(tools)去问大模型
        const result = await openaiClient.chat.completions.create({
            messages: chatHistory,
            model: deployment,
            tools: tools, // 把我们手搓的 Google 搜索工具挂载给它
            tool_choice: "auto" // 让模型自己决定要不要上网搜
        });

        const responseMessage = result.choices[0].message;

        // ✨ 判断模型是否决定要使用工具上网搜索！
        if (responseMessage.tool_calls) {
            // 把模型的调用指令存入历史
            chatHistory.push(responseMessage);

            // 循环执行模型要求我们调用的所有工具 (通常它只会调一个搜索工具)
            for (const toolCall of responseMessage.tool_calls) {
                if (toolCall.function.name === "search_web") {
                    const args = JSON.parse(toolCall.function.arguments);
                    // 执行搜索，拿到结果
                    const searchResult = await searchWeb(args.query);
                    
                    // 把搜索结果伪装成 'tool' 角色，喂回给大模型
                    chatHistory.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        name: toolCall.function.name,
                        content: searchResult
                    });
                }
            }

            // ✨ 第二次请求：带着刚搜到的资料，再次让大模型总结回答
            const finalResult = await openaiClient.chat.completions.create({
                messages: chatHistory,
                model: deployment
            });

            const finalReply = finalResult.choices[0].message.content;
            chatHistory.push({ role: "assistant", content: finalReply });
            return res.json({ reply: finalReply });
        }

        // 如果模型觉得不需要上网（比如你问它 1+1 等于几），就直接正常回复
        const aiReply = responseMessage.content;
        chatHistory.push({ role: "assistant", content: aiReply });
        res.json({ reply: aiReply });

    } catch (error) {
        console.error("🔥 AI 接口详细报错:", error);
        let errorMessage = 'AI 思考时出错了，请稍后再试~';
        if (error.response && error.response.data && error.response.data.error) {
            errorMessage = `Azure API 报错: ${error.response.data.error.message}`;
        } else if (error.message) {
            errorMessage = `后端报错: ${error.message}`;
        }
        res.status(500).json({ error: errorMessage });
    }
});


app.get('/', (req, res) => {
    res.send("TuoTuo Server is running (Multi-turn + Vision + Google Search enabled)!");
});

// ==========================================
// 2. HTTP 与 WebSocket (保持不变)
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

    try {
        const data = fs.readFileSync(historyFile, 'utf8');
        const recentHistory = JSON.parse(data).slice(-50);
        ws.send(JSON.stringify({ type: 'history', data: recentHistory }));
    } catch (err) {}

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

    ws.on('close', () => {
        clients.delete(ws);
        broadcastUserList();
    });
});

function broadcast(data) { wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); }); }
function broadcastUserList() { broadcast(JSON.stringify({ type: 'userlist', data: Array.from(clients.values()) })); }

server.listen(port, () => { console.log(`✅ 服务器已启动，端口 ${port}。全能形态已就绪。`); });
