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

// ✨ 关键升级：默认的 json 解析限制是 100kb，图片 Base64 很大，必须把限制调高到 50mb
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- 从环境变量获取 GPT-5.5 配置 ---
const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
const apiKey = process.env.AZURE_OPENAI_KEY; 
const apiVersion = "2024-12-01-preview";
const deployment = "gpt-5.5";

let openaiClient = null;
if (endpoint && apiKey) {
    openaiClient = new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment });
} else {
    console.warn("⚠️ 警告: 未检测到 AZURE_OPENAI_ENDPOINT 或 AZURE_OPENAI_KEY 环境变量！");
}

// ----------------------------------------------------
// 🌟 内存会话管理器 (用于实现多回合对话记忆)
// ----------------------------------------------------
const sessions = new Map();

// AI 聊天接口 (升级为多回合 + 视觉识别版)
app.post('/api/ai-chat', async (req, res) => {
    if (!openaiClient) {
        return res.status(500).json({ error: '后端未配置正确的 AI 密钥，请检查 Azure 环境变量。' });
    }

    try {
        const userMessage = req.body.message;
        const sessionId = req.body.sessionId || 'default_user';
        const base64Image = req.body.image; // ✨ 接收前端传来的图片 Base64 数据

        // 1. 获取或初始化这个用户的对话历史
        if (!sessions.has(sessionId)) {
            sessions.set(sessionId, [
                // 赋予 TuoTuo 灵魂的系统提示词
                { role: "system", content: "你叫TuoTuo，是一个全能型的 AI 助手，你将用可爱的语气帮助大家解决任何困难。" }
            ]);
        }
        const chatHistory = sessions.get(sessionId);

        // 2. ✨ 核心逻辑：判断是否带有图片，组装不同的格式发给大模型
        let formattedContent = userMessage;
        
        if (base64Image) {
            // 如果有图片，必须使用 OpenAI 规定的视觉(Vision)数组格式
            formattedContent = [
                { type: "text", text: userMessage || "请仔细看看这张图片，并描述一下里面的内容。" },
                { type: "image_url", image_url: { url: base64Image } }
            ];
        }

        // 把组装好的内容加入历史记录
        chatHistory.push({ role: "user", content: formattedContent });

        // 为了防止上下文过长导致超出 Token 限制，我们只保留最近的 10 条对话 (5组问答)
        // 注意要始终保留第一条 system prompt (索引为0)
        if (chatHistory.length > 11) {
            chatHistory.splice(1, 2);
        }

        // 3. 呼叫 Azure OpenAI
        const result = await openaiClient.chat.completions.create({
            messages: chatHistory,
            model: deployment,
        });

        const aiReply = result.choices[0].message.content;

        // 4. 把 AI 的回复也加入历史记录，完成这回合的记忆
        chatHistory.push({ role: "assistant", content: aiReply });

        res.json({ reply: aiReply });
    } catch (error) {
        console.error("🔥 AI 接口详细报错:", error);
        
        let errorMessage = 'AI 思考时出错了，请稍后再试~';
        if (error.response && error.response.data && error.response.data.error) {
            errorMessage = `Azure API 报错: ${error.response.data.error.message || JSON.stringify(error.response.data.error)}`;
        } else if (error.message) {
            errorMessage = `后端报错: ${error.message}`;
        }
        
        res.status(500).json({ error: errorMessage });
    }
});


// 测试路由
app.get('/', (req, res) => {
    res.send("TuoTuo Server is running (Multi-turn + Vision AI enabled)!");
});

// ==========================================
// 2. 将 Express 挂载到 HTTP Server
// ==========================================
const server = http.createServer(app);
const port = process.env.PORT || 8888;

// ==========================================
// 3. WebSocket 逻辑 (聊天室和日记本的持久化存储版)
// ==========================================
// 动态获取 Azure 的持久化根目录
const homeDir = process.env.HOME || process.env.HOMEDRIVE + process.env.HOMEPATH || __dirname;
const dataDir = path.join(homeDir, 'data');

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const historyFile = path.join(dataDir, 'chat_history.json');

if (!fs.existsSync(historyFile)) {
    fs.writeFileSync(historyFile, JSON.stringify([]));
}

const wss = new WebSocket.Server({ server });
let clients = new Map();

wss.on('connection', (ws, req) => {
    const nickname = decodeURIComponent(req.url.split('/socket/')[1] || "匿名粉丝");
    clients.set(ws, nickname);

    try {
        const data = fs.readFileSync(historyFile, 'utf8');
        const history = JSON.parse(data);
        const recentHistory = history.slice(-50);
        ws.send(JSON.stringify({ type: 'history', data: recentHistory }));
    } catch (err) {
        console.error("读取历史记录失败", err);
    }

    broadcastUserList();

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const msgObj = { type: 'message', ...data };

            const fileData = fs.readFileSync(historyFile, 'utf8');
            const history = JSON.parse(fileData);
            history.push(data);
            
            if (history.length > 1000) history.shift();
            
            fs.writeFileSync(historyFile, JSON.stringify(history));

            broadcast(JSON.stringify(msgObj));
        } catch (e) {
            console.error("处理消息失败");
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        broadcastUserList();
    });
});

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
    });
}

function broadcastUserList() {
    const userList = Array.from(clients.values());
    broadcast(JSON.stringify({ type: 'userlist', data: userList }));
}

// 启动服务器
server.listen(port, () => {
    console.log(`✅ 服务器已启动，端口 ${port}。支持 WebSocket 和多模态 HTTP API。`);
});
