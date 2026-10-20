/** 구성원 관리 (FR-01~FR-04, FR-19, FR-21, BR-02~BR-05, BR-10) */
const bcrypt = require('bcryptjs');
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const { toCsv } = require('../lib/util');
const scope = require('../services/scope');
const memberSvc = require('../services/members');
const taskSvc = require('../services/tasks');
const { reputationOf } = require('../services/reputation');

const idParam = { id: { type: 'integer', example: 8, desc: '구성원 ID' } };
const ROLE_ENUM = ['ASSOCIATE', 'SOLDIER', 'CAPO', 'UNDERBOSS', 'BOSS', 'ADMINISTRATOR'];

const MEMBER_EXAMPLE = {
  id: 8, username: 'soldier1', name: 'Paulie Conti', alias: 'Paulie', role: 'SOLDIER', roleName: 'Soldier', level: 2,
  status: 'ACTIVE', crewId: 1, crewName: 'Brooklyn Crew', email: 'soldier1@family.local', phone: '010-1000-1007', joinedAt: '2025-11-01T00:00:00.000Z',
};

/** 목록/내보내기 공통 조건 (권한 범위 내 검색, FR-21) */
async function listFilter(user, q) {
  const where = [];
  const params = [];
  const visible = await scope.visibleCrewIds(user);
  if (visible !== null) {
    const parts = ['m.id = ?'];
    params.push(user.id);
    if (visible.length) {
      parts.push('m.id IN (SELECT member_id FROM crew_memberships WHERE left_at IS NULL AND crew_id IN (?))');
      params.push(visible);
    }
    if (user.level >= 4) parts.push("NOT EXISTS (SELECT 1 FROM crew_memberships x WHERE x.member_id = m.id AND x.left_at IS NULL AND x.membership_type = 'FORMAL')");
    where.push(`(${parts.join(' OR ')})`);
  }
  if (q.q) { where.push('(m.name LIKE ? OR m.username LIKE ? OR m.alias LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  if (q.role) { where.push('r.code = ?'); params.push(q.role); }
  if (q.status) { where.push('m.status IN (?)'); params.push(q.status); }
  if (q.crewId) { where.push('m.id IN (SELECT member_id FROM crew_memberships WHERE left_at IS NULL AND crew_id = ?)'); params.push(q.crewId); }
  if (q.unaffiliated) where.push("NOT EXISTS (SELECT 1 FROM crew_memberships y WHERE y.member_id = m.id AND y.left_at IS NULL AND y.membership_type = 'FORMAL')");
  if (q.skill) { where.push('m.id IN (SELECT member_id FROM member_skills WHERE skill = ?)'); params.push(q.skill); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const LIST_FROM = `FROM members m JOIN roles r ON r.id = m.role_id
  LEFT JOIN crew_memberships cm ON cm.member_id = m.id AND cm.left_at IS NULL AND cm.membership_type = 'FORMAL'
  LEFT JOIN crews c ON c.id = cm.crew_id`;

/** 관리 범위 밖 구성원은 연락처 등 민감 정보 제외 */
async function redact(user, rows) {
  const managed = await scope.managedCrewIds(user);
  return rows.map((r) => {
    const full = r.id === user.id || managed === null || (r.crewId ? managed.includes(r.crewId) : user.level >= 4);
    if (full) return r;
    const { email, phone, notes, birthDate, isLocked, lastLoginAt, ...rest } = r;
    return { ...rest, limited: true };
  });
}

async function assertCanEditMember(user, target) {
  if (user.id !== target.id) {
    memberSvc.assertHigherThan(user, target, '정보');
    await scope.assertManageMember(user, target.id);
  }
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '04. Members', base: '/api/members' });

  const listQuery = {
    q: { type: 'string', desc: '이름/아이디/별칭 검색어', example: 'Paulie' },
    role: { type: 'string', enum: ROLE_ENUM },
    status: { type: 'array', items: { type: 'string', enum: memberSvc.STATUSES }, desc: '쉼표 구분 다중 선택 (예: ACTIVE,STANDBY)' },
    crewId: { type: 'integer', desc: '소속 Crew' },
    skill: { type: 'string', desc: '보유 기술', example: 'driving' },
    unaffiliated: { type: 'boolean', desc: 'true 이면 정식 소속이 없는 구성원만' },
  };

  api.get('', {
    summary: '구성원 검색/목록 (권한 범위 내, 필터·정렬·페이지)',
    description: 'Boss/Admin: 전체, Underboss: 감독 Crew + 무소속, Capo: 담당 Crew, Soldier/Associate: 자신이 속한 Crew. 관리 범위 밖 구성원은 연락처가 제외된다(limited=true).',
    reqs: ['FR-21', 'FR-05', 'NFR-04', 'BR-09'],
    scope: '역할별 조회 범위 적용',
    query: listQuery,
    list: { sort: { id: 'm.id', name: 'm.name', joinedAt: 'm.joined_at', level: 'r.level', status: 'm.status' }, defaultSort: 'id' },
    example: MEMBER_EXAMPLE,
  }, async (req) => {
    const f = await listFilter(req.user, req.q);
    const total = (await db.one(`SELECT COUNT(*) AS n ${LIST_FROM} ${f.sql}`, f.params)).n;
    const rows = await db.query(
      `SELECT m.id, m.username, m.name, m.alias, r.code AS role, r.name AS role_name, r.level, m.status, cm.crew_id, c.name AS crew_name,
              m.email, m.phone, m.joined_at, m.is_locked, m.last_login_at
       ${LIST_FROM} ${f.sql} ORDER BY ${req.page.orderBy} LIMIT ? OFFSET ?`,
      [...f.params, req.page.size, req.page.offset]
    );
    return paged(await redact(req.user, rows), total, req.page);
  });

  api.get('/export', {
    summary: '구성원 목록 CSV 내보내기 (검색 조건 동일 적용)',
    reqs: ['FR-21', 'FR-22'], perm: 'member.read', produces: 'text/csv',
    query: listQuery,
    example: 'id,username,name,role,status,crewName\n8,soldier1,Paulie Conti,SOLDIER,ACTIVE,Brooklyn Crew',
  }, async (req, res) => {
    const f = await listFilter(req.user, req.q);
    const rows = await db.query(
      `SELECT m.id, m.username, m.name, m.alias, r.code AS role, m.status, c.name AS crew_name, m.email, m.phone, m.joined_at
       ${LIST_FROM} ${f.sql} ORDER BY m.id LIMIT 5000`, f.params
    );
    const red = await redact(req.user, rows);
    await rec.audit(req.user, 'MEMBERS_EXPORTED', 'member', null, { count: rows.length, filter: req.q }, 'SUCCESS', req.ip);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="members.csv"');
    res.send(toCsv(red, ['id', 'username', 'name', 'alias', 'role', 'status', 'crewName', 'email', 'phone', 'joinedAt']));
  });

  api.get('/:id', {
    summary: '구성원 상세 조회 (소속 Crew, 기술 포함)',
    reqs: ['FR-02', 'FR-05', 'BR-09'],
    params: idParam,
    example: { ...MEMBER_EXAMPLE, crews: [{ crewId: 1, crewName: 'Brooklyn Crew', membershipType: 'FORMAL' }], skills: [{ skill: 'driving', level: 4 }] },
    errors: [403, 404],
    verify: 'soldier1 로그인 → GET /api/members/10 (다른 Crew) → 403 / GET /api/members/9 (같은 Crew) → 200, limited=true',
  }, async (req) => {
    const m = await memberSvc.getMember(req.params.id);
    await scope.assertViewMember(req.user, m.id);
    const [crews, skills] = await Promise.all([
      db.query('SELECT cm.crew_id, c.name AS crew_name, cm.membership_type, cm.joined_at FROM crew_memberships cm JOIN crews c ON c.id = cm.crew_id WHERE cm.member_id = ? AND cm.left_at IS NULL', [m.id]),
      db.query('SELECT skill, level FROM member_skills WHERE member_id = ? ORDER BY level DESC', [m.id]),
    ]);
    const formal = crews.find((c) => c.membershipType === 'FORMAL');
    const [out] = await redact(req.user, [{ ...m, crewId: formal ? formal.crewId : null, crewName: formal ? formal.crewName : null }]);
    return { ...out, statusLabel: memberSvc.STATUS_LABEL[m.status], crews, skills };
  });

  api.post('', {
    summary: '구성원 등록 (역할/상태/소속 Crew 지정 가능)',
    reqs: ['FR-01', 'FR-04', 'BR-01', 'BR-04'], perm: 'member.create', status: 201,
    body: {
      username: { type: 'string', required: true, minLength: 3, maxLength: 30, pattern: '^[a-zA-Z0-9_]+$', example: 'soldier7' },
      password: { type: 'string', required: true, minLength: 8, maxLength: 64, example: 'pass1234' },
      name: { type: 'string', required: true, maxLength: 50, example: 'Gino Vitale' },
      alias: { type: 'string', maxLength: 50, example: 'Gino' },
      email: { type: 'email', example: 'soldier7@family.local' },
      phone: { type: 'string', maxLength: 30, example: '010-3333-4444' },
      birthDate: { type: 'date', example: '1995-05-05' },
      role: { type: 'string', enum: ROLE_ENUM, default: 'ASSOCIATE', example: 'SOLDIER' },
      status: { type: 'string', enum: ['PENDING', 'ACTIVE', 'STANDBY'], default: 'ACTIVE', example: 'ACTIVE' },
      crewId: { type: 'integer', desc: '정식 소속 Crew (선택)', example: 1 },
      notes: { type: 'string', maxLength: 1000 },
    },
    example: { ...MEMBER_EXAMPLE, id: 20, username: 'soldier7', name: 'Gino Vitale' },
    errors: [403, { status: 409, code: 'CONFLICT', message: '이미 존재하는 값입니다(중복).' }],
  }, async (req) => {
    const b = req.body;
    const role = await memberSvc.getRole(b.role);
    if (req.user.role !== 'ADMINISTRATOR' && role.level >= req.user.level) throw E.forbidden('자신과 같거나 높은 역할로 구성원을 등록할 수 없습니다.', 'BR-04');
    if (b.crewId) await scope.assertManageCrew(req.user, b.crewId);
    const hash = await bcrypt.hash(b.password, 8);
    const id = await db.tx(async (t) => {
      const r = await t.query(
        'INSERT INTO members (username, password_hash, name, alias, email, phone, birth_date, role_id, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [b.username, hash, b.name, b.alias || null, b.email || null, b.phone || null, b.birthDate || null, role.id, b.status, b.notes || null]
      );
      if (b.crewId) {
        const crew = await t.one("SELECT id, name FROM crews WHERE id = ? AND status = 'ACTIVE'", [b.crewId]);
        if (!crew) throw E.notFound('활성 Crew', b.crewId);
        await t.query("INSERT INTO crew_memberships (crew_id, member_id, membership_type, changed_by) VALUES (?, ?, 'FORMAL', ?)", [b.crewId, r.insertId, req.user.id]);
        await rec.memberHistory(r.insertId, 'CREW', null, crew.name, req.user, '등록 시 배정', { crewId: crew.id });
      }
      await rec.memberHistory(r.insertId, 'STATUS', null, b.status, req.user, '구성원 등록');
      await rec.audit(req.user, 'MEMBER_CREATED', 'member', r.insertId, { username: b.username, role: b.role, crewId: b.crewId || null }, 'SUCCESS', req.ip);
      return r.insertId;
    });
    return memberSvc.getMember(id);
  });

  api.patch('/:id', {
    summary: '구성원 기본 정보 수정 (이름/별칭/연락처/생년월일/메모)',
    reqs: ['FR-01', 'BR-04'], perm: 'member.update', partial: true,
    params: idParam,
    body: {
      name: { type: 'string', maxLength: 50, example: 'Paulie Conti' },
      alias: { type: 'string', maxLength: 50, nullable: true, example: 'Paulie' },
      email: { type: 'email', nullable: true },
      phone: { type: 'string', maxLength: 30, nullable: true, example: '010-1111-2222' },
      birthDate: { type: 'date', nullable: true },
      notes: { type: 'string', maxLength: 1000, nullable: true, example: '운전 실력 우수' },
    },
    example: MEMBER_EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    const target = await memberSvc.getMember(req.params.id);
    await assertCanEditMember(req.user, target);
    const map = { name: 'name', alias: 'alias', email: 'email', phone: 'phone', birthDate: 'birth_date', notes: 'notes' };
    const keys = Object.keys(req.body);
    await db.query(`UPDATE members SET ${keys.map((k) => `${map[k]} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => req.body[k]), target.id]);
    await rec.audit(req.user, 'MEMBER_UPDATED', 'member', target.id, { fields: keys }, 'SUCCESS', req.ip);
    return memberSvc.getMember(target.id);
  });

  api.delete('/:id', {
    summary: '가입대기 구성원 삭제 (활동 이력이 없는 PENDING 계정만)',
    description: '활동 이력이 있는 구성원은 삭제할 수 없으며 상태를 WITHDRAWN 으로 변경해야 한다(이력 보존).',
    reqs: ['FR-01', 'FR-04', 'DR-01'], perm: 'member.delete',
    params: idParam,
    example: { id: 19, deleted: true },
    errors: [404, { status: 422, code: 'INVALID_STATE', message: 'PENDING 상태이고 활동 이력이 없는 구성원만 삭제할 수 있습니다.' }],
  }, async (req) => {
    const m = await memberSvc.getMember(req.params.id);
    const used = await db.one(
      `SELECT (SELECT COUNT(*) FROM crew_memberships WHERE member_id = ?) + (SELECT COUNT(*) FROM task_assignments WHERE member_id = ?)
            + (SELECT COUNT(*) FROM resource_allocations WHERE member_id = ?) AS n`, [m.id, m.id, m.id]
    );
    if (m.status !== 'PENDING' || used.n > 0) throw E.state('PENDING 상태이고 활동 이력이 없는 구성원만 삭제할 수 있습니다. 그 외에는 WITHDRAWN 으로 상태를 변경하세요.');
    await db.tx(async (t) => {
      await t.query('DELETE FROM crew_join_requests WHERE member_id = ?', [m.id]);
      await t.query('DELETE FROM members WHERE id = ?', [m.id]);
    });
    await rec.audit(req.user, 'MEMBER_DELETED', 'member', m.id, { username: m.username }, 'SUCCESS', req.ip);
    return { id: m.id, deleted: true };
  });

  api.patch('/:id/role', {
    summary: '구성원 역할 변경 (자신보다 높은 권한자 변경 불가)',
    description: 'BR-04: 대상의 현재 역할과 새 역할이 모두 요청자보다 낮아야 한다(Administrator 예외). Capo 는 담당 Crew 의 Associate↔Soldier 만 변경 가능. 변경 이력은 member_history 에 기록된다.',
    reqs: ['FR-03', 'BR-04', 'BR-05', 'BR-10'], perm: 'member.role',
    params: idParam,
    body: {
      role: { type: 'string', required: true, enum: ROLE_ENUM, example: 'SOLDIER' },
      reason: { type: 'string', maxLength: 300, example: '6개월 성실 활동' },
    },
    example: { memberId: 14, from: 'ASSOCIATE', to: 'SOLDIER', vacatedPositions: [] },
    errors: [404, { status: 403, rule: 'BR-04', code: 'FORBIDDEN', message: '자신보다 높거나 같은 권한을 가진 사용자의 역할은 변경할 수 없습니다.' }, 422],
    verify: 'capo1 로그인 → PATCH /api/members/14/role {role:SOLDIER} → 200 / PATCH /api/members/3/role (underboss) → 403 BR-04',
  }, async (req) => {
    const target = await memberSvc.getMember(req.params.id);
    const newRole = await memberSvc.getRole(req.body.role);
    await memberSvc.assertRoleChange(req.user, target, newRole);
    return db.tx((t) => memberSvc.applyRoleChange(t, req.user, target, newRole, req.body.reason));
  });

  api.patch('/:id/status', {
    summary: '구성원 상태 변경 (활동중/대기/정지/탈퇴)',
    description: '허용 전이: PENDING→ACTIVE|WITHDRAWN, ACTIVE→STANDBY|SUSPENDED|WITHDRAWN, STANDBY→ACTIVE|SUSPENDED|WITHDRAWN, SUSPENDED→ACTIVE|STANDBY|WITHDRAWN. 탈퇴 시 Crew 소속 종료·진행 전 업무 배정 해제·자원 예약 취소·세션 만료가 함께 처리된다. Capo 는 탈퇴 처리 불가.',
    reqs: ['FR-03', 'FR-04', 'BR-04', 'BR-10', 'FR-20'], perm: 'member.status',
    params: idParam,
    body: {
      status: { type: 'string', required: true, enum: memberSvc.STATUSES, example: 'STANDBY' },
      reason: { type: 'string', maxLength: 300, example: '장기 휴가' },
    },
    example: { memberId: 9, from: 'ACTIVE', to: 'STANDBY', effects: {} },
    errors: [404, 422],
  }, async (req) => {
    const target = await memberSvc.getMember(req.params.id);
    memberSvc.assertHigherThan(req.user, target, '상태');
    await scope.assertManageMember(req.user, target.id);
    if (req.user.role === 'CAPO' && req.body.status === 'WITHDRAWN') throw E.forbidden('탈퇴 처리는 Underboss 이상만 가능합니다.', 'BR-09');
    return db.tx(async (t) => {
      const locked = await memberSvc.getMember(target.id, t, { lock: true });
      return memberSvc.applyStatusChange(t, req.user, locked, req.body.status, req.body.reason);
    });
  });

  api.get('/:id/status-transitions', {
    summary: '구성원의 현재 상태에서 요청자가 수행 가능한 상태 전이 목록',
    reqs: ['FR-04'],
    params: idParam,
    example: { memberId: 9, current: 'ACTIVE', allowed: ['STANDBY', 'SUSPENDED', 'WITHDRAWN'], canChange: true },
    errors: [403, 404],
  }, async (req) => {
    const m = await memberSvc.getMember(req.params.id);
    await scope.assertViewMember(req.user, m.id);
    let canChange = req.user.perms.has('member.status') && req.user.id !== m.id && (req.user.role === 'ADMINISTRATOR' || m.level < req.user.level);
    if (canChange) canChange = await scope.canManageMember(req.user, m.id);
    let allowed = memberSvc.allowedTransitions(m.status, req.user);
    if (req.user.role === 'CAPO') allowed = allowed.filter((s) => s !== 'WITHDRAWN');
    return { memberId: m.id, current: m.status, currentLabel: memberSvc.STATUS_LABEL[m.status], allowed: canChange ? allowed : [], canChange };
  });

  api.get('/:id/crew-history', {
    summary: '구성원의 Crew 소속 이력 (가입/이동/탈퇴)',
    reqs: ['FR-19', 'BR-10', 'DR-01'],
    params: idParam,
    example: { id: 1, crewId: 1, crewName: 'Brooklyn Crew', membershipType: 'FORMAL', joinedAt: '2026-01-01T00:00:00.000Z', leftAt: null, leftReason: null },
    errors: [403, 404],
  }, async (req) => {
    const m = await memberSvc.getMember(req.params.id);
    await scope.assertViewMember(req.user, m.id);
    return db.query(
      `SELECT cm.id, cm.crew_id, c.name AS crew_name, cm.membership_type, cm.joined_at, cm.left_at, cm.left_reason, cb.username AS changed_by
         FROM crew_memberships cm JOIN crews c ON c.id = cm.crew_id LEFT JOIN members cb ON cb.id = cm.changed_by
        WHERE cm.member_id = ? ORDER BY cm.joined_at DESC, cm.id DESC`, [m.id]
    );
  });

  api.get('/:id/assignments', {
    summary: '구성원의 업무 참여 이력 (참여 기록·기여도 포함)',
    reqs: ['FR-11', 'FR-19', 'DR-02'],
    params: idParam,
    query: { taskStatus: { type: 'string', enum: taskSvc.STATUSES }, from: { type: 'datetime' }, to: { type: 'datetime' } },
    list: { sort: { startAt: 't.start_at', assignedAt: 'a.assigned_at' }, defaultSort: '-startAt' },
    example: { assignmentId: 5, taskId: 4, title: '월간 장부 정리', taskStatus: 'COMPLETED', resultOutcome: 'SUCCESS', taskRole: '장부 검토', status: 'ACCEPTED', attendance: 'PRESENT', contribution: 80 },
    errors: [403, 404],
  }, async (req) => {
    const m = await memberSvc.getMember(req.params.id);
    if (m.id !== req.user.id) await scope.assertManageMember(req.user, m.id, 'BR-09');
    const where = ['a.member_id = ?'];
    const params = [m.id];
    if (req.q.taskStatus) { where.push('t.status = ?'); params.push(req.q.taskStatus); }
    if (req.q.from) { where.push('t.end_at >= ?'); params.push(req.q.from); }
    if (req.q.to) { where.push('t.start_at <= ?'); params.push(req.q.to); }
    const base = `FROM task_assignments a JOIN tasks t ON t.id = a.task_id WHERE ${where.join(' AND ')}`;
    const total = (await db.one(`SELECT COUNT(*) AS n ${base}`, params)).n;
    const rows = await db.query(
      `SELECT a.id AS assignment_id, t.id AS task_id, t.title, t.status AS task_status, t.start_at, t.end_at, t.result_outcome,
              a.task_role, a.status, a.attendance, a.contribution, a.participation_note, a.assigned_at
       ${base} ORDER BY ${req.page.orderBy} LIMIT ? OFFSET ?`, [...params, req.page.size, req.page.offset]
    );
    return paged(rows, total, req.page);
  });

  api.get('/:id/schedule', {
    summary: '구성원 일정 타임라인 (업무·자원 사용·회의)',
    reqs: ['FR-09', 'BR-03'],
    params: idParam,
    query: {
      from: { type: 'datetime', desc: '기본: 현재', example: '2026-10-18T00:00:00Z' },
      to: { type: 'datetime', desc: '기본: from + 14일', example: '2026-11-01T00:00:00Z' },
    },
    example: [{ kind: 'TASK', refId: 1, title: '물류 창고 정기 점검', startAt: '2026-10-19T09:00:00.000Z', endAt: '2026-10-19T12:00:00.000Z', exclusive: true }],
    errors: [403, 404],
  }, async (req) => {
    const m = await memberSvc.getMember(req.params.id);
    await scope.assertViewMember(req.user, m.id);
    const from = req.q.from || new Date();
    const to = req.q.to || new Date(from.getTime() + 14 * 86400000);
    const [tasks, allocs, meetings] = await Promise.all([
      db.query(`SELECT t.id, t.title, t.start_at, t.end_at, t.allow_concurrent, t.status FROM task_assignments a JOIN tasks t ON t.id = a.task_id
                 WHERE a.member_id = ? AND a.status IN ('ASSIGNED','ACCEPTED') AND t.status IN ('PLANNED','IN_PROGRESS','ON_HOLD') AND t.start_at < ? AND t.end_at > ?`, [m.id, to, from]),
      db.query(`SELECT a.id, r.name, a.start_at, a.end_at, a.status FROM resource_allocations a JOIN resources r ON r.id = a.resource_id
                 WHERE a.member_id = ? AND a.status IN ('RESERVED','IN_USE') AND a.start_at < ? AND a.end_at > ?`, [m.id, to, from]),
      db.query(`SELECT mt.id, mt.title, mt.start_at, mt.end_at, ma.rsvp FROM meeting_attendees ma JOIN meetings mt ON mt.id = ma.meeting_id
                 WHERE ma.member_id = ? AND mt.status = 'SCHEDULED' AND mt.start_at < ? AND mt.end_at > ?`, [m.id, to, from]),
    ]);
    return [
      ...tasks.map((x) => ({ kind: 'TASK', refId: x.id, title: x.title, startAt: x.startAt, endAt: x.endAt, status: x.status, exclusive: !x.allowConcurrent })),
      ...allocs.map((x) => ({ kind: 'RESOURCE', refId: x.id, title: x.name, startAt: x.startAt, endAt: x.endAt, status: x.status })),
      ...meetings.map((x) => ({ kind: 'MEETING', refId: x.id, title: x.title, startAt: x.startAt, endAt: x.endAt, status: x.rsvp })),
    ].sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  });

  api.get('/:id/availability', {
    summary: '특정 시간대 배정 가능 여부 사전 점검 (상태·시간 중복)',
    reqs: ['BR-02', 'BR-03', 'FR-08'], perm: 'task.assign',
    params: idParam,
    query: {
      startAt: { type: 'datetime', required: true, example: '2026-10-19T10:00:00Z' },
      endAt: { type: 'datetime', required: true, example: '2026-10-19T11:00:00Z' },
      allowConcurrent: { type: 'boolean', default: false, desc: '배정하려는 업무가 동시 수행 가능한 업무인지' },
    },
    example: { memberId: 8, available: false, reasons: ['BR-03: 동일 시간대 업무 1건'], status: 'ACTIVE', conflicts: [{ taskId: 1, title: '물류 창고 정기 점검' }] },
    errors: [404],
  }, async (req) => {
    const m = await memberSvc.getMember(req.params.id);
    if (req.q.endAt <= req.q.startAt) throw E.badRequest('endAt 은 startAt 이후여야 합니다.');
    const conflicts = await taskSvc.findScheduleConflicts(db, m.id, req.q.startAt, req.q.endAt, req.q.allowConcurrent);
    const reasons = [];
    if (!['ACTIVE', 'STANDBY'].includes(m.status)) reasons.push(`BR-02: ${m.status} 상태`);
    if (conflicts.length) reasons.push(`BR-03: 동일 시간대 업무 ${conflicts.length}건`);
    return { memberId: m.id, available: reasons.length === 0, reasons, status: m.status, conflicts };
  });

  api.get('/:id/reputation', {
    summary: '구성원 평판 점수 (평가 평균, 가감점, 출석률)',
    reqs: ['FR-18', 'FR-19'],
    params: idParam,
    example: { memberId: 8, evaluationCount: 1, evaluationAverage: 4.5, ledgerPoints: 10, completedTasks: 6, attendanceRate: 100, score: 100, recentAdjustments: [] },
    errors: [403, 404],
  }, async (req) => {
    const m = await memberSvc.getMember(req.params.id);
    if (m.id !== req.user.id) {
      if (!req.user.perms.has('evaluation.read')) throw E.forbidden('평판 조회 권한(evaluation.read)이 필요합니다.');
      await scope.assertManageMember(req.user, m.id, 'BR-09');
    }
    const [rep] = await reputationOf([m.id]);
    const recent = await mongo.col('reputationLedger').find({ memberId: m.id }).sort({ at: -1 }).limit(10).toArray();
    return { ...rep, recentAdjustments: recent.map(mongo.out) };
  });

  api.post('/:id/reputation-adjustments', {
    summary: '평판 가감점 부여 (공로/과실)',
    reqs: ['FR-18', 'BR-10', 'FR-20'], perm: 'reputation.adjust', status: 201,
    params: idParam,
    body: {
      points: { type: 'integer', required: true, min: -50, max: 50, example: 5 },
      reason: { type: 'string', required: true, maxLength: 300, example: '위기 상황에서 신속 대응' },
    },
    example: { id: '6713...', memberId: 8, points: 5, reason: '위기 상황에서 신속 대응', score: 105 },
    errors: [403, 404],
  }, async (req) => {
    const m = await memberSvc.getMember(req.params.id);
    if (m.id === req.user.id) throw E.forbidden('자기 자신에게 평판 점수를 부여할 수 없습니다.');
    await scope.assertManageMember(req.user, m.id);
    if (req.body.points === 0) throw E.badRequest('points 는 0 이 아니어야 합니다.');
    const doc = { memberId: m.id, points: req.body.points, reason: req.body.reason, by: rec.actorOf(req.user), at: new Date() };
    const r = await mongo.col('reputationLedger').insertOne(doc);
    await rec.memberHistory(m.id, 'REPUTATION', null, req.body.points, req.user, req.body.reason);
    await rec.audit(req.user, 'REPUTATION_ADJUSTED', 'member', m.id, { points: req.body.points, reason: req.body.reason }, 'SUCCESS', req.ip);
    await rec.notify(m.id, 'EVALUATION', '평판 변경', `평판 점수 ${req.body.points > 0 ? '+' : ''}${req.body.points}: ${req.body.reason}`);
    const [rep] = await reputationOf([m.id]);
    return { ...mongo.out({ _id: r.insertedId, ...doc }), score: rep.score };
  });

  api.get('/:id/history', {
    summary: '구성원 주요 변경 이력 (역할·소속·상태·평가·징계)',
    reqs: ['BR-10', 'FR-19', 'FR-20'],
    params: idParam,
    query: {
      type: { type: 'string', enum: ['ROLE', 'STATUS', 'CREW', 'EVALUATION', 'REPUTATION', 'DISCIPLINE'] },
      from: { type: 'datetime' }, to: { type: 'datetime' },
    },
    list: { sort: { at: 'at' }, defaultSort: '-at' },
    example: { id: '6713...', memberId: 16, type: 'STATUS', from: 'ACTIVE', to: 'SUSPENDED', reason: '조직 정보 외부 유출', by: { id: 3, username: 'underboss1', role: 'UNDERBOSS' }, at: '2026-10-13T00:00:00.000Z' },
    errors: [403, 404],
  }, async (req) => {
    const m = await memberSvc.getMember(req.params.id);
    if (m.id !== req.user.id) {
      if (!req.user.perms.has('member.read')) throw E.forbidden('구성원 이력 조회 권한(member.read)이 필요합니다.');
      await scope.assertManageMember(req.user, m.id, 'BR-09');
    }
    const f = { memberId: m.id };
    if (req.q.type) f.type = req.q.type;
    if (req.q.from || req.q.to) f.at = { ...(req.q.from && { $gte: req.q.from }), ...(req.q.to && { $lte: req.q.to }) };
    const c = mongo.col('memberHistory');
    const [items, total] = await Promise.all([c.find(f).sort(req.page.mongoSort).skip(req.page.offset).limit(req.page.size).toArray(), c.countDocuments(f)]);
    return paged(items.map(mongo.out), total, req.page);
  });

  /* ----------------------------- 보유 기술 ----------------------------- */
  api.get('/:id/skills', {
    summary: '구성원 보유 기술 목록',
    reqs: ['FR-01', 'FR-08'],
    params: idParam,
    example: [{ skill: 'driving', level: 4 }],
    errors: [403, 404],
  }, async (req) => {
    const m = await memberSvc.getMember(req.params.id);
    await scope.assertViewMember(req.user, m.id);
    return db.query('SELECT skill, level FROM member_skills WHERE member_id = ? ORDER BY level DESC, skill', [m.id]);
  });

  api.put('/:id/skills/:skill', {
    summary: '구성원 기술 등록/수준 변경 (본인 또는 관리자)',
    reqs: ['FR-01'],
    params: { ...idParam, skill: { type: 'string', maxLength: 50, pattern: '^[a-z_]+$', example: 'security' } },
    body: { level: { type: 'integer', required: true, min: 1, max: 5, example: 3 } },
    example: { memberId: 8, skill: 'security', level: 3 },
    errors: [403, 404],
  }, async (req) => {
    const m = await memberSvc.getMember(req.params.id);
    if (m.id !== req.user.id) {
      if (!req.user.perms.has('member.update') && !req.user.perms.has('crew.members')) throw E.forbidden();
      await scope.assertManageMember(req.user, m.id);
    }
    await db.query('INSERT INTO member_skills (member_id, skill, level) VALUES (?,?,?) ON DUPLICATE KEY UPDATE level = VALUES(level)', [m.id, req.params.skill, req.body.level]);
    return { memberId: m.id, skill: req.params.skill, level: req.body.level };
  });

  api.delete('/:id/skills/:skill', {
    summary: '구성원 기술 삭제',
    reqs: ['FR-01'],
    params: { ...idParam, skill: { type: 'string', maxLength: 50, example: 'security' } },
    example: { memberId: 8, skill: 'security', deleted: true },
    errors: [403, 404],
  }, async (req) => {
    const m = await memberSvc.getMember(req.params.id);
    if (m.id !== req.user.id) {
      if (!req.user.perms.has('member.update') && !req.user.perms.has('crew.members')) throw E.forbidden();
      await scope.assertManageMember(req.user, m.id);
    }
    const r = await db.query('DELETE FROM member_skills WHERE member_id = ? AND skill = ?', [m.id, req.params.skill]);
    if (!r.affectedRows) throw E.notFound('기술', req.params.skill);
    return { memberId: m.id, skill: req.params.skill, deleted: true };
  });
};
