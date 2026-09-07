const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDefinition, toolboxUrl } = require('../scripts/enable-foundry-toolbox');

test('toolbox migration preserves persona, files, model and other tools without mutating source', () => {
    const source = { kind: 'prompt', model: 'gpt-6-astra', instructions: 'original', reasoning: { effort: 'medium' }, tool_choice: 'auto', structured_inputs: { attachment_file_1: { required: false, default_value: '' } }, tools: [{ type: 'web_search' }, { type: 'code_interpreter', container: { type: 'auto', file_ids: ['{{attachment_file_1}}'] } }, { type: 'mcp', server_label: 'other' }] };
    const before = structuredClone(source);
    const result = buildDefinition(source, 'https://example.com/mcp', 'conn');
    assert.deepEqual(source, before);
    assert.deepEqual({ ...result, tools: source.tools }, source);
    assert.deepEqual(result.tools.slice(0, 2), source.tools.slice(1));
    assert.deepEqual(result.tools[2], { type: 'mcp', server_label: 'tuotuo_web_search', server_url: 'https://example.com/mcp', project_connection_id: 'conn', require_approval: 'never' });
});

test('migration rejects duplicate migration and conflicting fixed tool choice', () => {
    assert.throws(() => buildDefinition({ kind: 'prompt', tools: [] }, 'https://example.com', 'conn'), /没有直接/);
    assert.throws(() => buildDefinition({ kind: 'prompt', tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search_preview' } }, 'https://example.com', 'conn'), /固定/);
});

test('toolbox URL pins and encodes a version and rejects credential-bearing endpoints', () => {
    assert.equal(toolboxUrl('https://example.com/api/projects/p/', 'search', '2'), 'https://example.com/api/projects/p/toolboxes/search/versions/2/mcp?api-version=v1');
    assert.throws(() => toolboxUrl('https://user:secret@example.com', 'search', '2'), /凭据/);
});
