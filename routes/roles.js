/** 역할 / 권한 관리 (FR-23, BR-09, DR-01) */
const db = require('../db/mysql');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule } = require('../lib/api');
const { invalidatePermCache } = require('../lib/auth');

const roleCode = { type: 'string', enum: ['ASSOCIATE', 'SOLDIER', 'CAPO', 'UNDERBOSS', 'BOSS', 'ADMINISTRATOR'], example: 'CAPO' };
const PROTECTED = { ADMINISTRATOR: ['permission.manage', 'account.manage', 'system.manage'] };

async function getRole(code) {
  const r = await db.one('SELECT * FROM roles WHERE code = ?', [code]);
  if (!r) throw E.notFound('역할', code);
  return r;
}
const rolePerms = async (roleId) => (await db.query('SELECT permission_code FROM role_permissions WHERE role_id = ? ORDER BY permission_code', [roleId])).map((r) => r.permissionCode);

async function assertPermExists(codes) {
  const rows = await db.query('SELECT code FROM permissions WHERE code IN (?)', [codes.length ? codes : ['']]);
  const missing = codes.filter((c) => !rows.some((r) => r.code === c));
  if (missing.length) throw E.badRequest('존재하지 않는 권한 코드가 있습니다.', { missing });
}

function assertNotProtected(role, removed) {
  const locked = (PROTECTED[role.code] || []).filter((p) => removed.includes(p));
  if (locked.length) throw E.state(`${role.code} 역할의 필수 권한은 제거할 수 없습니다(관리 기능 잠김 방지).`, { locked });
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '03. Roles & Permissions', base: '/api/roles' });

  api.get('', {
    summary: '역할 목록 (권한 등급 및 역할별 인원 수)',
    reqs: ['FR-23', 'DR-01'],
    example: { id: 3, code: 'CAPO', name: 'Capo', level: 3, description: 'Crew 책임자', memberCount: 3, permissionCount: 16 },
  }, async () => db.query(
    `SELECT r.*, (SELECT COUNT(*) FROM members m WHERE m.role_id = r.id AND m.status <> 'WITHDRAWN') AS member_count,
            (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count
       FROM roles r ORDER BY r.level`
  ));

  api.get('/:code', {
    summary: '역할 상세 (상태별 인원 분포 포함)',
    reqs: ['FR-23', 'DR-01'],
    params: { code: roleCode },
    example: { id: 3, code: 'CAPO', name: 'Capo', level: 3, membersByStatus: { ACTIVE: 3 } },
    errors: [404],
  }, async (req) => {
    const role = await getRole(req.params.code);
    const rows = await db.query('SELECT status, COUNT(*) AS n FROM members WHERE role_id = ? GROUP BY status', [role.id]);
    return { ...role, membersByStatus: Object.fromEntries(rows.map((r) => [r.status, r.n])) };
  });

  api.get('/:code/permissions', {
    summary: '역할의 권한 매트릭스 (전체 권한 중 부여 여부)',
    reqs: ['FR-23', 'BR-09'],
    params: { code: roleCode },
    example: { role: 'CAPO', permissions: [{ code: 'task.create', category: 'TASK', description: '업무 등록/복제/삭제', granted: true }] },
    errors: [404],
  }, async (req) => {
    const role = await getRole(req.params.code);
    const granted = await rolePerms(role.id);
    const all = await db.query('SELECT * FROM permissions ORDER BY category, code');
    return { role: role.code, permissions: all.map((p) => ({ ...p, granted: granted.includes(p.code) })) };
  });

  api.put('/:code/permissions', {
    summary: '역할의 권한 집합 전체 교체',
    reqs: ['FR-23', 'FR-20'], perm: 'permission.manage',
    params: { code: roleCode },
    body: { permissions: { type: 'array', required: true, items: 'string', example: ['task.create', 'task.update', 'task.assign'] } },
    example: { role: 'CAPO', added: ['task.assign'], removed: ['meeting.manage'], permissions: ['task.create', 'task.update', 'task.assign'] },
    errors: [404, 422],
  }, async (req) => {
    const role = await getRole(req.params.code);
    const next = [...new Set(req.body.permissions)];
    await assertPermExists(next);
    const prev = await rolePerms(role.id);
    const removed = prev.filter((p) => !next.includes(p));
    const added = next.filter((p) => !prev.includes(p));
    assertNotProtected(role, removed);
    await db.tx(async (t) => {
      await t.query('DELETE FROM role_permissions WHERE role_id = ?', [role.id]);
      if (next.length) await t.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ?', [next.map((p) => [role.id, p])]);
    });
    invalidatePermCache();
    await rec.audit(req.user, 'ROLE_PERMISSIONS_REPLACED', 'role', role.code, { added, removed }, 'SUCCESS', req.ip);
    return { role: role.code, added, removed, permissions: next.sort() };
  });

  api.post('/:code/permissions', {
    summary: '역할에 권한 1개 부여',
    reqs: ['FR-23', 'FR-20'], perm: 'permission.manage', status: 201,
    params: { code: roleCode },
    body: { permission: { type: 'string', required: true, example: 'stats.read' } },
    example: { role: 'CAPO', granted: 'stats.read' },
    errors: [404, 409],
  }, async (req) => {
    const role = await getRole(req.params.code);
    await assertPermExists([req.body.permission]);
    if ((await rolePerms(role.id)).includes(req.body.permission)) throw E.conflict('이미 부여된 권한입니다.');
    await db.query('INSERT INTO role_permissions (role_id, permission_code) VALUES (?, ?)', [role.id, req.body.permission]);
    invalidatePermCache();
    await rec.audit(req.user, 'PERMISSION_GRANTED', 'role', role.code, { permission: req.body.permission }, 'SUCCESS', req.ip);
    return { role: role.code, granted: req.body.permission };
  });

  api.delete('/:code/permissions/:permission', {
    summary: '역할에서 권한 1개 회수',
    reqs: ['FR-23', 'FR-20'], perm: 'permission.manage',
    params: { code: roleCode, permission: { type: 'string', example: 'stats.read' } },
    example: { role: 'CAPO', revoked: 'stats.read' },
    errors: [404, 422],
  }, async (req) => {
    const role = await getRole(req.params.code);
    assertNotProtected(role, [req.params.permission]);
    const r = await db.query('DELETE FROM role_permissions WHERE role_id = ? AND permission_code = ?', [role.id, req.params.permission]);
    if (!r.affectedRows) throw E.notFound('부여된 권한', req.params.permission);
    invalidatePermCache();
    await rec.audit(req.user, 'PERMISSION_REVOKED', 'role', role.code, { permission: req.params.permission }, 'SUCCESS', req.ip);
    return { role: role.code, revoked: req.params.permission };
  });

  const perms = defineModule(app, { tag: '03. Roles & Permissions', base: '/api/permissions' });
  perms.get('', {
    summary: '전체 권한 코드 목록 (각 권한을 보유한 역할 포함)',
    reqs: ['FR-23', 'BR-09'],
    query: { category: { type: 'string', enum: ['MEMBER', 'CREW', 'TASK', 'RESOURCE', 'EVALUATION', 'ADMIN'] } },
    example: { code: 'task.create', category: 'TASK', description: '업무 등록/복제/삭제', roles: ['CAPO', 'UNDERBOSS', 'BOSS'] },
  }, async (req) => {
    const rows = await db.query(
      `SELECT p.code, p.category, p.description, GROUP_CONCAT(r.code ORDER BY r.level) AS roles
         FROM permissions p LEFT JOIN role_permissions rp ON rp.permission_code = p.code LEFT JOIN roles r ON r.id = rp.role_id
        WHERE (? IS NULL OR p.category = ?) GROUP BY p.code, p.category, p.description ORDER BY p.category, p.code`,
      [req.q.category || null, req.q.category || null]
    );
    return rows.map((r) => ({ ...r, roles: r.roles ? r.roles.split(',') : [] }));
  });
};
