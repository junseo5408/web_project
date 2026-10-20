/**
 * 요청 검증기 (AR-02, AR-04, NFR-02)
 * 각 API 정의(doc)에 선언된 params/query/body 스펙으로 입력을 검증·형변환한다.
 * 선언되지 않은 필드는 제거된다(대량 할당 방지).
 */
const E = require('./errors');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

function checkValue(name, value, spec, fromString) {
  const type = spec.type || 'string';
  let v = value;
  const fail = (msg) => ({ error: `${name}: ${msg}` });

  switch (type) {
    case 'integer':
      if (fromString && typeof v === 'string' && /^-?\d+$/.test(v.trim())) v = Number(v);
      if (!Number.isInteger(v)) return fail('정수여야 합니다.');
      break;
    case 'number':
      if (fromString && typeof v === 'string' && v.trim() !== '' && !isNaN(v)) v = Number(v);
      if (typeof v !== 'number' || !Number.isFinite(v)) return fail('숫자여야 합니다.');
      break;
    case 'boolean':
      if (fromString && (v === 'true' || v === 'false')) v = v === 'true';
      if (typeof v !== 'boolean') return fail('true 또는 false 여야 합니다.');
      break;
    case 'datetime':
      if (typeof v !== 'string' || isNaN(Date.parse(v))) return fail('ISO-8601 날짜시간 형식이어야 합니다. 예) 2026-10-20T09:00:00Z');
      v = new Date(v);
      break;
    case 'date':
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v))) return fail('YYYY-MM-DD 형식이어야 합니다.');
      break;
    case 'email':
      if (typeof v !== 'string' || !EMAIL.test(v)) return fail('올바른 이메일 형식이 아닙니다.');
      break;
    case 'objectId':
      if (typeof v !== 'string' || !OBJECT_ID.test(v)) return fail('24자리 16진수 ID여야 합니다.');
      break;
    case 'array': {
      if (fromString && typeof v === 'string') v = v.split(',').map((s) => s.trim()).filter(Boolean);
      if (!Array.isArray(v)) return fail('배열이어야 합니다.');
      if (spec.maxItems && v.length > spec.maxItems) return fail(`최대 ${spec.maxItems}개까지 허용됩니다.`);
      if (spec.minItems && v.length < spec.minItems) return fail(`최소 ${spec.minItems}개 이상이어야 합니다.`);
      if (spec.items) {
        const itemSpec = typeof spec.items === 'string' ? { type: spec.items } : spec.items;
        const outArr = [];
        for (let i = 0; i < v.length; i++) {
          const r = checkValue(`${name}[${i}]`, v[i], itemSpec, fromString);
          if (r.error) return r;
          outArr.push(r.value);
        }
        v = outArr;
      }
      break;
    }
    case 'object':
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail('객체여야 합니다.');
      break;
    default:
      if (typeof v === 'number' && fromString) v = String(v);
      if (typeof v !== 'string') return fail('문자열이어야 합니다.');
      v = v.trim();
      if (spec.minLength !== undefined && v.length < spec.minLength) return fail(`최소 ${spec.minLength}자 이상이어야 합니다.`);
      if (spec.maxLength !== undefined && v.length > spec.maxLength) return fail(`최대 ${spec.maxLength}자까지 허용됩니다.`);
      if (spec.pattern && !new RegExp(spec.pattern).test(v)) return fail('형식이 올바르지 않습니다.');
  }

  if (spec.enum && !spec.enum.includes(v)) return fail(`허용 값: ${spec.enum.join(', ')}`);
  if (spec.min !== undefined && typeof v === 'number' && v < spec.min) return fail(`${spec.min} 이상이어야 합니다.`);
  if (spec.max !== undefined && typeof v === 'number' && v > spec.max) return fail(`${spec.max} 이하여야 합니다.`);
  return { value: v };
}

function validateSection(input, specs, where, { partial = false, fromString = false } = {}) {
  const out = {};
  const errors = [];
  const src = input && typeof input === 'object' ? input : {};
  for (const [name, spec] of Object.entries(specs || {})) {
    const raw = src[name];
    if (raw === undefined || (fromString && raw === '')) {
      if (spec.required && !partial) errors.push({ field: name, in: where, message: `${name}: 필수 항목입니다.` });
      else if (spec.default !== undefined) out[name] = spec.default;
      continue;
    }
    if (raw === null) {
      if (spec.nullable) out[name] = null;
      else errors.push({ field: name, in: where, message: `${name}: null 을 허용하지 않습니다.` });
      continue;
    }
    const r = checkValue(name, raw, spec, fromString);
    if (r.error) errors.push({ field: name, in: where, message: r.error });
    else out[name] = r.value;
  }
  return { out, errors };
}

/** 정렬/페이지 파라미터 해석 (AR-03, NFR-04) */
function parseList(query, list) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(query.size, 10) || list.defaultSize || 20));
  const sortable = list.sort || {};
  const sortParam = query.sort || list.defaultSort || Object.keys(sortable)[0];
  const order = [];
  const mongoSort = {};
  for (const token of String(sortParam || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const desc = token.startsWith('-');
    const key = desc ? token.slice(1) : token;
    if (!sortable[key]) {
      throw E.badRequest(`정렬 기준 '${key}' 은(는) 지원되지 않습니다.`, { allowed: Object.keys(sortable) });
    }
    order.push(`${sortable[key]} ${desc ? 'DESC' : 'ASC'}`);
    mongoSort[sortable[key]] = desc ? -1 : 1;
  }
  return { page, size, offset: (page - 1) * size, orderBy: order.join(', ') || '1', mongoSort };
}

/** API 정의를 바탕으로 요청 검증 미들웨어 생성 */
function validator(doc) {
  return (req, res, next) => {
    try {
      const errors = [];
      const p = validateSection(req.params, doc.params, 'path', { fromString: true });
      const q = validateSection(req.query, doc.query, 'query', { fromString: true });
      errors.push(...p.errors, ...q.errors);
      let body = {};
      if (doc.body) {
        if (req.body !== undefined && (typeof req.body !== 'object' || Array.isArray(req.body))) {
          throw E.badRequest('요청 본문은 JSON 객체여야 합니다.');
        }
        const b = validateSection(req.body, doc.body, 'body', { partial: doc.partial });
        errors.push(...b.errors);
        body = b.out;
        if (doc.partial && !errors.length && Object.keys(body).length === 0) {
          errors.push({ in: 'body', message: `변경할 항목을 하나 이상 입력하세요: ${Object.keys(doc.body).join(', ')}` });
        }
      }
      if (errors.length) throw E.badRequest('입력값이 올바르지 않습니다.', errors);
      req.params = { ...req.params, ...p.out };
      req.q = q.out;
      req.body = body;
      if (doc.list) req.page = parseList(req.query, doc.list);
      next();
    } catch (e) {
      next(e);
    }
  };
}

module.exports = { validator, validateSection, checkValue };
