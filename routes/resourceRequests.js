/** 자원 사용 요청 (FR-14, FR-17, BR-07, BR-08) : 구성원이 요청 → 관리자가 승인하면 배정 생성 */
const db = require('../db/mysql');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const scope = require('../services/scope');
const resSvc = require('../services/resources');
const { helpers: resHelpers } = require('./resources');

const EXAMPLE = {
  id: 1, resourceId: 5, resourceCode: 'CM-001', resourceName: '무전기 세트 1', requesterId: 9, requesterName: 'Joey Marino', taskId: null,
  startAt: '2026-10-19T09:00:00.000Z', endAt: '2026-10-19T12:00:00.000Z', purpose: '창고 점검 시 연락용', status: 'PENDING', reviewedBy: null, reviewComment: null, allocationId: null,
};
const SELECT = `SELECT q.*, r.code AS resource_code, r.name AS resource_name, r.crew_id AS resource_crew_id, m.name AS requester_name
  FROM resource_requests q JOIN resources r ON r.id = q.resource_id JOIN members m ON m.id = q.requester_id`;

async function getRequest(id) {
  const q = await db.one(`${SELECT} WHERE q.id = ?`, [id]);
  if (!q) throw E.notFound('자원 사용 요청', id);
  return q;
}

async function getPendingForReview(user, id) {
  const q = await getRequest(id);
  if (q.status !== 'PENDING') throw E.state(`이미 처리된 요청입니다. (${q.status})`);
  if (q.requesterId === user.id) throw E.forbidden('본인의 요청은 직접 심사할 수 없습니다.');
  await scope.assertManageMember(user, q.requesterId, 'BR-09');
  return q;
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '19. Resource Requests', base: '/api/resource-requests' });

  api.post('', {
    summary: '자원 사용 요청 (권한 등급·상태·시간 중복 사전 검사)',
    reqs: ['FR-14', 'FR-17', 'BR-07', 'BR-08'], status: 201,
    body: {
      resourceId: { type: 'integer', required: true, example: 9 },
      startAt: { type: 'datetime', required: true, example: '2026-10-22T09:00:00Z' },
      endAt: { type: 'datetime', required: true, example: '2026-10-22T12:00:00Z' },
      taskId: { type: 'integer', desc: '관련 업무 (본인 참여 업무)' },
      purpose: { type: 'string', required: true, maxLength: 255, example: '거래처 방문' },
    },
    example: EXAMPLE,
    errors: [403, 404, 409],
  }, async (req) => {
    const b = req.body;
    if (b.endAt <= b.startAt) throw E.badRequest('endAt 은 startAt 이후여야 합니다.');
    if (!['ACTIVE', 'STANDBY'].includes(req.user.status)) throw E.state('활동중인 구성원만 자원을 요청할 수 있습니다.');
    const r = await resHelpers.getVisibleResource(req.user, b.resourceId);
    if (resSvc.BLOCKED.includes(r.status)) throw E.rule('BR-08', `사용 불가 상태(${r.status})의 자원은 요청할 수 없습니다.`);
    if (b.taskId) {
      const p = await db.one("SELECT id FROM task_assignments WHERE task_id = ? AND member_id = ? AND status IN ('ASSIGNED','ACCEPTED')", [b.taskId, req.user.id]);
      if (!p) throw E.forbidden('본인이 참여하는 업무에 대해서만 요청할 수 있습니다.');
    }
    const conflicts = await resSvc.findAllocationConflicts(db, r.id, b.startAt, b.endAt);
    if (conflicts.length) throw E.rule('BR-07', '해당 시간대에 이미 배정된 자원입니다.', { conflicts });
    const ins = await db.query('INSERT INTO resource_requests (resource_id, requester_id, task_id, start_at, end_at, purpose) VALUES (?,?,?,?,?,?)',
      [r.id, req.user.id, b.taskId || null, b.startAt, b.endAt, b.purpose]);
    return getRequest(ins.insertId);
  });

  api.get('', {
    summary: '자원 사용 요청 목록 (내 요청 또는 심사 가능한 요청)',
    reqs: ['FR-14', 'FR-17', 'FR-21'],
    query: { status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] }, resourceId: { type: 'integer' } },
    list: { sort: { createdAt: 'q.created_at', startAt: 'q.start_at' }, defaultSort: '-createdAt' },
    example: EXAMPLE,
  }, async (req) => {
    const where = [];
    const params = [];
    const managed = req.user.perms.has('resource.allocate') ? await scope.managedCrewIds(req.user) : [];
    if (managed !== null) {
      const parts = ['q.requester_id = ?'];
      params.push(req.user.id);
      if (managed.length) { parts.push('q.requester_id IN (SELECT member_id FROM crew_memberships WHERE left_at IS NULL AND crew_id IN (?))'); params.push(managed); }
      where.push(`(${parts.join(' OR ')})`);
    }
    if (req.q.status) { where.push('q.status = ?'); params.push(req.q.status); }
    if (req.q.resourceId) { where.push('q.resource_id = ?'); params.push(req.q.resourceId); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await db.one(`SELECT COUNT(*) AS n FROM resource_requests q ${w}`, params)).n;
    const rows = await db.query(`${SELECT} ${w} ORDER BY ${req.page.orderBy} LIMIT ? OFFSET ?`, [...params, req.page.size, req.page.offset]);
    return paged(rows, total, req.page);
  });

  api.get('/:id', {
    summary: '자원 사용 요청 상세',
    reqs: ['FR-14'],
    params: { id: { type: 'integer', example: 1 } },
    example: EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    const q = await getRequest(req.params.id);
    if (q.requesterId !== req.user.id && !(req.user.perms.has('resource.allocate') && (await scope.canManageMember(req.user, q.requesterId)))) throw E.forbidden();
    return q;
  });

  api.post('/:id/approve', {
    summary: '자원 사용 요청 승인 (배정 생성 시 BR-07/BR-08 재검사)',
    reqs: ['FR-17', 'BR-07', 'BR-08'], perm: 'resource.allocate',
    params: { id: { type: 'integer', example: 1 } },
    body: { comment: { type: 'string', maxLength: 500, example: '승인' } },
    example: { ...EXAMPLE, status: 'APPROVED', reviewedBy: 5, allocationId: 4 },
    errors: [403, 404, 409, 422],
    verify: 'capo1 → POST /api/resource-requests/1/approve → APPROVED + allocationId 생성',
  }, async (req) => {
    const q = await getPendingForReview(req.user, req.params.id);
    if (q.resourceCrewId && !(await scope.canManageCrew(req.user, q.resourceCrewId))) throw E.forbidden('다른 Crew 소유 자원입니다.');
    await db.tx(async (t) => {
      const a = await resSvc.allocate(t, req.user, {
        resourceId: q.resourceId, memberId: q.taskId ? null : q.requesterId, taskId: q.taskId, startAt: q.startAt, endAt: q.endAt, purpose: q.purpose,
      });
      await t.query("UPDATE resource_requests SET status = 'APPROVED', reviewed_by = ?, review_comment = ?, reviewed_at = NOW(), allocation_id = ? WHERE id = ?",
        [req.user.id, req.body.comment || null, a.id, q.id]);
    });
    await rec.notify(q.requesterId, 'REQUEST_REVIEWED', '자원 요청 승인', `${q.resourceName} 사용 요청이 승인되었습니다.`, `/api/resource-requests/${q.id}`);
    return getRequest(q.id);
  });

  api.post('/:id/reject', {
    summary: '자원 사용 요청 반려 (사유 필수)',
    reqs: ['FR-17'], perm: 'resource.allocate',
    params: { id: { type: 'integer', example: 1 } },
    body: { comment: { type: 'string', required: true, maxLength: 500, example: '해당 시간 다른 업무 우선' } },
    example: { ...EXAMPLE, status: 'REJECTED', reviewComment: '해당 시간 다른 업무 우선' },
    errors: [403, 404, 422],
  }, async (req) => {
    const q = await getPendingForReview(req.user, req.params.id);
    await db.query("UPDATE resource_requests SET status = 'REJECTED', reviewed_by = ?, review_comment = ?, reviewed_at = NOW() WHERE id = ?", [req.user.id, req.body.comment, q.id]);
    await rec.notify(q.requesterId, 'REQUEST_REVIEWED', '자원 요청 반려', `${q.resourceName} 사용 요청이 반려되었습니다: ${req.body.comment}`);
    return getRequest(q.id);
  });

  api.delete('/:id', {
    summary: '내 자원 사용 요청 취소 (대기 상태만)',
    reqs: ['FR-14'],
    params: { id: { type: 'integer', example: 1 } },
    example: { ...EXAMPLE, status: 'CANCELLED' },
    errors: [403, 404, 422],
  }, async (req) => {
    const q = await getRequest(req.params.id);
    if (q.requesterId !== req.user.id) throw E.forbidden('본인의 요청만 취소할 수 있습니다.');
    if (q.status !== 'PENDING') throw E.state(`이미 처리된 요청입니다. (${q.status})`);
    await db.query("UPDATE resource_requests SET status = 'CANCELLED', reviewed_at = NOW() WHERE id = ?", [q.id]);
    return getRequest(q.id);
  });
};
