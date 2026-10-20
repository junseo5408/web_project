/** 징계 관리 (FR-03, FR-04, BR-04, BR-10, FR-20) : 경고 / 정지(상태 SUSPENDED 연동) */
const db = require('../db/mysql');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const scope = require('../services/scope');
const memberSvc = require('../services/members');

const EXAMPLE = {
  id: 1, memberId: 16, memberName: 'Mikey Bruno', actionType: 'SUSPENSION', reason: '조직 정보 외부 유출', issuedBy: 3, issuedByName: 'Marco Bellini',
  status: 'ACTIVE', revokedBy: null, revokeReason: null, revokedAt: null, createdAt: '2026-10-13T00:00:00.000Z',
};
const SELECT = `SELECT d.*, m.name AS member_name, ib.name AS issued_by_name FROM disciplinary_actions d
  JOIN members m ON m.id = d.member_id JOIN members ib ON ib.id = d.issued_by`;

async function getAction(id) {
  const d = await db.one(`${SELECT} WHERE d.id = ?`, [id]);
  if (!d) throw E.notFound('징계', id);
  return d;
}

module.exports = (app) => {
  const m = defineModule(app, { tag: '06. Discipline', base: '/api/members' });

  m.post('/:id/disciplinary-actions', {
    summary: '구성원 징계 등록 (SUSPENSION 은 상태를 정지로 변경)',
    description: '정지 징계 시 구성원 상태가 SUSPENDED 로 변경되며, 이후 새로운 업무 배정이 차단된다(BR-02).',
    reqs: ['FR-03', 'FR-04', 'BR-04', 'BR-10', 'BR-02'], perm: 'member.discipline', status: 201,
    params: { id: { type: 'integer', example: 9 } },
    body: {
      actionType: { type: 'string', required: true, enum: ['WARNING', 'SUSPENSION'], example: 'WARNING' },
      reason: { type: 'string', required: true, maxLength: 500, example: '보고 누락' },
    },
    example: { ...EXAMPLE, id: 3, memberId: 9, actionType: 'WARNING', reason: '보고 누락', statusChange: null },
    errors: [403, 404, 422],
  }, async (req) => {
    const target = await memberSvc.getMember(req.params.id);
    memberSvc.assertHigherThan(req.user, target, '징계');
    await scope.assertManageMember(req.user, target.id);
    let statusChange = null;
    const id = await db.tx(async (t) => {
      const r = await t.query('INSERT INTO disciplinary_actions (member_id, action_type, reason, issued_by) VALUES (?,?,?,?)', [target.id, req.body.actionType, req.body.reason, req.user.id]);
      if (req.body.actionType === 'SUSPENSION' && target.status !== 'SUSPENDED') {
        const locked = await memberSvc.getMember(target.id, t, { lock: true });
        statusChange = await memberSvc.applyStatusChange(t, req.user, locked, 'SUSPENDED', `징계 #${r.insertId}: ${req.body.reason}`);
      }
      return r.insertId;
    });
    await rec.memberHistory(target.id, 'DISCIPLINE', null, req.body.actionType, req.user, req.body.reason, { actionId: id });
    await rec.notify(target.id, 'DISCIPLINE', '징계 통지', `${req.body.actionType === 'WARNING' ? '경고' : '정지'} 처분: ${req.body.reason}`);
    return { ...(await getAction(id)), statusChange };
  });

  const api = defineModule(app, { tag: '06. Discipline', base: '/api/disciplinary-actions' });

  api.get('', {
    summary: '징계 목록 (관리 범위 내)',
    reqs: ['FR-19', 'BR-10'], perm: 'member.read',
    query: {
      memberId: { type: 'integer' },
      actionType: { type: 'string', enum: ['WARNING', 'SUSPENSION'] },
      status: { type: 'string', enum: ['ACTIVE', 'REVOKED'] },
    },
    list: { sort: { createdAt: 'd.created_at', id: 'd.id' }, defaultSort: '-createdAt' },
    example: EXAMPLE,
  }, async (req) => {
    const where = [];
    const params = [];
    const managed = await scope.managedCrewIds(req.user);
    if (managed !== null) {
      where.push('d.member_id IN (SELECT member_id FROM crew_memberships WHERE left_at IS NULL AND crew_id IN (?))');
      params.push(managed.length ? managed : [0]);
    }
    for (const [k, col] of [['memberId', 'd.member_id'], ['actionType', 'd.action_type'], ['status', 'd.status']]) {
      if (req.q[k]) { where.push(`${col} = ?`); params.push(req.q[k]); }
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await db.one(`SELECT COUNT(*) AS n FROM disciplinary_actions d ${w}`, params)).n;
    const rows = await db.query(`${SELECT} ${w} ORDER BY ${req.page.orderBy} LIMIT ? OFFSET ?`, [...params, req.page.size, req.page.offset]);
    return paged(rows, total, req.page);
  });

  api.get('/:id', {
    summary: '징계 상세',
    reqs: ['FR-19'],
    params: { id: { type: 'integer', example: 1 } },
    example: EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    const d = await getAction(req.params.id);
    if (d.memberId !== req.user.id) {
      if (!req.user.perms.has('member.read')) throw E.forbidden();
      await scope.assertManageMember(req.user, d.memberId, 'BR-09');
    }
    return d;
  });

  api.post('/:id/revoke', {
    summary: '징계 해제 (정지 징계 해제 시 다른 정지 징계가 없으면 상태를 ACTIVE 로 복구)',
    reqs: ['FR-04', 'BR-10', 'FR-20'], perm: 'member.discipline',
    params: { id: { type: 'integer', example: 1 } },
    body: { reason: { type: 'string', required: true, maxLength: 500, example: '소명 완료' } },
    example: { ...EXAMPLE, status: 'REVOKED', revokeReason: '소명 완료', statusChange: { memberId: 16, from: 'SUSPENDED', to: 'ACTIVE' } },
    errors: [403, 404, 422],
  }, async (req) => {
    const d = await getAction(req.params.id);
    if (d.status !== 'ACTIVE') throw E.state('이미 해제된 징계입니다.');
    const target = await memberSvc.getMember(d.memberId);
    memberSvc.assertHigherThan(req.user, target, '징계');
    await scope.assertManageMember(req.user, target.id);
    let statusChange = null;
    await db.tx(async (t) => {
      await t.query("UPDATE disciplinary_actions SET status = 'REVOKED', revoked_by = ?, revoke_reason = ?, revoked_at = NOW() WHERE id = ?", [req.user.id, req.body.reason, d.id]);
      if (d.actionType === 'SUSPENSION') {
        const other = await t.one("SELECT COUNT(*) AS n FROM disciplinary_actions WHERE member_id = ? AND action_type = 'SUSPENSION' AND status = 'ACTIVE'", [d.memberId]);
        const locked = await memberSvc.getMember(d.memberId, t, { lock: true });
        if (other.n === 0 && locked.status === 'SUSPENDED') {
          statusChange = await memberSvc.applyStatusChange(t, req.user, locked, 'ACTIVE', `징계 #${d.id} 해제`);
        }
      }
    });
    await rec.memberHistory(d.memberId, 'DISCIPLINE', d.actionType, 'REVOKED', req.user, req.body.reason, { actionId: d.id });
    return { ...(await getAction(d.id)), statusChange };
  });
};
