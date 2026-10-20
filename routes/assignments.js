/** 업무 배정 (FR-08, FR-11, BR-02, BR-03, BR-06) */
const db = require('../db/mysql');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule } = require('../lib/api');
const scope = require('../services/scope');
const taskSvc = require('../services/tasks');
const memberSvc = require('../services/members');

const params = { id: { type: 'integer', example: 2, desc: '업무 ID' }, memberId: { type: 'integer', example: 9, desc: '구성원 ID' } };
const EXAMPLE = { assignmentId: 12, taskId: 2, memberId: 9, name: 'Joey Marino', taskRole: '경비', instructions: '정문 경비', status: 'ASSIGNED', assignedAt: '2026-10-18T09:00:00.000Z' };

/** 배정 대상 범위: 관리 범위 구성원이거나, 업무 Crew 에 (준)소속된 구성원 */
async function assertAssignableScope(user, task, memberId) {
  if (await scope.canManageMember(user, memberId)) return;
  const inCrew = await db.one('SELECT id FROM crew_memberships WHERE member_id = ? AND crew_id = ? AND left_at IS NULL', [memberId, task.crewId]);
  if (!inCrew) throw E.forbidden(`구성원(id=${memberId})은 배정 권한 범위 밖입니다.`, 'BR-05');
}

async function getActiveAssignment(t, taskId, memberId) {
  const a = await t.one("SELECT * FROM task_assignments WHERE task_id = ? AND member_id = ? AND status IN ('ASSIGNED','ACCEPTED') FOR UPDATE", [taskId, memberId]);
  if (!a) throw E.notFound('업무 배정', `${taskId}:${memberId}`);
  return a;
}

async function doAssign(t, user, task, memberId, body) {
  const member = await memberSvc.getMember(memberId, t, { lock: true }); // 동시 배정 경쟁 방지
  await taskSvc.assertAssignable(t, member, task);
  const dup = await t.one("SELECT id FROM task_assignments WHERE task_id = ? AND member_id = ? AND status IN ('ASSIGNED','ACCEPTED')", [task.id, member.id]);
  if (dup) throw E.conflict('이미 이 업무에 배정된 구성원입니다.');
  const r = await t.query('INSERT INTO task_assignments (task_id, member_id, task_role, instructions, assigned_by) VALUES (?,?,?,?,?)',
    [task.id, member.id, body.taskRole || null, body.instructions || null, user.id]);
  await rec.taskHistory(task.id, 'ASSIGNED', null, member.id, user, null, { memberId: member.id, taskRole: body.taskRole || null });
  await rec.notify(member.id, 'TASK_ASSIGNED', '업무 배정', `'${task.title}' 업무에 배정되었습니다.`, `/api/me/tasks/${task.id}`);
  return r.insertId;
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '12. Task Assignments', base: '/api/tasks' });

  api.get('/:id/assignments', {
    summary: '업무 참여 구성원 목록 (배정 상태 포함)',
    reqs: ['FR-08', 'DR-02'],
    params: { id: params.id },
    query: { includeInactive: { type: 'boolean', default: false, desc: 'true 이면 거절/해제된 배정도 포함' } },
    example: [EXAMPLE],
    errors: [403, 404],
  }, async (req) => {
    const task = await taskSvc.getVisibleTask(req.user, req.params.id);
    return db.query(
      `SELECT a.id AS assignment_id, a.task_id, a.member_id, m.name, r.code AS role, a.task_role, a.instructions, a.status, a.assigned_at, a.responded_at,
              a.removed_at, ab.username AS assigned_by, a.attendance, a.contribution, a.participation_note
         FROM task_assignments a JOIN members m ON m.id = a.member_id JOIN roles r ON r.id = m.role_id JOIN members ab ON ab.id = a.assigned_by
        WHERE a.task_id = ? ${req.q.includeInactive ? '' : "AND a.status IN ('ASSIGNED','ACCEPTED')"} ORDER BY a.id`, [task.id]
    );
  });

  api.post('/:id/assignments', {
    summary: '업무에 구성원 배정',
    description: 'BR-02: 정지(SUSPENDED)/탈퇴(WITHDRAWN)/가입대기 구성원 배정 불가. BR-03: 동일 시간대에 동시 수행 불가 업무가 있으면 배정 불가. 구성원 행을 잠근 트랜잭션에서 검사하여 동시 요청에도 규칙이 보장된다.',
    reqs: ['FR-08', 'BR-02', 'BR-03', 'BR-05'], perm: 'task.assign', status: 201,
    params: { id: params.id },
    body: {
      memberId: { type: 'integer', required: true, example: 9 },
      taskRole: { type: 'string', maxLength: 50, example: '경비' },
      instructions: { type: 'string', maxLength: 2000, example: '정문 경비, 10시 집결' },
    },
    example: EXAMPLE,
    errors: [403, 404,
      { status: 409, rule: 'BR-02', message: 'SUSPENDED 상태의 구성원은 새로운 업무에 배정될 수 없습니다.' },
      { status: 409, rule: 'BR-03', message: '구성원에게 동일 시간대에 이미 배정된 업무가 있습니다.' }],
    verify: 'capo1 → POST /api/tasks/2/assignments {memberId:16} → 409 BR-02 / {memberId:8} → 409 BR-03 / {memberId:9}... (soldier2 는 1번 업무와 겹침) → 409 BR-03 / {memberId:14} → 201',
  }, async (req) => {
    const id = await db.tx(async (t) => {
      const task = await taskSvc.getManagedTask(req.user, req.params.id, t, { lock: true });
      await assertAssignableScope(req.user, task, req.body.memberId);
      return doAssign(t, req.user, task, req.body.memberId, req.body);
    });
    const a = await db.one('SELECT a.id AS assignment_id, a.task_id, a.member_id, m.name, a.task_role, a.instructions, a.status, a.assigned_at FROM task_assignments a JOIN members m ON m.id = a.member_id WHERE a.id = ?', [id]);
    return a;
  });

  api.patch('/:id/assignments/:memberId', {
    summary: '배정 정보 수정 (업무 내 역할, 지시사항)',
    reqs: ['FR-08', 'FR-09', 'BR-06'], perm: 'task.assign', partial: true,
    params,
    body: {
      taskRole: { type: 'string', maxLength: 50, nullable: true, example: '현장 보조' },
      instructions: { type: 'string', maxLength: 2000, nullable: true, example: '후문 경비로 변경' },
    },
    example: { ...EXAMPLE, taskRole: '현장 보조', instructions: '후문 경비로 변경' },
    errors: [403, 404, 409],
  }, async (req) => {
    await db.tx(async (t) => {
      const task = await taskSvc.getManagedTask(req.user, req.params.id, t);
      if (!taskSvc.OPEN_STATUSES.includes(task.status)) throw E.rule('BR-06', '완료/취소된 업무의 배정 정보는 변경할 수 없습니다.');
      const a = await getActiveAssignment(t, task.id, req.params.memberId);
      const keys = Object.keys(req.body);
      const col = { taskRole: 'task_role', instructions: 'instructions' };
      await t.query(`UPDATE task_assignments SET ${keys.map((k) => `${col[k]} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => req.body[k]), a.id]);
      await rec.notify(a.memberId, 'TASK_ASSIGNED', '배정 정보 변경', `'${task.title}' 의 역할/지시사항이 변경되었습니다.`, `/api/me/tasks/${task.id}`);
    });
    return db.one('SELECT a.id AS assignment_id, a.task_id, a.member_id, m.name, a.task_role, a.instructions, a.status, a.assigned_at FROM task_assignments a JOIN members m ON m.id = a.member_id WHERE a.task_id = ? AND a.member_id = ? AND a.status IN (\'ASSIGNED\',\'ACCEPTED\')', [req.params.id, req.params.memberId]);
  });

  api.delete('/:id/assignments/:memberId', {
    summary: '배정 해제',
    reqs: ['FR-08', 'BR-06'], perm: 'task.assign',
    params,
    query: { reason: { type: 'string', maxLength: 300, example: '인원 조정' } },
    example: { taskId: 2, memberId: 9, status: 'REMOVED' },
    errors: [403, 404, 409],
  }, async (req) => {
    await db.tx(async (t) => {
      const task = await taskSvc.getManagedTask(req.user, req.params.id, t);
      if (task.status === 'COMPLETED') throw E.rule('BR-06', '완료된 업무의 참여 기록은 변경할 수 없습니다.');
      const a = await getActiveAssignment(t, task.id, req.params.memberId);
      await t.query("UPDATE task_assignments SET status = 'REMOVED', removed_at = NOW() WHERE id = ?", [a.id]);
      await rec.taskHistory(task.id, 'UNASSIGNED', a.memberId, null, req.user, req.q.reason, { memberId: a.memberId });
      await rec.notify(a.memberId, 'TASK_UNASSIGNED', '배정 해제', `'${task.title}' 업무 배정이 해제되었습니다.`);
    });
    return { taskId: req.params.id, memberId: req.params.memberId, status: 'REMOVED' };
  });

  api.post('/:id/assignments/:memberId/replace', {
    summary: '배정 인원 교체 (기존 해제 + 신규 배정을 하나의 트랜잭션으로)',
    reqs: ['FR-08', 'BR-02', 'BR-03'], perm: 'task.assign',
    params,
    body: {
      newMemberId: { type: 'integer', required: true, example: 14 },
      reason: { type: 'string', maxLength: 300, example: '부상으로 교체' },
    },
    example: { taskId: 1, removedMemberId: 9, newAssignmentId: 13, newMemberId: 14 },
    errors: [403, 404, 409],
  }, async (req) => {
    return db.tx(async (t) => {
      const task = await taskSvc.getManagedTask(req.user, req.params.id, t, { lock: true });
      if (!taskSvc.OPEN_STATUSES.includes(task.status)) throw E.state('진행 전/중인 업무만 인원을 교체할 수 있습니다.');
      const old = await getActiveAssignment(t, task.id, req.params.memberId);
      await assertAssignableScope(req.user, task, req.body.newMemberId);
      await t.query("UPDATE task_assignments SET status = 'REMOVED', removed_at = NOW() WHERE id = ?", [old.id]);
      const newId = await doAssign(t, req.user, task, req.body.newMemberId, { taskRole: old.taskRole, instructions: old.instructions });
      await rec.taskHistory(task.id, 'REPLACED', old.memberId, req.body.newMemberId, req.user, req.body.reason);
      await rec.notify(old.memberId, 'TASK_UNASSIGNED', '배정 교체', `'${task.title}' 업무에서 다른 구성원으로 교체되었습니다.`);
      return { taskId: task.id, removedMemberId: old.memberId, newAssignmentId: newId, newMemberId: req.body.newMemberId };
    });
  });

  api.put('/:id/assignments/:memberId/participation', {
    summary: '완료 업무의 참여 기록(출석·기여도) 입력',
    description: '완료된 업무에 대해 참여 기록을 입력한다. 이미 입력된 기록의 수정은 BR-06 에 따라 task.result.amend 권한(Underboss 이상)이 필요하다.',
    reqs: ['FR-11', 'BR-06', 'FR-18'], perm: 'task.progress',
    params: { id: { type: 'integer', example: 4 }, memberId: { type: 'integer', example: 8 } },
    body: {
      attendance: { type: 'string', required: true, enum: ['PRESENT', 'PARTIAL', 'ABSENT'], example: 'PRESENT' },
      contribution: { type: 'integer', required: true, min: 0, max: 100, example: 85 },
      note: { type: 'string', maxLength: 500, example: '핵심 역할 수행' },
    },
    example: { taskId: 4, memberId: 8, attendance: 'PRESENT', contribution: 85, note: '핵심 역할 수행' },
    errors: [403, 404, { status: 409, rule: 'BR-06', message: '이미 기록된 참여 결과는 Underboss 이상만 수정할 수 있습니다.' }, 422],
  }, async (req) => {
    const task = await taskSvc.getManagedTask(req.user, req.params.id);
    if (task.status !== 'COMPLETED') throw E.state('완료된 업무에만 참여 기록을 입력할 수 있습니다.');
    const a = await db.one("SELECT * FROM task_assignments WHERE task_id = ? AND member_id = ? AND status IN ('ASSIGNED','ACCEPTED')", [task.id, req.params.memberId]);
    if (!a) throw E.notFound('업무 참여자', req.params.memberId);
    if (a.contribution !== null && !req.user.perms.has('task.result.amend')) {
      throw E.rule('BR-06', '이미 기록된 참여 결과는 Underboss 이상(task.result.amend)만 수정할 수 있습니다.');
    }
    await db.query('UPDATE task_assignments SET attendance = ?, contribution = ?, participation_note = ? WHERE id = ?', [req.body.attendance, req.body.contribution, req.body.note || null, a.id]);
    await rec.taskHistory(task.id, 'PARTICIPATION_RECORDED', a.contribution === null ? null : { attendance: a.attendance, contribution: a.contribution }, req.body, req.user, null, { memberId: a.memberId });
    return { taskId: task.id, memberId: a.memberId, attendance: req.body.attendance, contribution: req.body.contribution, note: req.body.note || null };
  });
};
