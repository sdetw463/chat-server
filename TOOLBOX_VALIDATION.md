# Toolbox + MCP 实测记录

日期：2026-09-07。用户已明确授权实际模型和搜索测试。未推送 GitHub，未切换生产 Agent。

后续更新：用户选择了方案 A，现已另行实现资源级 Responses 后端，见 `DEPLOYMENT_AI.md`。本文记录的是此前 Toolbox 排障阶段，不代表目前网站仍调用 Foundry Agent。原 Agent name/version 保留用于回退。

## 云端配置

- 项目：`https://nantaisdeninis-6292-resource.services.ai.azure.com/api/projects/nantaisdeninis-6292`
- Toolbox：`tuotuo-web-search`，版本 `1`，仅含普通 `web_search`。
- MCP：`https://nantaisdeninis-6292-resource.services.ai.azure.com/api/projects/nantaisdeninis-6292/toolboxes/tuotuo-web-search/versions/1/mcp?api-version=v1`
- 项目连接：`tuotuo-web-search-conn`，RemoteTool，UserEntraToken，audience `https://ai.azure.com`。
- 测试 Agent：`tuo-agent-astra-toolbox`，不是生产 Agent。
- 生产保留：`tuo-agent` / `15`。

## 实测结果

| 测试 | 结果 |
| --- | --- |
| MCP initialize、tools/list | HTTP 200，返回 web_search 工具定义 |
| 候选 v1：Astra，medium，Code Interpreter + MCP | HTTP 400，`reasoning.effort` unsupported_parameter |
| 候选 v2：同上，省略 reasoning | HTTP 500，server_error |
| 候选 v3：同套配置改为 gpt-5.6-sol、medium | 成功；约 26.9 秒；mcp_call completed，实际返回搜索结果及 Microsoft Learn 链接 |
| 候选 v4：Astra，仅 MCP，无 reasoning/Code Interpreter/附件槽 | HTTP 500，server_error |
| Astra：项目级 Responses，无工具，提示 Reply only OK | HTTP 500，server_error |
| 同一个 Astra 部署：资源级 Responses，无工具，相同提示 | completed，约 4.8 秒，回复 OK |

Astra 部署：`gpt-6-astra`，模型版本 `2026-09-03`，GlobalStandard。资源级地址为 `https://nantaisdeninis-6292-resource.cognitiveservices.azure.com/openai/v1/`。

以上结果把故障范围缩小到 Foundry 项目级 Astra 调用路径，不能仅凭这些响应确定微软内部具体根因。Toolbox 配置成功不等于 Astra Agent 可用；也不能将 v3 对照组当作 Astra 搜索成功。省略 reasoning 没有解决问题，所以没有更改生产推理配置。

## 支持请求可用证据

- v1 不支持 reasoning：request_id `09f53fc9d519ecfe9b2da399536ac11e`。
- v2 500：错误正文请求 ID `f4e9b972-d275-424a-84d0-7a0642c3d421`；request_id `b2ea209a85b6085788a1524f09e5a746`。
- v4 500：错误正文请求 ID `e019da49-71a9-40c7-b887-2054db924d1a`；request_id `34408a4cdbcff369616851361e9ceb73`。
- 项目级无工具 500：错误正文请求 ID `8ceff1d2-1e90-4452-b873-1162922aa08d`；request_id `256ceb89e6cb8c670e5ab4efe1cea69a`。
- Sol MCP 搜索成功：response ID `resp_07f4744d8026857d006a9e9f6fd8f881968c84f9339fd062a9`。

## 后续验收条件

1. 项目级 Astra 无工具 Responses 成功。
2. Astra + MCP 实际搜索成功，不能只检查最终文字或 HTTP 状态；必须检查 mcp_call 无错误且有真实结果。
3. 完整候选保留原 Agent 说明、文件槽、Code Interpreter，验证文件输入、生成、多轮文件复用及网站 SSE。
4. 使用 App Service 托管身份验证远程连接；本次开发者身份成功不能替代此项。
5. 以上通过后才锁定明确版本并切换生产，同时保留旧 name/version 作为回退。

不要将候选 v4（排障用的精简配置）或 latest 配置给网站。目前没有经过验收的完整 Astra Toolbox Agent。直接调用资源级模型 API 是另一种架构，需要单独实现，不能视为本方案已完成。

官方配置依据：https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/web-search
