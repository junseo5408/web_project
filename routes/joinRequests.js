/** Crew 가입 요청 (FR-01, FR-06, BR-01, BR-05) : 가입 신청 → Crew 책임자 승인 시 소속 + 가입 승인 */
const db = require('../db/mysql');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const scope = require('../services/scope');
const memberSvc = require('../services/members');
const { helpers: crewHelpers } = require('./crews');

const EXAMPLE = {
  id: 1, crewId: 3, crewName: 'Uptown Crew', memberId: 19, memberName: 'Sonny Amato', memberStatus: 'PENDING', membershipType: 'FORMAL',
  message: 'Uptown Crew 합류를 희망합니다.', status: 'PENDING', reviewedBy: null, reviewComment: null, createdAt: '2026-10-18T00:00:00.000Z',
};
const SELECT = `SELECT j.*, c.name AS crew_name, m.name AS member_name, m.status AS member_status
  FROM crew_join_requests j JOIN crews c ON c.id = j.crew_id JOIN members m ON m.id = j.member_id`;

async function getRequest(id) {
  const j = await db.one(`${SELECT} WHERE j.id = ?`, [id]);
  if (!j) throw E.notFound('가입 요청', id);
  return j;
}

async function getPendingForReview(user, id) {
  const j = await getRequest(id);
  if (j.status !== 'PENDING') throw E.state(`이미 처리된 요청입니다. (${j.status})`);
  await scope.assertManageCrew(user, j.crewId, 'BR-05');
  return j;
}

module.exports = (app) => {
  const c = defineModule(app, { tag: '09. Crew Join Requests', base: '/api/crews' });

  c.post('/:id/join-requests', {
    summary: 'Crew 가입 요청 (본인 신청, 가입대기 계정도 가능)',
    reqs: ['FR-01', 'FR-06', 'BR-01'], status: 201,
    params: { id: { type: 'integer', example: 3 } },
    body: {
      membershipType: { type: 'string', enum: ['FORMAL', 'AFFILIATE'], default: 'FORMAL', example: 'FORMAL' },
      message: { type: 'string', maxLength: 500, example: '합류를 희망합니다.' },
    },
    example: EXAMPLE,
    errors: [404, 409, 422],
  }, async (req) => {
    const crew = await crewHelpers.getActiveCrew(req.params.id);
    const memberships = await db.query('SELECT crew_id, membership_type FROM crew_memberships WHERE member_id = ? AND left_at IS NULL', [req.user.id]);
    if (memberships.some((m) => m.crewId === crew.id)) throw E.conflict('이미 해당 Crew 에 소속되어 있습니다.');
    if (req.body.membershipType === 'FORMAL' && memberships.some((m) => m.membershipType === 'FORMAL')) {
      throw E.rule('BR-01', '이미 다른 Crew 에 정식 소속되어 있어 정식 가입 요청을 할 수 없습니다.');
    }
    const dup = await db.one("SELECT id FROM crew_join_requests WHERE crew_id = ? AND member_id = ? AND status = 'PENDING'", [crew.id, req.user.id]);
    if (dup) throw E.conflict('이미 대기 중인 가입 요청이 있습니다.', { requestId: dup.id });
    const r = await db.query('INSERT INTO crew_join_requests (crew_id, member_id, membership_type, message) VALUES (?,?,?,?)',
      [crew.id, req.user.id, req.body.membershipType, req.body.message || null]);
    await rec.notify([crew.capoId], 'REQUEST_REVIEWED', '가입 요청', `${req.user.name} 님이 ${crew.name} 가입을 요청했습니다.`, `/api/join-requests/${r.insertId}`);
    return getRequest(r.insertId);
  });

  const api = defineModule(app, { tag: '09. Crew Join Requests', base: '/api/join-requests' });

  api.get('', {
    summary: '가입 요청 목록 (내 요청 또는 관리 Crew 로 들어온 요청)',
    reqs: ['FR-06', 'FR-21'],
    query: { status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] }, crewId: { type: 'integer' } },
    list: { sort: { createdAt: 'j.created_at', id: 'j.id' }, defaultSort: '-createdAt' },
    example: EXAMPLE,
  }, async (req) => {
    const where = [];
    const params = [];
    const managed = await scope.managedCrewIds(req.user);
    if (managed !== null) {
      where.push(managed.length ? '(j.member_id = ? OR j.crew_id IN (?))' : 'j.member_id = ?');
      params.push(req.user.id);
      if (managed.length) params.push(managed);
    }
    if (req.q.status) { where.push('j.status = ?'); params.push(req.q.status); }
    if (req.q.crewId) { where.push('j.crew_id = ?'); params.push(req.q.crewId); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await db.one(`SELECT COUNT(*) AS n FROM crew_join_requests j ${w}`, params)).n;
    const rows = await db.query(`${SELECT} ${w} ORDER BY ${req.page.orderBy} LIMIT ? OFFSET ?`, [...params, req.page.size, req.page.offset]);
    return paged(rows, total, req.page);
  });

  api.get('/:id', {
    summary: '가입 요청 상세',
    reqs: ['FR-06'],
    params: { id: { type: 'integer', example: 1 } },
    example: EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    const j = await getRequest(req.params.id);
    if (j.memberId !== req.user.id && !(await scope.canManageCrew(req.user, j.crewId))) throw E.forbidden();
    return j;
  });

  api.post('/:id/approve', {
    summary: '가입 요청 승인 (Crew 편성 + 가입대기 계정은 활동중으로 전환)',
    reqs: ['FR-01', 'FR-04', 'FR-06', 'BR-01', 'BR-05', 'BR-10'], perm: 'crew.members',
    params: { id: { type: 'integer', example: 1 } },
    body: { comment: { type: 'string', maxLength: 500, example: '환영합니다.' } },
    example: { ...EXAMPLE, status: 'APPROVED', memberStatus: 'ACTIVE', reviewComment: '환영합니다.' },
    errors: [403, 404, 409, 422],
    verify: 'capo3 로그인 → POST /api/join-requests/1/approve → pending1 이 Uptown Crew 소속 + ACTIVE',
  }, async (req) => {
    const j = await getPendingForReview(req.user, req.params.id);
    const crew = await crewHelpers.getActiveCrew(j.crewId);
    await db.tx(async (t) => {
      const m = await memberSvc.getMember(j.memberId, t, { lock: true });
      await crewHelpers.addMembership(t, req.user, crew, m, j.membershipType, `가입 요청 #${j.id} 승인`);
      if (m.status === 'PENDING') await memberSvc.applyStatusChange(t, req.user, m, 'ACTIVE', `가입 요청 #${j.id} 승인`);
      await t.query("UPDATE crew_join_requests SET status = 'APPROVED', reviewed_by = ?, review_comment = ?, reviewed_at = NOW() WHERE id = ?", [req.user.id, req.body.comment || null, j.id]);
    });
    await rec.audit(req.user, 'JOIN_REQUEST_APPROVED', 'crew', j.crewId, { requestId: j.id, memberId: j.memberId }, 'SUCCESS', req.ip);
    await rec.notify(j.memberId, 'REQUEST_REVIEWED', '가입 승인', `${crew.name} 가입이 승인되었습니다.`);
    return getRequest(j.id);
  });

  api.post('/:id/reject', {
    summary: '가입 요청 반려 (사유 필수)',
    reqs: ['FR-06'], perm: 'crew.members',
    params: { id: { type: 'integer', example: 1 } },
    body: { comment: { type: 'string', required: true, maxLength: 500, example: '현재 인원 충원 계획 없음' } },
    example: { ...EXAMPLE, status: 'REJECTED', reviewComment: '현재 인원 충원 계획 없음' },
    errors: [403, 404, 422],
  }, async (req) => {
    const j = await getPendingForReview(req.user, req.params.id);
    await db.query("UPDATE crew_join_requests SET status = 'REJECTED', reviewed_by = ?, review_comment = ?, reviewed_at = NOW() WHERE id = ?", [req.user.id, req.body.comment, j.id]);
    await rec.notify(j.memberId, 'REQUEST_REVIEWED', '가입 반려', `${j.crewName} 가입 요청이 반려되었습니다: ${req.body.comment}`);
    return getRequest(j.id);
  });

  api.delete('/:id', {
    summary: '내 가입 요청 취소 (대기 상태만)',
    reqs: ['FR-06'],
    params: { id: { type: 'integer', example: 1 } },
    example: { ...EXAMPLE, status: 'CANCELLED' },
    errors: [403, 404, 422],
  }, async (req) => {
    const j = await getRequest(req.params.id);
    if (j.memberId !== req.user.id) throw E.forbidden('본인의 요청만 취소할 수 있습니다.');
    if (j.status !== 'PENDING') throw E.state(`이미 처리된 요청입니다. (${j.status})`);
    await db.query("UPDATE crew_join_requests SET status = 'CANCELLED', reviewed_at = NOW() WHERE id = ?", [j.id]);
    return getRequest(j.id);
  });
};
