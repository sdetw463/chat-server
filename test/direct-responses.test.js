const test = require('node:test');
const assert = require('node:assert/strict');
const { resourceBaseURL, buildDirectRequest } = require('../lib/direct-responses');

test('direct resource URL accepts only HTTPS resource roots or v1 paths', () => {
    assert.equal(resourceBaseURL('https://example.openai.azure.com'), 'https://example.openai.azure.com/openai/v1/');
    assert.equal(resourceBaseURL('https://example.openai.azure.com/openai/v1/'), 'https://example.openai.azure.com/openai/v1/');
    for (const url of ['http://example.com', 'https://example.com/api/projects/test', 'https://user:secret@example.com', 'https://example.com/?key=secret']) {
        assert.throws(() => resourceBaseURL(url));
    }
});

test('direct request uses Astra medium, native tools, and actual uploaded file IDs', () => {
    const history = [{ role: 'user', content: '第一问' }, { role: 'assistant', content: '第一答' }];
    const currentMessage = { role: 'user', content: '请修改文件' };
    const request = buildDirectRequest({ history, currentMessage, uploadedFiles: [{ id: 'file-real' }] }, {});
    assert.equal(request.model, 'gpt-6-astra');
    assert.deepEqual(request.reasoning, { effort: 'medium' });
    assert.deepEqual(request.input, [...history, currentMessage]);
    assert.deepEqual(request.tools, [{ type: 'web_search' }, { type: 'code_interpreter', container: { type: 'auto', file_ids: ['file-real'] } }]);
    assert.match(request.instructions, /TuoTuo/);
    for (const key of ['conversation', 'previous_response_id', 'agent_reference', 'structured_inputs']) assert.equal(Object.hasOwn(request, key), false);
    assert.equal(history.length, 2);
});

test('direct chat still offers file generation with no attachment and validates effort', () => {
    const args = { history: [], currentMessage: { role: 'user', content: '创建 Word' }, uploadedFiles: [] };
    assert.deepEqual(buildDirectRequest(args, {}).tools[1].container.file_ids, []);
    assert.throws(() => buildDirectRequest(args, { AZURE_RESPONSES_REASONING_EFFORT: 'invalid' }));
});
