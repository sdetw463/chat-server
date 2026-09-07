#!/usr/bin/env node
'use strict';

const { AIProjectClient } = require('@azure/ai-projects');
const { DefaultAzureCredential } = require('@azure/identity');

function buildDefinition(source, serverUrl, connection) {
    if (source?.kind !== 'prompt') throw new Error('只支持 Prompt Agent。');
    const definition = structuredClone(source);
    if (!definition.tools?.some(t => ['web_search', 'web_search_preview'].includes(t.type))) {
        throw new Error('源版本没有直接 Web Search；请核对源版本，避免重复迁移。');
    }
    if (!connection) throw new Error('必须提供远程工具项目连接。');
    if (definition.tools.some(t => t.server_label === 'tuotuo_web_search')) {
        throw new Error('源版本已经有同名 MCP 工具。');
    }
    if (definition.tool_choice && !['auto', 'required', 'none'].includes(definition.tool_choice)) {
        throw new Error('源版本固定了特定工具，请先人工核对 tool_choice。');
    }
    definition.tools = definition.tools.filter(t => !['web_search', 'web_search_preview'].includes(t.type));
    definition.tools.push({
        type: 'mcp', server_label: 'tuotuo_web_search', server_url: serverUrl,
        project_connection_id: connection,
        // This dedicated, pinned toolbox must contain only the read-only web search tool.
        require_approval: 'never'
    });
    return definition;
}

function toolboxUrl(endpoint, name, version) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('项目 endpoint 必须是没有凭据或查询参数的 HTTPS URL。');
    }
    return `${endpoint.replace(/\/$/, '')}/toolboxes/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/mcp?api-version=v1`;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
        console.log('用法：\n  --stage toolbox --endpoint URL --toolbox NAME [--apply]\n  --stage agent --endpoint URL --toolbox NAME --toolbox-version VERSION --connection NAME --agent NAME --version SOURCE_VERSION --target-agent TEST_NAME [--apply]\n默认预览。只配置资源，不执行模型/搜索，不切换 App Service。远程连接使用官方 azd ai connection create 命令创建。');
        return;
    }
    const allowed = new Set(['--stage', '--endpoint', '--toolbox', '--toolbox-version', '--connection', '--agent', '--version', '--target-agent']);
    const options = {};
    let apply = false;
    for (let i = 0; i < args.length; i++) {
        const key = args[i];
        if (key === '--apply') { apply = true; continue; }
        if (!allowed.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`参数错误：${key}`);
        options[key.slice(2)] = args[++i];
    }
    const endpoint = options.endpoint || process.env.FOUNDRY_PROJECT_ENDPOINT;
    if (!endpoint) throw new Error('缺少 --endpoint。');
    const name = options.toolbox || 'tuotuo-web-search';
    toolboxUrl(endpoint, name, '1');
    const project = new AIProjectClient(endpoint, new DefaultAzureCredential());
    if (options.stage === 'toolbox') {
        const tools = [{ type: 'web_search' }];
        console.log(JSON.stringify({ name, tools, apply }, null, 2));
        if (apply) {
            // Do not overwrite or append versions to a pre-existing toolbox.
            for await (const existing of project.toolboxes.list()) {
                if (existing.name === name) throw new Error('Toolbox 已存在，请检查并显式引用其版本。');
            }
            const created = await project.toolboxes.createVersion(name, tools, { description: 'TuoTuo read-only web search; billing and Astra validation pending' });
            console.log(JSON.stringify({ toolbox: created.name, version: created.version, server_url: toolboxUrl(endpoint, created.name, created.version) }, null, 2));
        }
        return;
    }
    if (options.stage !== 'agent') throw new Error('--stage 必须是 toolbox 或 agent。');
    for (const key of ['toolbox-version', 'connection', 'version', 'target-agent']) {
        if (!options[key]) throw new Error(`缺少 --${key}。`);
    }
    const sourceName = options.agent || 'tuo-agent';
    if (options['target-agent'] === sourceName) throw new Error('请使用独立测试 Agent 名称，不在生产 Agent 上创建未验证版本。');
    const serverUrl = toolboxUrl(endpoint, name, options['toolbox-version']);
    const toolbox = await project.toolboxes.getVersion(name, options['toolbox-version']);
    if (toolbox.tools?.length !== 1 || toolbox.tools[0].type !== 'web_search' || toolbox.tools[0].custom_search_configuration) {
        throw new Error('只允许包含一个普通 web_search 工具的专用 Toolbox。');
    }
    const conn = await project.connections.get(options.connection);
    if (conn.target !== serverUrl || conn.type !== 'RemoteTool') throw new Error('远程连接类型或目标与 Toolbox 固定版本不匹配。');
    const source = await project.agents.getVersion(sourceName, options.version);
    const definition = buildDefinition(source.definition, serverUrl, options.connection);
    console.log(JSON.stringify({ target: options['target-agent'], definition, apply }, null, 2));
    if (apply) {
        const created = await project.agents.createVersion(options['target-agent'], definition, { description: `Toolbox candidate from ${sourceName}:${options.version}; not production verified` });
        console.log(JSON.stringify({ name: created.name, version: created.version, productionReady: false }, null, 2));
    }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildDefinition, toolboxUrl };
