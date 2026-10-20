/**
 * 인증 / 권한 검사 미들웨어 (BR-09, NFR-03)
 *  - 모든 보호 API는 서버 측에서 JWT 검증 후, DB에서 최신 계정 상태/역할/권한을 다시 읽어 판단한다.
 *    (화면에서 버튼을 숨기는 것과 무관하게 URL 직접 호출도 차단)
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const E = require('./errors');

const ROLE_LEVEL = { ASSOCIATE: 1, SOLDIER: 2, CAPO: 3, UNDERBOSS: 4, BOSS: 5, ADMINISTRATOR: 6 };

/* 역할별 권한 캐시 (권한 변경 시 invalidate) */
let permCache = null;
async function rolePermissions(roleCode) {
  if (!permCache) {
    permCache = new Map();
    const rows = await db.query(
      'SELECT r.code AS role_code, rp.permission_code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id'
    );
    for (const r of rows) {
      if (!permCache.has(r.roleCode)) permCache.set(r.roleCode, new Set());
      permCache.get(r.roleCode).add(r.permissionCode);
    }
  }
  return permCache.get(roleCode) || new Set();
}
const invalidatePermCache = () => { permCache = null; };

function signToken(member) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ sub: member.id, tv: member.tokenVersion, role: member.role }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
    jwtid: jti,
  });
  const { exp } = jwt.decode(token);
  return { token, jti, expiresAt: new Date(exp * 1000) };
}

async function loadPrincipal(memberId) {
  const user = await db.one(
    `SELECT m.id, m.username, m.name, m.alias, m.status, m.is_locked, m.token_version,
            r.code AS role, r.level, r.name AS role_name
       FROM members m JOIN roles r ON r.id = m.role_id WHERE m.id = ?`,
    [memberId]
  );
  if (!user) return null;
  const crews = await db.query(
    'SELECT crew_id, membership_type FROM crew_memberships WHERE member_id = ? AND left_at IS NULL',
    [memberId]
  );
  user.crewId = (crews.find((c) => c.membershipType === 'FORMAL') || {}).crewId || null;
  user.affiliateCrewIds = crews.filter((c) => c.membershipType === 'AFFILIATE').map((c) => c.crewId);
  user.perms = await rolePermissions(user.role);
  return user;
}

// 정지/대기(가입 승인 전) 상태 계정이 수행할 수 있는 쓰기 작업
const RESTRICTED_ALLOW = [/^\/api\/auth\//, /^\/api\/me\/notifications/, /^\/api\/crews\/\d+\/join-requests$/, /^\/api\/join-requests\/\d+$/];

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const fromHeader = header.startsWith('Bearer ');
    const token = fromHeader ? header.slice(7).trim() : req.cookies && req.cookies.token;
    if (!token) throw E.unauthorized('인증 토큰이 필요합니다. POST /api/auth/login 으로 로그인하세요.');
    // CSRF 방어: 쿠키로 인증된 변경 요청은 웹 화면이 보내는 X-Requested-With 헤더가 있어야 한다
    // (다른 사이트의 form 전송은 이 헤더를 붙일 수 없음)
    if (!fromHeader && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'XMLHttpRequest') {
      throw new E.AppError(403, 'CSRF_REJECTED', '허용되지 않은 요청 출처입니다.');
    }

    let payload;
    try {
      payload = jwt.verify(token, config.jwt.secret);
    } catch (e) {
      throw E.unauthorized('토큰이 유효하지 않거나 만료되었습니다.');
    }
    if (await mongo.col('revokedTokens').findOne({ jti: payload.jti })) {
      throw E.unauthorized('로그아웃된 토큰입니다. 다시 로그인하세요.');
    }
    const user = await loadPrincipal(payload.sub);
    if (!user) throw E.unauthorized('계정이 존재하지 않습니다.');
    if (user.tokenVersion !== payload.tv) throw E.unauthorized('세션이 만료되었습니다(강제 로그아웃 또는 비밀번호 변경). 다시 로그인하세요.');
    if (user.isLocked) throw E.unauthorized('잠긴 계정입니다. 관리자에게 문의하세요.');
    if (user.status === 'WITHDRAWN') throw E.unauthorized('탈퇴 처리된 계정입니다.');

    if (['SUSPENDED', 'PENDING'].includes(user.status) && req.method !== 'GET' && !RESTRICTED_ALLOW.some((r) => r.test(req.path))) {
      throw E.forbidden(`계정 상태(${user.status})에서는 이 작업을 수행할 수 없습니다.`, 'FR-04');
    }
    user.jti = payload.jti;
    user.tokenExp = new Date(payload.exp * 1000);
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

/** 권한 코드 중 하나라도 보유해야 통과 */
function requirePerm(perm) {
  const list = [].concat(perm);
  return (req, res, next) => {
    if (list.some((p) => req.user.perms.has(p))) return next();
    next(E.forbidden(`권한(${list.join(' 또는 ')})이 필요합니다. 현재 역할: ${req.user.role}`, 'BR-09'));
  };
}

const hasPerm = (user, perm) => user.perms.has(perm);

module.exports = { ROLE_LEVEL, authenticate, requirePerm, hasPerm, signToken, loadPrincipal, invalidatePermCache };
