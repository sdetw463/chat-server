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
app.use(cors()); // 允许跨域请求
app.use(express.json()); // 解析 JSON 格式的请求体

// --- 从环境变量获取 GPT-5.5 配置 ---
// 这样可以确保你的密钥不会暴露在 GitHub 上
const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
const apiKey = process.env.AZURE_OPENAI_KEY; 
const apiVersion = "2024-12-01-preview";
const deployment = "gpt-5.5";

let openaiClient = null;
if (endpoint && apiKey) {
    openaiClient = new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment });
} else {
    console.warn("⚠️ 警告: 未检测到 AZURE_OPENAI_ENDPOINT 或 AZURE_OPENAI_KEY 环境变量，AI 功能将无法正常工作！");
}

// 测试路由
app.get('/', (req, res) => {
    res.send("TuoTuo Server is running (WebSocket + AI API)!");
});

// AI 聊天接口
app.post('/api/ai-chat', async (req, res) => {
    if (!openaiClient) {
        return res.status(500).json({ error: '后端未配置正确的 AI 密钥，请检查 Azure 环境变量。' });
    }

    try {
        const userMessage = req.body.message;
        
        const result = await openaiClient.chat.completions.create({
            messages: [
                { role: "system", content: "你是一个友好的AI助手，现在部署在TuoTuo的个人网站上。你的回答应该专业、友好且富有同理心。" },
                { role: "user", content: userMessage }
            ],
            model: deployment,
        });

        res.json({ reply: result.choices[0].message.content });
    } catch (error) {
        console.error("AI 接口报错:", error);
        res.status(500).json({ error: 'AI 思考时出错了，请稍后再试~' });
    }
});


// ==========================================
// 2. 将 Express 挂载到 HTTP Server
// ==========================================
const server = http.createServer(app);
const port = process.env.PORT || 8888;


// ==========================================
// 3. WebSocket 逻辑 (保持你原来的代码不变)
// ==========================================
const historyFile = path.join(__dirname, 'chat_history.json');

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
