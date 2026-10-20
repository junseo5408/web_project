/** 내 정보 / 내 업무 / 알림 (FR-02, FR-09) */
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const memberSvc = require('../services/members');
const scope = require('../services/scope');

const NOTIFICATION_TYPES = ['TASK_ASSIGNED', 'TASK_UNASSIGNED', 'TASK_STATUS', 'ASSIGNMENT_DECLINED', 'ROLE_CHANGED', 'STATUS_CHANGED', 'CREW_CHANGED',
  'EVALUATION', 'RESOURCE', 'REQUEST_REVIEWED', 'ANNOUNCEMENT', 'MEETING', 'DISCIPLINE', 'BROADCAST'];

async function myCrews(memberId) {
  return db.query(
    `SELECT cm.crew_id, c.name AS crew_name, cm.membership_type, cm.joined_at, c.capo_id, cp.name AS capo_name
       FROM crew_memberships cm JOIN crews c ON c.id = cm.crew_id LEFT JOIN members cp ON cp.id = c.capo_id
      WHERE cm.member_id = ? AND cm.left_at IS NULL`,
    [memberId]
  );
}

async function getMyAssignment(user, assignmentId) {
  const a = await db.one(
    'SELECT a.*, t.status AS task_status, t.title, t.crew_id, t.start_at, t.end_at FROM task_assignments a JOIN tasks t ON t.id = a.task_id WHERE a.id = ?',
    [assignmentId]
  );
  if (!a) throw E.notFound('업무 배정', assignmentId);
  if (a.memberId !== user.id) throw E.forbidden('본인에게 배정된 업무만 응답할 수 있습니다.');
  if (a.status !== 'ASSIGNED') throw E.state(`이미 응답했거나 해제된 배정입니다. (현재 ${a.status})`);
  if (!['PLANNED', 'IN_PROGRESS', 'ON_HOLD'].includes(a.taskStatus)) throw E.state(`${a.taskStatus} 상태의 업무입니다.`);
  return a;
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '02. Me (내 정보)', base: '/api/me' });

  api.get('', {
    summary: '내 프로필 조회 (현재 소속, 역할, 상태, 활동 요약)',
    reqs: ['FR-02'],
    example: {
      id: 8, username: 'soldier1', name: 'Paulie Conti', role: 'SOLDIER', roleName: 'Soldier', level: 2, status: 'ACTIVE', statusLabel: '활동중',
      crews: [{ crewId: 1, crewName: 'Brooklyn Crew', membershipType: 'FORMAL', capoName: 'Tony Russo' }],
      activity: { openAssignments: 1, completedTasks: 6, activeAllocations: 0, reputation: 10 },
    },
  }, async (req) => {
    const me = await memberSvc.getMember(req.user.id);
    const [crews, open, done, alloc, rep] = await Promise.all([
      myCrews(me.id),
      db.one("SELECT COUNT(*) AS n FROM task_assignments a JOIN tasks t ON t.id=a.task_id WHERE a.member_id=? AND a.status IN ('ASSIGNED','ACCEPTED') AND t.status IN ('PLANNED','IN_PROGRESS','ON_HOLD')", [me.id]),
      db.one("SELECT COUNT(*) AS n FROM task_assignments a JOIN tasks t ON t.id=a.task_id WHERE a.member_id=? AND a.status='ACCEPTED' AND t.status='COMPLETED'", [me.id]),
      db.one("SELECT COUNT(*) AS n FROM resource_allocations WHERE member_id=? AND status IN ('RESERVED','IN_USE')", [me.id]),
      mongo.col('reputationLedger').aggregate([{ $match: { memberId: me.id } }, { $group: { _id: null, s: { $sum: '$points' } } }]).toArray(),
    ]);
    return {
      ...me, statusLabel: memberSvc.STATUS_LABEL[me.status], crews,
      activity: { openAssignments: open.n, completedTasks: done.n, activeAllocations: alloc.n, reputation: rep[0] ? rep[0].s : 0 },
    };
  });

  api.patch('', {
    summary: '내 연락처/별칭 수정 (역할·상태·소속은 변경 불가)',
    reqs: ['FR-01', 'FR-02'], partial: true,
    body: {
      alias: { type: 'string', maxLength: 50, nullable: true, example: 'Paulie Walnuts' },
      email: { type: 'email', nullable: true, example: 'paulie@family.local' },
      phone: { type: 'string', maxLength: 30, nullable: true, example: '010-2222-3333' },
    },
    example: { id: 8, alias: 'Paulie Walnuts', email: 'paulie@family.local', phone: '010-2222-3333' },
  }, async (req) => {
    const fields = Object.keys(req.body);
    await db.query(`UPDATE members SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`, [...fields.map((f) => req.body[f]), req.user.id]);
    const m = await memberSvc.getMember(req.user.id);
    return { id: m.id, alias: m.alias, email: m.email, phone: m.phone };
  });

  api.get('/tasks', {
    summary: '나에게 배정된 업무 목록 (확인 필요 사항 포함)',
    description: '배정된 업무와 함께 수락 필요 여부, 미완료 체크리스트 수, 배정된 자원 등 "내가 확인해야 할 정보"를 반환한다.',
    reqs: ['FR-09', 'FR-08'],
    query: {
      view: { type: 'string', enum: ['open', 'done', 'all'], default: 'open', desc: 'open=진행 예정/중, done=완료/취소, all=전체' },
      from: { type: 'datetime', desc: '시작일시 이후' }, to: { type: 'datetime', desc: '종료일시 이전' },
    },
    list: { sort: { startAt: 't.start_at', priority: 't.priority', assignedAt: 'a.assigned_at' }, defaultSort: 'startAt' },
    example: {
      assignmentId: 1, assignmentStatus: 'ACCEPTED', taskRole: '현장 책임', instructions: '집결 30분 전 도착',
      task: { id: 1, title: '물류 창고 정기 점검', status: 'PLANNED', priority: 'HIGH', startAt: '2026-10-19T09:00:00.000Z', endAt: '2026-10-19T12:00:00.000Z', location: 'Brooklyn 창고 3동', crewName: 'Brooklyn Crew' },
      actionRequired: ['체크리스트 미완료 2건'], resources: [{ code: 'VH-001', name: '검정 세단' }],
    },
  }, async (req) => {
    const where = ["a.member_id = ?", "a.status <> 'REMOVED'"];
    const params = [req.user.id];
    if (req.q.view === 'open') where.push("t.status IN ('PLANNED','IN_PROGRESS','ON_HOLD')", "a.status IN ('ASSIGNED','ACCEPTED')");
    if (req.q.view === 'done') where.push("t.status IN ('COMPLETED','CANCELLED')");
    if (req.q.from) { where.push('t.end_at >= ?'); params.push(req.q.from); }
    if (req.q.to) { where.push('t.start_at <= ?'); params.push(req.q.to); }
    const base = `FROM task_assignments a JOIN tasks t ON t.id = a.task_id JOIN crews c ON c.id = t.crew_id WHERE ${where.join(' AND ')}`;
    const total = (await db.one(`SELECT COUNT(*) AS n ${base}`, params)).n;
    const rows = await db.query(
      `SELECT a.id AS assignment_id, a.status AS assignment_status, a.task_role, a.instructions, a.assigned_at,
              t.id, t.title, t.status, t.priority, t.start_at, t.end_at, t.location, c.name AS crew_name
       ${base} ORDER BY ${req.page.orderBy} LIMIT ? OFFSET ?`,
      [...params, req.page.size, req.page.offset]
    );
    const ids = rows.map((r) => r.id);
    const [resources, checklists] = await Promise.all([
      ids.length ? db.query("SELECT a.task_id, r.code, r.name FROM resource_allocations a JOIN resources r ON r.id=a.resource_id WHERE a.task_id IN (?) AND a.status IN ('RESERVED','IN_USE')", [ids]) : [],
      ids.length ? mongo.col('taskChecklists').find({ taskId: { $in: ids } }).toArray() : [],
    ]);
    const items = rows.map((r) => {
      const actions = [];
      if (r.assignmentStatus === 'ASSIGNED') actions.push('배정 수락/거절 응답 필요');
      const cl = checklists.find((c) => c.taskId === r.id);
      const pending = cl ? cl.items.filter((i) => !i.done).length : 0;
      if (pending && ['PLANNED', 'IN_PROGRESS', 'ON_HOLD'].includes(r.status)) actions.push(`체크리스트 미완료 ${pending}건`);
      return {
        assignmentId: r.assignmentId, assignmentStatus: r.assignmentStatus, taskRole: r.taskRole, instructions: r.instructions,
        task: { id: r.id, title: r.title, status: r.status, priority: r.priority, startAt: r.startAt, endAt: r.endAt, location: r.location, crewName: r.crewName },
        actionRequired: actions,
        resources: resources.filter((x) => x.taskId === r.id).map((x) => ({ code: x.code, name: x.name })),
      };
    });
    return paged(items, total, req.page);
  });

  api.get('/tasks/:taskId', {
    summary: '내 업무 브리핑 (내 역할/지시사항, 동료, 자원, 체크리스트, 최근 코멘트)',
    reqs: ['FR-09', 'FR-08', 'FR-11'],
    params: { taskId: { type: 'integer', example: 1 } },
    example: {
      task: { id: 1, title: '물류 창고 정기 점검', status: 'PLANNED' },
      myAssignment: { id: 1, taskRole: '현장 책임', instructions: '집결 30분 전 도착', status: 'ACCEPTED' },
      teammates: [{ memberId: 9, name: 'Joey Marino', taskRole: '경비', status: 'ASSIGNED' }],
      resources: [{ resourceId: 1, code: 'VH-001', name: '검정 세단', status: 'RESERVED' }],
      checklist: [{ id: '1', text: '출입구 잠금 상태 확인', done: false }],
      recentComments: [{ author: 'capo1', body: '점검 체크리스트 반드시 확인' }],
      myEvaluation: null,
    },
    errors: [403, 404],
  }, async (req) => {
    const mine = await db.one("SELECT id, task_role, instructions, status, attendance, contribution FROM task_assignments WHERE task_id = ? AND member_id = ? AND status <> 'REMOVED' ORDER BY id DESC LIMIT 1", [req.params.taskId, req.user.id]);
    const task = await db.one('SELECT t.*, c.name AS crew_name FROM tasks t JOIN crews c ON c.id = t.crew_id WHERE t.id = ?', [req.params.taskId]);
    if (!task) throw E.notFound('업무', req.params.taskId);
    if (!mine) throw E.forbidden('나에게 배정된 업무가 아닙니다.', 'BR-09');
    const [teammates, resources, checklist, comments, evaluation] = await Promise.all([
      db.query("SELECT a.member_id, m.name, m.alias, a.task_role, a.status FROM task_assignments a JOIN members m ON m.id=a.member_id WHERE a.task_id=? AND a.member_id<>? AND a.status IN ('ASSIGNED','ACCEPTED')", [task.id, req.user.id]),
      db.query("SELECT a.resource_id, r.code, r.name, a.status, a.start_at, a.end_at FROM resource_allocations a JOIN resources r ON r.id=a.resource_id WHERE a.task_id=? AND a.status IN ('RESERVED','IN_USE')", [task.id]),
      mongo.col('taskChecklists').findOne({ taskId: task.id }),
      mongo.col('taskComments').find({ taskId: task.id }).sort({ createdAt: -1 }).limit(5).toArray(),
      mongo.col('evaluations').findOne({ taskId: task.id, memberId: req.user.id, status: 'ACTIVE' }, { projection: { evaluator: 0 } }),
    ]);
    return {
      task, myAssignment: mine, teammates, resources,
      checklist: checklist ? checklist.items : [],
      recentComments: comments.map((c) => ({ id: String(c._id), author: c.author.username, body: c.body, createdAt: c.createdAt })),
      myEvaluation: evaluation ? mongo.out(evaluation) : null,
    };
  });

  api.post('/assignments/:assignmentId/accept', {
    summary: '배정된 업무 수락',
    reqs: ['FR-09', 'FR-08'],
    params: { assignmentId: { type: 'integer', example: 2 } },
    example: { assignmentId: 2, status: 'ACCEPTED' },
    errors: [403, 404, 422],
    verify: 'soldier2 로그인 → POST /api/me/assignments/2/accept → ACCEPTED',
  }, async (req) => {
    const a = await getMyAssignment(req.user, req.params.assignmentId);
    await db.query("UPDATE task_assignments SET status = 'ACCEPTED', responded_at = NOW() WHERE id = ?", [a.id]);
    await rec.taskHistory(a.taskId, 'ASSIGNMENT_ACCEPTED', 'ASSIGNED', 'ACCEPTED', req.user, null, { memberId: req.user.id });
    await rec.activity(req.user.id, 'TASK_ACCEPTED', `업무 '${a.title}' 배정 수락`, { taskId: a.taskId });
    return { assignmentId: a.id, status: 'ACCEPTED' };
  });

  api.post('/assignments/:assignmentId/decline', {
    summary: '배정된 업무 거절 (사유 필수, Crew 책임자에게 알림)',
    reqs: ['FR-09', 'FR-08'],
    params: { assignmentId: { type: 'integer', example: 2 } },
    body: { reason: { type: 'string', required: true, maxLength: 300, example: '같은 시간 가족 행사' } },
    example: { assignmentId: 2, status: 'DECLINED' },
    errors: [403, 404, 422],
  }, async (req) => {
    const a = await getMyAssignment(req.user, req.params.assignmentId);
    await db.query("UPDATE task_assignments SET status = 'DECLINED', responded_at = NOW(), participation_note = ? WHERE id = ?", [req.body.reason, a.id]);
    await rec.taskHistory(a.taskId, 'ASSIGNMENT_DECLINED', 'ASSIGNED', 'DECLINED', req.user, req.body.reason, { memberId: req.user.id });
    const crew = await db.one('SELECT capo_id FROM crews WHERE id = ?', [a.crewId]);
    await rec.notify([crew.capoId, a.assignedBy], 'ASSIGNMENT_DECLINED', '배정 거절', `${req.user.name} 님이 '${a.title}' 배정을 거절했습니다: ${req.body.reason}`, `/api/tasks/${a.taskId}`);
    return { assignmentId: a.id, status: 'DECLINED' };
  });

  api.get('/dashboard', {
    summary: '내 대시보드 (7일 내 일정, 미읽은 알림, 대기 중 요청, 사용 중 자원)',
    reqs: ['FR-02', 'FR-09', 'FR-14'],
    example: { upcoming: [{ taskId: 1, title: '물류 창고 정기 점검', startAt: '2026-10-19T09:00:00.000Z' }], unreadNotifications: 2, pendingRequests: { resource: 1, join: 0 }, allocations: [] },
  }, async (req) => {
    const id = req.user.id;
    const [upcoming, unread, rr, jr, allocations, meetings] = await Promise.all([
      db.query(`SELECT t.id AS task_id, t.title, t.status, t.start_at, t.end_at, a.status AS assignment_status
                  FROM task_assignments a JOIN tasks t ON t.id=a.task_id
                 WHERE a.member_id=? AND a.status IN ('ASSIGNED','ACCEPTED') AND t.status IN ('PLANNED','IN_PROGRESS','ON_HOLD')
                   AND t.start_at < DATE_ADD(NOW(), INTERVAL 7 DAY) ORDER BY t.start_at`, [id]),
      mongo.col('notifications').countDocuments({ memberId: id, read: false }),
      db.one("SELECT COUNT(*) AS n FROM resource_requests WHERE requester_id=? AND status='PENDING'", [id]),
      db.one("SELECT COUNT(*) AS n FROM crew_join_requests WHERE member_id=? AND status='PENDING'", [id]),
      db.query("SELECT a.id, r.code, r.name, a.status, a.start_at, a.end_at FROM resource_allocations a JOIN resources r ON r.id=a.resource_id WHERE a.member_id=? AND a.status IN ('RESERVED','IN_USE')", [id]),
      db.query("SELECT m.id, m.title, m.start_at, ma.rsvp FROM meeting_attendees ma JOIN meetings m ON m.id=ma.meeting_id WHERE ma.member_id=? AND m.status='SCHEDULED' AND m.start_at > NOW() ORDER BY m.start_at", [id]),
    ]);
    return { upcoming, meetings, unreadNotifications: unread, pendingRequests: { resource: rr.n, join: jr.n }, allocations };
  });

  api.get('/inbox', {
    summary: '내 처리 대기함 (내가 응답·승인해야 할 항목 집계)',
    description: '배정 응답, 자원 사용 요청 승인, Crew 가입 요청, 승급 요청 심사, 평가 대기 등 역할과 관리 범위에 따라 현재 사용자가 처리해야 할 항목 수를 반환한다.',
    reqs: ['FR-09', 'FR-06', 'FR-17', 'FR-18'],
    example: { total: 4, items: [{ type: 'ASSIGNMENT', label: '배정 응답 대기', count: 1, link: '/tasks?mine=1' }, { type: 'RESOURCE_REQUEST', label: '자원 사용 요청 승인', count: 1, link: '/approvals' }] },
  }, async (req) => {
    const u = req.user;
    const items = [];
    const push = (type, label, count, link) => { if (count > 0) items.push({ type, label, count, link }); };
    const mine = await db.one(
      `SELECT COUNT(*) AS n FROM task_assignments a JOIN tasks t ON t.id = a.task_id
        WHERE a.member_id = ? AND a.status = 'ASSIGNED' AND t.status IN ('PLANNED','IN_PROGRESS','ON_HOLD')`, [u.id]);
    push('ASSIGNMENT', '배정 응답 대기', mine.n, '/tasks?mine=1');
    const managed = await scope.managedCrewIds(u);
    const inScope = (col) => (managed === null ? { sql: '1=1', p: [] } : managed.length ? { sql: `${col} IN (?)`, p: [managed] } : { sql: '1=0', p: [] });
    const memberScope = inScope('cm.crew_id');
    if (u.perms.has('resource.allocate')) {
      const r = await db.one(
        `SELECT COUNT(DISTINCT q.id) AS n FROM resource_requests q JOIN crew_memberships cm ON cm.member_id = q.requester_id AND cm.left_at IS NULL
          WHERE q.status = 'PENDING' AND q.requester_id <> ? AND ${memberScope.sql}`, [u.id, ...memberScope.p]);
      push('RESOURCE_REQUEST', '자원 사용 요청 승인', r.n, '/approvals');
    }
    if (u.perms.has('crew.members')) {
      const c = inScope('j.crew_id');
      const r = await db.one(`SELECT COUNT(*) AS n FROM crew_join_requests j WHERE j.status = 'PENDING' AND ${c.sql}`, c.p);
      push('JOIN_REQUEST', 'Crew 가입 요청 심사', r.n, '/approvals');
    }
    if (u.perms.has('promotion.review')) {
      const r = await db.one(
        `SELECT COUNT(DISTINCT p.id) AS n FROM promotion_requests p LEFT JOIN crew_memberships cm ON cm.member_id = p.member_id AND cm.left_at IS NULL
          WHERE p.status = 'PENDING' AND p.requested_by <> ? AND ${managed === null ? '1=1' : memberScope.sql}`, [u.id, ...(managed === null ? [] : memberScope.p)]);
      push('PROMOTION_REQUEST', '승급 요청 심사', r.n, '/approvals');
    }
    if (u.perms.has('evaluation.write')) {
      const c = inScope('t.crew_id');
      const rows = await db.query(
        `SELECT t.id AS task_id, a.member_id FROM tasks t JOIN task_assignments a ON a.task_id = t.id
          WHERE t.status = 'COMPLETED' AND t.completed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND a.status IN ('ASSIGNED','ACCEPTED') AND a.member_id <> ? AND ${c.sql}`,
        [u.id, ...c.p]);
      let pending = 0;
      if (rows.length) {
        const done = await mongo.col('evaluations').find({ status: 'ACTIVE', taskId: { $in: [...new Set(rows.map((r) => r.taskId))] } }, { projection: { taskId: 1, memberId: 1 } }).toArray();
        pending = rows.filter((r) => !done.some((d) => d.taskId === r.taskId && d.memberId === r.memberId)).length;
      }
      push('EVALUATION', '평가 대기', pending, '/evaluations');
    }
    push('NOTIFICATION', '읽지 않은 알림', await mongo.col('notifications').countDocuments({ memberId: u.id, read: false }), '/notifications');
    return { total: items.filter((i) => i.type !== 'NOTIFICATION').reduce((s, i) => s + i.count, 0), items };
  });

  /* ---------------------------- 알림 ---------------------------- */
  api.get('/notifications', {
    summary: '내 알림 목록',
    reqs: ['FR-09', 'NFR-01'],
    query: { unread: { type: 'boolean', desc: 'true 이면 읽지 않은 알림만' }, type: { type: 'string', enum: NOTIFICATION_TYPES } },
    list: { sort: { createdAt: 'createdAt' }, defaultSort: '-createdAt' },
    example: { id: '6711aa...', type: 'TASK_ASSIGNED', title: '업무 배정', message: '물류 창고 정기 점검 업무에 배정되었습니다.', link: '/api/me/tasks/1', read: false, createdAt: '2026-10-18T09:00:00.000Z' },
  }, async (req) => {
    const f = { memberId: req.user.id };
    if (req.q.unread) f.read = false;
    if (req.q.type) f.type = req.q.type;
    const c = mongo.col('notifications');
    const [items, total] = await Promise.all([c.find(f).sort(req.page.mongoSort).skip(req.page.offset).limit(req.page.size).toArray(), c.countDocuments(f)]);
    return paged(items.map(mongo.out), total, req.page);
  });

  api.patch('/notifications/read-all', {
    summary: '내 알림 모두 읽음 처리',
    reqs: ['FR-09'],
    example: { updated: 3 },
  }, async (req) => {
    const r = await mongo.col('notifications').updateMany({ memberId: req.user.id, read: false }, { $set: { read: true, readAt: new Date() } });
    return { updated: r.modifiedCount };
  });

  api.patch('/notifications/:id/read', {
    summary: '알림 1건 읽음 처리',
    reqs: ['FR-09'],
    params: { id: { type: 'objectId', example: '6711aa000000000000000001' } },
    example: { id: '6711aa000000000000000001', read: true },
    errors: [404],
  }, async (req) => {
    const r = await mongo.col('notifications').updateOne({ _id: mongo.oid(req.params.id), memberId: req.user.id }, { $set: { read: true, readAt: new Date() } });
    if (!r.matchedCount) throw E.notFound('알림', req.params.id);
    return { id: req.params.id, read: true };
  });

  api.delete('/notifications/:id', {
    summary: '알림 1건 삭제',
    reqs: ['FR-09'],
    params: { id: { type: 'objectId', example: '6711aa000000000000000001' } },
    example: { id: '6711aa000000000000000001', deleted: true },
    errors: [404],
  }, async (req) => {
    const r = await mongo.col('notifications').deleteOne({ _id: mongo.oid(req.params.id), memberId: req.user.id });
    if (!r.deletedCount) throw E.notFound('알림', req.params.id);
    return { id: req.params.id, deleted: true };
  });

  api.get('/notification-settings', {
    summary: '내 알림 수신 설정 조회',
    reqs: ['FR-09'],
    example: { mutedTypes: ['ANNOUNCEMENT'], availableTypes: NOTIFICATION_TYPES },
  }, async (req) => {
    const doc = await mongo.col('notificationPrefs').findOne({ memberId: req.user.id });
    return { mutedTypes: doc ? doc.mutedTypes : [], availableTypes: NOTIFICATION_TYPES };
  });

  api.put('/notification-settings', {
    summary: '내 알림 수신 설정 변경 (수신 거부할 알림 유형 지정)',
    reqs: ['FR-09'],
    body: { mutedTypes: { type: 'array', required: true, items: { type: 'string', enum: NOTIFICATION_TYPES }, example: ['ANNOUNCEMENT'] } },
    example: { mutedTypes: ['ANNOUNCEMENT'] },
  }, async (req) => {
    await mongo.col('notificationPrefs').updateOne({ memberId: req.user.id }, { $set: { mutedTypes: [...new Set(req.body.mutedTypes)], updatedAt: new Date() } }, { upsert: true });
    return { mutedTypes: [...new Set(req.body.mutedTypes)] };
  });

  /* ------------------------- 저장된 검색 조건 ------------------------- */
  api.get('/saved-filters', {
    summary: '내가 저장한 검색 조건 목록',
    reqs: ['FR-21', 'NFR-04'],
    query: { target: { type: 'string', enum: ['tasks', 'members', 'resources', 'crews'] } },
    example: { id: '6712...', name: '이번주 HIGH 업무', target: 'tasks', query: { priority: 'HIGH', status: 'PLANNED' }, createdAt: '2026-10-18T09:00:00.000Z' },
  }, async (req) => {
    const f = { memberId: req.user.id };
    if (req.q.target) f.target = req.q.target;
    return (await mongo.col('savedFilters').find(f).sort({ createdAt: -1 }).toArray()).map(mongo.out);
  });

  api.post('/saved-filters', {
    summary: '검색 조건 저장 (자주 쓰는 업무/구성원/자원 검색 조건)',
    reqs: ['FR-21', 'NFR-04'], status: 201,
    body: {
      name: { type: 'string', required: true, maxLength: 50, example: '이번주 HIGH 업무' },
      target: { type: 'string', required: true, enum: ['tasks', 'members', 'resources', 'crews'], example: 'tasks' },
      query: { type: 'object', required: true, example: { priority: 'HIGH', status: 'PLANNED' }, desc: '목록 API 에 그대로 전달할 query parameter' },
    },
    example: { id: '6712...', name: '이번주 HIGH 업무', target: 'tasks', query: { priority: 'HIGH', status: 'PLANNED' }, url: '/api/tasks?priority=HIGH&status=PLANNED' },
  }, async (req) => {
    const count = await mongo.col('savedFilters').countDocuments({ memberId: req.user.id });
    if (count >= 20) throw E.conflict('검색 조건은 최대 20개까지 저장할 수 있습니다.');
    const doc = { memberId: req.user.id, ...req.body, createdAt: new Date() };
    const r = await mongo.col('savedFilters').insertOne(doc);
    const qs = new URLSearchParams(Object.entries(req.body.query).map(([k, v]) => [k, String(v)])).toString();
    return { ...mongo.out({ _id: r.insertedId, ...doc }), url: `/api/${req.body.target}?${qs}` };
  });

  api.delete('/saved-filters/:id', {
    summary: '저장한 검색 조건 삭제',
    reqs: ['FR-21'],
    params: { id: { type: 'objectId', example: '6712aa000000000000000001' } },
    example: { id: '6712aa000000000000000001', deleted: true },
    errors: [404],
  }, async (req) => {
    const r = await mongo.col('savedFilters').deleteOne({ _id: mongo.oid(req.params.id), memberId: req.user.id });
    if (!r.deletedCount) throw E.notFound('검색 조건', req.params.id);
    return { id: req.params.id, deleted: true };
  });
};
