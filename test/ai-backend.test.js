const test = require('node:test');
const assert = require('node:assert/strict');

const { _test } = require('../server');
const { buildDefinition } = require('../scripts/enable-foundry-runtime-files');

test('normal chat forwards the user message without a duplicate backend persona', () => {
    const text = _test.buildFoundryAgentUserMessage('你好，介绍一下你自己。', [], 'normal');
    assert.equal(text, '你好，介绍一下你自己。');
    assert.doesNotMatch(text, /本轮由 Foundry Agent|代码解释器|Web Search|系统提示词/);
});

test('reasoning modes add only a short per-request user preference', () => {
    assert.match(_test.buildFoundryAgentUserMessage('比较两个方案', [], 'think'), /^请仔细分析后回答。/);
    assert.match(_test.buildFoundryAgentUserMessage('查资料', [], 'research'), /^请对下面的问题进行深入研究/);
});

test('uploaded documents are described in the message instead of using unsupported native input_file', async () => {
    const content = await _test.buildFoundryAgentUserContent(
        '修改这个文件',
        [{
            name: '计划.csv',
            mimeType: 'text/csv',
            fileData: 'data:text/csv;base64,eCx5CjEsMgo='
        }],
        [],
        'normal',
        [],
        'public'
    );

    assert.equal(content.length, 1);
    assert.deepEqual(content[0], {
        type: 'input_text',
        text: '修改这个文件\n\n本轮已附加文件：\n- 计划.csv'
    });
});

test('uploaded file IDs are mapped to Code Interpreter structured input slots', () => {
    assert.deepEqual(_test.buildFoundryFileStructuredInputs([
        { id: 'assistant-file-1' },
        { id: 'assistant-file-2' }
    ]), {
        attachment_file_1: 'assistant-file-1',
        attachment_file_2: 'assistant-file-2',
        attachment_file_3: ''
    });
});

test('attachment requests do not override the Agent tool choice', () => {
    const currentMessage = { type: 'message', role: 'user', content: [] };
    const requestBody = _test.buildFoundryResponseRequestBody({
        conversationId: 'conv-1',
        history: [],
        currentMessage
    });

    assert.deepEqual(requestBody, {
        conversation: 'conv-1',
        input: [currentMessage]
    });
    assert.equal(Object.hasOwn(requestBody, 'tool_choice'), false);
});

test('new uploaded files are registered as reusable session files', () => {
    const files = _test.registerFoundryInputSessionFiles([{
        id: 'file_uploaded_once',
        filename: '原始论文.docx',
        persistent: true,
        isNewSessionFile: true
    }, {
        id: 'file_temporary',
        filename: 'temporary.pdf',
        persistent: false,
        isNewSessionFile: false
    }], 'user-1');

    assert.equal(files.length, 1);
    assert.equal(files[0].filename, '原始论文.docx');
    assert.match(files[0].url, /^\/api\/ai-agent-file\//);
});

test('optional Foundry file slots include empty defaults and preserve existing tools', () => {
    const definition = buildDefinition({
        kind: 'prompt',
        model: 'gpt-test',
        instructions: '保留原说明',
        tools: [
            { type: 'web_search' },
            { type: 'code_interpreter', container: { type: 'auto' } }
        ]
    }, ['attachment_file_1', 'attachment_file_2']);

    assert.equal(definition.instructions, '保留原说明');
    assert.deepEqual(definition.tools[0], { type: 'web_search' });
    assert.deepEqual(definition.tools[1].container.file_ids, [
        '{{attachment_file_1}}',
        '{{attachment_file_2}}'
    ]);
    assert.deepEqual(definition.structured_inputs.attachment_file_1, {
        description: '第 1 个运行时附件的 file ID',
        required: false,
        default_value: '',
        schema: { type: 'string' }
    });
});

test('conversation seed preserves roles instead of flattening history into prompt text', () => {
    assert.deepEqual(_test.buildConversationSeed([
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答' }
    ]), [
        { type: 'message', role: 'user', content: '第一问' },
        { type: 'message', role: 'assistant', content: '第一答' }
    ]);
});

test('only official container file citations become download cards', () => {
    const files = _test.extractGeneratedFiles({
        output: [
            { type: 'code_interpreter_call', file_id: 'input-file-should-not-leak' },
            {
                type: 'message',
                content: [{
                    type: 'output_text',
                    text: '文件已生成',
                    annotations: [{
                        type: 'container_file_citation',
                        file_id: 'cfile_123',
                        container_id: 'cntr_123',
                        filename: '结果.xlsx'
                    }]
                }]
            }
        ]
    }, 'public');

    assert.equal(files.length, 1);
    assert.equal(files[0].filename, '结果.xlsx');
    assert.match(files[0].url, /^\/api\/ai-agent-file\//);
});

test('web citations are extracted from response annotations and web search output', () => {
    const sources = _test.extractCitationSources({
        output: [{
            type: 'message',
            content: [{
                type: 'output_text',
                annotations: [{ type: 'url_citation', title: 'Microsoft', url: 'https://learn.microsoft.com/a' }]
            }]
        }, {
            type: 'web_search_call',
            action: { sources: [{ title: 'Azure', url: 'https://azure.microsoft.com/b' }] }
        }]
    });

    assert.deepEqual(sources, [
        { title: 'Microsoft', url: 'https://learn.microsoft.com/a' },
        { title: 'Azure', url: 'https://azure.microsoft.com/b' }
    ]);
});

test('gpt-image-2 sizes comply with arbitrary-resolution constraints', () => {
    assert.equal(_test.resolveImageSize('9:16', '', ''), '1008x1792');
    assert.equal(_test.resolveImageSize('auto', '', '1234x987'), '1024x1024');
    assert.equal(_test.resolveImageSize('auto', '', '1536x1152'), '1536x1152');
});

test('invalid or oversized attachment payloads are rejected before Foundry is called', () => {
    assert.throws(() => _test.validateAgentRequest({
        userMessage: '读取附件',
        documents: [{ name: 'bad.pdf', fileData: 'not-a-data-url' }],
        images: [],
        historyMessages: [],
        sessionFiles: []
    }), /附件.*无效/);
});
