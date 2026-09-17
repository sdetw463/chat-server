'use strict';
const path = require('node:path').posix;

function linkedSandboxPaths(response) {
    const paths = new Set();
    for (const item of response?.output || []) {
        if (item?.type !== 'message') continue;
        for (const part of item.content || []) {
            for (const match of String(part.text || '').matchAll(/sandbox:(\/mnt\/data\/[^\s)\]>"']+)/g)) {
                let value;
                try { value = decodeURIComponent(match[1]); } catch { continue; }
                if (!value.includes('\0') && !value.includes('\\') && path.normalize(value) === value && value.startsWith('/mnt/data/')) paths.add(value);
            }
        }
    }
    return [...paths].slice(0, 12);
}

// Foundry can omit container_file_citation when a later web-search answer
// repeats a sandbox link. A model-written path alone never grants access:
// resolve only actual assistant-created files in this response's completed
// code-interpreter containers, via the authenticated project's Files API.
async function resolveLinkedGeneratedFiles(response, citations, openai, { signal } = {}) {
    signal?.throwIfAborted();
    const linked = linkedSandboxPaths(response);
    const unresolved = new Set(linked.filter(value => !citations.some(c => c.filename === path.basename(value))));
    const containers = [...new Set((response?.output || []).filter(item => item?.type === 'code_interpreter_call' && item.status === 'completed' && item.container_id).map(item => item.container_id))].reverse().slice(0, 8);
    const recovered = [];
    for (const containerId of containers) {
        if (!unresolved.size) break;
        signal?.throwIfAborted();
        let visited = 0;
        for await (const file of openai.containers.files.list(containerId, { limit: 100 }, { signal, timeout: 15000, maxRetries: 1 })) {
            signal?.throwIfAborted();
            if (++visited > 200) break;
            if (file.source !== 'assistant' || file.container_id !== containerId || !file.id || !unresolved.has(file.path)) continue;
            recovered.push({ fileId: file.id, containerId, filename: path.basename(file.path) });
            unresolved.delete(file.path);
            if (!unresolved.size) break;
        }
    }
    return { citations: [...citations, ...recovered], unresolved: [...unresolved] };
}
module.exports = { linkedSandboxPaths, resolveLinkedGeneratedFiles };
