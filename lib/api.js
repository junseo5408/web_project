/**
 * API 레지스트리
 *  - 각 API를 "한 곳"에서 정의하면 라우팅, 인증/권한 검사, 입력 검증, Swagger 문서,
 *    요구사항 추적표(Requirement ↔ API)가 모두 이 정의로부터 생성된다. (CR-04, AR-08)
 */
const { validator } = require('./validate');
const { authenticate, requirePerm } = require('./auth');

const registry = [];

function wrap(doc, fn) {
  return async (req, res, next) => {
    try {
      const result = await fn(req, res);
      if (res.headersSent) return;
      const status = doc.status || 200;
      if (result && result.__paged) {
        return res.status(status).json({ success: true, message: doc.ok || '조회 성공', data: result.items, meta: result.meta });
      }
      res.status(status).json({ success: true, message: doc.ok || '요청이 성공적으로 처리되었습니다.', data: result === undefined ? null : result });
    } catch (e) {
      next(e);
    }
  };
}

/** 페이지 결과 생성 헬퍼 */
const paged = (items, total, page) => ({
  __paged: true,
  items,
  meta: { page: page.page, size: page.size, total, totalPages: Math.ceil(total / page.size) },
});

/** API 를 정의한 소스 위치 (요구사항 추적표의 "구현 위치") */
function callerLocation() {
  const line = (new Error().stack.split('\n').find((l) => l.includes(`${require('path').sep}routes${require('path').sep}`)) || '');
  const m = line.match(/(routes[\\/][^:]+):(\d+)/);
  return m ? `${m[1].replace(/\\/g, '/')}:${m[2]}` : null;
}

function defineModule(app, { tag, base }) {
  const add = (method) => (path, doc, handler) => {
    const entry = {
      id: `API-${String(registry.length + 1).padStart(3, '0')}`,
      method: method.toUpperCase(),
      path: base + path,
      tag,
      location: callerLocation(),
      ...doc,
    };
    registry.push(entry);
    const mws = [];
    if (doc.auth !== false) mws.push(authenticate);
    if (doc.perm) mws.push(requirePerm(doc.perm));
    mws.push(validator(doc));
    app[method](base + path, ...mws, wrap(doc, handler));
  };
  return { get: add('get'), post: add('post'), put: add('put'), patch: add('patch'), delete: add('delete') };
}

/* ------------------------------ Swagger 생성 ------------------------------ */

function toSchema(spec) {
  const s = {};
  switch (spec.type || 'string') {
    case 'integer': s.type = 'integer'; break;
    case 'number': s.type = 'number'; break;
    case 'boolean': s.type = 'boolean'; break;
    case 'datetime': s.type = 'string'; s.format = 'date-time'; break;
    case 'date': s.type = 'string'; s.format = 'date'; break;
    case 'email': s.type = 'string'; s.format = 'email'; break;
    case 'objectId': s.type = 'string'; s.pattern = '^[a-f0-9]{24}$'; break;
    case 'array': s.type = 'array'; s.items = toSchema(typeof spec.items === 'string' ? { type: spec.items } : spec.items || {}); break;
    case 'object': s.type = 'object'; break;
    default: s.type = 'string';
  }
  if (spec.enum) s.enum = spec.enum;
  if (spec.min !== undefined) s.minimum = spec.min;
  if (spec.max !== undefined) s.maximum = spec.max;
  if (spec.maxLength !== undefined) s.maxLength = spec.maxLength;
  if (spec.minLength !== undefined) s.minLength = spec.minLength;
  if (spec.default !== undefined) s.default = spec.default;
  if (spec.nullable) s.nullable = true;
  if (spec.desc) s.description = spec.desc;
  if (spec.example !== undefined) s.example = spec.example;
  return s;
}

const ERROR_SAMPLES = {
  400: { code: 'VALIDATION_ERROR', message: '입력값이 올바르지 않습니다.', details: [{ field: 'name', in: 'body', message: 'name: 필수 항목입니다.' }] },
  401: { code: 'UNAUTHORIZED', message: '인증이 필요합니다.' },
  403: { code: 'FORBIDDEN', message: '이 작업을 수행할 권한이 없습니다.', details: { rule: 'BR-09' } },
  404: { code: 'NOT_FOUND', message: '대상(id=999)을(를) 찾을 수 없습니다.', details: { entity: '대상', id: 999 } },
  409: { code: 'CONFLICT', message: '현재 데이터와 충돌합니다.' },
  422: { code: 'INVALID_STATE', message: '현재 상태에서 허용되지 않는 작업입니다.' },
};
const STATUS_TEXT = { 400: '잘못된 입력', 401: '인증 실패', 403: '권한 부족', 404: '대상 없음', 409: '업무 규칙 위반 / 충돌', 422: '허용되지 않는 상태' };

function buildOperation(e) {
  const op = {
    tags: [e.tag],
    summary: `[${e.id}] ${e.summary}`,
    operationId: e.id,
    description: [
      e.description || e.summary,
      '',
      `**관련 요구사항**: ${(e.reqs || []).join(', ')}`,
      `**필요 권한**: ${e.auth === false ? '없음 (공개)' : e.perm ? `로그인 + 권한 \`${[].concat(e.perm).join(' | ')}\`` : '로그인 사용자'}`,
      e.scope ? `**접근 범위**: ${e.scope}` : '',
    ].filter((x) => x !== undefined).join('\n\n'),
    parameters: [],
    responses: {},
  };
  if (e.auth !== false) op.security = [{ bearerAuth: [] }];

  for (const [name, spec] of Object.entries(e.params || {})) {
    op.parameters.push({ name, in: 'path', required: true, description: spec.desc, schema: toSchema(spec), example: spec.example });
  }
  for (const [name, spec] of Object.entries(e.query || {})) {
    op.parameters.push({ name, in: 'query', required: !!spec.required, description: spec.desc, schema: toSchema(spec), example: spec.example });
  }
  if (e.list) {
    op.parameters.push(
      { name: 'page', in: 'query', description: '페이지 번호 (1부터)', schema: { type: 'integer', default: 1, minimum: 1 } },
      { name: 'size', in: 'query', description: '페이지 크기 (최대 100)', schema: { type: 'integer', default: e.list.defaultSize || 20, maximum: 100 } },
      {
        name: 'sort', in: 'query',
        description: `정렬 기준. 내림차순은 '-' 접두사. 허용: ${Object.keys(e.list.sort).join(', ')}`,
        schema: { type: 'string', default: e.list.defaultSort },
      }
    );
  }
  if (e.body) {
    const props = {};
    const required = [];
    const example = {};
    for (const [name, spec] of Object.entries(e.body)) {
      props[name] = toSchema(spec);
      if (spec.required && !e.partial) required.push(name);
      if (spec.example !== undefined) example[name] = spec.example;
    }
    op.requestBody = {
      required: !e.partial || true,
      content: { 'application/json': { schema: { type: 'object', properties: props, required: required.length ? required : undefined }, example: e.bodyExample || example } },
    };
  }

  const okStatus = e.status || 200;
  const okExample = e.list
    ? { success: true, message: '조회 성공', data: e.example !== undefined ? [e.example] : [], meta: { page: 1, size: 20, total: 1, totalPages: 1 } }
    : { success: true, message: e.ok || '요청이 성공적으로 처리되었습니다.', data: e.example !== undefined ? e.example : null };
  op.responses[okStatus] = {
    description: e.responseDesc || '성공',
    content: e.produces === 'text/csv'
      ? { 'text/csv': { schema: { type: 'string' }, example: e.example } }
      : { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' }, example: okExample } },
  };

  const statuses = new Map();
  if (e.params || e.query || e.body) statuses.set(400, null);
  if (e.auth !== false) statuses.set(401, null);
  if (e.perm || e.scope) statuses.set(403, null);
  for (const err of e.errors || []) {
    if (typeof err === 'number') statuses.set(err, statuses.get(err) || null);
    else statuses.set(err.status, err);
  }
  for (const [status, custom] of [...statuses.entries()].sort((a, b) => a[0] - b[0])) {
    const sample = custom
      ? { code: custom.code || (custom.rule ? 'BUSINESS_RULE_VIOLATION' : ERROR_SAMPLES[status].code), message: custom.message, details: custom.rule ? { rule: custom.rule } : undefined }
      : ERROR_SAMPLES[status];
    op.responses[status] = {
      description: custom ? `${STATUS_TEXT[status]} (${custom.rule || custom.code || ''})` : STATUS_TEXT[status],
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { success: false, error: sample } } },
    };
  }
  return op;
}

function buildSwaggerSpec(config) {
  const paths = {};
  for (const e of registry) {
    const p = e.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    paths[p] = paths[p] || {};
    paths[p][e.method.toLowerCase()] = buildOperation(e);
  }
  const tags = [...new Set(registry.map((e) => e.tag))].map((name) => ({ name }));
  return {
    openapi: '3.0.3',
    info: {
      title: 'The Family 통합 정보시스템 API',
      version: '1.0.0',
      description: [
        `학번: ${config.studentId} · 전체 API 수: **${registry.length}개**`,
        '',
        '### 사용 방법',
        '1. `POST /api/auth/login` 을 실행하여 토큰을 발급받습니다. (예: `boss` / `pass1234`)',
        '2. 우측 상단 **Authorize** 버튼을 눌러 발급받은 `token` 값을 입력합니다.',
        '3. 각 API의 **Try it out → Execute** 로 실제 요청을 실행합니다.',
        '',
        '### 공통 응답 형식',
        '- 성공: `{ success: true, message, data, meta? }`',
        '- 실패: `{ success: false, error: { code, message, details } }`',
        '- 오류 코드: VALIDATION_ERROR(400), UNAUTHORIZED(401), FORBIDDEN(403), NOT_FOUND(404), CONFLICT/BUSINESS_RULE_VIOLATION(409), INVALID_STATE(422)',
      ].join('\n'),
    },
    servers: [{ url: '/' }],
    tags,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        SuccessResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string' },
            data: {},
            meta: { type: 'object', properties: { page: { type: 'integer' }, size: { type: 'integer' }, total: { type: 'integer' }, totalPages: { type: 'integer' } } },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } },
          },
        },
      },
    },
    paths,
  };
}

module.exports = { defineModule, paged, registry, buildSwaggerSpec };
