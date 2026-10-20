/**
 * EJS 서버 사이드 렌더링 화면 (CR-02)
 *  - 레이아웃·메뉴는 서버에서 사용자 권한에 맞게 렌더링하고, 권한이 없는 화면은 서버에서 403 으로 차단한다 (NFR-03, BR-09)
 *  - 화면의 데이터 조회/변경은 동일한 REST API 를 호출하므로 업무 규칙이 화면과 API 에 똑같이 적용된다
 */
const mongo = require('../db/mongo');
const config = require('../config');
const ICONS = require('../public/js/icons');
const { authenticate } = require('../lib/auth');
const { registry } = require('../lib/api');
const { login } = require('./auth');

const svg = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

const NAV = [
  { group: '업무', items: [
    { key: 'dashboard', href: '/dashboard', label: '대시보드', icon: 'dashboard' },
    { key: 'tasks', href: '/tasks', label: '업무', icon: 'tasks' },
    { key: 'calendar', href: '/calendar', label: '캘린더', icon: 'calendar' },
    { key: 'meetings', href: '/meetings', label: '회의', icon: 'meeting' },
  ] },
  { group: '조직', items: [
    { key: 'members', href: '/members', label: '구성원', icon: 'users' },
    { key: 'crews', href: '/crews', label: 'Crew', icon: 'crew' },
  ] },
  { group: '자원', items: [
    { key: 'resources', href: '/resources', label: '공용 자원', icon: 'box' },
    { key: 'allocations', href: '/allocations', label: '자원 사용', icon: 'key' },
  ] },
  { group: '결재 · 평가', items: [
    { key: 'approvals', href: '/approvals', label: '요청 · 승인', icon: 'inbox', badge: true },
    { key: 'evaluations', href: '/evaluations', label: '평가 · 평판', icon: 'star' },
  ] },
  { group: '관리', items: [
    { key: 'stats', href: '/stats', label: '운영 현황', icon: 'chart', perm: 'stats.read' },
    { key: 'audit', href: '/audit', label: '감사 로그', icon: 'audit', perm: 'audit.read' },
    { key: 'admin-accounts', href: '/admin/accounts', label: '계정 관리', icon: 'lock', perm: 'account.manage' },
    { key: 'admin-roles', href: '/admin/roles', label: '권한 관리', icon: 'shield', perm: 'permission.manage' },
    { key: 'admin-system', href: '/admin/system', label: '시스템 설정', icon: 'settings', perm: 'system.manage' },
  ] },
  { group: '개발자', items: [
    { key: 'api-docs', href: '/api-docs', label: 'API 문서 (Swagger)', icon: 'code', external: true },
    { key: 'catalog', href: '/catalog', label: '요구사항 추적표', icon: 'book', external: true },
  ] },
];

const PAGES = [
  { path: '/dashboard', page: 'dashboard', title: '대시보드', section: '업무', chart: true },
  { path: '/tasks', page: 'tasks', title: '업무', section: '업무' },
  { path: '/tasks/:id', page: 'task-detail', title: '업무 상세', section: '업무', nav: 'tasks' },
  { path: '/calendar', page: 'calendar', title: '캘린더', section: '업무' },
  { path: '/meetings', page: 'meetings', title: '회의', section: '업무' },
  { path: '/members', page: 'members', title: '구성원', section: '조직' },
  { path: '/members/:id', page: 'member-detail', title: '구성원 상세', section: '조직', nav: 'members' },
  { path: '/crews', page: 'crews', title: 'Crew', section: '조직' },
  { path: '/crews/:id', page: 'crew-detail', title: 'Crew 상세', section: '조직', nav: 'crews', chart: true },
  { path: '/resources', page: 'resources', title: '공용 자원', section: '자원' },
  { path: '/resources/:id', page: 'resource-detail', title: '자원 상세', section: '자원', nav: 'resources' },
  { path: '/allocations', page: 'allocations', title: '자원 사용', section: '자원' },
  { path: '/approvals', page: 'approvals', title: '요청 · 승인', section: '결재 · 평가' },
  { path: '/evaluations', page: 'evaluations', title: '평가 · 평판', section: '결재 · 평가' },
  { path: '/stats', page: 'stats', title: '운영 현황', section: '관리', perm: 'stats.read', chart: true },
  { path: '/audit', page: 'audit', title: '감사 로그', section: '관리', perm: 'audit.read' },
  { path: '/admin/accounts', page: 'admin-accounts', title: '계정 관리', section: '관리', perm: 'account.manage' },
  { path: '/admin/roles', page: 'admin-roles', title: '권한 관리', section: '관리', perm: 'permission.manage' },
  { path: '/admin/system', page: 'admin-system', title: '시스템 설정', section: '관리', perm: 'system.manage' },
  { path: '/notifications', page: 'notifications', title: '알림', section: '내 정보' },
  { path: '/me', page: 'me', title: '내 정보', section: '내 정보' },
];

/** 페이지 인증: 실패 시 로그인 화면으로 이동 */
function pageAuth(req, res, next) {
  authenticate(req, res, (err) => {
    if (err) {
      res.clearCookie('token');
      const q = new URLSearchParams({ next: req.originalUrl });
      if (req.cookies && req.cookies.token) q.set('error', err.message);
      return res.redirect(`/login?${q}`);
    }
    next();
  });
}

const hasAny = (user, perm) => [].concat(perm).some((p) => user.perms.has(p));

function renderShell(req, res, def, { params = {}, error = null, status = 200 } = {}) {
  const u = req.user;
  const nav = NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.perm || hasAny(u, i.perm)) })).filter((g) => g.items.length);
  const appData = {
    user: { id: u.id, username: u.username, name: u.name, role: u.role, level: u.level, status: u.status, crewId: u.crewId, perms: [...u.perms].sort() },
    page: def.page, params, demoMode: config.demoMode,
  };
  res.status(status).render('layout', {
    def, nav, user: u, error, icon: svg,
    appDataJson: JSON.stringify(appData).replace(/</g, '\\u003c'),
  });
}

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/login') ? n : '/dashboard');

const REQ_GROUPS = [
  ['기능 요구사항', 'FR', 23], ['업무 규칙', 'BR', 10], ['데이터 요구사항', 'DR', 6],
];

module.exports = (app) => {
  app.get('/', (req, res) => res.redirect('/dashboard'));

  app.get('/login', (req, res) => {
    res.render('login', { error: req.query.error || null, next: safeNext(req.query.next), demoMode: config.demoMode, username: '', icon: svg });
  });

  app.post('/login', async (req, res) => {
    const { username = '', password = '' } = req.body || {};
    const next = safeNext(req.body && req.body.next);
    try {
      if (!username || !password) throw new Error('아이디와 비밀번호를 입력하세요.');
      const r = await login(String(username), String(password), req); // REST 로그인과 동일한 로직 재사용
      res.cookie('token', r.token, { httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600 * 1000 });
      res.redirect(next);
    } catch (e) {
      res.status(401).render('login', { error: e.message, next, demoMode: config.demoMode, username: String(username).slice(0, 30), icon: svg });
    }
  });

  app.get('/logout', pageAuth, async (req, res) => {
    await mongo.col('revokedTokens').updateOne({ jti: req.user.jti }, { $set: { jti: req.user.jti, memberId: req.user.id, expiresAt: req.user.tokenExp } }, { upsert: true });
    await mongo.col('loginHistory').insertOne({ memberId: req.user.id, username: req.user.username, event: 'LOGOUT', result: 'SUCCESS', ip: req.ip, at: new Date() });
    res.clearCookie('token');
    res.redirect('/login');
  });

  for (const def of PAGES) {
    app.get(def.path, pageAuth, (req, res) => {
      if (def.perm && !hasAny(req.user, def.perm)) {
        return renderShell(req, res, { ...def, page: null }, { status: 403, error: { code: 403, title: '접근 권한이 없습니다', message: `이 화면은 ${def.perm} 권한이 필요합니다. 현재 역할: ${req.user.role}` } });
      }
      if (req.params.id !== undefined && !/^\d+$/.test(req.params.id)) {
        return renderShell(req, res, { ...def, page: null }, { status: 404, error: { code: 404, title: '페이지를 찾을 수 없습니다', message: '잘못된 주소입니다.' } });
      }
      renderShell(req, res, { nav: def.page, ...def }, { params: req.params.id ? { id: Number(req.params.id) } : {} });
    });
  }

  /* 요구사항 추적표 (공개, 개발자용) */
  app.get('/catalog', (req, res) => {
    const tags = [...new Set(registry.map((e) => e.tag))];
    const byReq = {};
    for (const e of registry) for (const r of e.reqs || []) (byReq[r] = byReq[r] || []).push(e);
    const groups = REQ_GROUPS.map(([label, prefix, n]) => [label, Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`)]);
    res.render('catalog', { registry, tags, byReq, groups });
  });

  /* 존재하지 않는 화면 */
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || !req.accepts('html')) return next();
    res.status(404).render('error', { status: 404, code: 'NOT_FOUND', message: '요청한 페이지를 찾을 수 없습니다.' });
  });
};
