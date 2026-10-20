/** 자원 배정 / 사용 / 반납 (FR-15, FR-17, BR-07, BR-08, DR-03) */
const db = require('../db/mysql');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const scope = require('../services/scope');
const resSvc = require('../services/resources');
const taskSvc = require('../services/tasks');

const idParam = { id: { type: 'integer', example: 1, desc: '배정 ID' } };
const EXAMPLE = {
  id: 1, resourceId: 1, resourceCode: 'VH-001', resourceName: '검정 세단', taskId: 1, taskTitle: '물류 창고 정기 점검', memberId: null, memberName: null,
  startAt: '2026-10-19T09:00:00.000Z', endAt: '2026-10-19T12:00:00.000Z', status: 'RESERVED', purpose: '창고 점검 이동', allocatedBy: 5,
  checkedOutAt: null, returnedAt: null, returnCondition: null,
};

/** 배정 대상(업무/구성원)과 자원이 모두 요청자의 관리 범위인지 */
async function assertCanAllocate(user, { resourceId, taskId, memberId }) {
  const r = await resSvc.getResource(resourceId);
  if (r.crewId && !(await scope.canManageCrew(user, r.crewId))) throw E.forbidden(`자원(${r.code})은 다른 Crew 소유입니다.`, 'BR-09');
  if (taskId) await taskSvc.getManagedTask(user, taskId);
  if (memberId) await scope.assertManageMember(user, memberId, 'BR-09');
}

/** 배정 당사자(구성원 본인 / 업무 참여자) 또는 관리자 */
async function assertParty(user, a) {
  if (a.memberId === user.id) return;
  if (a.taskId) {
    const p = await db.one("SELECT id FROM task_assignments WHERE task_id = ? AND member_id = ? AND status IN ('ASSIGNED','ACCEPTED')", [a.taskId, user.id]);
    if (p) return;
  }
  if (user.perms.has('resource.allocate')) {
    if (a.taskId) { const t = await taskSvc.getTask(a.taskId); if (await scope.canManageCrew(user, t.crewId)) return; }
    if (a.memberId && (await scope.canManageMember(user, a.memberId))) return;
  }
  throw E.forbidden('이 자원 배정의 당사자 또는 관리자만 처리할 수 있습니다.');
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '18. Resource Allocations', base: '/api/allocations' });

  api.get('', {
    summary: '자원 배정/사용 기록 조회 (자원·업무·구성원·상태·기간)',
    description: '관리자는 관리 범위 전체, 일반 구성원은 본인 또는 본인이 참여한 업무의 배정만 조회된다.',
    reqs: ['FR-15', 'FR-17', 'DR-03', 'FR-21'],
    query: {
      resourceId: { type: 'integer' }, taskId: { type: 'integer' }, memberId: { type: 'integer' },
      status: { type: 'array', items: { type: 'string', enum: ['RESERVED', 'IN_USE', 'RETURNED', 'CANCELLED'] } },
      from: { type: 'datetime' }, to: { type: 'datetime' },
      overdue: { type: 'boolean', desc: 'true: 반납 예정 시각이 지난 사용중 배정' },
    },
    list: { sort: { startAt: 'a.start_at', id: 'a.id', createdAt: 'a.created_at' }, defaultSort: '-startAt' },
    example: EXAMPLE,
  }, async (req) => {
    const where = [];
    const params = [];
    const managed = await scope.managedCrewIds(req.user);
    if (managed !== null) {
      const parts = ['a.member_id = ?', "a.task_id IN (SELECT task_id FROM task_assignments WHERE member_id = ? AND status IN ('ASSIGNED','ACCEPTED'))"];
      params.push(req.user.id, req.user.id);
      if (managed.length && req.user.perms.has('resource.allocate')) {
        parts.push('r.crew_id IN (?)', 'a.task_id IN (SELECT id FROM tasks WHERE crew_id IN (?))');
        params.push(managed, managed);
      }
      where.push(`(${parts.join(' OR ')})`);
    }
    for (const [k, col] of [['resourceId', 'a.resource_id'], ['taskId', 'a.task_id'], ['memberId', 'a.member_id']]) {
      if (req.q[k]) { where.push(`${col} = ?`); params.push(req.q[k]); }
    }
    if (req.q.status) { where.push('a.status IN (?)'); params.push(req.q.status); }
    if (req.q.from) { where.push('a.end_at >= ?'); params.push(req.q.from); }
    if (req.q.to) { where.push('a.start_at <= ?'); params.push(req.q.to); }
    if (req.q.overdue) where.push("a.status = 'IN_USE' AND a.end_at < NOW()");
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = 'FROM resource_allocations a JOIN resources r ON r.id = a.resource_id LEFT JOIN tasks tk ON tk.id = a.task_id LEFT JOIN members m ON m.id = a.member_id';
    const total = (await db.one(`SELECT COUNT(*) AS n ${from} ${w}`, params)).n;
    const rows = await db.query(`SELECT a.*, r.code AS resource_code, r.name AS resource_name, tk.title AS task_title, m.name AS member_name ${from} ${w} ORDER BY ${req.page.orderBy} LIMIT ? OFFSET ?`,
      [...params, req.page.size, req.page.offset]);
    return paged(rows, total, req.page);
  });

  api.get('/:id', {
    summary: '자원 배정 상세',
    reqs: ['FR-15', 'FR-17'],
    params: idParam,
    example: EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    const a = await resSvc.getAllocation(req.params.id);
    await assertParty(req.user, a);
    return a;
  });

  api.post('', {
    summary: '자원을 업무 또는 구성원에게 배정 (예약)',
    description: 'BR-08: 사용 불가/점검 필요/정비중/폐기 자원은 배정 불가. BR-07: 동일 자원이 같은 시간대에 이미 배정되어 있으면 불가. 업무 배정 시 기간을 생략하면 업무 일정이 적용된다. 자원 행을 잠근 트랜잭션에서 검사한다.',
    reqs: ['FR-17', 'BR-07', 'BR-08', 'DR-03'], perm: 'resource.allocate', status: 201,
    body: {
      resourceId: { type: 'integer', required: true, example: 9 },
      taskId: { type: 'integer', example: 5, desc: '업무 배정 시' },
      memberId: { type: 'integer', desc: '구성원 개인 배정 시' },
      startAt: { type: 'datetime', example: '2026-10-20T13:00:00Z', desc: '업무 배정 시 생략 가능' },
      endAt: { type: 'datetime', example: '2026-10-20T16:00:00Z' },
      purpose: { type: 'string', maxLength: 255, example: '답사 이동' },
    },
    bodyExample: { resourceId: 1, taskId: 2, purpose: '거래처 미팅 이동' },
    example: EXAMPLE,
    errors: [403, 404,
      { status: 409, rule: 'BR-07', message: '자원(검정 세단)은 해당 시간대에 이미 배정되어 있습니다.' },
      { status: 409, rule: 'BR-08', message: '사용 불가 상태(MAINTENANCE)의 자원은 배정할 수 없습니다.' }],
    verify: 'capo1 → POST /api/allocations {resourceId:1, taskId:2} → 409 BR-07 (1번 업무와 시간 겹침) / boss → {resourceId:3, taskId:2} → 409 BR-08',
  }, async (req) => {
    const b = req.body;
    if (b.taskId && b.memberId) throw E.badRequest('taskId 와 memberId 중 하나만 지정하세요.');
    await assertCanAllocate(req.user, b);
    const a = await db.tx((t) => resSvc.allocate(t, req.user, b));
    await rec.audit(req.user, 'RESOURCE_ALLOCATED', 'resource', b.resourceId, { allocationId: a.id, taskId: b.taskId || null, memberId: b.memberId || null }, 'SUCCESS', req.ip);
    if (a.memberId) await rec.notify(a.memberId, 'RESOURCE', '자원 배정', `${a.resourceName} 이(가) 배정되었습니다.`, `/api/allocations/${a.id}`);
    return a;
  });

  api.patch('/:id', {
    summary: '예약 기간 변경 (중복 재검사)',
    reqs: ['FR-17', 'BR-07', 'BR-08'], perm: 'resource.allocate',
    params: idParam,
    body: {
      startAt: { type: 'datetime', required: true, example: '2026-10-19T13:00:00Z' },
      endAt: { type: 'datetime', required: true, example: '2026-10-19T15:00:00Z' },
    },
    example: { ...EXAMPLE, startAt: '2026-10-19T13:00:00.000Z', endAt: '2026-10-19T15:00:00.000Z' },
    errors: [403, 404, 409, 422],
  }, async (req) => {
    if (req.body.endAt <= req.body.startAt) throw E.badRequest('endAt 은 startAt 이후여야 합니다.');
    const before = await resSvc.getAllocation(req.params.id);
    await assertCanAllocate(req.user, before);
    await db.tx(async (t) => {
      const r = await resSvc.getResource(before.resourceId, t, { lock: true });
      const a = await t.one('SELECT * FROM resource_allocations WHERE id = ? FOR UPDATE', [before.id]);
      if (a.status !== 'RESERVED') throw E.state('예약(RESERVED) 상태에서만 기간을 변경할 수 있습니다.');
      if (resSvc.BLOCKED.includes(r.status)) throw E.rule('BR-08', `사용 불가 상태(${r.status})의 자원입니다.`);
      const conflicts = await resSvc.findAllocationConflicts(t, a.resourceId, req.body.startAt, req.body.endAt, [a.id]);
      if (conflicts.length) throw E.rule('BR-07', '변경하려는 기간에 이미 다른 배정이 있습니다.', { conflicts });
      await t.query('UPDATE resource_allocations SET start_at = ?, end_at = ? WHERE id = ?', [req.body.startAt, req.body.endAt, a.id]);
      await rec.resourceHistory(a.resourceId, 'RESCHEDULED', { startAt: a.startAt, endAt: a.endAt }, req.body, req.user, { allocationId: a.id });
    });
    return resSvc.getAllocation(before.id);
  });

  api.delete('/:id', {
    summary: '자원 예약 취소 (RESERVED 상태만)',
    reqs: ['FR-15', 'FR-17'],
    params: idParam,
    example: { ...EXAMPLE, status: 'CANCELLED' },
    errors: [403, 404, 422],
  }, async (req) => {
    const a = await resSvc.getAllocation(req.params.id);
    await assertParty(req.user, a);
    if (a.status !== 'RESERVED') throw E.state('예약(RESERVED) 상태만 취소할 수 있습니다.');
    await db.query("UPDATE resource_allocations SET status = 'CANCELLED' WHERE id = ?", [a.id]);
    await rec.resourceHistory(a.resourceId, 'CANCELLED', 'RESERVED', 'CANCELLED', req.user, { allocationId: a.id });
    return resSvc.getAllocation(a.id);
  });

  api.post('/:id/checkout', {
    summary: '자원 사용 시작 (체크아웃: RESERVED → IN_USE)',
    reqs: ['FR-15', 'BR-07', 'BR-08', 'DR-03'],
    params: idParam,
    example: { ...EXAMPLE, status: 'IN_USE', checkedOutAt: '2026-10-19T09:00:00.000Z' },
    errors: [403, 404, 409, 422],
  }, async (req) => {
    const before = await resSvc.getAllocation(req.params.id);
    await assertParty(req.user, before);
    await db.tx(async (t) => {
      const r = await resSvc.getResource(before.resourceId, t, { lock: true });
      const a = await t.one('SELECT * FROM resource_allocations WHERE id = ? FOR UPDATE', [before.id]);
      if (a.status !== 'RESERVED') throw E.state(`예약(RESERVED) 상태에서만 사용을 시작할 수 있습니다. (현재 ${a.status})`);
      if (new Date(a.endAt) <= new Date()) throw E.state('예약 기간이 이미 지났습니다.');
      if (resSvc.BLOCKED.includes(r.status)) throw E.rule('BR-08', `사용 불가 상태(${r.status})의 자원은 사용할 수 없습니다.`);
      const other = await t.one("SELECT id FROM resource_allocations WHERE resource_id = ? AND status = 'IN_USE' AND id <> ?", [r.id, a.id]);
      if (other) throw E.rule('BR-07', '이전 사용자가 아직 반납하지 않았습니다.', { allocationId: other.id });
      await t.query("UPDATE resource_allocations SET status = 'IN_USE', checked_out_at = NOW() WHERE id = ?", [a.id]);
      await rec.resourceHistory(r.id, 'CHECKED_OUT', 'RESERVED', 'IN_USE', req.user, { allocationId: a.id });
      await resSvc.syncInUse(t, r.id, req.user);
    });
    await rec.activity(req.user.id, 'RESOURCE_CHECKOUT', `${before.resourceName} 사용 시작`, { allocationId: before.id });
    return resSvc.getAllocation(before.id);
  });

  api.post('/:id/return', {
    summary: '자원 반납 (상태 기록, 파손 시 점검 필요 / 분실 시 사용 불가 자동 전환)',
    reqs: ['FR-15', 'FR-16', 'DR-03'],
    params: idParam,
    body: {
      condition: { type: 'string', required: true, enum: ['GOOD', 'DAMAGED', 'LOST'], example: 'GOOD' },
      note: { type: 'string', maxLength: 500, example: '이상 없음' },
    },
    example: { ...EXAMPLE, status: 'RETURNED', returnCondition: 'GOOD', resourceStatus: 'AVAILABLE' },
    errors: [403, 404, 422],
  }, async (req) => {
    const before = await resSvc.getAllocation(req.params.id);
    await assertParty(req.user, before);
    const resourceStatus = await db.tx(async (t) => {
      const r = await resSvc.getResource(before.resourceId, t, { lock: true });
      const a = await t.one('SELECT * FROM resource_allocations WHERE id = ? FOR UPDATE', [before.id]);
      if (a.status !== 'IN_USE') throw E.state(`사용중(IN_USE) 상태만 반납할 수 있습니다. (현재 ${a.status})`);
      await t.query("UPDATE resource_allocations SET status = 'RETURNED', returned_at = NOW(), return_condition = ?, return_note = ? WHERE id = ?", [req.body.condition, req.body.note || null, a.id]);
      await rec.resourceHistory(r.id, 'RETURNED', 'IN_USE', 'RETURNED', req.user, { allocationId: a.id, condition: req.body.condition, note: req.body.note || null });
      let next = await resSvc.syncInUse(t, r.id, req.user);
      if (req.body.condition !== 'GOOD') {
        const target = req.body.condition === 'DAMAGED' ? 'NEEDS_INSPECTION' : 'UNAVAILABLE';
        await t.query("INSERT INTO resource_issues (resource_id, reported_by, severity, description) VALUES (?, ?, 'HIGH', ?)", [r.id, req.user.id, `반납 시 ${req.body.condition}: ${req.body.note || ''}`]);
        await t.query('UPDATE resources SET status = ? WHERE id = ?', [target, r.id]);
        await rec.resourceHistory(r.id, 'STATUS_CHANGED', next, target, req.user, { reason: `반납 상태 ${req.body.condition}`, allocationId: a.id });
        next = target;
      }
      return next;
    });
    return { ...(await resSvc.getAllocation(before.id)), resourceStatus };
  });
};
