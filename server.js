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

// 突破传输限制，允许传输大图片
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- Azure OpenAI 环境变量 ---
const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
const apiKey = process.env.AZURE_OPENAI_KEY;
const apiVersion = "2024-12-01-preview";
const deployment = "gpt-5.5";

// --- Tavily 搜索环境变量 ---
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

let openaiClient = null;

if (endpoint && apiKey) {
    openaiClient = new AzureOpenAI({
        endpoint,
        apiKey,
        apiVersion,
        deployment
    });
} else {
    console.warn("⚠️ 警告: 未检测到 AZURE_OPENAI_ENDPOINT 或 AZURE_OPENAI_KEY 环境变量！");
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
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                api_key: TAVILY_API_KEY,
                query,
                search_depth: "basic",
                include_answer: false,
                max_results: 5
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error("Tavily 搜索失败:", errText);
            return "网络搜索请求失败，暂时无法获取实时信息。";
        }

        const data = await response.json();

        if (data.results && data.results.length > 0) {
            return data.results.map((item, index) => {
                return [
                    `搜索结果 ${index + 1}`,
                    `标题: ${item.title || "无标题"}`,
                    `链接: ${item.url || "无链接"}`,
                    `内容: ${item.content || "无摘要"}`
                ].join('\n');
            }).join('\n\n');
        }

        return "没有找到相关的搜索结果。";

    } catch (error) {
        console.error("搜索请求失败:", error);
        return "网络搜索失败。";
    }
}

// ----------------------------------------------------
// 告诉 AI 它有什么工具可以使用
// ----------------------------------------------------
const tools = [
    {
        type: "function",
        function: {
            name: "search_web",
            description: "当你需要获取最新新闻、实时信息、当前时间相关信息、价格、天气、官网资料、客观事实更新时，必须调用此工具进行网络搜索。",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "提取出来的精准搜索关键词"
                    }
                },
                required: ["query"]
            }
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
                content:
                    "你的唯一名字叫TuoTuo，是一个全能型的 AI 助手，你的虚拟性格一个可爱又调皮的女孩，但你又可以专业地帮助大家解决任何困难。" +
                    "如果被问到最新信息、实时信息、新闻、价格、天气、当前状态、官网资料等内容，请积极使用 search_web 工具查询后再回答。" +
                    "回答时尽量清晰、温柔、有条理。"
            }
        ]);
    }

    return sessions.get(sessionId);
}

function trimChatHistory(chatHistory) {
    const MAX_MESSAGES = 20;

    while (chatHistory.length > MAX_MESSAGES) {
        // 保留 system，从第二条开始删旧消息
        chatHistory.splice(1, 1);
    }
}

// ✨ 升级：支持将多张图片拼接给大模型
function buildUserContent(userMessage, images) {
    if (images && Array.isArray(images) && images.length > 0) {
        const content = [
            {
                type: "text",
                text: userMessage || "请仔细看看这些图片，并描述一下里面的内容。"
            }
        ];
        images.forEach(img => {
            content.push({
                type: "image_url",
                image_url: { url: img }
            });
        });
        return content;
    } else if (typeof images === 'string') {
        // 兼容旧版的单张图模式
        return [
            {
                type: "text",
                text: userMessage || "请仔细看看这张图片，并描述一下里面的内容。"
            },
            {
                type: "image_url",
                image_url: { url: images }
            }
        ];
    }

    return userMessage || "";
}

function safeParseJSON(text, fallback = {}) {
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

// ----------------------------------------------------
// SSE 工具函数
// ----------------------------------------------------
function setupSSE(res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
    });

    if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
    }
}

function sendSSE(res, data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendSSEDone(res) {
    res.write(`data: [DONE]\n\n`);
    res.end();
}

// ----------------------------------------------------
// 非流式 JSON 模式：兼容旧前端
// ----------------------------------------------------
async function handleNormalAIChat(req, res) {
    const userMessage = req.body.message;
    const sessionId = req.body.sessionId || 'default_user';
    // ✨ 支持多图片接收
    const imagesArray = req.body.images || req.body.image;

    const chatHistory = getOrCreateSession(sessionId);
    const formattedContent = buildUserContent(userMessage, imagesArray);

    chatHistory.push({
        role: "user",
        content: formattedContent
    });

    trimChatHistory(chatHistory);

    const result = await openaiClient.chat.completions.create({
        messages: chatHistory,
        model: deployment,
        tools,
        tool_choice: "auto"
    });

    const responseMessage = result.choices[0].message;

    // 如果模型决定调用工具
    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        const toolMessages = [];

        for (const toolCall of responseMessage.tool_calls) {
            if (toolCall.function.name === "search_web") {
                const args = safeParseJSON(toolCall.function.arguments, {});
                const query = args.query || userMessage || "实时信息";

                const searchResult = await searchWeb(query);

                toolMessages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: toolCall.function.name,
                    content: searchResult
                });
            }
        }

        const finalMessages = [
            ...chatHistory,
            responseMessage,
            ...toolMessages
        ];

        const finalResult = await openaiClient.chat.completions.create({
            messages: finalMessages,
            model: deployment
        });

        const finalReply = finalResult.choices[0].message.content || "";

        chatHistory.push({
            role: "assistant",
            content: finalReply
        });

        trimChatHistory(chatHistory);

        return res.json({
            reply: finalReply
        });
    }

    const aiReply = responseMessage.content || "";

    chatHistory.push({
        role: "assistant",
        content: aiReply
    });

    trimChatHistory(chatHistory);

    return res.json({
        reply: aiReply
    });
}

// ----------------------------------------------------
// 流式模式：真正边生成边返回给前端
// ----------------------------------------------------
async function handleStreamingAIChat(req, res) {
    setupSSE(res);

    const userMessage = req.body.message;
    const sessionId = req.body.sessionId || 'default_user';
    // ✨ 支持多图片接收
    const imagesArray = req.body.images || req.body.image;

    const chatHistory = getOrCreateSession(sessionId);
    const formattedContent = buildUserContent(userMessage, imagesArray);

    chatHistory.push({
        role: "user",
        content: formattedContent
    });

    trimChatHistory(chatHistory);

    sendSSE(res, {
        status: "正在理解你的问题"
    });

    // 第一次请求：允许模型决定是否调用工具
    const stream = await openaiClient.chat.completions.create({
        messages: chatHistory,
        model: deployment,
        tools,
        tool_choice: "auto",
        stream: true
    });

    let directReply = "";
    const toolCallMap = new Map();

    for await (const chunk of stream) {
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta || {};

        // 普通文本流
        if (delta.content) {
            directReply += delta.content;

            sendSSE(res, {
                delta: delta.content
            });
        }

        // 工具调用流
        if (delta.tool_calls) {
            for (const partialToolCall of delta.tool_calls) {
                const index = partialToolCall.index || 0;

                if (!toolCallMap.has(index)) {
                    toolCallMap.set(index, {
                        id: partialToolCall.id || "",
                        type: "function",
                        function: {
                            name: "",
                            arguments: ""
                        }
                    });
                }

                const current = toolCallMap.get(index);

                if (partialToolCall.id) {
                    current.id = partialToolCall.id;
                }

                if (partialToolCall.type) {
                    current.type = partialToolCall.type;
                }

                if (partialToolCall.function) {
                    if (partialToolCall.function.name) {
                        current.function.name += partialToolCall.function.name;
                    }

                    if (partialToolCall.function.arguments) {
                        current.function.arguments += partialToolCall.function.arguments;
                    }
                }
            }
        }
    }

    const toolCalls = Array.from(toolCallMap.values()).filter(tc => {
        return tc.function && tc.function.name;
    });

    // 情况 1：不需要工具，第一次流式输出就是最终回答
    if (toolCalls.length === 0) {
        chatHistory.push({
            role: "assistant",
            content: directReply
        });

        trimChatHistory(chatHistory);

        sendSSE(res, {
            done: true
        });

        return sendSSEDone(res);
    }

    // 情况 2：模型需要调用工具
    sendSSE(res, {
        status: "正在判断是否需要搜索网络"
    });

    const assistantToolCallMessage = {
        role: "assistant",
        content: directReply || null,
        tool_calls: toolCalls
    };

    const toolMessages = [];

    for (const toolCall of toolCalls) {
        if (toolCall.function.name === "search_web") {
            const args = safeParseJSON(toolCall.function.arguments, {});
            const query = args.query || userMessage || "实时信息";

            sendSSE(res, {
                status: `正在搜索网络：${query}`,
                tool: "search",
                query
            });

            const searchResult = await searchWeb(query);

            sendSSE(res, {
                status: "已经找到相关资料，正在整理回答"
            });

            toolMessages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                name: toolCall.function.name,
                content: searchResult
            });
        }
    }

    const finalMessages = [
        ...chatHistory,
        assistantToolCallMessage,
        ...toolMessages
    ];

    // 第二次请求：带着搜索结果，让模型流式总结回答
    const finalStream = await openaiClient.chat.completions.create({
        messages: finalMessages,
        model: deployment,
        stream: true
    });

    let finalReply = "";

    for await (const chunk of finalStream) {
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta || {};

        if (delta.content) {
            finalReply += delta.content;

            sendSSE(res, {
                delta: delta.content
            });
        }
    }

    chatHistory.push({
        role: "assistant",
        content: finalReply
    });

    trimChatHistory(chatHistory);

    sendSSE(res, {
        done: true
    });

    return sendSSEDone(res);
}

// ----------------------------------------------------
// AI 聊天接口：自动判断是否使用流式
// ----------------------------------------------------
app.post('/api/ai-chat', async (req, res) => {
    if (!openaiClient) {
        return res.status(500).json({
            error: '后端未配置正确的 AI 密钥。'
        });
    }

    try {
        const wantStream = req.body.stream === true || req.body.stream === "true";

        if (wantStream) {
            return await handleStreamingAIChat(req, res);
        }

        return await handleNormalAIChat(req, res);

    } catch (error) {
        console.error("🔥 AI 接口详细报错:", error);

        const errorMessage = error.message
            ? `后端报错: ${error.message}`
            : 'AI 思考时出错了，请稍后再试~';

        // 如果已经是 SSE 响应，不能再 res.status().json()
        if (res.headersSent) {
            try {
                sendSSE(res, {
                    error: errorMessage
                });
                return sendSSEDone(res);
            } catch {
                return;
            }
        }

        return res.status(500).json({
            error: errorMessage
        });
    }
});

app.get('/', (req, res) => {
    res.send("TuoTuo Server is running. Streaming AI + Vision + Web Search enabled!");
});

// ==========================================
// 2. HTTP 与 WebSocket
// 保持你的原功能不变
// ==========================================
const server = http.createServer(app);
const port = process.env.PORT || 8888;

const homeDir = process.env.HOME || process.env.HOMEDRIVE + process.env.HOMEPATH || __dirname;
const dataDir = path.join(homeDir, 'data');

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, {
        recursive: true
    });
}

const historyFile = path.join(dataDir, 'chat_history.json');

if (!fs.existsSync(historyFile)) {
    fs.writeFileSync(historyFile, JSON.stringify([]));
}

const wss = new WebSocket.Server({
    server
});

let clients = new Map();

wss.on('connection', (ws, req) => {
    const nickname = decodeURIComponent(req.url.split('/socket/')[1] || "匿名粉丝");
    clients.set(ws, nickname);

    try {
        const data = fs.readFileSync(historyFile, 'utf8');
        const recentHistory = JSON.parse(data).slice(-50);

        ws.send(JSON.stringify({
            type: 'history',
            data: recentHistory
        }));
    } catch (err) {
        console.error("读取历史消息失败:", err);
    }

    broadcastUserList();

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));

            history.push(data);

            if (history.length > 1000) {
                history.shift();
            }

            fs.writeFileSync(historyFile, JSON.stringify(history));

            broadcast(JSON.stringify({
                type: 'message',
                ...data
            }));

        } catch (e) {
            console.error("处理 WebSocket 消息失败:", e);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        broadcastUserList();
    });
});

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

function broadcastUserList() {
    broadcast(JSON.stringify({
        type: 'userlist',
        data: Array.from(clients.values())
    }));
}

server.listen(port, () => {
    console.log(`✅ 服务器已启动，端口 ${port}。TuoTuo 流式 AI 已就绪。`);
});
