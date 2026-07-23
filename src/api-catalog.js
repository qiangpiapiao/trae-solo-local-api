'use strict';

/**
 * Canonical route catalog for GET /v1 and GET /v1/openapi.json.
 * Keep in sync when adding routes in server.js.
 */

const PACKAGE_VERSION = (() => {
  try {
    return require('../package.json').version;
  } catch {
    return '0.0.0';
  }
})();

/** @typedef {{ method: string, path: string, group: string, summary: string, auth: boolean, body?: object, query?: object }} RouteDef */

/** @type {RouteDef[]} */
const ROUTES = [
  // Core chat
  {
    method: 'POST',
    path: '/v1/chat/completions',
    group: 'openai',
    summary: 'OpenAI-compatible chat completions (stream + tools + think_effort + auto-continue)',
    auth: true,
    body: {
      model: 'string',
      messages: 'array',
      stream: 'boolean?',
      tools: 'array?',
      think_effort: 'auto|off|low|high|max?',
      reasoning_effort: 'alias of think_effort?',
      max_tokens: 'number?',
      temperature: 'number?',
      config_name: 'string?',
      function: 'string?',
    },
  },
  {
    method: 'POST',
    path: '/v1/messages',
    group: 'anthropic',
    summary: 'Anthropic-compatible messages (stream + tools + think_effort + auto-continue)',
    auth: true,
    body: {
      model: 'string',
      messages: 'array',
      system: 'string|array?',
      stream: 'boolean?',
      tools: 'array?',
      think_effort: 'auto|off|low|high|max?',
      max_tokens: 'number?',
    },
  },
  {
    method: 'GET',
    path: '/v1/models',
    group: 'openai',
    summary: 'List model ids / function aliases',
    auth: true,
  },
  {
    method: 'GET',
    path: '/v1/think-effort',
    group: 'meta',
    summary: 'Supported think_effort levels per SOLO config_name',
    auth: true,
  },

  // Health / meta
  {
    method: 'GET',
    path: '/health',
    group: 'meta',
    summary: 'Liveness probe (no auth)',
    auth: false,
  },
  {
    method: 'GET',
    path: '/v1/status',
    group: 'meta',
    summary: 'Auth + SOLO token status, auto_continue flags',
    auth: true,
  },
  {
    method: 'GET',
    path: '/v1/info',
    group: 'meta',
    summary: 'Server info snapshot',
    auth: true,
  },
  {
    method: 'GET',
    path: '/v1',
    group: 'meta',
    summary: 'API catalog (this document as JSON)',
    auth: false,
  },
  {
    method: 'GET',
    path: '/v1/openapi.json',
    group: 'meta',
    summary: 'Minimal OpenAPI 3.0 document for MCP / tooling',
    auth: false,
  },

  // Config schema (dashboard / sessions)
  {
    method: 'GET',
    path: '/v1/config/schema',
    group: 'config',
    summary: 'Session config schema (UI + validation)',
    auth: true,
  },
  {
    method: 'GET',
    path: '/v1/config/defaults',
    group: 'config',
    summary: 'Global defaults for new sessions',
    auth: true,
  },
  {
    method: 'PUT',
    path: '/v1/config/defaults',
    group: 'config',
    summary: 'Update global defaults',
    auth: true,
  },

  // Sessions
  {
    method: 'GET',
    path: '/v1/sessions',
    group: 'sessions',
    summary: 'List sessions',
    auth: true,
  },
  {
    method: 'POST',
    path: '/v1/sessions',
    group: 'sessions',
    summary: 'Create session',
    auth: true,
  },
  {
    method: 'GET',
    path: '/v1/sessions/:id',
    group: 'sessions',
    summary: 'Get session',
    auth: true,
  },
  {
    method: 'PUT',
    path: '/v1/sessions/:id',
    group: 'sessions',
    summary: 'Update session',
    auth: true,
  },
  {
    method: 'DELETE',
    path: '/v1/sessions/:id',
    group: 'sessions',
    summary: 'Delete session',
    auth: true,
  },
  {
    method: 'POST',
    path: '/v1/sessions/:id/messages',
    group: 'sessions',
    summary: 'Append message',
    auth: true,
  },
  {
    method: 'DELETE',
    path: '/v1/sessions/:id/messages/:msgId',
    group: 'sessions',
    summary: 'Truncate messages from msgId',
    auth: true,
  },
  {
    method: 'GET',
    path: '/v1/sessions/:id/export',
    group: 'sessions',
    summary: 'Export session',
    auth: true,
  },

  // SOLO helpers
  {
    method: 'GET',
    path: '/v1/models/detail',
    group: 'solo',
    summary: 'SOLO get_detail_param for a function/model',
    auth: true,
  },
  {
    method: 'GET',
    path: '/v1/chat/modes',
    group: 'solo',
    summary: 'SOLO chat modes',
    auth: true,
  },
  {
    method: 'POST',
    path: '/v1/chat/file',
    group: 'solo',
    summary: 'Chat and save full reply to workspace file',
    auth: true,
  },
  {
    method: 'POST',
    path: '/v1/encrypt',
    group: 'solo',
    summary: 'Encrypt text (debug / parity)',
    auth: true,
  },
  {
    method: 'POST',
    path: '/v1/decrypt',
    group: 'solo',
    summary: 'Decrypt text (debug / parity)',
    auth: true,
  },

  // Files
  {
    method: 'GET',
    path: '/v1/files',
    group: 'files',
    summary: 'List workspace files',
    auth: true,
  },
  {
    method: 'GET',
    path: '/v1/files/read',
    group: 'files',
    summary: 'Read workspace file',
    auth: true,
  },
  {
    method: 'GET',
    path: '/v1/sync/pending',
    group: 'files',
    summary: 'Pending output-sync paths',
    auth: true,
  },
  {
    method: 'POST',
    path: '/v1/sync/clear',
    group: 'files',
    summary: 'Clear pending sync queue',
    auth: true,
  },

  // Dashboard
  {
    method: 'GET',
    path: '/v1/dashboard',
    group: 'dashboard',
    summary: 'Dashboard HTML (no auth on page shell)',
    auth: false,
  },
  {
    method: 'GET',
    path: '/v1/dashboard/status',
    group: 'dashboard',
    summary: 'Runtime status for UI',
    auth: true,
  },
  {
    method: 'GET',
    path: '/v1/dashboard/sessions',
    group: 'dashboard',
    summary: 'Traffic log sessions',
    auth: true,
  },
  {
    method: 'GET',
    path: '/v1/dashboard/requests',
    group: 'dashboard',
    summary: 'Recent requests',
    auth: true,
  },
  {
    method: 'GET',
    path: '/v1/dashboard/stats',
    group: 'dashboard',
    summary: 'Aggregate stats',
    auth: true,
  },
  {
    method: 'GET',
    path: '/v1/dashboard/log/:date/:workspace/:logId',
    group: 'dashboard',
    summary: 'Log detail',
    auth: true,
  },
  {
    method: 'GET',
    path: '/v1/dashboard/active/:logId',
    group: 'dashboard',
    summary: 'Active request detail',
    auth: true,
  },
  {
    method: 'GET',
    path: '/v1/dashboard/fallback-config',
    group: 'dashboard',
    summary: 'Queue fallback config',
    auth: true,
  },
  {
    method: 'POST',
    path: '/v1/dashboard/fallback-config',
    group: 'dashboard',
    summary: 'Update queue fallback config',
    auth: true,
  },
  {
    method: 'GET',
    path: '/v1/dashboard/model-config',
    group: 'dashboard',
    summary: 'model-config.json',
    auth: true,
  },
  {
    method: 'POST',
    path: '/v1/dashboard/model-config',
    group: 'dashboard',
    summary: 'Replace model-config',
    auth: true,
  },
  {
    method: 'POST',
    path: '/v1/dashboard/model-config/models',
    group: 'dashboard',
    summary: 'Upsert one model mapping',
    auth: true,
  },
  {
    method: 'DELETE',
    path: '/v1/dashboard/model-config/models/:key',
    group: 'dashboard',
    summary: 'Delete model mapping',
    auth: true,
  },
];

function getCatalog() {
  const groups = {};
  for (const r of ROUTES) {
    if (!groups[r.group]) groups[r.group] = [];
    groups[r.group].push({
      method: r.method,
      path: r.path,
      summary: r.summary,
      auth: r.auth,
      body: r.body || undefined,
      query: r.query || undefined,
    });
  }
  return {
    name: 'trae-solo-local-api',
    version: PACKAGE_VERSION,
    base_url: null,
    auth: {
      schemes: ['Authorization: Bearer <API_KEY>', 'x-api-key: <API_KEY>', '?key=<API_KEY>'],
      default_key_env: 'API_KEY',
    },
    features: {
      think_effort: true,
      auto_continue: true,
      queue_fallback: true,
      openai: true,
      anthropic: true,
    },
    groups,
    routes: ROUTES.map((r) => ({
      method: r.method,
      path: r.path,
      group: r.group,
      summary: r.summary,
      auth: r.auth,
    })),
  };
}

/**
 * Minimal OpenAPI 3.0 — enough for MCP/tooling discovery, not full schema gen.
 */
function getOpenApiDocument(baseUrl) {
  const paths = {};
  for (const r of ROUTES) {
    if (!paths[r.path]) paths[r.path] = {};
    const method = r.method.toLowerCase();
    const op = {
      tags: [r.group],
      summary: r.summary,
      operationId: `${method}_${r.path.replace(/[\/{}:]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`,
      responses: {
        200: { description: 'OK' },
        400: { description: 'Invalid request' },
        401: { description: 'Auth error' },
      },
    };
    if (r.auth) {
      op.security = [{ bearerAuth: [] }, { apiKeyHeader: [] }];
    }
    if (r.body && (method === 'post' || method === 'put')) {
      op.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', description: JSON.stringify(r.body) },
          },
        },
      };
    }
    paths[r.path][method] = op;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'trae-solo-local-api',
      version: PACKAGE_VERSION,
      description:
        'Local OpenAI/Anthropic-compatible gateway over TRAE SOLO. ' +
        'Chat: POST /v1/chat/completions, POST /v1/messages. ' +
        'think_effort + auto-continue supported.',
    },
    servers: baseUrl ? [{ url: baseUrl }] : [{ url: 'http://localhost:19900' }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        apiKeyHeader: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      },
      schemas: {
        OpenAIError: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
              required: ['message', 'type'],
            },
          },
        },
      },
    },
  };
}

module.exports = {
  ROUTES,
  getCatalog,
  getOpenApiDocument,
  PACKAGE_VERSION,
};
