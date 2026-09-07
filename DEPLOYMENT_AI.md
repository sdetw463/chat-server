# TuoTuo AI 部署配置

聊天与文件处理支持两种显式选择的后端：`direct-responses`（方案 A，Astra 资源级 Responses API）和 `foundry-agent`（旧版回退路径）。绘画与参考图编辑继续只使用 `gpt-image-2`，不受聊天切换影响。部署前，请在 Azure App Service 的环境变量中配置以下值。

## 方案 A：Astra 资源级 Responses API

2026-09-07 已配置到 App Service，并通过线上聊天、搜索、Excel 生成、原文件跨轮读取及上传修改验证，见 [DIRECT_RESPONSES_VALIDATION.md](DIRECT_RESPONSES_VALIDATION.md)。

```dotenv
AI_CHAT_BACKEND=direct-responses
AZURE_RESPONSES_ENDPOINT=https://nantaisdeninis-6292-resource.cognitiveservices.azure.com
AZURE_RESPONSES_DEPLOYMENT=gpt-6-astra
AZURE_RESPONSES_REASONING_EFFORT=medium
```

- 使用 App Service 托管身份获取 Entra token，不增加模型 API key。该身份需具有资源级推理权限。
- 后端明确发送模型、推理强度及原生 `web_search` / `code_interpreter` 工具；工具执行循环由 Responses API 承担，不再调用 `agent_reference`、Toolbox 或 MCP。
- 人设说明现在来自 `config/chat-instructions.md`（迁移自 `tuo-agent` v15），由后端仓库管理。以后修改 Foundry Agent 说明不会自动改变方案 A。
- MongoDB 继续保存和恢复历史，按现有近期窗口发送文本；不使用旧项目级 Conversation ID。Blob 原文件保留，每轮需要时重新上传并挂载真实 file ID，完成后清理本轮临时上传。文件下载卡片和前端 SSE 协议保持兼容。
- 没有任何模型失败后自动降级到其他模型的逻辑；也不自动重复可能已执行的工具任务。历史文件读取失败时明确报错，不根据文字记录伪装成读取原文件。
- SVG、VDX、VSDX 等不在 Azure Files 上传白名单中的扩展名，由 `lib/file-transport.js` 无损包装为单文件 ZIP 后挂载，并向模型说明如何读取。此规则同时覆盖新附件和历史文件重挂载。数据库/Blob 保存的仍是原文件；临时下载也会解开后端自身的包装，保留原文件名和字节。普通 PDF、Excel、PNG、ZIP 等不受影响，不会重复包装用户上传的 ZIP。
- 此实现不保证任意复杂 Office 排版转换完全保真；Code Interpreter 运行环境和转换库仍有各自限制。
- 需同时上传 `server.js`、`lib/`、`config/`、`package.json`、`test/`、`scripts/` 与部署文档，不能只上传 server.js。不要上传 node_modules、本地缓存或凭据。前端无需修改。
- 回退只需将 `AI_CHAT_BACKEND=foundry-agent`，并保留原 `FOUNDRY_AGENT_NAME=tuo-agent` / `FOUNDRY_AGENT_VERSION=15`。不要删除原 Foundry 配置。

以下存储、图片和 Foundry 变量仍保留；Foundry 变量在方案 A 中仅供旧文件兼容或回退使用。

```dotenv
# 允许访问该后端的前端站点。多个站点用英文逗号分隔，必须写完整协议与域名。
APP_ALLOWED_ORIGINS=https://your-personal-site.example

# AI 对话、消息和文件索引的长期存储（现有聊天室使用的 MongoDB 可继续复用）
MONGODB_URI=mongodb+srv://...
# 用户上传和 Agent 生成文件的长期存储（容器名为 tuotuo-files）
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=...

# Foundry Agent（聊天、联网、文件分析与编辑）
FOUNDRY_PROJECT_ENDPOINT=https://your-resource.services.ai.azure.com/api/projects/your-project
FOUNDRY_AGENT_NAME=tuo-agent
# 生产环境建议锁定已验证版本；版本 10 使用 medium reasoning，并启用运行时附件槽和 tool_choice: auto
FOUNDRY_AGENT_VERSION=10
# 必须与 Agent YAML 中的 Code Interpreter 结构化输入名称一致
FOUNDRY_CODE_INTERPRETER_FILE_SLOTS=attachment_file_1,attachment_file_2,attachment_file_3
# 默认启用；Conversation ID 同时持久化到 MongoDB，失效时由数据库历史重建
FOUNDRY_USE_CONVERSATIONS=true
# MongoDB 永久保存完整历史；每次实际送给无状态模型的近期窗口与字符预算
AI_CONTEXT_MESSAGE_LIMIT=40
AI_CONTEXT_CHARACTER_BUDGET=90000
# 每个会话允许保存并检索的文件引用上限（每轮实际挂载数仍由 Agent 文件槽数量决定）
AI_SESSION_FILE_LIMIT=80
# 单个会话长期文件总量，默认 1 GiB
AI_SESSION_STORAGE_MAX_BYTES=1073741824
# 单次流式聊天的最大运行时间（毫秒），默认 20 分钟
FOUNDRY_STREAM_MAX_MS=1200000
# 发给浏览器和反向代理的 SSE 心跳间隔（毫秒），默认 15 秒
FOUNDRY_STREAM_HEARTBEAT_MS=15000

# 绘图专用：部署名必须指向 gpt-image-2。
AZURE_OPENAI_IMAGE_ENDPOINT=https://your-image-resource.openai.azure.com
AZURE_OPENAI_IMAGE_KEY=replace-with-image-resource-key
AZURE_OPENAI_IMAGE_DEPLOYMENT=gpt-image-2
AZURE_OPENAI_IMAGE_API_VERSION=2025-04-01-preview
```

部署后，所有访客都可以直接使用 AI，不需要注册、用户名或密码。浏览器会生成随机 `clientId`；MongoDB 按该标识保存会话和完整消息，Local Storage 只作为本地缓存。Foundry Conversation 用于连续调用，MongoDB 才是可恢复的历史事实源。由于当前没有账号系统，换浏览器、换设备或清除包含 `clientId` 的网站数据后，无法证明是同一位访客，也就不能自动取回原聊天。

为兼容 Cosmos DB for MongoDB 的低吞吐账户，会话、消息和文件元数据共用一个物理集合 `ai_sessions`，通过 `docType` 区分记录类型。不要分别创建 `ai_messages` 和 `ai_files` 集合；三个独立集合会各自申请最低吞吐量，可能超过账户的 RU/s 总上限。

### 流式连接与长任务

后端会从请求开始就发送 SSE 心跳，并在每次写入后尽量刷新缓冲。部署链路中的 CDN、反向代理或 Application Gateway 也必须允许 `text/event-stream` 立即透传，不能合并或缓存响应；代理超时时间应大于 `FOUNDRY_STREAM_MAX_MS`。浏览器连续 90 秒收不到包括心跳在内的任何数据时，会结束等待并保留已经生成的正文。

`FOUNDRY_STREAM_MAX_MS` 只是为单次网页连接设置的安全上限。若 Word、Excel、深度研究等任务经常超过网页请求窗口，应改用 Foundry 后台响应并由前端轮询状态，而不是无限维持一条 HTTP 连接。

## Foundry 身份

后端访问 Foundry Agent 使用 `DefaultAzureCredential`。在 Azure App Service 上建议启用托管身份，并在 Foundry 项目范围为该身份分配 `Azure AI User`（新界面中可能显示为 `Foundry User`）；本地开发可先运行 `az login`。Code Interpreter 和 Web Search 等内置工具由 Foundry Agent Service 管理认证。

## 旧版 foundry-agent 模式的行为配置来源

`tuo-agent` 在 Foundry 中保存的模型、说明和工具就是聊天行为的唯一配置来源。后端只通过 `agent_reference` 引用它，不再复制人设、搜索规则或文件生成提示词，也不会为附件临时创建另一个 Agent。

请在 Foundry 中确认该版本已经启用：

- Code Interpreter：处理、修改和生成 Word、Excel、CSV、PDF、ZIP、图表等文件。
- Web Search：由 Agent 根据自己的说明和用户问题决定何时调用。

### 配置运行时附件槽

Excel、CSV 等文件不能作为当前模型的原生 `input_file` 直接读取。后端会先通过 Files API 上传附件，再通过 structured inputs 把 file ID 挂载给同一个 Agent 的 Code Interpreter。

Foundry 门户右侧的 **YAML 标签是当前版本的只读预览**，不能直接编辑。`structured_inputs` 需要通过 SDK/REST 创建一个新 Agent 版本。仓库已提供安全脚本：

```bash
cd chat-server-main
az login

# 只读取版本 6 并预览，不修改云端
npm run foundry:enable-files -- --version 6

# 确认预览无误后，创建新版本
npm run foundry:enable-files -- --version 6 --apply
```

脚本会保留版本 6 的模型、说明、Web Search 和其他配置，只给 Code Interpreter 加入下面的运行时文件槽：

```yaml
tools:
  - type: code_interpreter
    container:
      type: auto
      file_ids:
        - "{{attachment_file_1}}"
        - "{{attachment_file_2}}"
        - "{{attachment_file_3}}"

structured_inputs:
  attachment_file_1:
    description: 第一个运行时附件的 file ID
    required: false
    default_value: ""
    schema:
      type: string
  attachment_file_2:
    description: 第二个运行时附件的 file ID
    required: false
    default_value: ""
    schema:
      type: string
  attachment_file_3:
    description: 第三个运行时附件的 file ID
    required: false
    default_value: ""
    schema:
      type: string
```

保存并发布新版本后，把 `FOUNDRY_AGENT_VERSION` 改为新版本号。三个槽位名称必须与 `FOUNDRY_CODE_INTERPRETER_FILE_SLOTS` 完全一致。后端只负责通过 `structured_inputs` 挂载附件，不覆盖 Agent 版本中的 `tool_choice`；工具选择由 Agent 自己决定。完成后，后端会删除临时上传的输入文件。

同一聊天中的文件需要在每一轮重新挂载：Foundry Conversation 不保证 Code Interpreter 临时容器目录永久存在。新版后端会把用户原始上传和 Agent 生成文件立即复制到 Azure Blob Storage，并在 MongoDB 保存会话归属和文件元数据。后续请求会从 Blob 读取相关文件、临时上传到 Foundry、完成后删除临时 Foundry 文件。文件选择优先匹配用户明确提到的文件名，其次选择最近文件，不再依赖代码解释器容器长期存活。

Agent 生成的文件通过响应中的 `container_file_citation` 注解变成网站下载卡片。更新 Foundry 中的说明或工具后应发布新版本，先验证，再修改 `FOUNDRY_AGENT_VERSION`，避免生产行为随“最新版”漂移。

## Astra 的 Toolbox + MCP 候选接入（尚未上线）

当前接入脚本使用 `@azure/ai-projects >= 2.3.1`，保留源 Agent 的模型、说明、reasoning、Code Interpreter 和 structured inputs，只将直接的 Web Search 换成专用 Toolbox 的 MCP 引用。后端继续使用 `agent_reference`，现在也能转发 MCP 连接/调用进度。

2026-09-07 已获用户授权并执行真实测试：Toolbox 和连接已创建，`gpt-5.6-sol` 对照组成功完成 MCP 搜索，但 Astra 的项目级 Responses 调用仍失败，因此没有切换 App Service。详细证据见 [TOOLBOX_VALIDATION.md](TOOLBOX_VALIDATION.md)。Astra 文件任务和 App Service 托管身份的 MCP 集成尚未通过验收。Toolbox Web Search 仍计费，API 调用成功不代表赠金覆盖。

准备顺序（默认命令只预览，`--apply` 创建配置，不执行搜索）：

```bash
export FOUNDRY_PROJECT_ENDPOINT="https://nantaisdeninis-6292-resource.services.ai.azure.com/api/projects/nantaisdeninis-6292"
npm run foundry:enable-toolbox -- --stage toolbox --toolbox tuotuo-web-search
```

首次配置可加 `--apply` 创建专用 Toolbox；当前 `tuotuo-web-search` 版本 `1` 已存在，不要重复创建。使用官方 Azure Developer CLI 指定项目 endpoint 创建连接（该 CLI 与 `az` 不同；连接 `tuotuo-web-search-conn` 当前也已存在）：

```bash
azd ai connection create tuotuo-web-search-conn --project-endpoint "$FOUNDRY_PROJECT_ENDPOINT" --kind remote-tool --target "<返回的 server_url>" --auth-type user-entra-token --audience https://ai.azure.com
```

创建连接后先预览独立候选 Agent，再加 `--apply` 创建候选版本：

```bash
npm run foundry:enable-toolbox -- --stage agent --agent tuo-agent --version 16 --target-agent tuo-agent-astra-toolbox --toolbox tuotuo-web-search --toolbox-version "<Toolbox版本>" --connection tuotuo-web-search-conn
```

脚本检查 Toolbox 仅含一个普通 `web_search`、连接类型及目标匹配。独立候选 Agent 不影响现有 `tuo-agent`。Toolbox 版本必须固定，不使用 latest；审批策略仅针对这个专用搜索 Toolbox 自动批准。不要给该固定版本添加写入工具或凭据。

上线验收：验证 Astra 普通聊天、带有效引用的真实搜索、搜索失败处理、SSE 状态、Excel/Word 输入与生成、多轮文件转换；还需使用 App Service 的实际托管身份验证远程连接，开发者登录成功不能替代此项。MCP 返回工具错误时不要将未经搜索的模型回答当成成功搜索。

只有集成验收通过并接受相应费用后，才同时设置 `FOUNDRY_AGENT_NAME=tuo-agent-astra-toolbox` 及实际候选版本。目前候选版本均不是可上线的 Astra 完整版本，尤其不要引用 latest。变更前记录线上两个原始值；回退时一并恢复。本次保留线上 `tuo-agent` / `15`，以后执行切换前应重新读取确认。

## 已移除的聊天通道（兼容说明）

以下旧聊天环境变量不再被代码读取，可以在确认新部署可用后删除：

- `AZURE_OPENAI_CHAT_ENDPOINT`
- `AZURE_OPENAI_CHAT_DEPLOYMENT`
- `AZURE_OPENAI_KEY`
- `AZURE_OPENAI_API_KEY`

`AZURE_OPENAI_IMAGE_ENDPOINT` 可以与原 Azure OpenAI 资源相同，但图片密钥必须单独用 `AZURE_OPENAI_IMAGE_KEY` 配置。

以下临时 Agent 配置也不再使用，可以删除：

- `FOUNDRY_MODEL_DEPLOYMENT`
- `AZURE_AI_MODEL_DEPLOYMENT_NAME`
- `FOUNDRY_FILE_AGENT_INSTRUCTIONS`

`TUOTUO_SITE_PASSWORD`、`TUOTUO_SESSION_SECRET` 和 `TUOTUO_SESSION_DAYS` 都是旧版访问控制配置，部署新版后不再使用，可以从 App Service 环境变量中删除。

## 文件访问策略

新部署后上传或生成的文件通过随机高熵下载链接访问，文件本体保存在 Azure Blob Storage，默认不设置自动过期时间，App Service 重启或扩容不会使其失效。删除对应 AI 会话时，后端会同时删除该会话的 Blob 文件和 MongoDB 元数据。部署前产生的旧 24 小时临时链接无法在进程重启后补救性恢复。

长期保存依赖 `MONGODB_URI` 和 `AZURE_STORAGE_CONNECTION_STRING` 同时可用；缺少任意一项时，后端会兼容性回退为旧的临时文件链接。部署后请访问 `/api/status` 确认数据库与对象存储均为正常状态。
