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
app.use(express.json());

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
// 🌟 新增：简单的内存会话管理器 (用于实现多回合对话记忆)
// 注意：如果服务器重启，这些内存中的对话历史会丢失。
// ----------------------------------------------------
const sessions = new Map();

// AI 聊天接口 (升级为多回合对话版)
app.post('/api/ai-chat', async (req, res) => {
    if (!openaiClient) {
        return res.status(500).json({ error: '后端未配置正确的 AI 密钥，请检查 Azure 环境变量。' });
    }

    try {
        const userMessage = req.body.message;
        // 简单起见，我们暂时用一个固定的 session ID（例如 'default_user'）
        // 如果你需要区分不同用户，可以要求前端在发请求时带上用户的 nickname
        const sessionId = req.body.sessionId || 'default_user';

        // 1. 获取或初始化这个用户的对话历史
        if (!sessions.has(sessionId)) {
            sessions.set(sessionId, [
                { role: "system", content: "你叫TuoTuo，是一个全能型的 AI 助手，你被赋予的模拟性格是一个可爱又有点调皮的女孩子，你将帮助大家解决任何困难。" }
            ]);
        }
        const chatHistory = sessions.get(sessionId);

        // 2. 把用户的新消息加入历史记录
        chatHistory.push({ role: "user", content: userMessage });

        // 为了防止上下文过长导致超出 Token 限制，我们只保留最近的 10 条对话 (5组问答)
        // 注意要始终保留第一条 system prompt
        if (chatHistory.length > 11) {
            // 删除掉最老的两条 (一问一答)，保留最新的
            chatHistory.splice(1, 2);
        }

        // 3. 把包含历史记录的完整数组发给大模型
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
    res.send("TuoTuo Server is running (Multi-turn AI enabled)!");
});

// ==========================================
// 2. 将 Express 挂载到 HTTP Server
// ==========================================
const server = http.createServer(app);
const port = process.env.PORT || 8888;

// ==========================================
// 3. WebSocket 逻辑 (持久化存储版)
// ==========================================
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
    console.log(`✅ 服务器已启动，端口 ${port}。支持 WebSocket 和 HTTP API。`);
});
