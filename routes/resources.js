/** 공용 자원 관리 (FR-13, FR-14, FR-15, FR-16, DR-03) */
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const scope = require('../services/scope');
const resSvc = require('../services/resources');

const idParam = { id: { type: 'integer', example: 1, desc: '자원 ID' } };
const EXAMPLE = {
  id: 1, code: 'VH-001', name: '검정 세단', typeId: 1, typeCode: 'VEHICLE', typeName: '차량', crewId: 1, crewName: 'Brooklyn Crew',
  status: 'AVAILABLE', location: 'Brooklyn 차고', minRoleLevel: 2, description: '검정 세단 (VH-001)', usable: true,
};

/** FR-14: 역할 등급과 소속 Crew 에 따라 볼 수 있는 자원 */
async function visibility(user) {
  if (scope.isAll(user)) return { sql: '1=1', params: [] };
  const visible = await scope.visibleCrewIds(user);
  return {
    sql: `(r.min_role_level <= ? AND (r.crew_id IS NULL ${visible.length ? 'OR r.crew_id IN (?)' : ''}))`,
    params: visible.length ? [user.level, visible] : [user.level],
  };
}
async function getVisibleResource(user, id) {
  const r = await resSvc.getResource(id);
  const v = await visibility(user);
  const ok = await db.one(`SELECT r.id FROM resources r WHERE r.id = ? AND ${v.sql}`, [id, ...v.params]);
  if (!ok) throw E.forbidden(`자원(id=${id})에 접근할 권한이 없습니다. (필요 등급 ${r.minRoleLevel})`, 'BR-09');
  return r;
}
async function assertManageResource(user, r) {
  if (r.crewId) await scope.assertManageCrew(user, r.crewId, 'BR-09');
  else if (!scope.isAll(user) && user.role !== 'UNDERBOSS') throw E.forbidden('공용(Crew 미지정) 자원은 Underboss 이상만 관리할 수 있습니다.');
}
const withUsable = (r) => ({ ...r, usable: !resSvc.BLOCKED.includes(r.status) });

module.exports = (app) => {
  const api = defineModule(app, { tag: '16. Resources', base: '/api/resources' });

  api.get('', {
    summary: '자원 목록/검색 (유형·상태·Crew·검색어)',
    description: 'FR-14: 요청자의 역할 등급(minRoleLevel)과 소속 Crew 에 따라 볼 수 있는 자원만 반환된다. usable=false 는 사용 불가/점검 필요 자원(FR-16).',
    reqs: ['FR-13', 'FR-14', 'FR-16', 'FR-21', 'NFR-04'],
    query: {
      type: { type: 'string', desc: '유형 코드', example: 'VEHICLE' },
      status: { type: 'array', items: { type: 'string', enum: resSvc.STATUSES } },
      crewId: { type: 'integer' },
      q: { type: 'string', desc: '코드/이름/위치 검색', example: '세단' },
      usable: { type: 'boolean', desc: 'true: 정상 자원만, false: 사용 불가/점검 필요 자원만' },
      includeRetired: { type: 'boolean', default: false },
    },
    list: { sort: { id: 'r.id', code: 'r.code', name: 'r.name', status: 'r.status', updatedAt: 'r.updated_at' }, defaultSort: 'code' },
    example: EXAMPLE,
  }, async (req) => {
    const v = await visibility(req.user);
    const where = [v.sql];
    const params = [...v.params];
    if (req.q.type) { where.push('rt.code = ?'); params.push(req.q.type); }
    if (req.q.status) { where.push('r.status IN (?)'); params.push(req.q.status); }
    if (req.q.crewId) { where.push('r.crew_id = ?'); params.push(req.q.crewId); }
    if (req.q.q) { where.push('(r.code LIKE ? OR r.name LIKE ? OR r.location LIKE ?)'); params.push(`%${req.q.q}%`, `%${req.q.q}%`, `%${req.q.q}%`); }
    if (req.q.usable !== undefined) { where.push(`r.status ${req.q.usable ? 'NOT IN' : 'IN'} (?)`); params.push(resSvc.BLOCKED); }
    if (!req.q.includeRetired && !(req.q.status || []).includes('RETIRED')) where.push("r.status <> 'RETIRED'");
    const w = where.join(' AND ');
    const total = (await db.one(`SELECT COUNT(*) AS n FROM ${resSvc.RESOURCE_FROM} WHERE ${w}`, params)).n;
    const rows = await db.query(`SELECT ${resSvc.RESOURCE_COLUMNS} FROM ${resSvc.RESOURCE_FROM} WHERE ${w} ORDER BY ${req.page.orderBy} LIMIT ? OFFSET ?`, [...params, req.page.size, req.page.offset]);
    return paged(rows.map(withUsable), total, req.page);
  });

  api.get('/available', {
    summary: '지정 시간대에 내가 이용 가능한 자원 (권한·상태·기존 배정 고려)',
    reqs: ['FR-14', 'BR-07', 'BR-08'],
    query: {
      startAt: { type: 'datetime', required: true, example: '2026-10-19T10:00:00Z' },
      endAt: { type: 'datetime', required: true, example: '2026-10-19T11:00:00Z' },
      type: { type: 'string', example: 'VEHICLE' },
    },
    example: [{ ...EXAMPLE, id: 9, code: 'VH-004', name: '오토바이' }],
  }, async (req) => {
    if (req.q.endAt <= req.q.startAt) throw E.badRequest('endAt 은 startAt 이후여야 합니다.');
    const v = await visibility(req.user);
    const params = [...v.params, resSvc.BLOCKED, req.q.endAt, req.q.startAt];
    let typeSql = '';
    if (req.q.type) { typeSql = 'AND rt.code = ?'; params.push(req.q.type); }
    const rows = await db.query(
      `SELECT ${resSvc.RESOURCE_COLUMNS} FROM ${resSvc.RESOURCE_FROM}
        WHERE ${v.sql} AND r.status NOT IN (?)
          AND NOT EXISTS (SELECT 1 FROM resource_allocations a WHERE a.resource_id = r.id AND a.status IN ('RESERVED','IN_USE') AND a.start_at < ? AND a.end_at > ?)
          ${typeSql} ORDER BY r.code`, params
    );
    return rows.map(withUsable);
  });

  api.get('/attention', {
    summary: '관리 필요 자원 현황 (점검 필요/정비중/사용 불가 + 미해결 이슈 + 반납 지연)',
    reqs: ['FR-16', 'FR-13'], perm: ['resource.manage', 'resource.allocate'],
    example: {
      blocked: [{ ...EXAMPLE, id: 8, code: 'EQ-001', status: 'NEEDS_INSPECTION', usable: false, openIssues: 1 }],
      overdueReturns: [{ allocationId: 2, resourceCode: 'VH-002', endAt: '2026-10-18T12:00:00.000Z', overdueHours: 3 }],
    },
  }, async (req) => {
    const v = await visibility(req.user);
    const blocked = await db.query(
      `SELECT ${resSvc.RESOURCE_COLUMNS}, (SELECT COUNT(*) FROM resource_issues i WHERE i.resource_id = r.id AND i.status = 'OPEN') AS open_issues
         FROM ${resSvc.RESOURCE_FROM} WHERE ${v.sql} AND r.status IN ('NEEDS_INSPECTION','MAINTENANCE','UNAVAILABLE') ORDER BY FIELD(r.status,'NEEDS_INSPECTION','MAINTENANCE','UNAVAILABLE'), r.code`, v.params
    );
    const overdue = await db.query(
      `SELECT a.id AS allocation_id, r.code AS resource_code, r.name AS resource_name, a.member_id, a.task_id, a.end_at,
              TIMESTAMPDIFF(HOUR, a.end_at, NOW()) AS overdue_hours
         FROM resource_allocations a JOIN resources r ON r.id = a.resource_id
        WHERE ${v.sql} AND a.status = 'IN_USE' AND a.end_at < NOW() ORDER BY a.end_at`, v.params
    );
    return { blocked: blocked.map(withUsable), overdueReturns: overdue };
  });

  api.get('/:id', {
    summary: '자원 상세 (현재 사용 현황, 다음 예약, 미해결 이슈)',
    reqs: ['FR-13', 'DR-03'],
    params: idParam,
    example: { ...EXAMPLE, currentUse: null, upcoming: [{ allocationId: 1, taskId: 1, startAt: '2026-10-19T09:00:00.000Z', endAt: '2026-10-19T12:00:00.000Z', status: 'RESERVED' }], openIssues: [] },
    errors: [403, 404],
  }, async (req) => {
    const r = await getVisibleResource(req.user, req.params.id);
    const [current, upcoming, issues] = await Promise.all([
      db.one("SELECT id AS allocation_id, task_id, member_id, start_at, end_at, checked_out_at FROM resource_allocations WHERE resource_id = ? AND status = 'IN_USE' LIMIT 1", [r.id]),
      db.query("SELECT id AS allocation_id, task_id, member_id, start_at, end_at, status FROM resource_allocations WHERE resource_id = ? AND status = 'RESERVED' AND end_at > NOW() ORDER BY start_at LIMIT 10", [r.id]),
      db.query("SELECT id, severity, description, created_at FROM resource_issues WHERE resource_id = ? AND status = 'OPEN'", [r.id]),
    ]);
    return { ...withUsable(r), currentUse: current, upcoming, openIssues: issues };
  });

  api.post('', {
    summary: '자원 등록',
    reqs: ['FR-13', 'FR-20'], perm: 'resource.manage', status: 201,
    body: {
      code: { type: 'string', required: true, maxLength: 30, pattern: '^[A-Z0-9-]+$', example: 'VH-005' },
      name: { type: 'string', required: true, maxLength: 100, example: '소형 승합차' },
      typeCode: { type: 'string', required: true, example: 'VEHICLE' },
      crewId: { type: 'integer', nullable: true, example: 1, desc: '소유 Crew (null 이면 조직 공용)' },
      location: { type: 'string', maxLength: 100, example: 'Brooklyn 차고' },
      minRoleLevel: { type: 'integer', min: 1, max: 6, desc: '이용 가능한 최소 역할 등급 (미지정 시 유형 기본값)', example: 2 },
      description: { type: 'string', maxLength: 500 },
    },
    example: { ...EXAMPLE, id: 10, code: 'VH-005', name: '소형 승합차' },
    errors: [403, 404, 409],
  }, async (req) => {
    const b = req.body;
    const type = await db.one('SELECT * FROM resource_types WHERE code = ?', [b.typeCode]);
    if (!type) throw E.notFound('자원 유형', b.typeCode);
    if (b.crewId) await scope.assertManageCrew(req.user, b.crewId, 'BR-09');
    else if (!scope.isAll(req.user) && req.user.role !== 'UNDERBOSS') throw E.forbidden('공용 자원은 Underboss 이상만 등록할 수 있습니다.');
    const r = await db.query('INSERT INTO resources (code, name, type_id, crew_id, location, min_role_level, description) VALUES (?,?,?,?,?,?,?)',
      [b.code, b.name, type.id, b.crewId || null, b.location || null, b.minRoleLevel || type.defaultMinLevel, b.description || null]);
    await rec.resourceHistory(r.insertId, 'REGISTERED', null, 'AVAILABLE', req.user);
    await rec.audit(req.user, 'RESOURCE_CREATED', 'resource', r.insertId, { code: b.code }, 'SUCCESS', req.ip);
    return withUsable(await resSvc.getResource(r.insertId));
  });

  api.patch('/:id', {
    summary: '자원 정보 수정 (이름/위치/소유 Crew/이용 등급/설명)',
    reqs: ['FR-13'], perm: 'resource.manage', partial: true,
    params: idParam,
    body: {
      name: { type: 'string', maxLength: 100 },
      location: { type: 'string', maxLength: 100, nullable: true, example: 'Harbor 차고' },
      crewId: { type: 'integer', nullable: true },
      minRoleLevel: { type: 'integer', min: 1, max: 6, example: 3 },
      description: { type: 'string', maxLength: 500, nullable: true },
    },
    example: EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    const r = await resSvc.getResource(req.params.id);
    await assertManageResource(req.user, r);
    if (req.body.crewId) await scope.assertManageCrew(req.user, req.body.crewId, 'BR-09');
    const col = { name: 'name', location: 'location', crewId: 'crew_id', minRoleLevel: 'min_role_level', description: 'description' };
    const keys = Object.keys(req.body);
    await db.query(`UPDATE resources SET ${keys.map((k) => `${col[k]} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => req.body[k]), r.id]);
    await rec.resourceHistory(r.id, 'UPDATED', null, null, req.user, { fields: req.body });
    return withUsable(await resSvc.getResource(r.id));
  });

  api.delete('/:id', {
    summary: '자원 삭제 (사용 이력이 전혀 없는 경우만, 그 외는 RETIRED 상태로 관리)',
    reqs: ['FR-13', 'DR-03'], perm: 'resource.manage',
    params: idParam,
    example: { id: 10, deleted: true },
    errors: [403, 404, 422],
  }, async (req) => {
    const r = await resSvc.getResource(req.params.id);
    await assertManageResource(req.user, r);
    const used = await db.one('SELECT (SELECT COUNT(*) FROM resource_allocations WHERE resource_id = ?) + (SELECT COUNT(*) FROM resource_requests WHERE resource_id = ?) + (SELECT COUNT(*) FROM resource_issues WHERE resource_id = ?) AS n', [r.id, r.id, r.id]);
    if (used.n) throw E.state('사용/요청/이슈 이력이 있는 자원은 삭제할 수 없습니다. 상태를 RETIRED 로 변경하세요(이력 보존, DR-03).');
    await db.query('DELETE FROM resources WHERE id = ?', [r.id]);
    await rec.audit(req.user, 'RESOURCE_DELETED', 'resource', r.id, { code: r.code }, 'SUCCESS', req.ip);
    return { id: r.id, deleted: true };
  });

  api.patch('/:id/status', {
    summary: '자원 상태 변경 (정상/점검 필요/정비중/사용 불가/폐기)',
    description: 'IN_USE 는 체크아웃/반납에 의해 자동 관리된다. 사용 불가 계열 상태로 변경하면 이후 새 배정이 차단된다(BR-08). cancelReservations=true 이면 기존 예약도 취소한다.',
    reqs: ['FR-13', 'FR-15', 'FR-16', 'BR-08'], perm: 'resource.manage',
    params: idParam,
    body: {
      status: { type: 'string', required: true, enum: ['AVAILABLE', 'NEEDS_INSPECTION', 'MAINTENANCE', 'UNAVAILABLE', 'RETIRED'], example: 'MAINTENANCE' },
      reason: { type: 'string', required: true, maxLength: 300, example: '정기 정비' },
      cancelReservations: { type: 'boolean', default: false },
    },
    example: { resourceId: 1, from: 'AVAILABLE', to: 'MAINTENANCE', affectedReservations: [{ id: 1, taskId: 1 }], cancelledReservations: 0 },
    errors: [403, 404, 422],
  }, async (req) => {
    return db.tx(async (t) => {
      const r = await resSvc.getResource(req.params.id, t, { lock: true });
      await assertManageResource(req.user, r);
      const to = req.body.status;
      if (!(resSvc.MANUAL_TRANSITIONS[r.status] || []).includes(to)) {
        throw E.state(`자원 상태 ${r.status} → ${to} 는 허용되지 않습니다.`, { allowed: resSvc.MANUAL_TRANSITIONS[r.status] });
      }
      if (to === 'RETIRED') {
        const inUse = await t.one("SELECT COUNT(*) AS n FROM resource_allocations WHERE resource_id = ? AND status IN ('IN_USE','RESERVED')", [r.id]);
        if (inUse.n) throw E.state('사용 중이거나 예약된 자원은 폐기할 수 없습니다. 예약을 먼저 정리하세요.');
      }
      const affected = resSvc.BLOCKED.includes(to)
        ? await t.query("SELECT id, task_id, member_id, start_at, end_at FROM resource_allocations WHERE resource_id = ? AND status = 'RESERVED'", [r.id]) : [];
      let cancelled = 0;
      if (affected.length && req.body.cancelReservations) {
        cancelled = (await t.query("UPDATE resource_allocations SET status = 'CANCELLED' WHERE resource_id = ? AND status = 'RESERVED'", [r.id])).affectedRows;
      }
      await t.query('UPDATE resources SET status = ? WHERE id = ?', [to, r.id]);
      await rec.resourceHistory(r.id, 'STATUS_CHANGED', r.status, to, req.user, { reason: req.body.reason, cancelledReservations: cancelled });
      await rec.audit(req.user, 'RESOURCE_STATUS_CHANGED', 'resource', r.id, { from: r.status, to, reason: req.body.reason }, 'SUCCESS', req.ip);
      return { resourceId: r.id, from: r.status, to, affectedReservations: affected, cancelledReservations: cancelled };
    });
  });

  api.get('/:id/history', {
    summary: '자원 사용·반납·상태 변경 이력 (MongoDB)',
    reqs: ['FR-15', 'DR-03'],
    params: idParam,
    query: { event: { type: 'string', enum: ['REGISTERED', 'UPDATED', 'STATUS_CHANGED', 'ALLOCATED', 'RESCHEDULED', 'CANCELLED', 'CHECKED_OUT', 'RETURNED', 'ISSUE_REPORTED', 'ISSUE_RESOLVED'] }, from: { type: 'datetime' }, to: { type: 'datetime' } },
    list: { sort: { at: 'at' }, defaultSort: '-at' },
    example: { id: '6718...', resourceId: 2, event: 'CHECKED_OUT', from: 'RESERVED', to: 'IN_USE', by: { id: 6, username: 'capo2', role: 'CAPO' }, allocationId: 2, at: '2026-10-18T08:00:00.000Z' },
    errors: [403, 404],
  }, async (req) => {
    const r = await getVisibleResource(req.user, req.params.id);
    const f = { resourceId: r.id };
    if (req.q.event) f.event = req.q.event;
    if (req.q.from || req.q.to) f.at = { ...(req.q.from && { $gte: req.q.from }), ...(req.q.to && { $lte: req.q.to }) };
    const c = mongo.col('resourceHistory');
    const [items, total] = await Promise.all([c.find(f).sort(req.page.mongoSort).skip(req.page.offset).limit(req.page.size).toArray(), c.countDocuments(f)]);
    return paged(items.map(mongo.out), total, req.page);
  });

  api.get('/:id/availability', {
    summary: '자원의 기간 내 사용 가능/불가 구간 (예약 현황)',
    reqs: ['FR-14', 'BR-07'],
    params: idParam,
    query: {
      from: { type: 'datetime', desc: '기본: 현재' },
      to: { type: 'datetime', desc: '기본: from + 7일' },
    },
    example: { resourceId: 1, status: 'AVAILABLE', usable: true, busy: [{ allocationId: 1, startAt: '2026-10-19T09:00:00.000Z', endAt: '2026-10-19T12:00:00.000Z', status: 'RESERVED' }] },
    errors: [403, 404],
  }, async (req) => {
    const r = await getVisibleResource(req.user, req.params.id);
    const from = req.q.from || new Date();
    const to = req.q.to || new Date(from.getTime() + 7 * 86400000);
    const busy = await db.query(
      "SELECT id AS allocation_id, start_at, end_at, status, task_id, member_id FROM resource_allocations WHERE resource_id = ? AND status IN ('RESERVED','IN_USE') AND start_at < ? AND end_at > ? ORDER BY start_at",
      [r.id, to, from]
    );
    return { resourceId: r.id, status: r.status, usable: !resSvc.BLOCKED.includes(r.status), from, to, busy };
  });
};

module.exports.helpers = { getVisibleResource, assertManageResource, visibility };
