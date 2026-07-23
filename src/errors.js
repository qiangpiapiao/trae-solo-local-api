'use strict';

/**
 * Unified error response helpers.
 *
 * OpenAI-style (most /v1/* JSON APIs):
 *   { error: { message, type, code? } }
 *
 * Anthropic /v1/messages keeps createAnthropicError from anthropic-format.js.
 */

function openaiErrorBody(message, type = 'invalid_request_error', code = null) {
  const err = { message: String(message || 'error'), type: String(type || 'api_error') };
  if (code != null && code !== '') err.code = String(code);
  return { error: err };
}

/**
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} message
 * @param {string} [type]
 * @param {string|null} [code]
 */
function sendOpenAIError(res, status, message, type = 'invalid_request_error', code = null) {
  if (res.headersSent || res.writableEnded) return res;
  return res.status(status).json(openaiErrorBody(message, type, code));
}

/** Normalize legacy `res.json({ error: 'string' })` call sites when migrating. */
function isOpenAIErrorShape(body) {
  return !!(
    body &&
    typeof body === 'object' &&
    body.error &&
    typeof body.error === 'object' &&
    typeof body.error.message === 'string'
  );
}

module.exports = {
  openaiErrorBody,
  sendOpenAIError,
  isOpenAIErrorShape,
};
