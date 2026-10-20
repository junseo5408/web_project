/** 지역 관리 (FR-05, FR-22) : 여러 지역의 Crew 운영 */
const db = require('../db/mysql');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule } = require('../lib/api');

const EXAMPLE = { id: 1, name: 'Brooklyn', description: '동부 항만 인근 상업 지구', crewCount: 1, createdAt: '2026-01-01T00:00:00.000Z' };
const SELECT = `SELECT g.*, (SELECT COUNT(*) FROM crews c WHERE c.region_id = g.id AND c.status = 'ACTIVE') AS crew_count FROM regions g`;

async function getRegion(id) {
  const r = await db.one(`${SELECT} WHERE g.id = ?`, [id]);
  if (!r) throw E.notFound('지역', id);
  return r;
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '08. Regions', base: '/api/regions' });

  api.get('', {
    summary: '지역 목록 (활성 Crew 수 포함)',
    reqs: ['FR-05', 'FR-21'],
    query: { q: { type: 'string', desc: '이름 검색' } },
    example: EXAMPLE,
  }, async (req) => db.query(`${SELECT} WHERE (? IS NULL OR g.name LIKE ?) ORDER BY g.name`, [req.q.q || null, `%${req.q.q || ''}%`]));

  api.get('/:id', {
    summary: '지역 상세 (소속 Crew 목록 포함)',
    reqs: ['FR-05'],
    params: { id: { type: 'integer', example: 1 } },
    example: { ...EXAMPLE, crews: [{ id: 1, name: 'Brooklyn Crew', status: 'ACTIVE', capoName: 'Tony Russo' }] },
    errors: [404],
  }, async (req) => {
    const r = await getRegion(req.params.id);
    const crews = await db.query('SELECT c.id, c.name, c.status, m.name AS capo_name FROM crews c LEFT JOIN members m ON m.id = c.capo_id WHERE c.region_id = ? ORDER BY c.name', [r.id]);
    return { ...r, crews };
  });

  api.post('', {
    summary: '지역 등록',
    reqs: ['FR-05', 'FR-20'], perm: 'region.manage', status: 201,
    body: {
      name: { type: 'string', required: true, maxLength: 50, example: 'Queens' },
      description: { type: 'string', maxLength: 255, example: '동부 주거 지역' },
    },
    example: { ...EXAMPLE, id: 4, name: 'Queens', crewCount: 0 },
    errors: [{ status: 409, code: 'CONFLICT', message: '이미 존재하는 값입니다(중복).' }],
  }, async (req) => {
    const r = await db.query('INSERT INTO regions (name, description) VALUES (?, ?)', [req.body.name, req.body.description || null]);
    await rec.audit(req.user, 'REGION_CREATED', 'region', r.insertId, req.body, 'SUCCESS', req.ip);
    return getRegion(r.insertId);
  });

  api.patch('/:id', {
    summary: '지역 정보 수정',
    reqs: ['FR-05'], perm: 'region.manage', partial: true,
    params: { id: { type: 'integer', example: 1 } },
    body: { name: { type: 'string', maxLength: 50, example: 'Brooklyn' }, description: { type: 'string', maxLength: 255, nullable: true, example: '브루클린 전역' } },
    example: EXAMPLE,
    errors: [404, 409],
  }, async (req) => {
    const r = await getRegion(req.params.id);
    const keys = Object.keys(req.body);
    await db.query(`UPDATE regions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => req.body[k]), r.id]);
    await rec.audit(req.user, 'REGION_UPDATED', 'region', r.id, req.body, 'SUCCESS', req.ip);
    return getRegion(r.id);
  });

  api.delete('/:id', {
    summary: '지역 삭제 (연결된 Crew 가 없을 때만)',
    reqs: ['FR-05', 'DR-01'], perm: 'region.manage',
    params: { id: { type: 'integer', example: 4 } },
    example: { id: 4, deleted: true },
    errors: [404, { status: 422, code: 'INVALID_STATE', message: '이 지역에 연결된 Crew 가 있어 삭제할 수 없습니다.' }],
  }, async (req) => {
    const r = await getRegion(req.params.id);
    const used = await db.one('SELECT COUNT(*) AS n FROM crews WHERE region_id = ?', [r.id]);
    if (used.n) throw E.state('이 지역에 연결된 Crew 가 있어 삭제할 수 없습니다.', { crews: used.n });
    await db.query('DELETE FROM regions WHERE id = ?', [r.id]);
    await rec.audit(req.user, 'REGION_DELETED', 'region', r.id, { name: r.name }, 'SUCCESS', req.ip);
    return { id: r.id, deleted: true };
  });

  api.get('/:id/stats', {
    summary: '지역별 운영 현황 (구성원·업무·자원 집계)',
    reqs: ['FR-22'], perm: 'stats.read',
    params: { id: { type: 'integer', example: 1 } },
    example: { regionId: 1, name: 'Brooklyn', crews: 1, members: 5, tasksByStatus: { PLANNED: 2, COMPLETED: 6 }, resourcesByStatus: { AVAILABLE: 1 } },
    errors: [404],
  }, async (req) => {
    const r = await getRegion(req.params.id);
    const [members, tasks, resources] = await Promise.all([
      db.one(`SELECT COUNT(*) AS n FROM crew_memberships cm JOIN crews c ON c.id = cm.crew_id
               WHERE c.region_id = ? AND cm.left_at IS NULL AND cm.membership_type = 'FORMAL'`, [r.id]),
      db.query('SELECT t.status, COUNT(*) AS n FROM tasks t JOIN crews c ON c.id = t.crew_id WHERE c.region_id = ? GROUP BY t.status', [r.id]),
      db.query('SELECT rs.status, COUNT(*) AS n FROM resources rs JOIN crews c ON c.id = rs.crew_id WHERE c.region_id = ? GROUP BY rs.status', [r.id]),
    ]);
    return {
      regionId: r.id, name: r.name, crews: r.crewCount, members: members.n,
      tasksByStatus: Object.fromEntries(tasks.map((x) => [x.status, x.n])),
      resourcesByStatus: Object.fromEntries(resources.map((x) => [x.status, x.n])),
    };
  });
};
