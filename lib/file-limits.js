'use strict';

// Raw bytes, before Base64 (4/3 expansion). Keep the JSON envelope bounded too.
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const CHAT_JSON_LIMIT = '75mb';
module.exports = { MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_ATTACHMENTS, CHAT_JSON_LIMIT };
