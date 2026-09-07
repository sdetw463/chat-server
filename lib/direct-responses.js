'use strict';

const fs = require('node:fs');
const path = require('node:path');
const OpenAI = require('openai');
const { getBearerTokenProvider } = require('@azure/identity');

function resourceBaseURL(endpoint) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || !['/', '/openai/v1', '/openai/v1/'].includes(url.pathname)) {
        throw new Error('AZURE_RESPONSES_ENDPOINT 必须是资源级 HTTPS 地址，不能填写 Foundry 项目地址。');
    }
    url.pathname = '/openai/v1/';
    return url.href;
}

function createDirectClient(credential, env = process.env) {
    return new OpenAI({
        baseURL: resourceBaseURL(env.AZURE_RESPONSES_ENDPOINT),
        apiKey: getBearerTokenProvider(credential, 'https://ai.azure.com/.default'),
        // Avoid silently repeating billable file/tool execution after ambiguous failures.
        maxRetries: 0
    });
}

const instructions = fs.readFileSync(path.join(__dirname, '../config/chat-instructions.md'), 'utf8');

function buildDirectRequest({ history, currentMessage, uploadedFiles }, env = process.env) {
    const effort = env.AZURE_RESPONSES_REASONING_EFFORT || 'medium';
    if (!['low', 'medium', 'high'].includes(effort)) throw new Error('不支持的 AZURE_RESPONSES_REASONING_EFFORT。');
    return {
        model: env.AZURE_RESPONSES_DEPLOYMENT || 'gpt-6-astra',
        instructions,
        reasoning: { effort },
        // MongoDB is the durable history source. Never reuse project-scoped
        // conversation IDs or deleted uploaded-file IDs on this resource route.
        input: [...history, currentMessage],
        tools: [
            { type: 'web_search' },
            { type: 'code_interpreter', container: { type: 'auto', file_ids: uploadedFiles.map(file => file.id) } }
        ],
        tool_choice: 'auto'
    };
}

module.exports = { resourceBaseURL, createDirectClient, buildDirectRequest };
