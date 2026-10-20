/**
 * 운영 보안 미들웨어
 *  - 보안 응답 헤더
 *  - 로그인 실패 횟수 제한 (IP + 아이디 기준, 무차별 대입 방지)
 *  - 접근 로그
 */
const crypto = require('crypto');
const mongo = require('../db/mongo');
const E = require('./errors');

/** 보안 헤더. Swagger UI 는 자체 스크립트를 쓰므로 CSP 를 적용하지 않는다. */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (!req.path.startsWith('/api-docs')) {
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'");
  }
  res.removeHeader('X-Powered-By');
  next();
}

/**
 * 로그인 무차별 대입 방지: "실패한" 시도만 집계한다 (정상 로그인은 제한하지 않음).
 *  - 같은 IP + 아이디: 10분에 20회 실패 시 차단 (계정 잠금 정책과 별개로 아이디 열거 방지)
 *  - 같은 IP 전체: 10분에 60회 실패 시 차단 (여러 아이디를 대상으로 한 대입 공격 방지)
 */
const LOGIN_WINDOW = 10 * 60 * 1000;
const loginFailures = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of loginFailures) if (v.reset < now) loginFailures.delete(k); }, LOGIN_WINDOW).unref();
const loginKeys = (req, username) => [[`ip:${req.ip}`, 60], [`ip:${req.ip}:${String(username || '').toLowerCase()}`, 20]];
const loginGuard = {
  check(req, username) {
    const now = Date.now();
    for (const [k, max] of loginKeys(req, username)) {
      const e = loginFailures.get(k);
      if (e && e.reset > now && e.count >= max) {
        throw new E.AppError(429, 'TOO_MANY_REQUESTS', `로그인 실패가 너무 많습니다. ${Math.ceil((e.reset - now) / 60000)}분 후 다시 시도하세요.`);
      }
    }
  },
  fail(req, username) {
    const now = Date.now();
    for (const [k] of loginKeys(req, username)) {
      const e = loginFailures.get(k);
      if (!e || e.reset < now) loginFailures.set(k, { count: 1, reset: now + LOGIN_WINDOW });
      else e.count += 1;
    }
  },
};

/** 접근 로그 (정적 파일 제외) */
function accessLog(req, res, next) {
  if (req.path.startsWith('/public') || req.path.startsWith('/vendor') || req.path.startsWith('/api-docs')) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const who = req.user ? req.user.username : '-';
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms ${who}`);
  });
  next();
}

/**
 * JWT 서명 비밀키: 환경변수가 없으면 최초 실행 시 난수로 생성하여 MongoDB 에 보관한다.
 * (서버를 재시작해도 발급된 토큰이 유지되고, 소스 코드에 비밀키가 노출되지 않음)
 */
async function ensureJwtSecret(config) {
  if (process.env.JWT_SECRET) {
    config.jwt.secret = process.env.JWT_SECRET;
    return;
  }
  const col = mongo.col('settings');
  const doc = await col.findOne({ _id: 'secrets' });
  if (doc && doc.jwtSecret) {
    config.jwt.secret = doc.jwtSecret;
    return;
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  await col.updateOne({ _id: 'secrets' }, { $setOnInsert: { jwtSecret: secret, createdAt: new Date() } }, { upsert: true });
  config.jwt.secret = (await col.findOne({ _id: 'secrets' })).jwtSecret;
}

module.exports = { securityHeaders, loginGuard, accessLog, ensureJwtSecret };
