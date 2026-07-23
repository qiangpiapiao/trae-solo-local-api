import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getCatalog, getOpenApiDocument, ROUTES } = require('../../src/api-catalog');
const { openaiErrorBody, sendOpenAIError, isOpenAIErrorShape } = require('../../src/errors');

describe('api-catalog', () => {
  it('lists core chat routes', () => {
    const paths = ROUTES.map((r) => r.path);
    expect(paths).toContain('/v1/chat/completions');
    expect(paths).toContain('/v1/messages');
    expect(paths).toContain('/v1/think-effort');
    expect(paths).toContain('/v1');
    expect(paths).toContain('/v1/openapi.json');
  });

  it('getCatalog groups routes and exposes features', () => {
    const c = getCatalog();
    expect(c.name).toBe('trae-solo-local-api');
    expect(c.features.think_effort).toBe(true);
    expect(c.features.auto_continue).toBe(true);
    expect(c.groups.openai).toBeTruthy();
    expect(c.groups.anthropic).toBeTruthy();
    expect(c.routes.length).toBe(ROUTES.length);
  });

  it('getOpenApiDocument is OpenAPI 3', () => {
    const doc = getOpenApiDocument('http://localhost:19900');
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.paths['/v1/chat/completions'].post).toBeTruthy();
    expect(doc.paths['/v1/messages'].post).toBeTruthy();
    expect(doc.components.securitySchemes.bearerAuth).toBeTruthy();
  });
});

describe('errors', () => {
  it('openaiErrorBody shape', () => {
    const b = openaiErrorBody('bad', 'invalid_request_error', 'missing');
    expect(b.error.message).toBe('bad');
    expect(b.error.type).toBe('invalid_request_error');
    expect(b.error.code).toBe('missing');
    expect(isOpenAIErrorShape(b)).toBe(true);
  });

  it('sendOpenAIError writes status json', () => {
    let statusCode = null;
    let body = null;
    const res = {
      headersSent: false,
      writableEnded: false,
      status(code) {
        statusCode = code;
        return this;
      },
      json(obj) {
        body = obj;
        return this;
      },
    };
    sendOpenAIError(res, 400, 'nope');
    expect(statusCode).toBe(400);
    expect(body.error.message).toBe('nope');
    expect(body.error.type).toBe('invalid_request_error');
  });
});
