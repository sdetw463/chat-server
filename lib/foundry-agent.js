'use strict';

const { AIProjectClient } = require('@azure/ai-projects');

function createFoundryClients(endpoint, credential) {
    const project = new AIProjectClient(endpoint, credential);
    // A retry after an ambiguous network failure can execute tools twice.
    // Reads and file uploads opt into bounded retries separately.
    const openai = project.getOpenAIClient({ maxRetries: 0, timeout: 180000 });
    return { project, openai };
}

module.exports = { createFoundryClients };
