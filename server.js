const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 【修复3：Azure 上的持久化存储目录必须是 /home，否则没有写入权限会导致服务器崩溃】
const isAzure = process.env.WEBSITE_SITE_NAME !== undefined;
const dataDir = isAzure ? '/home/data' : __dirname;

// 确保数据目录存在
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const historyFile = path.join(dataDir, 'chat_history.json');

// 初始化：如果文件不存在，创建一个空的
if (!fs.existsSync(historyFile)) {
    fs.writeFileSync(historyFile, JSON.stringify([]));
}

const port = process.env.PORT || 8888;
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("TuoTuo Chat Server is running beautifully on Azure!");
});

const wss = new WebSocket.Server({ server });
let clients = new Map();

wss.on('connection', (ws, req) => {
    // 配合前端的 encodeURIComponent，这里使用 decodeURIComponent 解析中文昵称
    const nickname = decodeURIComponent(req.url.split('/socket/')[1] || "匿名粉丝");
    clients.set(ws, nickname);

    // 新用户连接时，发送历史记录
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

            // 将新消息追加到本地文件中
            const fileData = fs.readFileSync(historyFile, 'utf8');
            const history = JSON.parse(fileData);
            history.push(data);
            
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
    console.log(`✅ 聊天服务器已启动，历史记录将保存在: ${historyFile}`);
});
