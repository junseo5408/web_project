/** 관리자 기능 (FR-23, FR-20, FR-22) : 계정·보안·시스템 설정·무결성 점검 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const config = require('../config');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged, registry } = require('../lib/api');
const { invalidatePermCache } = require('../lib/auth');
const { getSettings, updateSettings } = require('../services/settings');
const memberSvc = require('../services/members');
const seed = require('../db/seed');

const idParam = { id: { type: 'integer', example: 9, desc: '구성원(계정) ID' } };
const ACCOUNT_EXAMPLE = { id: 9, username: 'soldier2', name: 'Joey Marino', role: 'SOLDIER', status: 'ACTIVE', isLocked: false, lockedReason: null, failedLogins: 0, lastLoginAt: '2026-10-18T09:00:00.000Z', tokenVersion: 0 };

async function getAccount(id) {
  const a = await db.one(
    `SELECT m.id, m.username, m.name, r.code AS role, r.level, m.status, m.is_locked, m.locked_reason, m.failed_logins, m.last_login_at, m.token_version
       FROM members m JOIN roles r ON r.id = m.role_id WHERE m.id = ?`, [id]
  );
  if (!a) throw E.notFound('계정', id);
  return a;
}
function assertNotSelf(user, a) {
  if (a.id === user.id) throw E.forbidden('자기 자신의 계정에는 이 작업을 수행할 수 없습니다.', 'BR-04');
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '26. Admin', base: '/api/admin' });

  /* ------------------------------ 계정 관리 ------------------------------ */
  api.get('/accounts', {
    summary: '계정 목록 (잠금 여부, 로그인 실패 횟수, 최근 로그인)',
    reqs: ['FR-23', 'FR-21'], perm: 'account.manage',
    query: {
      q: { type: 'string', desc: '아이디/이름 검색' },
      locked: { type: 'boolean' },
      role: { type: 'string', enum: ['ASSOCIATE', 'SOLDIER', 'CAPO', 'UNDERBOSS', 'BOSS', 'ADMINISTRATOR'] },
      inactiveDays: { type: 'integer', min: 1, desc: 'N일 이상 로그인하지 않은 계정' },
    },
    list: { sort: { id: 'm.id', username: 'm.username', lastLoginAt: 'm.last_login_at', failedLogins: 'm.failed_logins' }, defaultSort: 'id' },
    example: ACCOUNT_EXAMPLE,
  }, async (req) => {
    const where = [];
    const params = [];
    if (req.q.q) { where.push('(m.username LIKE ? OR m.name LIKE ?)'); params.push(`%${req.q.q}%`, `%${req.q.q}%`); }
    if (req.q.locked !== undefined) { where.push('m.is_locked = ?'); params.push(req.q.locked ? 1 : 0); }
    if (req.q.role) { where.push('r.code = ?'); params.push(req.q.role); }
    if (req.q.inactiveDays) { where.push('(m.last_login_at IS NULL OR m.last_login_at < DATE_SUB(NOW(), INTERVAL ? DAY))'); params.push(req.q.inactiveDays); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = 'FROM members m JOIN roles r ON r.id = m.role_id';
    const total = (await db.one(`SELECT COUNT(*) AS n ${from} ${w}`, params)).n;
    const rows = await db.query(
      `SELECT m.id, m.username, m.name, r.code AS role, m.status, m.is_locked, m.locked_reason, m.failed_logins, m.last_login_at, m.token_version
       ${from} ${w} ORDER BY ${req.page.orderBy} LIMIT ? OFFSET ?`, [...params, req.page.size, req.page.offset]
    );
    return paged(rows, total, req.page);
  });

  api.post('/accounts/:id/lock', {
    summary: '계정 잠금 (로그인 차단 + 기존 세션 즉시 무효)',
    reqs: ['FR-23', 'FR-20', 'NFR-03'], perm: 'account.manage',
    params: idParam,
    body: { reason: { type: 'string', required: true, maxLength: 255, example: '보안 사고 조사' } },
    example: { ...ACCOUNT_EXAMPLE, isLocked: true, lockedReason: '보안 사고 조사', tokenVersion: 1 },
    errors: [403, 404, 422],
  }, async (req) => {
    const a = await getAccount(req.params.id);
    assertNotSelf(req.user, a);
    if (a.isLocked) throw E.state('이미 잠긴 계정입니다.');
    await db.query('UPDATE members SET is_locked = 1, locked_reason = ?, token_version = token_version + 1 WHERE id = ?', [req.body.reason, a.id]);
    await rec.audit(req.user, 'ACCOUNT_LOCKED', 'account', a.id, { reason: req.body.reason }, 'SUCCESS', req.ip);
    return getAccount(a.id);
  });

  api.post('/accounts/:id/unlock', {
    summary: '계정 잠금 해제 (로그인 실패 횟수 초기화)',
    reqs: ['FR-23', 'FR-20'], perm: 'account.manage',
    params: idParam,
    example: ACCOUNT_EXAMPLE,
    errors: [404, 422],
  }, async (req) => {
    const a = await getAccount(req.params.id);
    if (!a.isLocked) throw E.state('잠긴 계정이 아닙니다.');
    await db.query('UPDATE members SET is_locked = 0, locked_reason = NULL, failed_logins = 0 WHERE id = ?', [a.id]);
    await rec.audit(req.user, 'ACCOUNT_UNLOCKED', 'account', a.id, {}, 'SUCCESS', req.ip);
    return getAccount(a.id);
  });

  api.post('/accounts/:id/reset-password', {
    summary: '비밀번호 초기화 (임시 비밀번호 발급, 기존 세션 만료)',
    reqs: ['FR-23', 'FR-20'], perm: 'account.manage',
    params: idParam,
    example: { id: 9, username: 'soldier2', temporaryPassword: 'Tmp-8f2a9c1d', sessionsRevoked: true },
    errors: [403, 404],
  }, async (req) => {
    const a = await getAccount(req.params.id);
    assertNotSelf(req.user, a);
    const temp = `Tmp-${crypto.randomBytes(4).toString('hex')}`;
    await db.query('UPDATE members SET password_hash = ?, token_version = token_version + 1, failed_logins = 0 WHERE id = ?', [await bcrypt.hash(temp, 8), a.id]);
    await rec.audit(req.user, 'PASSWORD_RESET', 'account', a.id, {}, 'SUCCESS', req.ip);
    await rec.notify(a.id, 'BROADCAST', '비밀번호 초기화', '관리자에 의해 비밀번호가 초기화되었습니다. 로그인 후 변경하세요.');
    return { id: a.id, username: a.username, temporaryPassword: temp, sessionsRevoked: true };
  });

  api.post('/accounts/:id/force-logout', {
    summary: '강제 로그아웃 (해당 계정의 모든 발급 토큰 무효화)',
    reqs: ['FR-23', 'NFR-03'], perm: 'account.manage',
    params: idParam,
    example: { id: 9, username: 'soldier2', tokenVersion: 2, sessionsRevoked: true },
    errors: [403, 404],
  }, async (req) => {
    const a = await getAccount(req.params.id);
    assertNotSelf(req.user, a);
    await db.query('UPDATE members SET token_version = token_version + 1 WHERE id = ?', [a.id]);
    await rec.audit(req.user, 'FORCE_LOGOUT', 'account', a.id, {}, 'SUCCESS', req.ip);
    return { id: a.id, username: a.username, tokenVersion: a.tokenVersion + 1, sessionsRevoked: true };
  });

  api.patch('/accounts/:id/username', {
    summary: '로그인 아이디 변경',
    reqs: ['FR-23', 'FR-01'], perm: 'account.manage',
    params: idParam,
    body: { username: { type: 'string', required: true, minLength: 3, maxLength: 30, pattern: '^[a-zA-Z0-9_]+$', example: 'joey_m' } },
    example: { ...ACCOUNT_EXAMPLE, username: 'joey_m' },
    errors: [404, 409],
  }, async (req) => {
    const a = await getAccount(req.params.id);
    memberSvc.assertHigherThan(req.user, a, '계정');
    await db.query('UPDATE members SET username = ?, token_version = token_version + 1 WHERE id = ?', [req.body.username, a.id]);
    await rec.audit(req.user, 'USERNAME_CHANGED', 'account', a.id, { from: a.username, to: req.body.username }, 'SUCCESS', req.ip);
    return getAccount(a.id);
  });

  api.get('/accounts/:id/login-history', {
    summary: '특정 계정의 로그인 이력 (성공/실패, IP)',
    reqs: ['FR-23', 'FR-20'], perm: 'account.manage',
    params: idParam,
    query: { result: { type: 'string', enum: ['SUCCESS', 'FAIL'] } },
    list: { sort: { at: 'at' }, defaultSort: '-at' },
    example: { id: '671d...', memberId: 9, username: 'soldier2', event: 'LOGIN', result: 'FAIL', reason: 'BAD_PASSWORD', ip: '::1', at: '2026-10-18T09:00:00.000Z' },
    errors: [404],
  }, async (req) => {
    const a = await getAccount(req.params.id);
    const f = { $or: [{ memberId: a.id }, { username: a.username }] };
    if (req.q.result) f.result = req.q.result;
    const c = mongo.col('loginHistory');
    const [items, total] = await Promise.all([c.find(f, { projection: { jti: 0 } }).sort(req.page.mongoSort).skip(req.page.offset).limit(req.page.size).toArray(), c.countDocuments(f)]);
    return paged(items.map(mongo.out), total, req.page);
  });

  api.get('/security/failed-logins', {
    summary: '로그인 실패 집계 (계정·IP 별, 의심 계정 탐지)',
    reqs: ['FR-23', 'FR-22'], perm: 'account.manage',
    query: { hours: { type: 'integer', min: 1, max: 720, default: 24, desc: '최근 N시간' }, threshold: { type: 'integer', min: 1, default: 3, desc: '의심 판단 실패 횟수' } },
    example: { since: '2026-10-17T09:00:00.000Z', byAccount: [{ username: 'soldier2', failures: 4, lastAt: '2026-10-18T08:00:00.000Z', suspicious: true }], byIp: [{ ip: '::1', failures: 4 }] },
  }, async (req) => {
    const since = new Date(Date.now() - req.q.hours * 3600000);
    const match = { result: 'FAIL', at: { $gte: since } };
    const c = mongo.col('loginHistory');
    const [byAccount, byIp] = await Promise.all([
      c.aggregate([{ $match: match }, { $group: { _id: '$username', n: { $sum: 1 }, last: { $max: '$at' }, reasons: { $addToSet: '$reason' } } }, { $sort: { n: -1 } }]).toArray(),
      c.aggregate([{ $match: match }, { $group: { _id: '$ip', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
    ]);
    return {
      since,
      byAccount: byAccount.map((x) => ({ username: x._id, failures: x.n, lastAt: x.last, reasons: x.reasons, suspicious: x.n >= req.q.threshold })),
      byIp: byIp.map((x) => ({ ip: x._id, failures: x.n })),
    };
  });

  /* ------------------------------ 시스템 ------------------------------ */
  api.get('/settings', {
    summary: '시스템 운영 설정 조회',
    reqs: ['FR-23'], perm: 'system.manage',
    example: { evaluationEditWindowHours: 72, maxActiveAssignmentsPerMember: 5, loginLockThreshold: 5, resourceRequestAutoExpireHours: 48 },
  }, async () => getSettings());

  api.patch('/settings', {
    summary: '시스템 운영 설정 변경 (평가 수정 가능 시간, 1인 최대 동시 업무 수, 로그인 잠금 임계값)',
    reqs: ['FR-23', 'FR-20'], perm: 'system.manage', partial: true,
    body: {
      evaluationEditWindowHours: { type: 'integer', min: 0, max: 720, example: 48 },
      maxActiveAssignmentsPerMember: { type: 'integer', min: 1, max: 50, example: 5 },
      loginLockThreshold: { type: 'integer', min: 3, max: 20, example: 5 },
      resourceRequestAutoExpireHours: { type: 'integer', min: 1, max: 720, example: 48 },
    },
    example: { evaluationEditWindowHours: 48, maxActiveAssignmentsPerMember: 5, loginLockThreshold: 5, resourceRequestAutoExpireHours: 48 },
  }, async (req) => {
    const before = await getSettings();
    const after = await updateSettings(req.body, req.user);
    await rec.audit(req.user, 'SETTINGS_UPDATED', 'system', 'settings', { before, changes: req.body }, 'SUCCESS', req.ip);
    return after;
  });

  api.get('/system/info', {
    summary: '시스템 정보 (DB 이름, 버전, 테이블/컬렉션별 데이터 건수)',
    reqs: ['FR-23', 'DR-05', 'DR-06'], perm: 'system.manage',
    example: { studentId: '202600000', node: 'v20.18.0', mysql: { database: 'family_202600000', version: '8.0.46', tables: { members: 19 } }, mongo: { database: 'family_log_202600000', collections: { audit_logs: 42 } }, apiCount: 230 },
  }, async () => {
    const tables = await db.query('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name', [config.mysql.database]);
    const counts = {};
    for (const t of tables) counts[t.name] = (await db.one(`SELECT COUNT(*) AS n FROM \`${t.name}\``)).n;
    const colls = {};
    for (const name of Object.values(mongo.COLLECTIONS)) colls[name] = await mongo.getDb().collection(name).estimatedDocumentCount();
    const v = await db.one('SELECT VERSION() AS v');
    const mv = await mongo.getDb().command({ buildInfo: 1 });
    return {
      studentId: config.studentId, node: process.version, uptimeSeconds: Math.round(process.uptime()),
      mysql: { database: config.mysql.database, version: v.v, tables: counts },
      mongo: { database: config.mongo.dbName, version: mv.version, collections: colls },
      apiCount: registry.length,
    };
  });

  api.get('/integrity-check', {
    summary: '업무 규칙 무결성 점검 (BR-01/03/07/08 위반 데이터 탐지 + 운영 참고 정보)',
    description: '저장된 데이터 전체를 대상으로 업무 규칙 위반 여부를 점검한다. 정상 운영 시 모든 항목이 0건이어야 한다.',
    reqs: ['FR-23', 'BR-01', 'BR-03', 'BR-07', 'BR-08', 'DR-01'], perm: 'system.manage',
    example: { ok: true, checks: { 'BR-01 multipleFormalCrews': [], 'BR-03 overlappingAssignments': [], 'BR-07 overlappingAllocations': [], 'BR-08 blockedResourcesWithReservations': [], 'info: inactiveMembersWithOpenAssignments': [], 'info: crewsWithoutCapo': [] } },
  }, async () => {
    const checks = {
      'BR-01 multipleFormalCrews': await db.query("SELECT member_id, COUNT(*) AS crews FROM crew_memberships WHERE left_at IS NULL AND membership_type = 'FORMAL' GROUP BY member_id HAVING COUNT(*) > 1"),
      'BR-03 overlappingAssignments': await db.query(
        `SELECT a1.member_id, a1.task_id AS task_a, a2.task_id AS task_b FROM task_assignments a1
           JOIN task_assignments a2 ON a1.member_id = a2.member_id AND a1.task_id < a2.task_id
           JOIN tasks t1 ON t1.id = a1.task_id JOIN tasks t2 ON t2.id = a2.task_id
          WHERE a1.status IN ('ASSIGNED','ACCEPTED') AND a2.status IN ('ASSIGNED','ACCEPTED')
            AND t1.status IN ('PLANNED','IN_PROGRESS','ON_HOLD') AND t2.status IN ('PLANNED','IN_PROGRESS','ON_HOLD')
            AND t1.start_at < t2.end_at AND t2.start_at < t1.end_at AND NOT (t1.allow_concurrent = 1 AND t2.allow_concurrent = 1)`),
      'BR-07 overlappingAllocations': await db.query(
        `SELECT a1.resource_id, a1.id AS allocation_a, a2.id AS allocation_b FROM resource_allocations a1
           JOIN resource_allocations a2 ON a1.resource_id = a2.resource_id AND a1.id < a2.id
          WHERE a1.status IN ('RESERVED','IN_USE') AND a2.status IN ('RESERVED','IN_USE') AND a1.start_at < a2.end_at AND a2.start_at < a1.end_at`),
      'BR-08 blockedResourcesWithReservations': await db.query(
        `SELECT r.id AS resource_id, r.code, r.status, a.id AS allocation_id FROM resources r JOIN resource_allocations a ON a.resource_id = r.id
          WHERE r.status IN ('NEEDS_INSPECTION','MAINTENANCE','UNAVAILABLE','RETIRED') AND a.status = 'RESERVED'`),
      'info: inactiveMembersWithOpenAssignments': await db.query(
        `SELECT a.member_id, m.status, a.task_id FROM task_assignments a JOIN members m ON m.id = a.member_id JOIN tasks t ON t.id = a.task_id
          WHERE a.status IN ('ASSIGNED','ACCEPTED') AND t.status IN ('PLANNED','IN_PROGRESS','ON_HOLD') AND m.status IN ('SUSPENDED','WITHDRAWN','PENDING')`),
      'info: crewsWithoutCapo': await db.query("SELECT id, name FROM crews WHERE status = 'ACTIVE' AND capo_id IS NULL"),
    };
    const ruleKeys = Object.keys(checks).filter((k) => k.startsWith('BR-'));
    return { ok: ruleKeys.every((k) => checks[k].length === 0), checkedAt: new Date(), checks };
  });

  api.post('/system/reset-demo', {
    summary: '데모 데이터 초기화 (테스트 재현용: 모든 데이터를 초기 상태로)',
    description: '채점/테스트 재현을 위해 MySQL·MongoDB 데이터를 초기 데모 상태로 되돌린다. 실행 후 모든 사용자는 다시 로그인해야 한다.',
    reqs: ['FR-23', 'DR-05'], perm: 'system.manage',
    body: { confirm: { type: 'string', required: true, enum: ['RESET'], example: 'RESET', desc: '확인 문구 RESET' } },
    example: { reset: true, at: '2026-10-18T09:00:00.000Z' },
  }, async (req) => {
    if (!config.demoMode) throw E.forbidden('운영 모드(DEMO_MODE=false)에서는 데모 초기화를 사용할 수 없습니다.', 'FR-23');
    await seed.resetDemo();
    invalidatePermCache();
    await rec.audit(req.user, 'DEMO_RESET', 'system', null, {}, 'SUCCESS', req.ip);
    return { reset: true, at: new Date() };
  });

  api.post('/broadcast', {
    summary: '전체/대상 공지 알림 발송 (역할·Crew 필터)',
    reqs: ['FR-23'], perm: 'system.manage', status: 201,
    body: {
      title: { type: 'string', required: true, maxLength: 100, example: '시스템 점검 안내' },
      message: { type: 'string', required: true, maxLength: 1000, example: '오늘 22시~23시 시스템 점검이 있습니다.' },
      roles: { type: 'array', items: { type: 'string', enum: ['ASSOCIATE', 'SOLDIER', 'CAPO', 'UNDERBOSS', 'BOSS', 'ADMINISTRATOR'] } },
      crewId: { type: 'integer' },
    },
    example: { recipients: 15 },
  }, async (req) => {
    const where = ["m.status IN ('ACTIVE','STANDBY','SUSPENDED')"];
    const params = [];
    if (req.body.roles && req.body.roles.length) { where.push('r.code IN (?)'); params.push(req.body.roles); }
    if (req.body.crewId) { where.push('m.id IN (SELECT member_id FROM crew_memberships WHERE left_at IS NULL AND crew_id = ?)'); params.push(req.body.crewId); }
    const rows = await db.query(`SELECT m.id FROM members m JOIN roles r ON r.id = m.role_id WHERE ${where.join(' AND ')}`, params);
    await rec.notify(rows.map((r) => r.id), 'BROADCAST', req.body.title, req.body.message);
    await rec.audit(req.user, 'BROADCAST_SENT', 'system', null, { title: req.body.title, recipients: rows.length }, 'SUCCESS', req.ip);
    return { recipients: rows.length };
  });

  /* ----------------------------- 공개 엔드포인트 ----------------------------- */
  const sys = defineModule(app, { tag: '27. System', base: '/api' });

  sys.get('/health', {
    summary: '서버 및 DB 연결 상태 확인 (공개)',
    reqs: ['NFR-01', 'NFR-02', 'CR-06'], auth: false,
    example: { status: 'UP', mysql: 'UP', mongo: 'UP', time: '2026-10-18T09:00:00.000Z' },
  }, async () => {
    const check = async (fn) => { try { await fn(); return 'UP'; } catch (e) { return 'DOWN'; } };
    const [m, g] = await Promise.all([check(() => db.query('SELECT 1')), check(() => mongo.getDb().command({ ping: 1 }))]);
    return { status: m === 'UP' && g === 'UP' ? 'UP' : 'DEGRADED', mysql: m, mongo: g, time: new Date() };
  });

  sys.get('/api-catalog', {
    summary: 'API 카탈로그 (전체 API 와 연결된 요구사항 - 요구사항 추적용, 공개)',
    reqs: ['AR-06', 'AR-08', 'CR-04'], auth: false,
    query: { req: { type: 'string', desc: '요구사항 ID 로 필터 (예: BR-03)', example: 'BR-03' }, tag: { type: 'string' } },
    example: { total: 230, items: [{ id: 'API-001', method: 'POST', path: '/api/auth/register', summary: '회원 가입 신청', reqs: ['FR-01', 'FR-04'] }] },
  }, async (req) => {
    let items = registry.map((e) => ({ id: e.id, method: e.method, path: e.path, tag: e.tag, summary: e.summary, reqs: e.reqs || [], perm: e.perm || null, auth: e.auth !== false, location: e.location }));
    if (req.q.req) items = items.filter((i) => i.reqs.includes(req.q.req));
    if (req.q.tag) items = items.filter((i) => i.tag.includes(req.q.tag));
    return { total: registry.length, count: items.length, items };
  });
};
