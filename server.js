const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 定义存储路径（保存在根目录下）
const historyFile = path.join(__dirname, 'chat_history.json');

// 初始化：如果文件不存在，创建一个空的
if (!fs.existsSync(historyFile)) {
    fs.writeFileSync(historyFile, JSON.stringify([]));
}

const port = process.env.PORT || 8888;
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("TuoTuo Chat Server with File Persistence is running!");
});

const wss = new WebSocket.Server({ server });
let clients = new Map();

wss.on('connection', (ws, req) => {
    const nickname = decodeURIComponent(req.url.split('/socket/')[1] || "匿名粉丝");
    clients.set(ws, nickname);

    // --- 核心：新用户连接时，读取本地文件并发送历史记录 ---
    try {
        const data = fs.readFileSync(historyFile, 'utf8');
        const history = JSON.parse(data);
        // 只发送最近的 50 条，防止加载太慢
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

            // --- 核心：将新消息追加到本地文件中 ---
            const fileData = fs.readFileSync(historyFile, 'utf8');
            const history = JSON.parse(fileData);
            history.push(data);
            
            // 限制文件大小，只保留最近 1000 条，防止硬盘撑爆
            if (history.length > 1000) history.shift();
            
            fs.writeFileSync(historyFile, JSON.stringify(history));

            // 转发给所有人
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

server.listen(port, () => {
    console.log(`✅ 聊天服务器已启动，历史记录将保存在本地文件`);
});