/** 통합 검색 (FR-21, NFR-04) : 권한 범위 내 구성원/Crew/업무/자원 */
const db = require('../db/mysql');
const { defineModule } = require('../lib/api');
const scope = require('../services/scope');
const taskSvc = require('../services/tasks');
const { helpers: resHelpers } = require('./resources');

async function searchAll(user, q, types, limit) {
  const like = `%${q}%`;
  const out = {};
  if (types.includes('members')) {
    const visible = await scope.visibleCrewIds(user);
    const cond = visible === null ? '1=1' : visible.length ? '(m.id = ? OR m.id IN (SELECT member_id FROM crew_memberships WHERE left_at IS NULL AND crew_id IN (?)))' : 'm.id = ?';
    const params = visible === null ? [] : visible.length ? [user.id, visible] : [user.id];
    out.members = await db.query(
      `SELECT m.id, m.name, m.alias, m.username, r.code AS role, m.status FROM members m JOIN roles r ON r.id = m.role_id
        WHERE ${cond} AND (m.name LIKE ? OR m.alias LIKE ? OR m.username LIKE ?) ORDER BY m.name LIMIT ?`, [...params, like, like, like, limit]
    );
  }
  if (types.includes('crews')) {
    out.crews = await db.query("SELECT c.id, c.name, c.status, g.name AS region_name FROM crews c LEFT JOIN regions g ON g.id = c.region_id WHERE c.name LIKE ? OR c.description LIKE ? OR g.name LIKE ? ORDER BY c.name LIMIT ?", [like, like, like, limit]);
  }
  if (types.includes('tasks')) {
    const vis = await taskSvc.visibilityFilter(user, 't');
    out.tasks = await db.query(`SELECT t.id, t.title, t.status, t.priority, t.start_at FROM tasks t WHERE ${vis.sql} AND (t.title LIKE ? OR t.description LIKE ? OR t.location LIKE ?) ORDER BY t.start_at DESC LIMIT ?`,
      [...vis.params, like, like, like, limit]);
  }
  if (types.includes('resources')) {
    const v = await resHelpers.visibility(user);
    out.resources = await db.query(`SELECT r.id, r.code, r.name, r.status FROM resources r WHERE ${v.sql} AND (r.code LIKE ? OR r.name LIKE ? OR r.location LIKE ?) ORDER BY r.code LIMIT ?`,
      [...v.params, like, like, like, limit]);
  }
  return out;
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '23. Search', base: '/api/search' });
  const ALL = ['members', 'crews', 'tasks', 'resources'];

  api.get('', {
    summary: '통합 검색 (구성원·Crew·업무·자원, 권한 범위 내)',
    reqs: ['FR-21', 'NFR-04', 'BR-09'],
    query: {
      q: { type: 'string', required: true, minLength: 1, maxLength: 50, example: 'Brooklyn' },
      types: { type: 'array', items: { type: 'string', enum: ALL }, desc: '검색 대상 (쉼표 구분, 기본 전체)', example: 'members,tasks' },
      limit: { type: 'integer', min: 1, max: 50, default: 10, desc: '대상별 최대 건수' },
    },
    example: { query: 'Brooklyn', counts: { members: 0, crews: 1, tasks: 2, resources: 0 }, results: { crews: [{ id: 1, name: 'Brooklyn Crew', status: 'ACTIVE', regionName: 'Brooklyn' }] } },
  }, async (req) => {
    const results = await searchAll(req.user, req.q.q, req.q.types || ALL, req.q.limit);
    return { query: req.q.q, counts: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.length])), results };
  });

  api.get('/suggest', {
    summary: '검색어 자동완성 (이름 접두어 일치, 최대 10건)',
    reqs: ['FR-21', 'NFR-04'],
    query: { q: { type: 'string', required: true, minLength: 1, maxLength: 30, example: 'Pa' } },
    example: [{ type: 'member', id: 8, label: 'Paulie Conti (Paulie)' }, { type: 'task', id: 4, label: 'Paulie 장부 정리' }],
  }, async (req) => {
    const prefix = `${req.q.q}%`;
    const vis = await taskSvc.visibilityFilter(req.user, 't');
    const visible = await scope.visibleCrewIds(req.user);
    const mCond = visible === null ? '1=1' : visible.length ? 'm.id IN (SELECT member_id FROM crew_memberships WHERE left_at IS NULL AND crew_id IN (?))' : '1=0';
    const [members, crews, tasks] = await Promise.all([
      db.query(`SELECT m.id, m.name, m.alias FROM members m WHERE ${mCond} AND (m.name LIKE ? OR m.alias LIKE ?) LIMIT 5`, [...(visible && visible.length ? [visible] : []), prefix, prefix]),
      db.query('SELECT id, name FROM crews WHERE name LIKE ? LIMIT 3', [prefix]),
      db.query(`SELECT t.id, t.title FROM tasks t WHERE ${vis.sql} AND t.title LIKE ? ORDER BY t.start_at DESC LIMIT 5`, [...vis.params, prefix]),
    ]);
    return [
      ...members.map((m) => ({ type: 'member', id: m.id, label: m.alias ? `${m.name} (${m.alias})` : m.name })),
      ...crews.map((c) => ({ type: 'crew', id: c.id, label: c.name })),
      ...tasks.map((t) => ({ type: 'task', id: t.id, label: t.title })),
    ].slice(0, 10);
  });
};
