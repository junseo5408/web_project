/** 자원 이상 신고 / 점검 처리 (FR-16, FR-15) */
const db = require('../db/mysql');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const resSvc = require('../services/resources');
const { helpers: resHelpers } = require('./resources');

const EXAMPLE = {
  id: 1, resourceId: 8, resourceCode: 'EQ-001', resourceName: '금고 개폐 장비', resourceStatus: 'NEEDS_INSPECTION', reportedBy: 8, reporterName: 'Paulie Conti',
  severity: 'HIGH', description: '다이얼 잠금 장치 오작동', status: 'OPEN', resolvedBy: null, resolution: null, resolvedAt: null, createdAt: '2026-10-18T00:00:00.000Z',
};
const SELECT = `SELECT i.*, r.code AS resource_code, r.name AS resource_name, r.status AS resource_status, m.name AS reporter_name
  FROM resource_issues i JOIN resources r ON r.id = i.resource_id JOIN members m ON m.id = i.reported_by`;

async function getIssue(id) {
  const i = await db.one(`${SELECT} WHERE i.id = ?`, [id]);
  if (!i) throw E.notFound('자원 이슈', id);
  return i;
}

module.exports = (app) => {
  const r = defineModule(app, { tag: '20. Resource Issues', base: '/api/resources' });

  r.post('/:id/issues', {
    summary: '자원 이상 신고 (정상 자원은 점검 필요 상태로 자동 전환)',
    reqs: ['FR-16', 'FR-15', 'BR-08'], status: 201,
    params: { id: { type: 'integer', example: 1 } },
    body: {
      severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'], default: 'MEDIUM', example: 'MEDIUM' },
      description: { type: 'string', required: true, maxLength: 500, example: '타이어 공기압 경고등 점등' },
    },
    example: { ...EXAMPLE, id: 2, resourceId: 1, resourceCode: 'VH-001', resourceStatus: 'NEEDS_INSPECTION', severity: 'MEDIUM' },
    errors: [403, 404],
  }, async (req) => {
    const res = await resHelpers.getVisibleResource(req.user, req.params.id);
    if (res.status === 'RETIRED') throw E.state('폐기된 자원입니다.');
    const id = await db.tx(async (t) => {
      const ins = await t.query('INSERT INTO resource_issues (resource_id, reported_by, severity, description) VALUES (?,?,?,?)', [res.id, req.user.id, req.body.severity, req.body.description]);
      await rec.resourceHistory(res.id, 'ISSUE_REPORTED', null, null, req.user, { issueId: ins.insertId, severity: req.body.severity });
      if (res.status === 'AVAILABLE') {
        await t.query("UPDATE resources SET status = 'NEEDS_INSPECTION' WHERE id = ?", [res.id]);
        await rec.resourceHistory(res.id, 'STATUS_CHANGED', 'AVAILABLE', 'NEEDS_INSPECTION', req.user, { reason: `이슈 #${ins.insertId} 신고` });
      }
      return ins.insertId;
    });
    return getIssue(id);
  });

  const api = defineModule(app, { tag: '20. Resource Issues', base: '/api/resource-issues' });

  api.get('', {
    summary: '자원 이슈 목록 (상태·심각도·자원)',
    reqs: ['FR-16', 'FR-15'], perm: ['resource.manage', 'resource.allocate'],
    query: { status: { type: 'string', enum: ['OPEN', 'RESOLVED'] }, severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] }, resourceId: { type: 'integer' } },
    list: { sort: { createdAt: 'i.created_at', severity: 'i.severity' }, defaultSort: '-createdAt' },
    example: EXAMPLE,
  }, async (req) => {
    const v = await resHelpers.visibility(req.user);
    const where = [v.sql];
    const params = [...v.params];
    for (const [k, col] of [['status', 'i.status'], ['severity', 'i.severity'], ['resourceId', 'i.resource_id']]) {
      if (req.q[k]) { where.push(`${col} = ?`); params.push(req.q[k]); }
    }
    const w = where.join(' AND ');
    const total = (await db.one(`SELECT COUNT(*) AS n FROM resource_issues i JOIN resources r ON r.id = i.resource_id WHERE ${w}`, params)).n;
    const rows = await db.query(`${SELECT} WHERE ${w} ORDER BY ${req.page.orderBy} LIMIT ? OFFSET ?`, [...params, req.page.size, req.page.offset]);
    return paged(rows, total, req.page);
  });

  api.get('/:id', {
    summary: '자원 이슈 상세',
    reqs: ['FR-16'],
    params: { id: { type: 'integer', example: 1 } },
    example: EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    const i = await getIssue(req.params.id);
    await resHelpers.getVisibleResource(req.user, i.resourceId);
    return i;
  });

  api.post('/:id/resolve', {
    summary: '자원 이슈 해결 처리 (다른 미해결 이슈가 없으면 자원 상태 복구)',
    reqs: ['FR-16', 'FR-15', 'FR-13'], perm: 'resource.manage',
    params: { id: { type: 'integer', example: 1 } },
    body: {
      resolution: { type: 'string', required: true, maxLength: 500, example: '다이얼 교체 완료' },
      restoreStatus: { type: 'string', enum: ['AVAILABLE', 'MAINTENANCE', 'UNAVAILABLE', 'RETIRED'], default: 'AVAILABLE', desc: '해결 후 자원 상태' },
    },
    example: { ...EXAMPLE, status: 'RESOLVED', resolution: '다이얼 교체 완료', resourceStatus: 'AVAILABLE' },
    errors: [403, 404, 422],
  }, async (req) => {
    const i = await getIssue(req.params.id);
    if (i.status !== 'OPEN') throw E.state('이미 해결된 이슈입니다.');
    const res = await resSvc.getResource(i.resourceId);
    await resHelpers.assertManageResource(req.user, res);
    await db.tx(async (t) => {
      await t.query("UPDATE resource_issues SET status = 'RESOLVED', resolved_by = ?, resolution = ?, resolved_at = NOW() WHERE id = ?", [req.user.id, req.body.resolution, i.id]);
      await rec.resourceHistory(res.id, 'ISSUE_RESOLVED', null, null, req.user, { issueId: i.id, resolution: req.body.resolution });
      const open = await t.one("SELECT COUNT(*) AS n FROM resource_issues WHERE resource_id = ? AND status = 'OPEN'", [res.id]);
      const cur = await t.one('SELECT status FROM resources WHERE id = ? FOR UPDATE', [res.id]);
      const target = req.body.restoreStatus;
      if (open.n === 0 && cur.status !== 'IN_USE' && cur.status !== target && (resSvc.MANUAL_TRANSITIONS[cur.status] || []).includes(target)) {
        await t.query('UPDATE resources SET status = ? WHERE id = ?', [target, res.id]);
        await rec.resourceHistory(res.id, 'STATUS_CHANGED', cur.status, target, req.user, { reason: `이슈 #${i.id} 해결` });
      }
    });
    return getIssue(i.id);
  });
};
