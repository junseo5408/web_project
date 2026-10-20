/** 자원 유형 관리 (FR-13, FR-14) */
const db = require('../db/mysql');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule } = require('../lib/api');

const EXAMPLE = { id: 1, code: 'VEHICLE', name: '차량', description: '업무용 차량', defaultMinLevel: 2, resourceCount: 4, availableCount: 2 };
const SELECT = `SELECT rt.*, (SELECT COUNT(*) FROM resources r WHERE r.type_id = rt.id AND r.status <> 'RETIRED') AS resource_count,
  (SELECT COUNT(*) FROM resources r WHERE r.type_id = rt.id AND r.status = 'AVAILABLE') AS available_count FROM resource_types rt`;

async function getType(id) {
  const t = await db.one(`${SELECT} WHERE rt.id = ?`, [id]);
  if (!t) throw E.notFound('자원 유형', id);
  return t;
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '17. Resource Types', base: '/api/resource-types' });

  api.get('', {
    summary: '자원 유형 목록 (유형별 보유/가용 수량)',
    reqs: ['FR-13', 'FR-14'],
    example: [EXAMPLE],
  }, async () => db.query(`${SELECT} ORDER BY rt.code`));

  api.get('/:id', {
    summary: '자원 유형 상세',
    reqs: ['FR-13'],
    params: { id: { type: 'integer', example: 1 } },
    example: EXAMPLE,
    errors: [404],
  }, async (req) => getType(req.params.id));

  api.post('', {
    summary: '자원 유형 등록',
    reqs: ['FR-13'], perm: 'resource.manage', status: 201,
    body: {
      code: { type: 'string', required: true, maxLength: 30, pattern: '^[A-Z_]+$', example: 'DOCUMENT' },
      name: { type: 'string', required: true, maxLength: 50, example: '문서' },
      description: { type: 'string', maxLength: 255, example: '기밀 문서 보관함' },
      defaultMinLevel: { type: 'integer', min: 1, max: 6, default: 2, example: 3 },
    },
    example: { ...EXAMPLE, id: 6, code: 'DOCUMENT', name: '문서', defaultMinLevel: 3, resourceCount: 0, availableCount: 0 },
    errors: [409],
  }, async (req) => {
    const b = req.body;
    const r = await db.query('INSERT INTO resource_types (code, name, description, default_min_level) VALUES (?,?,?,?)', [b.code, b.name, b.description || null, b.defaultMinLevel]);
    await rec.audit(req.user, 'RESOURCE_TYPE_CREATED', 'resourceType', r.insertId, b, 'SUCCESS', req.ip);
    return getType(r.insertId);
  });

  api.patch('/:id', {
    summary: '자원 유형 수정',
    reqs: ['FR-13'], perm: 'resource.manage', partial: true,
    params: { id: { type: 'integer', example: 1 } },
    body: {
      name: { type: 'string', maxLength: 50 },
      description: { type: 'string', maxLength: 255, nullable: true },
      defaultMinLevel: { type: 'integer', min: 1, max: 6, example: 2 },
    },
    example: EXAMPLE,
    errors: [404],
  }, async (req) => {
    const t = await getType(req.params.id);
    const col = { name: 'name', description: 'description', defaultMinLevel: 'default_min_level' };
    const keys = Object.keys(req.body);
    await db.query(`UPDATE resource_types SET ${keys.map((k) => `${col[k]} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => req.body[k]), t.id]);
    return getType(t.id);
  });

  api.delete('/:id', {
    summary: '자원 유형 삭제 (해당 유형 자원이 없을 때만)',
    reqs: ['FR-13', 'DR-01'], perm: 'resource.manage',
    params: { id: { type: 'integer', example: 6 } },
    example: { id: 6, deleted: true },
    errors: [404, 422],
  }, async (req) => {
    const t = await getType(req.params.id);
    const used = await db.one('SELECT COUNT(*) AS n FROM resources WHERE type_id = ?', [t.id]);
    if (used.n) throw E.state('이 유형의 자원이 존재하여 삭제할 수 없습니다.', { resources: used.n });
    await db.query('DELETE FROM resource_types WHERE id = ?', [t.id]);
    return { id: t.id, deleted: true };
  });
};
