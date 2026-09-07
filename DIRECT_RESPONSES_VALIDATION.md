# 方案 A 部署与验证记录

日期：2026-09-07。用户授权实际测试和方案 A 实施。GitHub 未提交。

## 已部署

- App Service：`tuotuo`，资源组 `web`。
- `AI_CHAT_BACKEND=direct-responses`
- `AZURE_RESPONSES_ENDPOINT=https://nantaisdeninis-6292-resource.cognitiveservices.azure.com`
- `AZURE_RESPONSES_DEPLOYMENT=gpt-6-astra`
- `AZURE_RESPONSES_REASONING_EFFORT=medium`
- 采用 App Service 现有托管身份，无新增模型密钥或权限分配。
- 生图路由和 `gpt-image-2` 配置没有修改。
- 本地新代码文件：`lib/direct-responses.js`、`config/chat-instructions.md`，以及 `server.js` 中的显式后端分流和文件兼容逻辑。

## 实测

| 验证 | 结果 |
| --- | --- |
| 本地自动化测试 | 28 项通过，含直接后端 HTTP 附件挂载与文件下载测试 |
| Astra 资源级原生 Web Search | 实际 web_search_call 完成并返回 URL citation |
| Astra 资源级 Word 生成 | 返回有效 DOCX，下载文件 ZIP 签名正确 |
| 下一轮重新挂载原 DOCX 并生成 PDF | 成功，包含代码解释器的 SSE 进度事件和 PDF 下载引用；环境没有完整 Word/LibreOffice，替代渲染不保证任意排版保真 |
| 线上普通聊天 | HTTP 200，约 3.9 秒，conversation=null，未沿用项目级 Conversation |
| 线上 SSE | HTTP 200，收到 status、delta、done，正文为“流式连接正常”，无 error |
| 最终重启后验收 | HTTP 200，backend=direct-responses、model=gpt-6-astra、usedAgent=false、conversation=null，回复 OK；三个运行代码文件与本地内容逐字节一致 |
| 线上搜索 | HTTP 200，约 35.7 秒，返回 Azure 官网产品页及结构化 sources；Microsoft Learn 页面未返回正文时，模型换官方产品页核实 |
| 线上 Excel 生成 | 约 14.1 秒，numbers.xlsx，Blob + MongoDB 长期保存成功 |
| 线上跨轮原文件读取 | 未传历史或 sessionFiles，仅使用同一测试会话；自动恢复 numbers.xlsx，下载的 sum.txt 为 18，符合 7+11 |
| 线上重新上传并修改 Excel | 约 21.3 秒，A1 改为 30、B1 保持 11，另存 Excel；下载的 edited-sum.txt 为 41 |
| 测试数据清理 | 两个独立测试会话通过 DELETE 接口清理，未触碰真实用户会话或星空寄语 |

这些是小样本功能验证，不是速度保证。外部搜索结果和代码解释器环境可能影响耗时、可用性与格式保真。

另在启动日志中观察到已有历史同步接口的 Cosmos DB for MongoDB `16500 / 429 TooManyRequests`（批量历史写入限流）。方案 A 的上述测试读写成功，但不能据此声称历史同步没有限流风险。本次没有扩容数据库、提高 RU/s 或更改计费设置；这一问题应单独优化批量同步/重试策略。

## 回退与仓库同步

原线上 server.js 已备份到 App Service 的 `/home/data/tuotuo-server-before-astra-20260907.js`，不在公开网站目录。原 `FOUNDRY_AGENT_NAME=tuo-agent` / `FOUNDRY_AGENT_VERSION=15` 未删除。

正常回退使用新代码，将 `AI_CHAT_BACKEND` 改为 `foundry-agent` 即可。持久化原文件使用 Blob，跨后端仍可读取；旧项目级历史保留在 MongoDB 中。临时文件授权不具有跨重启的长期保证。

用户提交后端仓库时务必包含 `lib/` 和 `config/`，以及更新后的 server.js、package.json、scripts/、test/ 和部署文档。此次没有修改前端。仅复制 server.js 会因缺少新模块而启动失败。

方案 A 的人设现在由 `config/chat-instructions.md` 管理，内容迁移自 Foundry Agent v15。继续在 Foundry 门户编辑旧 Agent 不会改变方案 A 的行为。

官方 API 依据：https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses
