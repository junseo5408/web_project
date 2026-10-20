/** 인증 / 계정 (FR-01, FR-02, FR-23, NFR-03) */
const bcrypt = require('bcryptjs');
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const { signToken, loadPrincipal } = require('../lib/auth');
const { getSettings } = require('../services/settings');
const scope = require('../services/scope');
const { loginGuard } = require('../lib/security');

const username = { type: 'string', required: true, minLength: 3, maxLength: 30, pattern: '^[a-zA-Z0-9_]+$', example: 'boss', desc: '로그인 ID' };
const password = { type: 'string', required: true, minLength: 8, maxLength: 64, example: 'pass1234' };

async function issue(member, req, event = 'LOGIN') {
  const { token, jti, expiresAt } = signToken(member);
  await mongo.col('loginHistory').insertOne({ memberId: member.id, username: member.username, event, result: 'SUCCESS', ip: req.ip, userAgent: req.headers['user-agent'] || null, jti, at: new Date() });
  return { token, tokenType: 'Bearer', expiresAt };
}

async function login(usernameValue, passwordValue, req) {
  loginGuard.check(req, usernameValue);
  const m = await db.one(
    `SELECT m.id, m.username, m.name, m.password_hash, m.status, m.is_locked, m.failed_logins, m.token_version, r.code AS role
       FROM members m JOIN roles r ON r.id = m.role_id WHERE m.username = ?`,
    [usernameValue]
  );
  const fail = async (reason, memberId = null) => {
    loginGuard.fail(req, usernameValue);
    await mongo.col('loginHistory').insertOne({ memberId, username: usernameValue, event: 'LOGIN', result: 'FAIL', reason, ip: req.ip, at: new Date() });
  };
  if (!m) {
    await fail('UNKNOWN_USER');
    throw E.unauthorized('아이디 또는 비밀번호가 올바르지 않습니다.');
  }
  if (m.isLocked) {
    await fail('LOCKED', m.id);
    throw E.unauthorized('잠긴 계정입니다. 관리자에게 잠금 해제를 요청하세요.');
  }
  if (!(await bcrypt.compare(passwordValue, m.passwordHash))) {
    const { loginLockThreshold } = await getSettings();
    const failed = m.failedLogins + 1;
    const lock = failed >= loginLockThreshold;
    await db.query('UPDATE members SET failed_logins = ?, is_locked = ?, locked_reason = ? WHERE id = ?',
      [failed, lock ? 1 : 0, lock ? `로그인 ${failed}회 연속 실패` : null, m.id]);
    await fail('BAD_PASSWORD', m.id);
    if (lock) await rec.audit(null, 'ACCOUNT_AUTO_LOCKED', 'member', m.id, { failedLogins: failed });
    throw E.unauthorized(lock ? `로그인 ${failed}회 실패로 계정이 잠겼습니다.` : `아이디 또는 비밀번호가 올바르지 않습니다. (실패 ${failed}/${loginLockThreshold})`);
  }
  if (m.status === 'WITHDRAWN') {
    await fail('WITHDRAWN', m.id);
    throw E.unauthorized('탈퇴 처리된 계정입니다.');
  }
  await db.query('UPDATE members SET failed_logins = 0, last_login_at = NOW() WHERE id = ?', [m.id]);
  return { member: m, ...(await issue(m, req)) };
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '01. Auth', base: '/api/auth' });

  api.post('/register', {
    summary: '회원 가입 신청 (Associate, 가입대기 상태로 등록)',
    reqs: ['FR-01', 'FR-04'], auth: false, status: 201,
    body: {
      username: { ...username, example: 'newcomer1' }, password,
      name: { type: 'string', required: true, maxLength: 50, example: '홍길동' },
      alias: { type: 'string', maxLength: 50, example: 'Gil' },
      email: { type: 'email', example: 'newcomer1@family.local' },
      phone: { type: 'string', maxLength: 30, example: '010-1234-5678' },
    },
    example: { id: 20, username: 'newcomer1', role: 'ASSOCIATE', status: 'PENDING' },
    errors: [{ status: 409, code: 'CONFLICT', message: '이미 존재하는 값입니다(중복).' }],
    verify: '새 username 으로 가입 → 201, status=PENDING 확인. 같은 username 재가입 → 409',
  }, async (req) => {
    const b = req.body;
    const hash = await bcrypt.hash(b.password, 8);
    const r = await db.query(
      "INSERT INTO members (username, password_hash, name, alias, email, phone, role_id, status) VALUES (?,?,?,?,?,?,1,'PENDING')",
      [b.username, hash, b.name, b.alias || null, b.email || null, b.phone || null]
    );
    await rec.memberHistory(r.insertId, 'STATUS', null, 'PENDING', null, '가입 신청');
    await rec.audit(null, 'MEMBER_REGISTERED', 'member', r.insertId, { username: b.username, via: 'self-register' }, 'SUCCESS', req.ip);
    return { id: r.insertId, username: b.username, role: 'ASSOCIATE', status: 'PENDING' };
  });

  api.post('/login', {
    summary: '로그인 (JWT 토큰 발급)',
    description: '로그인 성공 시 JWT 토큰을 발급한다. 연속 실패 횟수가 설정값 이상이면 계정이 자동 잠금된다. 데모 계정 비밀번호는 모두 pass1234.',
    reqs: ['NFR-03', 'FR-23'], auth: false,
    body: { username, password },
    example: { token: 'eyJhbGciOi...', tokenType: 'Bearer', expiresAt: '2026-10-19T02:00:00.000Z', member: { id: 2, username: 'boss', name: 'Vincenzo Moretti', role: 'BOSS', status: 'ACTIVE' } },
    errors: [401, { status: 429, code: 'TOO_MANY_REQUESTS', message: '로그인 실패가 너무 많습니다. 10분 후 다시 시도하세요.' }],
    verify: 'boss / pass1234 로그인 → token 발급. 틀린 비밀번호 → 401',
  }, async (req) => {
    const { member, ...tok } = await login(req.body.username, req.body.password, req);
    return { ...tok, member: { id: member.id, username: member.username, name: member.name, role: member.role, status: member.status } };
  });

  api.post('/logout', {
    summary: '로그아웃 (현재 토큰 폐기)',
    reqs: ['NFR-03'],
    example: { revoked: true },
    verify: '로그아웃 후 같은 토큰으로 GET /api/me → 401',
  }, async (req) => {
    await mongo.col('revokedTokens').updateOne({ jti: req.user.jti }, { $set: { jti: req.user.jti, memberId: req.user.id, expiresAt: req.user.tokenExp } }, { upsert: true });
    await mongo.col('loginHistory').insertOne({ memberId: req.user.id, username: req.user.username, event: 'LOGOUT', result: 'SUCCESS', ip: req.ip, at: new Date() });
    return { revoked: true };
  });

  api.post('/refresh', {
    summary: '토큰 재발급 (기존 토큰은 폐기)',
    reqs: ['NFR-03'],
    example: { token: 'eyJhbGciOi...', tokenType: 'Bearer', expiresAt: '2026-10-19T02:00:00.000Z' },
  }, async (req) => {
    await mongo.col('revokedTokens').updateOne({ jti: req.user.jti }, { $set: { jti: req.user.jti, memberId: req.user.id, expiresAt: req.user.tokenExp } }, { upsert: true });
    return issue(req.user, req, 'REFRESH');
  });

  api.put('/password', {
    summary: '내 비밀번호 변경 (다른 세션은 모두 만료)',
    reqs: ['FR-01', 'FR-23'],
    body: { currentPassword: { ...password, example: 'pass1234' }, newPassword: { ...password, example: 'newpass5678' } },
    example: { changed: true, token: 'eyJhbGciOi...', tokenType: 'Bearer', expiresAt: '2026-10-19T02:00:00.000Z' },
    errors: [{ status: 401, code: 'UNAUTHORIZED', message: '현재 비밀번호가 올바르지 않습니다.' }],
  }, async (req) => {
    const m = await db.one('SELECT password_hash FROM members WHERE id = ?', [req.user.id]);
    if (!(await bcrypt.compare(req.body.currentPassword, m.passwordHash))) throw E.unauthorized('현재 비밀번호가 올바르지 않습니다.');
    if (req.body.currentPassword === req.body.newPassword) throw E.badRequest('새 비밀번호가 기존 비밀번호와 같습니다.');
    await db.query('UPDATE members SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [await bcrypt.hash(req.body.newPassword, 8), req.user.id]);
    await rec.audit(req.user, 'PASSWORD_CHANGED', 'member', req.user.id, {}, 'SUCCESS', req.ip);
    const fresh = await loadPrincipal(req.user.id);
    return { changed: true, ...(await issue(fresh, req, 'PASSWORD_CHANGED')) };
  });

  api.get('/login-history', {
    summary: '내 로그인/로그아웃 이력 조회',
    reqs: ['FR-02', 'FR-20'],
    query: { result: { type: 'string', enum: ['SUCCESS', 'FAIL'], desc: '결과 필터' } },
    list: { sort: { at: 'at' }, defaultSort: '-at' },
    example: { id: '6710...', event: 'LOGIN', result: 'SUCCESS', ip: '::1', at: '2026-10-18T09:00:00.000Z' },
  }, async (req) => {
    const filter = { memberId: req.user.id };
    if (req.q.result) filter.result = req.q.result;
    const c = mongo.col('loginHistory');
    const [items, total] = await Promise.all([
      c.find(filter, { projection: { jti: 0 } }).sort(req.page.mongoSort).skip(req.page.offset).limit(req.page.size).toArray(),
      c.countDocuments(filter),
    ]);
    return paged(items.map(mongo.out), total, req.page);
  });

  api.get('/permissions', {
    summary: '내 역할, 권한 목록, 관리 범위(Crew) 조회',
    reqs: ['FR-02', 'NFR-03'],
    example: { role: 'CAPO', level: 3, permissions: ['task.create', 'task.assign'], managedCrewIds: [1], scope: 'CREWS' },
  }, async (req) => {
    const managed = await scope.managedCrewIds(req.user);
    return {
      role: req.user.role, level: req.user.level, permissions: [...req.user.perms].sort(),
      managedCrewIds: managed, scope: managed === null ? 'ALL' : managed.length ? 'CREWS' : 'SELF',
    };
  });
};

module.exports.login = login;
