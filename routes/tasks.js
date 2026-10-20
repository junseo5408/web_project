/** 업무 관리 (FR-07, FR-10, FR-11, FR-12, BR-03, BR-06, BR-07) */
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const { toCsv } = require('../lib/util');
const scope = require('../services/scope');
const taskSvc = require('../services/tasks');
const resSvc = require('../services/resources');

const idParam = { id: { type: 'integer', example: 1, desc: '업무 ID' } };
const TASK_EXAMPLE = {
  id: 1, title: '물류 창고 정기 점검', description: '물류 창고 정기 점검 업무', crewId: 1, crewName: 'Brooklyn Crew', priority: 'HIGH', status: 'PLANNED',
  startAt: '2026-10-19T09:00:00.000Z', endAt: '2026-10-19T12:00:00.000Z', location: 'Brooklyn 창고 3동', allowConcurrent: false,
  requiredSkills: ['security'], resultOutcome: null, resultSummary: null, resultValue: null, completedAt: null, assigneeCount: 2,
};

const listQuery = {
  from: { type: 'datetime', desc: '기간 시작 (업무 기간이 겹치는 항목)', example: '2026-10-01T00:00:00Z' },
  to: { type: 'datetime', desc: '기간 종료', example: '2026-12-31T00:00:00Z' },
  crewId: { type: 'integer', desc: 'Crew' },
  status: { type: 'array', items: { type: 'string', enum: taskSvc.STATUSES }, desc: '쉼표 구분 다중 (예: PLANNED,IN_PROGRESS)' },
  priority: { type: 'array', items: { type: 'string', enum: taskSvc.PRIORITIES } },
  memberId: { type: 'integer', desc: '담당(배정) 구성원' },
  q: { type: 'string', desc: '제목/설명/장소 검색', example: '창고' },
  overdue: { type: 'boolean', desc: 'true: 종료 시각이 지났는데 완료/취소되지 않은 업무' },
  unassigned: { type: 'boolean', desc: 'true: 배정 인원이 없는 업무' },
};

async function buildFilter(user, q) {
  const vis = await taskSvc.visibilityFilter(user, 't');
  const where = [vis.sql];
  const params = [...vis.params];
  if (q.from) { where.push('t.end_at >= ?'); params.push(q.from); }
  if (q.to) { where.push('t.start_at <= ?'); params.push(q.to); }
  if (q.crewId) { where.push('t.crew_id = ?'); params.push(q.crewId); }
  if (q.status) { where.push('t.status IN (?)'); params.push(q.status); }
  if (q.priority) { where.push('t.priority IN (?)'); params.push(q.priority); }
  if (q.memberId) { where.push("EXISTS (SELECT 1 FROM task_assignments fa WHERE fa.task_id = t.id AND fa.member_id = ? AND fa.status IN ('ASSIGNED','ACCEPTED'))"); params.push(q.memberId); }
  if (q.q) { where.push('(t.title LIKE ? OR t.description LIKE ? OR t.location LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  if (q.overdue) where.push("t.end_at < NOW() AND t.status IN ('PLANNED','IN_PROGRESS','ON_HOLD')");
  if (q.unassigned) where.push("NOT EXISTS (SELECT 1 FROM task_assignments ua WHERE ua.task_id = t.id AND ua.status IN ('ASSIGNED','ACCEPTED'))");
  return { sql: where.join(' AND '), params };
}

const ASSIGNEE_COUNT = "(SELECT COUNT(*) FROM task_assignments x WHERE x.task_id = t.id AND x.status IN ('ASSIGNED','ACCEPTED')) AS assignee_count";

function assertEditable(task) {
  if (task.status === 'COMPLETED') throw E.rule('BR-06', '완료된 업무의 정보는 변경할 수 없습니다. 결과 수정은 PATCH /api/tasks/{id}/result (Underboss 이상) 를 사용하세요.');
  if (task.status === 'CANCELLED') throw E.state('취소된 업무는 수정할 수 없습니다. 먼저 PLANNED 로 복구하세요.');
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '11. Tasks', base: '/api/tasks' });

  api.get('', {
    summary: '업무 탐색 (기간·Crew·상태·우선순위·담당자·검색어, 정렬, 페이지)',
    description: '권한 범위 내 업무만 조회된다. Boss/Admin: 전체, Underboss/Capo: 관리 Crew + 본인 배정, Soldier: 소속 Crew + 본인 배정, Associate: 본인 배정.',
    reqs: ['FR-12', 'FR-21', 'NFR-04', 'AR-03'],
    scope: '역할별 업무 조회 범위 적용',
    query: listQuery,
    list: { sort: { id: 't.id', startAt: 't.start_at', priority: 't.priority', createdAt: 't.created_at', status: 't.status' }, defaultSort: '-startAt' },
    example: TASK_EXAMPLE,
    verify: 'capo1 로그인 → GET /api/tasks?status=PLANNED&sort=startAt → Brooklyn Crew 업무만 조회',
  }, async (req) => {
    const f = await buildFilter(req.user, req.q);
    const base = `FROM tasks t JOIN crews c ON c.id = t.crew_id WHERE ${f.sql}`;
    const total = (await db.one(`SELECT COUNT(*) AS n ${base}`, f.params)).n;
    const rows = await db.query(`SELECT ${taskSvc.TASK_COLUMNS}, ${ASSIGNEE_COUNT} ${base} ORDER BY ${req.page.orderBy} LIMIT ? OFFSET ?`,
      [...f.params, req.page.size, req.page.offset]);
    return paged(rows, total, req.page);
  });

  api.get('/export', {
    summary: '업무 목록 CSV 내보내기 (탐색 조건 동일 적용)',
    reqs: ['FR-12', 'FR-22'], perm: ['task.create', 'stats.read'], produces: 'text/csv',
    query: listQuery,
    example: 'id,title,crewName,priority,status,startAt,endAt,assigneeCount,resultOutcome\n1,물류 창고 정기 점검,Brooklyn Crew,HIGH,PLANNED,...',
  }, async (req, res) => {
    const f = await buildFilter(req.user, req.q);
    const rows = await db.query(`SELECT ${taskSvc.TASK_COLUMNS}, ${ASSIGNEE_COUNT} FROM tasks t JOIN crews c ON c.id = t.crew_id WHERE ${f.sql} ORDER BY t.start_at LIMIT 5000`, f.params);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="tasks.csv"');
    res.send(toCsv(rows, ['id', 'title', 'crewName', 'priority', 'status', 'startAt', 'endAt', 'location', 'assigneeCount', 'resultOutcome', 'resultValue']));
  });

  api.get('/calendar', {
    summary: '업무 캘린더 (일자별 그룹)',
    reqs: ['FR-12', 'FR-09'],
    query: {
      from: { type: 'datetime', required: true, example: '2026-10-01T00:00:00Z' },
      to: { type: 'datetime', required: true, example: '2026-10-31T23:59:59Z' },
      crewId: { type: 'integer' },
      memberId: listQuery.memberId,
      status: listQuery.status,
    },
    example: [{ date: '2026-10-19', count: 2, tasks: [{ id: 1, title: '물류 창고 정기 점검', status: 'PLANNED', priority: 'HIGH', startAt: '2026-10-19T09:00:00.000Z' }] }],
  }, async (req) => {
    if (req.q.to - req.q.from > 92 * 86400000) throw E.badRequest('조회 기간은 최대 92일입니다.');
    const f = await buildFilter(req.user, req.q);
    const rows = await db.query(`SELECT t.id, t.title, t.status, t.priority, t.start_at, t.end_at, c.name AS crew_name FROM tasks t JOIN crews c ON c.id = t.crew_id WHERE ${f.sql} ORDER BY t.start_at`, f.params);
    const days = new Map();
    for (const r of rows) {
      const key = new Date(r.startAt).toISOString().slice(0, 10);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(r);
    }
    return [...days.entries()].map(([date, tasks]) => ({ date, count: tasks.length, tasks }));
  });

  api.get('/:id', {
    summary: '업무 상세 (참여 구성원, 배정 자원 포함)',
    reqs: ['FR-07', 'FR-08', 'DR-02'],
    params: idParam,
    example: { ...TASK_EXAMPLE, assignees: [{ assignmentId: 1, memberId: 8, name: 'Paulie Conti', taskRole: '현장 책임', status: 'ACCEPTED' }], resources: [{ allocationId: 1, resourceId: 1, code: 'VH-001', name: '검정 세단', status: 'RESERVED' }] },
    errors: [403, 404],
  }, async (req) => {
    const task = await taskSvc.getVisibleTask(req.user, req.params.id);
    const [assignees, resources] = await Promise.all([
      db.query("SELECT a.id AS assignment_id, a.member_id, m.name, m.alias, a.task_role, a.status, a.attendance, a.contribution FROM task_assignments a JOIN members m ON m.id = a.member_id WHERE a.task_id = ? AND a.status <> 'REMOVED' ORDER BY a.id", [task.id]),
      db.query('SELECT a.id AS allocation_id, a.resource_id, r.code, r.name, a.status, a.start_at, a.end_at FROM resource_allocations a JOIN resources r ON r.id = a.resource_id WHERE a.task_id = ? ORDER BY a.id', [task.id]),
    ]);
    return { ...task, assignees, resources };
  });

  api.post('', {
    summary: '업무 등록 (기본 정보, 일정, 중요도)',
    reqs: ['FR-07', 'BR-09'], perm: 'task.create', status: 201,
    body: {
      title: { type: 'string', required: true, maxLength: 100, example: '신규 거래처 실사' },
      description: { type: 'string', maxLength: 5000, example: '신규 거래처 매장 실사 및 보고' },
      crewId: { type: 'integer', required: true, example: 1 },
      priority: { type: 'string', enum: taskSvc.PRIORITIES, default: 'NORMAL', example: 'HIGH' },
      startAt: { type: 'datetime', required: true, example: '2026-10-25T09:00:00Z' },
      endAt: { type: 'datetime', required: true, example: '2026-10-25T12:00:00Z' },
      location: { type: 'string', maxLength: 100, example: 'Brooklyn 5번가' },
      allowConcurrent: { type: 'boolean', default: false, desc: 'true 이면 다른 업무와 동시 수행 가능(BR-03 예외)' },
      requiredSkills: { type: 'array', items: 'string', maxItems: 10, example: ['negotiation'] },
    },
    example: { ...TASK_EXAMPLE, id: 25, title: '신규 거래처 실사' },
    errors: [403, 404],
    verify: 'capo1 로그인 → crewId=1 로 등록 → 201 / crewId=2 로 등록 → 403',
  }, async (req) => {
    const id = await db.tx((t) => taskSvc.createTask(t, req.user, req.body));
    await rec.taskHistory(id, 'CREATED', null, 'PLANNED', req.user);
    await rec.audit(req.user, 'TASK_CREATED', 'task', id, { title: req.body.title, crewId: req.body.crewId }, 'SUCCESS', req.ip);
    return taskSvc.getTask(id);
  });

  api.patch('/:id', {
    summary: '업무 기본 정보 수정 (제목/설명/중요도/장소/필요 기술)',
    description: 'BR-06: 완료된 업무는 수정할 수 없다. 일정 변경은 PATCH /schedule, 상태 변경은 PATCH /status 를 사용한다.',
    reqs: ['FR-07', 'BR-06'], perm: 'task.update', partial: true,
    params: idParam,
    body: {
      title: { type: 'string', maxLength: 100, example: '물류 창고 정기 점검 (2차)' },
      description: { type: 'string', maxLength: 5000, nullable: true },
      priority: { type: 'string', enum: taskSvc.PRIORITIES, example: 'CRITICAL' },
      location: { type: 'string', maxLength: 100, nullable: true },
      requiredSkills: { type: 'array', items: 'string', maxItems: 10 },
    },
    example: TASK_EXAMPLE,
    errors: [403, 404, { status: 409, rule: 'BR-06', message: '완료된 업무의 정보는 변경할 수 없습니다.' }],
  }, async (req) => {
    const task = await taskSvc.getManagedTask(req.user, req.params.id);
    assertEditable(task);
    const map = { title: 'title', description: 'description', priority: 'priority', location: 'location', requiredSkills: 'required_skills' };
    const keys = Object.keys(req.body);
    await db.query(`UPDATE tasks SET ${keys.map((k) => `${map[k]} = ?`).join(', ')} WHERE id = ?`,
      [...keys.map((k) => (k === 'requiredSkills' ? JSON.stringify(req.body[k]) : req.body[k])), task.id]);
    await rec.taskHistory(task.id, 'UPDATED', null, null, req.user, null, { fields: req.body });
    return taskSvc.getTask(task.id);
  });

  api.patch('/:id/schedule', {
    summary: '업무 일정 변경 (참여자 시간 중복·자원 중복 재검사)',
    description: '새 일정이 배정된 구성원의 다른 업무와 겹치면 BR-03, 예약된 자원이 다른 배정과 겹치면 BR-07 위반으로 거부된다. 통과 시 해당 업무의 자원 예약 기간도 함께 이동한다.',
    reqs: ['FR-07', 'BR-03', 'BR-07'], perm: 'task.update',
    params: idParam,
    body: {
      startAt: { type: 'datetime', required: true, example: '2026-10-19T10:30:00Z' },
      endAt: { type: 'datetime', required: true, example: '2026-10-19T13:00:00Z' },
      allowConcurrent: { type: 'boolean', example: false },
    },
    example: { ...TASK_EXAMPLE, startAt: '2026-10-19T10:30:00.000Z', endAt: '2026-10-19T13:00:00.000Z', movedReservations: 1 },
    errors: [403, 404, { status: 409, rule: 'BR-03', message: '구성원에게 동일 시간대에 이미 배정된 업무가 있습니다.' }],
  }, async (req) => {
    const { startAt, endAt } = req.body;
    if (endAt <= startAt) throw E.badRequest('endAt 은 startAt 이후여야 합니다.');
    let moved = 0;
    await db.tx(async (t) => {
      const task = await taskSvc.getManagedTask(req.user, req.params.id, t, { lock: true });
      if (!taskSvc.OPEN_STATUSES.includes(task.status)) throw task.status === 'COMPLETED' ? E.rule('BR-06', '완료된 업무의 일정은 변경할 수 없습니다.') : E.state('취소된 업무입니다.');
      const allowConcurrent = req.body.allowConcurrent !== undefined ? req.body.allowConcurrent : task.allowConcurrent;
      const assignees = await taskSvc.activeAssigneeIds(task.id, t);
      if (assignees.length) await t.query('SELECT id FROM members WHERE id IN (?) FOR UPDATE', [assignees]);
      for (const memberId of assignees) {
        const conflicts = await taskSvc.findScheduleConflicts(t, memberId, startAt, endAt, allowConcurrent, task.id);
        if (conflicts.length) throw E.rule('BR-03', `구성원(id=${memberId})의 다른 업무와 시간이 겹칩니다.`, { memberId, conflicts });
      }
      const allocs = await t.query("SELECT id, resource_id FROM resource_allocations WHERE task_id = ? AND status = 'RESERVED'", [task.id]);
      for (const a of allocs) {
        await t.query('SELECT id FROM resources WHERE id = ? FOR UPDATE', [a.resourceId]);
        const conflicts = await resSvc.findAllocationConflicts(t, a.resourceId, startAt, endAt, allocs.map((x) => x.id));
        if (conflicts.length) throw E.rule('BR-07', `배정된 자원(id=${a.resourceId})이 새 일정에 다른 배정과 겹칩니다.`, { resourceId: a.resourceId, conflicts });
      }
      await t.query('UPDATE tasks SET start_at = ?, end_at = ?, allow_concurrent = ? WHERE id = ?', [startAt, endAt, allowConcurrent ? 1 : 0, task.id]);
      if (allocs.length) await t.query('UPDATE resource_allocations SET start_at = ?, end_at = ? WHERE id IN (?)', [startAt, endAt, allocs.map((x) => x.id)]);
      moved = allocs.length;
      await rec.taskHistory(task.id, 'RESCHEDULED', { startAt: task.startAt, endAt: task.endAt }, { startAt, endAt }, req.user);
      await rec.notify(assignees, 'TASK_STATUS', '업무 일정 변경', `'${task.title}' 일정이 변경되었습니다.`, `/api/me/tasks/${task.id}`);
    });
    return { ...(await taskSvc.getTask(req.params.id)), movedReservations: moved };
  });

  api.patch('/:id/status', {
    summary: '업무 진행 상태 변경 (전이 규칙 검사, 이력 기록)',
    description: '허용 전이: PLANNED→IN_PROGRESS|CANCELLED, IN_PROGRESS→ON_HOLD|CANCELLED, ON_HOLD→IN_PROGRESS|CANCELLED, CANCELLED→PLANNED. 완료(COMPLETED)는 결과 입력이 필요한 POST /complete 로만 가능. 취소 시 자원 예약도 취소된다.',
    reqs: ['FR-07', 'FR-10', 'FR-20'], perm: 'task.progress',
    params: idParam,
    body: {
      status: { type: 'string', required: true, enum: ['PLANNED', 'IN_PROGRESS', 'ON_HOLD', 'CANCELLED'], example: 'IN_PROGRESS' },
      reason: { type: 'string', maxLength: 300, example: '현장 도착, 작업 시작' },
    },
    example: { taskId: 1, from: 'PLANNED', to: 'IN_PROGRESS', cancelledReservations: 0 },
    errors: [403, 404, { status: 422, code: 'INVALID_STATE', message: '상태 전이 COMPLETED → PLANNED 는 허용되지 않습니다.' }],
    verify: 'capo1 → PATCH /api/tasks/1/status {status:IN_PROGRESS} → 200 → GET /api/tasks/1/status-history 에 기록 확인',
  }, async (req) => {
    return db.tx(async (t) => {
      const task = await taskSvc.getManagedTask(req.user, req.params.id, t, { lock: true });
      const to = req.body.status;
      const allowed = taskSvc.TRANSITIONS[task.status] || [];
      if (!allowed.includes(to)) {
        if (task.status === 'COMPLETED') throw E.rule('BR-06', '완료된 업무의 상태는 변경할 수 없습니다. 재개는 POST /reopen (Underboss 이상).');
        throw E.state(`상태 전이 ${task.status} → ${to} 는 허용되지 않습니다.`, { allowed });
      }
      if (to === 'PLANNED') {
        // 취소 → 재계획 시 참여자 일정 충돌 재검사
        for (const memberId of await taskSvc.activeAssigneeIds(task.id, t)) {
          const c = await taskSvc.findScheduleConflicts(t, memberId, task.startAt, task.endAt, task.allowConcurrent, task.id);
          if (c.length) throw E.rule('BR-03', `구성원(id=${memberId})의 다른 업무와 시간이 겹쳐 복구할 수 없습니다.`, { memberId, conflicts: c });
        }
      }
      await t.query('UPDATE tasks SET status = ? WHERE id = ?', [to, task.id]);
      let cancelled = 0;
      if (to === 'CANCELLED') {
        const r = await t.query("UPDATE resource_allocations SET status = 'CANCELLED' WHERE task_id = ? AND status = 'RESERVED'", [task.id]);
        cancelled = r.affectedRows;
      }
      await rec.taskHistory(task.id, 'STATUS_CHANGED', task.status, to, req.user, req.body.reason);
      await rec.notify(await taskSvc.activeAssigneeIds(task.id, t), 'TASK_STATUS', '업무 상태 변경', `'${task.title}' : ${task.status} → ${to}`, `/api/me/tasks/${task.id}`);
      return { taskId: task.id, from: task.status, to, cancelledReservations: cancelled };
    });
  });

  api.get('/:id/transitions', {
    summary: '현재 상태에서 가능한 다음 상태 목록',
    reqs: ['FR-10'],
    params: idParam,
    example: { taskId: 1, current: 'PLANNED', allowed: ['IN_PROGRESS', 'CANCELLED'], canComplete: false, canReopen: false },
    errors: [403, 404],
  }, async (req) => {
    const task = await taskSvc.getVisibleTask(req.user, req.params.id);
    return {
      taskId: task.id, current: task.status, allowed: taskSvc.TRANSITIONS[task.status],
      canComplete: task.status === 'IN_PROGRESS', canReopen: task.status === 'COMPLETED',
    };
  });

  api.get('/:id/status-history', {
    summary: '업무 상태·배정 변경 이력 (MongoDB)',
    reqs: ['FR-10', 'FR-20'],
    params: idParam,
    query: { event: { type: 'string', enum: ['CREATED', 'UPDATED', 'RESCHEDULED', 'STATUS_CHANGED', 'COMPLETED', 'REOPENED', 'RESULT_AMENDED', 'ASSIGNED', 'UNASSIGNED', 'REPLACED', 'ASSIGNMENT_ACCEPTED', 'ASSIGNMENT_DECLINED', 'PARTICIPATION_RECORDED'] } },
    list: { sort: { at: 'at' }, defaultSort: '-at' },
    example: { id: '6715...', taskId: 1, event: 'STATUS_CHANGED', from: 'PLANNED', to: 'IN_PROGRESS', note: '현장 도착', by: { id: 5, username: 'capo1', role: 'CAPO' }, at: '2026-10-19T09:00:00.000Z' },
    errors: [403, 404],
  }, async (req) => {
    const task = await taskSvc.getVisibleTask(req.user, req.params.id);
    const f = { taskId: task.id };
    if (req.q.event) f.event = req.q.event;
    const c = mongo.col('taskHistory');
    const [items, total] = await Promise.all([c.find(f).sort(req.page.mongoSort).skip(req.page.offset).limit(req.page.size).toArray(), c.countDocuments(f)]);
    return paged(items.map(mongo.out), total, req.page);
  });

  api.post('/:id/complete', {
    summary: '업무 완료 처리 (결과 및 참여 기록 입력)',
    description: '진행중(IN_PROGRESS) 업무만 완료 가능. 결과(성공/부분/실패, 요약, 성과값)와 참여자별 출석·기여도를 기록하며, 이후 평가·통계에 활용된다(FR-11). 미사용 자원 예약은 자동 취소된다.',
    reqs: ['FR-10', 'FR-11', 'FR-20'], perm: 'task.progress',
    params: idParam,
    body: {
      outcome: { type: 'string', required: true, enum: ['SUCCESS', 'PARTIAL', 'FAILURE'], example: 'SUCCESS' },
      summary: { type: 'string', required: true, maxLength: 5000, example: '화물 인수 완료, 이상 없음' },
      value: { type: 'number', min: 0, example: 15000, desc: '성과 수치(금액 등)' },
      participation: {
        type: 'array', maxItems: 50,
        items: { type: 'object' },
        desc: '[{ memberId, attendance: PRESENT|PARTIAL|ABSENT, contribution: 0~100, note }]',
        example: [{ memberId: 10, attendance: 'PRESENT', contribution: 90 }, { memberId: 11, attendance: 'PRESENT', contribution: 70 }],
      },
    },
    example: { ...TASK_EXAMPLE, id: 3, status: 'COMPLETED', resultOutcome: 'SUCCESS', resultSummary: '화물 인수 완료, 이상 없음', resultValue: 15000 },
    errors: [403, 404, 422],
    verify: 'capo2 → POST /api/tasks/3/complete → COMPLETED. 이후 soldier3 가 PATCH /api/tasks/3/result → 403 (BR-06)',
  }, async (req) => {
    const b = req.body;
    await db.tx(async (t) => {
      const task = await taskSvc.getManagedTask(req.user, req.params.id, t, { lock: true });
      if (task.status !== 'IN_PROGRESS') throw E.state(`진행중(IN_PROGRESS) 업무만 완료할 수 있습니다. (현재 ${task.status})`);
      await t.query("UPDATE tasks SET status = 'COMPLETED', result_outcome = ?, result_summary = ?, result_value = ?, completed_at = NOW(), completed_by = ? WHERE id = ?",
        [b.outcome, b.summary, b.value === undefined ? null : b.value, req.user.id, task.id]);
      await t.query("UPDATE resource_allocations SET status = 'CANCELLED' WHERE task_id = ? AND status = 'RESERVED'", [task.id]);
      for (const p of b.participation || []) {
        if (!Number.isInteger(p.memberId)) throw E.badRequest('participation[].memberId 는 정수여야 합니다.');
        if (p.attendance && !['PRESENT', 'PARTIAL', 'ABSENT'].includes(p.attendance)) throw E.badRequest('participation[].attendance 값이 올바르지 않습니다.');
        if (p.contribution !== undefined && (!Number.isInteger(p.contribution) || p.contribution < 0 || p.contribution > 100)) throw E.badRequest('participation[].contribution 은 0~100 정수입니다.');
        const r = await t.query("UPDATE task_assignments SET attendance = ?, contribution = ?, participation_note = ? WHERE task_id = ? AND member_id = ? AND status IN ('ASSIGNED','ACCEPTED')",
          [p.attendance || 'PRESENT', p.contribution === undefined ? null : p.contribution, p.note || null, task.id, p.memberId]);
        if (!r.affectedRows) throw E.badRequest(`구성원(id=${p.memberId})은 이 업무의 참여자가 아닙니다.`);
      }
      await rec.taskHistory(task.id, 'COMPLETED', task.status, 'COMPLETED', req.user, b.summary, { outcome: b.outcome, value: b.value });
      const members = await taskSvc.activeAssigneeIds(task.id, t);
      for (const m of members) await rec.activity(m, 'TASK_COMPLETED', `업무 '${task.title}' 완료 (${b.outcome})`, { taskId: task.id });
      await rec.notify(members, 'TASK_STATUS', '업무 완료', `'${task.title}' 업무가 완료 처리되었습니다.`, `/api/me/tasks/${task.id}`);
    });
    await rec.audit(req.user, 'TASK_COMPLETED', 'task', req.params.id, { outcome: b.outcome }, 'SUCCESS', req.ip);
    return taskSvc.getTask(req.params.id);
  });

  api.get('/:id/result', {
    summary: '업무 결과 및 참여 기록 조회',
    reqs: ['FR-11', 'FR-19'],
    params: idParam,
    example: {
      taskId: 4, status: 'COMPLETED', outcome: 'SUCCESS', summary: '장부 정리 완료', value: 12500, completedAt: '2026-10-11T17:00:00.000Z', completedBy: 'capo1',
      participants: [{ memberId: 8, name: 'Paulie Conti', taskRole: '장부 검토', attendance: 'PRESENT', contribution: 80 }], amendments: 0,
    },
    errors: [403, 404, 422],
  }, async (req) => {
    const task = await taskSvc.getVisibleTask(req.user, req.params.id);
    if (task.status !== 'COMPLETED') throw E.state('완료된 업무만 결과가 존재합니다.');
    const [participants, by, amendments] = await Promise.all([
      db.query("SELECT a.member_id, m.name, a.task_role, a.attendance, a.contribution, a.participation_note FROM task_assignments a JOIN members m ON m.id = a.member_id WHERE a.task_id = ? AND a.status IN ('ASSIGNED','ACCEPTED')", [task.id]),
      db.one('SELECT username FROM members WHERE id = ?', [task.completedBy]),
      mongo.col('taskHistory').countDocuments({ taskId: task.id, event: 'RESULT_AMENDED' }),
    ]);
    return {
      taskId: task.id, title: task.title, status: task.status, outcome: task.resultOutcome, summary: task.resultSummary, value: task.resultValue,
      completedAt: task.completedAt, completedBy: by ? by.username : null, participants, amendments,
    };
  });

  api.patch('/:id/result', {
    summary: '완료된 업무 결과 수정 (Underboss 이상, 사유 필수, 수정 전 값 이력 보존)',
    description: 'BR-06: 완료된 업무의 핵심 결과는 일반 구성원(Soldier/Capo)이 변경할 수 없다. task.result.amend 권한(Underboss 이상)만 수정 가능하며 변경 전/후 값이 이력에 남는다.',
    reqs: ['BR-06', 'FR-11', 'FR-20'], perm: 'task.result.amend',
    params: idParam,
    body: {
      outcome: { type: 'string', enum: ['SUCCESS', 'PARTIAL', 'FAILURE'], example: 'PARTIAL' },
      summary: { type: 'string', maxLength: 5000, example: '재검토 결과 일부 누락 확인' },
      value: { type: 'number', min: 0, nullable: true, example: 11000 },
      reason: { type: 'string', required: true, maxLength: 300, example: '감사 결과 반영' },
    },
    example: { ...TASK_EXAMPLE, id: 4, status: 'COMPLETED', resultOutcome: 'PARTIAL', resultValue: 11000 },
    errors: [{ status: 403, code: 'FORBIDDEN', message: '권한(task.result.amend)이 필요합니다.' }, 404, 422],
  }, async (req) => {
    const task = await taskSvc.getManagedTask(req.user, req.params.id);
    if (task.status !== 'COMPLETED') throw E.state('완료된 업무만 결과를 수정할 수 있습니다.');
    const { reason, ...changes } = req.body;
    if (!Object.keys(changes).length) throw E.badRequest('수정할 결과 항목(outcome, summary, value)을 입력하세요.');
    const map = { outcome: 'result_outcome', summary: 'result_summary', value: 'result_value' };
    const keys = Object.keys(changes);
    await db.query(`UPDATE tasks SET ${keys.map((k) => `${map[k]} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => changes[k]), task.id]);
    const before = { outcome: task.resultOutcome, summary: task.resultSummary, value: task.resultValue };
    await rec.taskHistory(task.id, 'RESULT_AMENDED', before, changes, req.user, reason);
    await rec.audit(req.user, 'TASK_RESULT_AMENDED', 'task', task.id, { before, after: changes, reason }, 'SUCCESS', req.ip);
    return taskSvc.getTask(task.id);
  });

  api.post('/:id/reopen', {
    summary: '완료된 업무 재개 (Underboss 이상, COMPLETED → IN_PROGRESS)',
    reqs: ['BR-06', 'FR-10'], perm: 'task.result.amend',
    params: idParam,
    body: { reason: { type: 'string', required: true, maxLength: 300, example: '추가 작업 필요' } },
    example: { taskId: 4, from: 'COMPLETED', to: 'IN_PROGRESS' },
    errors: [403, 404, 422],
  }, async (req) => {
    const task = await taskSvc.getManagedTask(req.user, req.params.id);
    if (task.status !== 'COMPLETED') throw E.state('완료된 업무만 재개할 수 있습니다.');
    await db.query("UPDATE tasks SET status = 'IN_PROGRESS', completed_at = NULL, completed_by = NULL WHERE id = ?", [task.id]);
    await rec.taskHistory(task.id, 'REOPENED', 'COMPLETED', 'IN_PROGRESS', req.user, req.body.reason, { previousResult: { outcome: task.resultOutcome, summary: task.resultSummary, value: task.resultValue } });
    await rec.audit(req.user, 'TASK_REOPENED', 'task', task.id, { reason: req.body.reason }, 'SUCCESS', req.ip);
    return { taskId: task.id, from: 'COMPLETED', to: 'IN_PROGRESS' };
  });

  api.post('/:id/duplicate', {
    summary: '업무 복제 (새 일정으로 PLANNED 업무 생성, 체크리스트 포함)',
    reqs: ['FR-07'], perm: 'task.create', status: 201,
    params: idParam,
    body: {
      startAt: { type: 'datetime', required: true, example: '2026-11-02T09:00:00Z' },
      endAt: { type: 'datetime', required: true, example: '2026-11-02T12:00:00Z' },
      title: { type: 'string', maxLength: 100, example: '물류 창고 정기 점검 (11월)' },
    },
    example: { ...TASK_EXAMPLE, id: 26, title: '물류 창고 정기 점검 (11월)', startAt: '2026-11-02T09:00:00.000Z' },
    errors: [403, 404],
  }, async (req) => {
    const src = await taskSvc.getVisibleTask(req.user, req.params.id);
    const id = await db.tx((t) => taskSvc.createTask(t, req.user, {
      title: req.body.title || `${src.title} (복제)`, description: src.description, crewId: src.crewId, priority: src.priority,
      startAt: req.body.startAt, endAt: req.body.endAt, location: src.location, allowConcurrent: src.allowConcurrent, requiredSkills: src.requiredSkills,
    }));
    const cl = await mongo.col('taskChecklists').findOne({ taskId: src.id });
    if (cl) await mongo.col('taskChecklists').insertOne({ taskId: id, items: cl.items.map((i) => ({ ...i, done: false, updatedAt: new Date() })), seq: cl.seq });
    await rec.taskHistory(id, 'CREATED', null, 'PLANNED', req.user, `업무 #${src.id} 복제`);
    return taskSvc.getTask(id);
  });

  api.delete('/:id', {
    summary: '업무 삭제 (배정·자원 이력이 없는 PLANNED/CANCELLED 업무만)',
    description: '참여·자원 이력이 있는 업무는 삭제할 수 없으며 CANCELLED 상태로 관리해야 한다(이력 보존).',
    reqs: ['FR-07', 'DR-02'], perm: 'task.create',
    params: idParam,
    example: { id: 25, deleted: true },
    errors: [403, 404, 422],
  }, async (req) => {
    const task = await taskSvc.getManagedTask(req.user, req.params.id);
    if (!['PLANNED', 'CANCELLED'].includes(task.status)) throw E.state('PLANNED 또는 CANCELLED 상태의 업무만 삭제할 수 있습니다.');
    const used = await db.one('SELECT (SELECT COUNT(*) FROM task_assignments WHERE task_id = ?) + (SELECT COUNT(*) FROM resource_allocations WHERE task_id = ?) AS n', [task.id, task.id]);
    if (used.n) throw E.state('배정 또는 자원 이력이 있는 업무는 삭제할 수 없습니다. CANCELLED 상태로 변경하세요.', { references: used.n });
    await db.query('DELETE FROM tasks WHERE id = ?', [task.id]);
    await Promise.all([mongo.col('taskChecklists').deleteOne({ taskId: task.id }), mongo.col('taskComments').deleteMany({ taskId: task.id })]);
    await rec.audit(req.user, 'TASK_DELETED', 'task', task.id, { title: task.title }, 'SUCCESS', req.ip);
    return { id: task.id, deleted: true };
  });

  api.get('/:id/timeline', {
    summary: '업무 통합 타임라인 (상태 이력 + 코멘트 + 자원 사용 이벤트)',
    reqs: ['FR-10', 'FR-15', 'FR-20'],
    params: idParam,
    example: [{ kind: 'HISTORY', event: 'CREATED', by: 'capo1', at: '2026-10-14T00:00:00.000Z' }, { kind: 'COMMENT', body: '점검 체크리스트 반드시 확인', by: 'capo1', at: '2026-10-18T00:00:00.000Z' }],
    errors: [403, 404],
  }, async (req) => {
    const task = await taskSvc.getVisibleTask(req.user, req.params.id);
    const allocIds = (await db.query('SELECT id FROM resource_allocations WHERE task_id = ?', [task.id])).map((r) => r.id);
    const [history, comments, resEvents] = await Promise.all([
      mongo.col('taskHistory').find({ taskId: task.id }).toArray(),
      mongo.col('taskComments').find({ taskId: task.id }).toArray(),
      allocIds.length ? mongo.col('resourceHistory').find({ allocationId: { $in: allocIds } }).toArray() : [],
    ]);
    return [
      ...history.map((h) => ({ kind: 'HISTORY', event: h.event, from: h.from, to: h.to, note: h.note, by: h.by.username, at: h.at })),
      ...comments.map((c) => ({ kind: 'COMMENT', body: c.body, by: c.author.username, at: c.createdAt })),
      ...resEvents.map((r) => ({ kind: 'RESOURCE', event: r.event, resourceId: r.resourceId, from: r.from, to: r.to, by: r.by.username, at: r.at })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at));
  });

  api.get('/:id/candidates', {
    summary: '배정 후보 추천 (상태·시간 충돌 없는 구성원, 기술 적합도·실무 인력·업무량 순)',
    reqs: ['FR-08', 'BR-02', 'BR-03'], perm: 'task.assign',
    params: idParam,
    query: { includeOtherCrews: { type: 'boolean', default: false, desc: '관리 범위 내 다른 Crew 구성원도 포함' } },
    example: [{ memberId: 9, name: 'Joey Marino', role: 'SOLDIER', status: 'ACTIVE', crewId: 1, skillMatch: 1, matchedSkills: ['security'], openAssignments: 1 }],
    errors: [403, 404, 422],
  }, async (req) => {
    const task = await taskSvc.getManagedTask(req.user, req.params.id);
    if (!taskSvc.OPEN_STATUSES.includes(task.status)) throw E.state('진행 전/중인 업무만 후보를 조회할 수 있습니다.');
    let crewIds = [task.crewId];
    if (req.q.includeOtherCrews) {
      const managed = await scope.managedCrewIds(req.user);
      crewIds = managed === null ? (await db.query("SELECT id FROM crews WHERE status = 'ACTIVE'")).map((c) => c.id) : managed;
    }
    const members = await db.query(
      `SELECT DISTINCT m.id AS member_id, m.name, r.code AS role, m.status, cm.crew_id,
              (SELECT COUNT(*) FROM task_assignments a JOIN tasks t ON t.id = a.task_id WHERE a.member_id = m.id AND a.status IN ('ASSIGNED','ACCEPTED') AND t.status IN ('PLANNED','IN_PROGRESS','ON_HOLD')) AS open_assignments
         FROM crew_memberships cm JOIN members m ON m.id = cm.member_id JOIN roles r ON r.id = m.role_id
        WHERE cm.crew_id IN (?) AND cm.left_at IS NULL AND m.status IN ('ACTIVE','STANDBY') AND r.level <= 3
          AND m.id NOT IN (SELECT member_id FROM task_assignments WHERE task_id = ? AND status IN ('ASSIGNED','ACCEPTED'))`,
      [crewIds, task.id]
    );
    const skills = members.length ? await db.query('SELECT member_id, skill FROM member_skills WHERE member_id IN (?)', [members.map((m) => m.memberId)]) : [];
    const required = task.requiredSkills || [];
    const out = [];
    for (const m of members) {
      const conflicts = await taskSvc.findScheduleConflicts(db, m.memberId, task.startAt, task.endAt, task.allowConcurrent, task.id);
      if (conflicts.length) continue;
      const own = skills.filter((s) => s.memberId === m.memberId).map((s) => s.skill);
      const matched = required.filter((s) => own.includes(s));
      out.push({ ...m, skillMatch: required.length ? Math.round((matched.length / required.length) * 100) / 100 : 1, matchedSkills: matched });
    }
    const supervisor = (m) => (m.role === 'CAPO' ? 1 : 0);
    return out.sort((a, b) => b.skillMatch - a.skillMatch || supervisor(a) - supervisor(b) || a.openAssignments - b.openAssignments);
  });

  api.get('/:id/conflicts', {
    summary: '업무 충돌 진단 (참여자 일정 중복 BR-03, 자원 중복 BR-07)',
    reqs: ['BR-03', 'BR-07', 'FR-12'], perm: 'task.assign',
    params: idParam,
    example: { taskId: 1, ok: true, memberConflicts: [], resourceConflicts: [] },
    errors: [403, 404],
  }, async (req) => {
    const task = await taskSvc.getManagedTask(req.user, req.params.id);
    const memberConflicts = [];
    for (const memberId of await taskSvc.activeAssigneeIds(task.id)) {
      const c = await taskSvc.findScheduleConflicts(db, memberId, task.startAt, task.endAt, task.allowConcurrent, task.id);
      if (c.length) memberConflicts.push({ memberId, conflicts: c });
    }
    const resourceConflicts = [];
    const allocs = await db.query("SELECT id, resource_id, start_at, end_at FROM resource_allocations WHERE task_id = ? AND status IN ('RESERVED','IN_USE')", [task.id]);
    for (const a of allocs) {
      const c = await resSvc.findAllocationConflicts(db, a.resourceId, a.startAt, a.endAt, [a.id]);
      if (c.length) resourceConflicts.push({ allocationId: a.id, resourceId: a.resourceId, conflicts: c });
    }
    return { taskId: task.id, ok: !memberConflicts.length && !resourceConflicts.length, memberConflicts, resourceConflicts };
  });
};
