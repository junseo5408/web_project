/** 승급 요청 워크플로 (FR-03, BR-04, BR-10) : Capo 가 요청 → 상위 권한자가 승인/반려 */
const db = require('../db/mysql');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const scope = require('../services/scope');
const memberSvc = require('../services/members');

const EXAMPLE = {
  id: 1, memberId: 14, memberName: 'Danny Lombardi', currentRole: 'ASSOCIATE', targetRole: 'SOLDIER', requestedBy: 5, requestedByName: 'Tony Russo',
  reason: '6개월간 성실 활동', status: 'PENDING', reviewedBy: null, reviewComment: null, createdAt: '2026-10-18T00:00:00.000Z', reviewedAt: null,
};
const SELECT = `SELECT p.id, p.member_id, m.name AS member_name, cr.code AS current_role, tr.code AS target_role, tr.level AS target_level,
  p.requested_by, rb.name AS requested_by_name, p.reason, p.status, p.reviewed_by, p.review_comment, p.created_at, p.reviewed_at
  FROM promotion_requests p JOIN members m ON m.id = p.member_id JOIN roles cr ON cr.id = p.current_role_id
  JOIN roles tr ON tr.id = p.target_role_id JOIN members rb ON rb.id = p.requested_by`;

async function getRequest(id) {
  const r = await db.one(`${SELECT} WHERE p.id = ?`, [id]);
  if (!r) throw E.notFound('승급 요청', id);
  return r;
}

async function assertCanSee(user, r) {
  if (r.requestedBy === user.id || r.memberId === user.id) return;
  if (user.perms.has('promotion.review') && (await scope.canManageMember(user, r.memberId))) return;
  throw E.forbidden('이 승급 요청을 조회할 권한이 없습니다.');
}

async function getPendingForReview(user, id) {
  const r = await getRequest(id);
  if (r.status !== 'PENDING') throw E.state(`이미 처리된 요청입니다. (${r.status})`);
  if (r.requestedBy === user.id) throw E.forbidden('본인이 요청한 승급은 직접 심사할 수 없습니다(직무 분리).', 'BR-04');
  await scope.assertManageMember(user, r.memberId);
  return r;
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '05. Promotion Requests', base: '/api/promotion-requests' });

  api.post('', {
    summary: '승급 요청 등록',
    description: '현재보다 높은 역할로의 승급만 요청할 수 있으며, 같은 구성원에 대해 대기 중인 요청이 있으면 중복 등록할 수 없다.',
    reqs: ['FR-03', 'BR-04'], perm: 'promotion.request', status: 201,
    body: {
      memberId: { type: 'integer', required: true, example: 9 },
      targetRole: { type: 'string', required: true, enum: ['SOLDIER', 'CAPO', 'UNDERBOSS'], example: 'CAPO' },
      reason: { type: 'string', required: true, maxLength: 500, example: '경비 업무 리더십 탁월' },
    },
    example: EXAMPLE,
    errors: [403, 404, 409, 422],
  }, async (req) => {
    const target = await memberSvc.getMember(req.body.memberId);
    const role = await memberSvc.getRole(req.body.targetRole);
    await scope.assertManageMember(req.user, target.id);
    if (target.id === req.user.id) throw E.forbidden('자기 자신의 승급은 요청할 수 없습니다.', 'BR-04');
    if (role.level <= target.level) throw E.state(`승급 요청은 현재 역할(${target.role})보다 높은 역할만 가능합니다.`);
    if (!['ACTIVE', 'STANDBY'].includes(target.status)) throw E.state(`${target.status} 상태의 구성원은 승급 요청 대상이 아닙니다.`);
    const dup = await db.one("SELECT id FROM promotion_requests WHERE member_id = ? AND status = 'PENDING'", [target.id]);
    if (dup) throw E.conflict('이미 대기 중인 승급 요청이 있습니다.', { requestId: dup.id });
    const cur = await memberSvc.getRole(target.role);
    const r = await db.query('INSERT INTO promotion_requests (member_id, current_role_id, target_role_id, requested_by, reason) VALUES (?,?,?,?,?)',
      [target.id, cur.id, role.id, req.user.id, req.body.reason]);
    await rec.audit(req.user, 'PROMOTION_REQUESTED', 'member', target.id, { requestId: r.insertId, targetRole: role.code }, 'SUCCESS', req.ip);
    return getRequest(r.insertId);
  });

  api.get('', {
    summary: '승급 요청 목록 (내가 요청했거나 심사 가능한 요청)',
    reqs: ['FR-03', 'FR-19'],
    query: { status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] }, memberId: { type: 'integer' } },
    list: { sort: { createdAt: 'p.created_at', id: 'p.id' }, defaultSort: '-createdAt' },
    example: EXAMPLE,
  }, async (req) => {
    const where = [];
    const params = [];
    if (req.user.perms.has('promotion.review')) {
      const visible = await scope.managedCrewIds(req.user);
      if (visible !== null) {
        where.push(`(p.requested_by = ? OR p.member_id IN (SELECT member_id FROM crew_memberships WHERE left_at IS NULL AND crew_id IN (?)))`);
        params.push(req.user.id, visible.length ? visible : [0]);
      }
    } else {
      where.push('(p.requested_by = ? OR p.member_id = ?)');
      params.push(req.user.id, req.user.id);
    }
    if (req.q.status) { where.push('p.status = ?'); params.push(req.q.status); }
    if (req.q.memberId) { where.push('p.member_id = ?'); params.push(req.q.memberId); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await db.one(`SELECT COUNT(*) AS n FROM promotion_requests p ${w}`, params)).n;
    const rows = await db.query(`${SELECT} ${w} ORDER BY ${req.page.orderBy} LIMIT ? OFFSET ?`, [...params, req.page.size, req.page.offset]);
    return paged(rows, total, req.page);
  });

  api.get('/:id', {
    summary: '승급 요청 상세',
    reqs: ['FR-03'],
    params: { id: { type: 'integer', example: 1 } },
    example: EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    const r = await getRequest(req.params.id);
    await assertCanSee(req.user, r);
    return r;
  });

  api.post('/:id/approve', {
    summary: '승급 요청 승인 (역할 변경 실행 + 이력 기록)',
    description: '승인자는 대상 구성원과 목표 역할보다 높은 권한을 가져야 한다(BR-04). 요청자 본인은 승인할 수 없다.',
    reqs: ['FR-03', 'BR-04', 'BR-10'], perm: 'promotion.review',
    params: { id: { type: 'integer', example: 1 } },
    body: { comment: { type: 'string', maxLength: 500, example: '승인합니다.' } },
    example: { ...EXAMPLE, status: 'APPROVED', reviewedBy: 3, reviewComment: '승인합니다.' },
    errors: [403, 404, 422],
    verify: 'underboss1 로그인 → POST /api/promotion-requests/1/approve → associate1 역할 SOLDIER 로 변경',
  }, async (req) => {
    const r = await getPendingForReview(req.user, req.params.id);
    const target = await memberSvc.getMember(r.memberId);
    if (target.role !== r.currentRole) throw E.state('요청 이후 구성원의 역할이 이미 변경되었습니다. 요청을 반려하세요.');
    const role = await memberSvc.getRole(r.targetRole);
    await memberSvc.assertRoleChange(req.user, target, role);
    await db.tx(async (t) => {
      await t.query("UPDATE promotion_requests SET status = 'APPROVED', reviewed_by = ?, review_comment = ?, reviewed_at = NOW() WHERE id = ?", [req.user.id, req.body.comment || null, r.id]);
      await memberSvc.applyRoleChange(t, req.user, target, role, `승급 요청 #${r.id} 승인`);
    });
    await rec.notify([r.requestedBy], 'REQUEST_REVIEWED', '승급 요청 승인', `${r.memberName} 님의 ${r.targetRole} 승급 요청이 승인되었습니다.`);
    return getRequest(r.id);
  });

  api.post('/:id/reject', {
    summary: '승급 요청 반려 (사유 필수)',
    reqs: ['FR-03'], perm: 'promotion.review',
    params: { id: { type: 'integer', example: 1 } },
    body: { comment: { type: 'string', required: true, maxLength: 500, example: '추가 실적 필요' } },
    example: { ...EXAMPLE, status: 'REJECTED', reviewComment: '추가 실적 필요' },
    errors: [403, 404, 422],
  }, async (req) => {
    const r = await getPendingForReview(req.user, req.params.id);
    await db.query("UPDATE promotion_requests SET status = 'REJECTED', reviewed_by = ?, review_comment = ?, reviewed_at = NOW() WHERE id = ?", [req.user.id, req.body.comment, r.id]);
    await rec.audit(req.user, 'PROMOTION_REJECTED', 'member', r.memberId, { requestId: r.id, comment: req.body.comment }, 'SUCCESS', req.ip);
    await rec.notify([r.requestedBy], 'REQUEST_REVIEWED', '승급 요청 반려', `${r.memberName} 님의 승급 요청이 반려되었습니다: ${req.body.comment}`);
    return getRequest(r.id);
  });

  api.delete('/:id', {
    summary: '승급 요청 취소 (요청자 본인, 대기 상태만)',
    reqs: ['FR-03'],
    params: { id: { type: 'integer', example: 1 } },
    example: { ...EXAMPLE, status: 'CANCELLED' },
    errors: [403, 404, 422],
  }, async (req) => {
    const r = await getRequest(req.params.id);
    if (r.requestedBy !== req.user.id) throw E.forbidden('요청자 본인만 취소할 수 있습니다.');
    if (r.status !== 'PENDING') throw E.state(`이미 처리된 요청입니다. (${r.status})`);
    await db.query("UPDATE promotion_requests SET status = 'CANCELLED', reviewed_at = NOW() WHERE id = ?", [r.id]);
    return getRequest(r.id);
  });
};
