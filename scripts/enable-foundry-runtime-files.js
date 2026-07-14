#!/usr/bin/env node

const { DefaultAzureCredential } = require('@azure/identity');
const { AIProjectClient } = require('@azure/ai-projects');

const DEFAULT_SLOTS = 'attachment_file_1,attachment_file_2,attachment_file_3';

function readArg(name) {
    const index = process.argv.indexOf(name);
    if (index === -1) return '';
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) {
        throw new Error(`${name} 后面缺少参数值。`);
    }
    return value;
}

function printHelp() {
    console.log(`
为 Foundry Agent 的 Code Interpreter 添加运行时文件槽。

默认只预览将要发布的 definition，不会修改云端。

用法：
  npm run foundry:enable-files -- --version 6
  npm run foundry:enable-files -- --version 6 --apply

参数：
  --endpoint <url>   Foundry 项目 endpoint（也可用 FOUNDRY_PROJECT_ENDPOINT）
  --agent <name>     Agent 名称（默认 FOUNDRY_AGENT_NAME 或 tuo-agent）
  --version <value>  要复制的源版本（也可用 FOUNDRY_AGENT_VERSION）
  --slots <a,b,c>    文件槽名称
  --apply            确认创建新 Agent 版本
`);
}

function parseSlots(value) {
    const slots = String(value || DEFAULT_SLOTS)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

    if (!slots.length) throw new Error('至少需要一个运行时文件槽。');
    if (slots.length > 8) throw new Error('运行时文件槽最多配置 8 个。');
    if (new Set(slots).size !== slots.length) throw new Error('运行时文件槽不能重名。');

    for (const slot of slots) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(slot)) {
            throw new Error(`文件槽名称不合法：${slot}`);
        }
    }
    return slots;
}

function buildDefinition(sourceDefinition, slots) {
    if (!sourceDefinition || sourceDefinition.kind !== 'prompt') {
        throw new Error('脚本只支持 kind: prompt 的 Foundry Agent。');
    }

    const definition = JSON.parse(JSON.stringify(sourceDefinition));
    const tools = Array.isArray(definition.tools) ? definition.tools : [];
    let codeInterpreterFound = false;

    definition.tools = tools.map((tool) => {
        if (!tool || tool.type !== 'code_interpreter') return tool;
        codeInterpreterFound = true;
        const oldContainer = tool.container && typeof tool.container === 'object'
            ? tool.container
            : {};
        return {
            ...tool,
            container: {
                ...oldContainer,
                type: 'auto',
                file_ids: slots.map((slot) => `{{${slot}}}`)
            }
        };
    });

    if (!codeInterpreterFound) {
        throw new Error('源 Agent 没有启用 Code Interpreter，请先在 Foundry 左侧“工具”中添加。');
    }

    definition.structured_inputs = {
        ...(definition.structured_inputs || {})
    };
    for (const [index, slot] of slots.entries()) {
        definition.structured_inputs[slot] = {
            description: `第 ${index + 1} 个运行时附件的 file ID`,
            required: false,
            default_value: '',
            schema: { type: 'string' }
        };
    }

    return definition;
}

async function main() {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        printHelp();
        return;
    }

    const endpoint = readArg('--endpoint')
        || process.env.FOUNDRY_PROJECT_ENDPOINT
        || process.env.AZURE_AI_PROJECT_ENDPOINT
        || process.env.AZURE_FOUNDRY_PROJECT_ENDPOINT;
    const agentName = readArg('--agent')
        || process.env.FOUNDRY_AGENT_NAME
        || process.env.AZURE_AI_AGENT_NAME
        || 'tuo-agent';
    const sourceVersion = readArg('--version')
        || process.env.FOUNDRY_AGENT_VERSION
        || process.env.AZURE_AI_AGENT_VERSION;
    const slots = parseSlots(readArg('--slots')
        || process.env.FOUNDRY_CODE_INTERPRETER_FILE_SLOTS
        || DEFAULT_SLOTS);
    const apply = process.argv.includes('--apply');

    if (!endpoint) throw new Error('缺少 Foundry 项目 endpoint。请配置 FOUNDRY_PROJECT_ENDPOINT 或传入 --endpoint。');
    if (!sourceVersion) throw new Error('缺少源 Agent 版本。请配置 FOUNDRY_AGENT_VERSION 或传入 --version。');

    const project = new AIProjectClient(endpoint, new DefaultAzureCredential());
    console.log(`正在读取 ${agentName} 版本 ${sourceVersion} ...`);
    const source = await project.agents.getVersion(agentName, String(sourceVersion));
    const definition = buildDefinition(source.definition, slots);

    if (!apply) {
        console.log('\n预览完成：云端未做任何修改。');
        console.log(JSON.stringify(definition, null, 2));
        console.log('\n确认无误后，在同一条命令末尾加 --apply 创建新版本。');
        return;
    }

    const created = await project.agents.createVersion(agentName, definition, {
        description: source.description,
        metadata: source.metadata
    });
    console.log(`\n已创建 ${created.name} 版本 ${created.version}。`);
    console.log(`请将 App Service 的 FOUNDRY_AGENT_VERSION 更新为 ${created.version}，然后重启应用。`);
    console.log(`FOUNDRY_CODE_INTERPRETER_FILE_SLOTS=${slots.join(',')}`);
}

if (require.main === module) {
    main().catch((error) => {
        const detail = error && error.message ? error.message : String(error);
        console.error(`\n操作失败：${detail}`);
        if (/credential|authentication|unauthorized|forbidden|Azure CLI/i.test(detail)) {
            console.error('本地运行前请先执行 az login，并确认当前身份有 Agent 读取/创建版本权限。');
        }
        process.exitCode = 1;
    });
}

module.exports = { buildDefinition, parseSlots };
