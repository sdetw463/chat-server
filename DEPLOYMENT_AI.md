# TuoTuo AI 服务

2026-09-17 起统一使用 Azure Foundry Agent Service。资源级 Astra 直连客户端、后端选择开关和 Toolbox 迁移方案已移除。图片生成仍使用独立 GPT Image 2 API。

## 线上配置

- App Service：`tuotuo`，资源组 `web`，Node.js 22，1个实例，Always On。
- Project：`https://nantaisdeninis-6292-resource.services.ai.azure.com/api/projects/nantaisdeninis-6292`
- `FOUNDRY_AGENT_NAME=tuo-agent`
- `FOUNDRY_AGENT_VERSION=17`
- 代理模型：`gpt-6-astra`
- 推理配置：`effort=high`，`summary=auto`。
- 工具：原生 `web_search`、`code_interpreter`。
- 文件槽：`attachment_file_1` 到 `attachment_file_10`，可选、空默认值。
- `FOUNDRY_USE_CONVERSATIONS=true`，使用 Foundry conversation 保持多轮上下文，数据库历史用于首次创建或恢复。
- `APP_ALLOWED_ORIGINS=https://tuotuo.love`
- `WEBSITES_CONTAINER_START_TIME_LIMIT=600`：给平台证书更新、依赖解包和Node冷启动留足时间。

Azure 托管身份已有项目资源上的 Foundry Agent Consumer / Foundry User 权限。密钥保存在 App Service 配置，禁止提交 `.env`。MongoDB、Blob 和图片服务的现有配置继续使用。

聊天已不读取 `AI_CHAT_BACKEND` 或任何 `AZURE_RESPONSES_*` 变量。Agent版本控制模型和推理配置，更新时固定具体版本，不使用latest。

## 构建与修改代理

```bash
npm ci
npm test
npm run check
```

修改 `config/chat-instructions.md` 后，用 `npm run foundry:configure` 预览基于 `FOUNDRY_AGENT_VERSION` 的新定义；添加 `-- --apply` 创建新版本。脚本固定 Astra/high 和10个附件槽，不会自行切换线上。测试新版本后更新 App Service 的 `FOUNDRY_AGENT_VERSION`。

## 请求与存储

`lib/foundry-agent.js` 只构造项目级客户端，Responses 禁止自动重试以防重复执行工具。文件传输和幂等数据库操作允许有限重试。初始上游响应默认等待最多180秒；已建立的流没有默认总时长上限，可通过 `FOUNDRY_STREAM_MAX_MS` 显式设置。SSE每15秒心跳，断开/停止通过AbortSignal传递到模型和上传。

每个用户/会话同一时间只允许一个生成请求，重复请求返回409。该互斥目前在单Node进程内，与当前单实例部署一致；横向扩容前需要数据库租约或共享锁。会话同步、完成持久化和删除共用短时写锁。模型成功但数据库临时失败时返回 `historyWarning`，浏览器保留完整回复继续重试同步。

会话、消息、文件共用 `ai_sessions` 集合，通过 `docType` 隔离。`clientCreatedAt` / `clientUpdatedAt` 索引支持先排序再限量读取；初始化历史最多2个会话并发读取，降低 Cosmos 限流。浏览器保存全部本地历史；服务端返回每个会话最近300条、最多80个近期或置顶会话，不删除更早数据库记录。

删除立即标记会话不可用、移除活动记录，`lib/session-gc.js` 持久保存文件和conversation清理任务并后台重试，不等待Azure上游释放资源。清理仅作用于原用户/会话；历史直连副本的scope不匹配时保留回收元数据，不向新项目发送错误删除请求。

## 文件

单文件200MiB、单轮500MiB、最多10个附件。网页4MiB分块上传，Blob持久保存原件，Foundry Files用磁盘流发送；特殊扩展名仍用无损ZIP封装。每个会话默认最多80个文件、1GiB持久存储。上游文件同项目校验后复用24小时。下载Blob使用流式传输，避免整文件常驻Node内存。临时分块目录支持超时及服务重启后的遗留清理。

下载链接使用随机192bit bearer token；持有链接的人可下载。保持原有访问行为。AI入口仍沿用网站既有昵称资格与活跃WebSocket token，不是完整账号认证系统。

## 实测证据（2026-09-17）

- 代理17：普通流式回复、两轮代号记忆、官方来源联网搜索均完成。
- Code Interpreter读取合成CSV、求和42、生成result.txt，下载内容正确。
- 项目Files上传/下载110MiB合成数据，SHA-256一致，测试文件已清理。
- 本地后端70项测试通过，包括SSE/取消/并发、文件/下载、删除回收、WebSocket与历史。
- 前端20项DOM回归通过；桌面和390px手机布局验证，零尺寸玻璃初始化错误已修复。
- npm依赖审计无已知漏洞（验证当时）。

## 发布与回退

GitHub `main` 推送触发测试和Azure部署；使用package-lock及npm ci。部署显式clean/restart，避免旧模块残留；应用数据持久保存于MongoDB/Blob，不在部署目录。先更新后端配置和代码，检查 `/api/status`，再验证真实AI流、工具、文件与历史，最后发布前端。

回退需同步恢复旧Git提交和旧App Service配置，因为旧直连变量已经不属于新实现。数据库原有聊天、照片、日记和附件不因代码发布清空。
