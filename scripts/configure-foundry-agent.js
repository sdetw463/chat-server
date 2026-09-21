#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DefaultAzureCredential } = require('@azure/identity');
const { createFoundryClients } = require('../lib/foundry-agent');
const { buildDefinition: withFileSlots } = require('./enable-foundry-runtime-files');
const { MAX_ATTACHMENTS } = require('../lib/file-limits');

function buildDefinition(source) {
    const slots = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => `attachment_file_${i + 1}`);
    const definition = withFileSlots(source, slots);
    definition.model = 'gpt-6-astra';
    definition.reasoning = { effort: 'high', summary: 'auto' };
    definition.instructions = fs.readFileSync(path.join(__dirname, '../config/chat-instructions.md'), 'utf8');
    definition.tools = (definition.tools || []).map(tool => tool?.type === 'web_search'
        ? { ...tool, search_context_size: 'high' }
        : tool);
    return definition;
}

async function main() {
    const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
    const name = process.env.FOUNDRY_AGENT_NAME || 'tuo-agent';
    const version = process.env.FOUNDRY_AGENT_VERSION;
    if (!endpoint || !version) throw new Error('请设置 FOUNDRY_PROJECT_ENDPOINT 和作为源版本的 FOUNDRY_AGENT_VERSION。');
    const { project } = createFoundryClients(endpoint, new DefaultAzureCredential());
    const source = await project.agents.getVersion(name, version);
    const definition = buildDefinition(source.definition);
    if (!process.argv.includes('--apply')) {
        console.log(JSON.stringify({ name, sourceVersion: version, definition }, null, 2));
        return;
    }
    const created = await project.agents.createVersion(name, definition, { description: 'Astra high, broader web search, detailed responses, 10 runtime attachments' });
    console.log(JSON.stringify({ name: created.name, version: created.version }));
    console.log('请先测试新版本，再更新 App Service 的 FOUNDRY_AGENT_VERSION；此命令不会切换线上配置。');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildDefinition };
