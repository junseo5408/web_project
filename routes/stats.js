/** 운영 현황 / 통계 (FR-22, FR-11) : Underboss 는 감독 Crew 범위, Boss/Admin 은 전체 */
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const E = require('../lib/errors');
const { defineModule } = require('../lib/api');
const scope = require('../services/scope');

const period = {
  from: { type: 'datetime', desc: '기간 시작 (기본: 90일 전)', example: '2026-07-01T00:00:00Z' },
  to: { type: 'datetime', desc: '기간 종료 (기본: 현재)', example: '2026-12-31T00:00:00Z' },
  crewId: { type: 'integer', desc: '특정 Crew 로 한정' },
};

/** 통계 대상 Crew 범위 결정 */
async function crewScope(user, crewId) {
  const managed = await scope.managedCrewIds(user);
  if (crewId) {
    if (managed !== null && !managed.includes(crewId)) throw E.forbidden(`Crew(id=${crewId}) 통계 조회 권한이 없습니다.`);
    return [crewId];
  }
  return managed;
}
const crewCond = (ids, col) => (ids === null ? { sql: '1=1', params: [] } : ids.length ? { sql: `${col} IN (?)`, params: [ids] } : { sql: '1=0', params: [] });
const range = (q) => ({ from: q.from || new Date(Date.now() - 90 * 86400000), to: q.to || new Date() });
const toMap = (rows, k = 'k') => Object.fromEntries(rows.map((r) => [r[k], r.n]));
async function scopedMemberIds(crews) {
  if (crews === null) return null;
  if (!crews.length) return [];
  return (await db.query('SELECT DISTINCT member_id FROM crew_memberships WHERE left_at IS NULL AND crew_id IN (?)', [crews])).map((r) => r.memberId);
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '24. Statistics', base: '/api/stats' });

  api.get('/overview', {
    summary: '운영 현황 요약 (KPI 대시보드)',
    reqs: ['FR-22'], perm: 'stats.read',
    query: { crewId: period.crewId },
    example: {
      members: { total: 18, active: 14, suspended: 1 }, crews: 3,
      tasks: { open: 5, overdue: 0, inProgress: 1, completedLast30Days: 3 },
      resources: { total: 9, available: 5, blocked: 3, inUse: 1 }, openIssues: 1, pendingRequests: { resource: 1, promotion: 1, join: 1 },
    },
  }, async (req) => {
    const crews = await crewScope(req.user, req.q.crewId);
    const mc = crewCond(crews, 'cm.crew_id');
    const tc = crewCond(crews, 't.crew_id');
    const rc = crewCond(crews, 'r.crew_id');
    const [m, cr, t, r, issues, rr, pr, jr] = await Promise.all([
      db.one(`SELECT COUNT(DISTINCT m.id) AS total, COUNT(DISTINCT IF(m.status='ACTIVE', m.id, NULL)) AS active, COUNT(DISTINCT IF(m.status='SUSPENDED', m.id, NULL)) AS suspended,
                     COUNT(DISTINCT IF(m.status='PENDING', m.id, NULL)) AS pending
                FROM members m ${crews === null ? 'LEFT' : ''} JOIN crew_memberships cm ON cm.member_id = m.id AND cm.left_at IS NULL WHERE m.status <> 'WITHDRAWN' AND ${mc.sql}`, mc.params),
      db.one(`SELECT COUNT(*) AS n FROM crews c WHERE c.status = 'ACTIVE' AND ${crewCond(crews, 'c.id').sql}`, crewCond(crews, 'c.id').params),
      db.one(`SELECT SUM(t.status IN ('PLANNED','IN_PROGRESS','ON_HOLD')) AS open, SUM(t.status = 'IN_PROGRESS') AS in_progress,
                     SUM(t.status IN ('PLANNED','IN_PROGRESS','ON_HOLD') AND t.end_at < NOW()) AS overdue,
                     SUM(t.status = 'COMPLETED' AND t.completed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS completed_last30_days
                FROM tasks t WHERE ${tc.sql}`, tc.params),
      db.one(`SELECT COUNT(*) AS total, SUM(r.status='AVAILABLE') AS available, SUM(r.status='IN_USE') AS in_use,
                     SUM(r.status IN ('NEEDS_INSPECTION','MAINTENANCE','UNAVAILABLE')) AS blocked
                FROM resources r WHERE r.status <> 'RETIRED' AND ${crews === null ? '1=1' : `(r.crew_id IS NULL OR ${rc.sql})`}`, rc.params),
      db.one("SELECT COUNT(*) AS n FROM resource_issues WHERE status = 'OPEN'"),
      db.one("SELECT COUNT(*) AS n FROM resource_requests WHERE status = 'PENDING'"),
      db.one("SELECT COUNT(*) AS n FROM promotion_requests WHERE status = 'PENDING'"),
      db.one(`SELECT COUNT(*) AS n FROM crew_join_requests j WHERE j.status = 'PENDING' AND ${crewCond(crews, 'j.crew_id').sql}`, crewCond(crews, 'j.crew_id').params),
    ]);
    const num = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v || 0)]));
    return {
      scope: crews === null ? 'ALL' : crews,
      members: num(m), crews: cr.n, tasks: num(t), resources: num(r), openIssues: issues.n,
      pendingRequests: { resource: rr.n, promotion: pr.n, join: jr.n },
    };
  });

  api.get('/members', {
    summary: '구성원 현황 (상태별·역할별·Crew별 분포)',
    reqs: ['FR-22', 'FR-04'], perm: 'stats.read',
    query: { crewId: period.crewId },
    example: { byStatus: { ACTIVE: 14, STANDBY: 1, SUSPENDED: 1 }, byRole: { SOLDIER: 8, CAPO: 3 }, byCrew: [{ crewId: 1, crewName: 'Brooklyn Crew', ACTIVE: 4, SUSPENDED: 1, total: 5 }], unaffiliated: 4 },
  }, async (req) => {
    const crews = await crewScope(req.user, req.q.crewId);
    const c = crewCond(crews, 'cm.crew_id');
    const join = `FROM members m JOIN roles r ON r.id = m.role_id ${crews === null ? 'LEFT' : ''} JOIN crew_memberships cm ON cm.member_id = m.id AND cm.left_at IS NULL AND cm.membership_type = 'FORMAL' WHERE ${c.sql}`;
    const [byStatus, byRole, byCrew, unaff] = await Promise.all([
      db.query(`SELECT m.status AS k, COUNT(*) AS n ${join} GROUP BY m.status`, c.params),
      db.query(`SELECT r.code AS k, COUNT(*) AS n ${join} AND m.status <> 'WITHDRAWN' GROUP BY r.code, r.level ORDER BY r.level`, c.params),
      db.query(`SELECT cm.crew_id, cr.name AS crew_name, m.status, COUNT(*) AS n FROM crew_memberships cm JOIN members m ON m.id = cm.member_id JOIN crews cr ON cr.id = cm.crew_id
                 WHERE cm.left_at IS NULL AND cm.membership_type = 'FORMAL' AND ${c.sql} GROUP BY cm.crew_id, cr.name, m.status`, c.params),
      crews === null ? db.one("SELECT COUNT(*) AS n FROM members m WHERE m.status <> 'WITHDRAWN' AND NOT EXISTS (SELECT 1 FROM crew_memberships x WHERE x.member_id = m.id AND x.left_at IS NULL AND x.membership_type = 'FORMAL')") : { n: null },
    ]);
    const crewsOut = new Map();
    for (const r of byCrew) {
      if (!crewsOut.has(r.crewId)) crewsOut.set(r.crewId, { crewId: r.crewId, crewName: r.crewName, total: 0 });
      const o = crewsOut.get(r.crewId);
      o[r.status] = r.n;
      o.total += r.n;
    }
    return { byStatus: toMap(byStatus), byRole: toMap(byRole), byCrew: [...crewsOut.values()], unaffiliated: unaff.n };
  });

  api.get('/crews', {
    summary: 'Crew 별 운영 비교 (인원, 업무 완료율, 성공률, 평균 기여도, 성과값)',
    reqs: ['FR-22', 'FR-11'], perm: 'stats.read',
    query: { from: period.from, to: period.to },
    example: [{ crewId: 1, crewName: 'Brooklyn Crew', members: 5, tasksTotal: 9, completed: 6, cancelled: 1, completionRate: 85.7, successRate: 66.7, avgContribution: 72.3, totalValue: 45500 }],
  }, async (req) => {
    const crews = await crewScope(req.user);
    const { from, to } = range(req.q);
    const c = crewCond(crews, 'c.id');
    const rows = await db.query(
      `SELECT c.id AS crew_id, c.name AS crew_name,
              (SELECT COUNT(*) FROM crew_memberships cm WHERE cm.crew_id = c.id AND cm.left_at IS NULL AND cm.membership_type = 'FORMAL') AS members,
              COUNT(t.id) AS tasks_total, SUM(t.status = 'COMPLETED') AS completed, SUM(t.status = 'CANCELLED') AS cancelled,
              SUM(t.result_outcome = 'SUCCESS') AS success, COALESCE(SUM(t.result_value), 0) AS total_value,
              (SELECT AVG(a.contribution) FROM task_assignments a JOIN tasks t2 ON t2.id = a.task_id WHERE t2.crew_id = c.id AND t2.start_at BETWEEN ? AND ?) AS avg_contribution
         FROM crews c LEFT JOIN tasks t ON t.crew_id = c.id AND t.start_at BETWEEN ? AND ?
        WHERE c.status = 'ACTIVE' AND ${c.sql} GROUP BY c.id, c.name ORDER BY c.id`, [from, to, from, to, ...c.params]
    );
    return rows.map((r) => {
      const completed = Number(r.completed || 0);
      const closed = completed + Number(r.cancelled || 0);
      return {
        crewId: r.crewId, crewName: r.crewName, members: r.members, tasksTotal: r.tasksTotal, completed, cancelled: Number(r.cancelled || 0),
        completionRate: closed ? Math.round((completed / closed) * 1000) / 10 : null,
        successRate: completed ? Math.round((Number(r.success) / completed) * 1000) / 10 : null,
        avgContribution: r.avgContribution === null ? null : Math.round(Number(r.avgContribution) * 10) / 10,
        totalValue: Number(r.totalValue),
      };
    });
  });

  api.get('/tasks', {
    summary: '업무 현황 (기간 내 상태별·우선순위별·결과별 분포)',
    reqs: ['FR-22', 'FR-12', 'FR-11'], perm: 'stats.read',
    query: period,
    example: { period: { from: '2026-07-20T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z' }, total: 24, byStatus: { COMPLETED: 17, PLANNED: 4 }, byPriority: { HIGH: 6, NORMAL: 12 }, byOutcome: { SUCCESS: 11, PARTIAL: 4, FAILURE: 2 }, avgDurationHours: 4.1 },
  }, async (req) => {
    const crews = await crewScope(req.user, req.q.crewId);
    const { from, to } = range(req.q);
    const c = crewCond(crews, 't.crew_id');
    const base = `FROM tasks t WHERE t.start_at BETWEEN ? AND ? AND ${c.sql}`;
    const params = [from, to, ...c.params];
    const [byStatus, byPriority, byOutcome, agg] = await Promise.all([
      db.query(`SELECT t.status AS k, COUNT(*) AS n ${base} GROUP BY t.status`, params),
      db.query(`SELECT t.priority AS k, COUNT(*) AS n ${base} GROUP BY t.priority`, params),
      db.query(`SELECT t.result_outcome AS k, COUNT(*) AS n ${base} AND t.status = 'COMPLETED' GROUP BY t.result_outcome`, params),
      db.one(`SELECT COUNT(*) AS total, AVG(TIMESTAMPDIFF(MINUTE, t.start_at, t.end_at)) / 60 AS avg_hours ${base}`, params),
    ]);
    return {
      period: { from, to }, total: agg.total, byStatus: toMap(byStatus), byPriority: toMap(byPriority), byOutcome: toMap(byOutcome),
      avgDurationHours: agg.avgHours === null ? null : Math.round(Number(agg.avgHours) * 10) / 10,
    };
  });

  api.get('/tasks/trend', {
    summary: '업무 추이 (일/주/월 단위 생성·완료 건수 시계열)',
    reqs: ['FR-22'], perm: 'stats.read',
    query: { ...period, interval: { type: 'string', enum: ['day', 'week', 'month'], default: 'week' } },
    example: [{ bucket: '2026-W40', created: 3, completed: 2 }],
  }, async (req) => {
    const crews = await crewScope(req.user, req.q.crewId);
    const { from, to } = range(req.q);
    const c = crewCond(crews, 'crew_id');
    const fmt = { day: '%Y-%m-%d', week: '%x-W%v', month: '%Y-%m' }[req.q.interval];
    const [created, completed] = await Promise.all([
      db.query(`SELECT DATE_FORMAT(created_at, '${fmt}') AS k, COUNT(*) AS n FROM tasks WHERE created_at BETWEEN ? AND ? AND ${c.sql} GROUP BY k`, [from, to, ...c.params]),
      db.query(`SELECT DATE_FORMAT(completed_at, '${fmt}') AS k, COUNT(*) AS n FROM tasks WHERE status = 'COMPLETED' AND completed_at BETWEEN ? AND ? AND ${c.sql} GROUP BY k`, [from, to, ...c.params]),
    ]);
    const keys = [...new Set([...created, ...completed].map((r) => r.k))].sort();
    const cm = toMap(created);
    const dm = toMap(completed);
    return keys.map((k) => ({ bucket: k, created: cm[k] || 0, completed: dm[k] || 0 }));
  });

  api.get('/members/workload', {
    summary: '구성원별 업무량 (기간 내 배정 건수·배정 시간·진행중 업무)',
    reqs: ['FR-22', 'FR-08', 'BR-03'], perm: 'stats.read',
    query: { ...period, limit: { type: 'integer', min: 1, max: 100, default: 20 } },
    example: [{ memberId: 8, name: 'Paulie Conti', crewName: 'Brooklyn Crew', assignments: 7, hours: 31, openAssignments: 1 }],
  }, async (req) => {
    const crews = await crewScope(req.user, req.q.crewId);
    const { from, to } = range(req.q);
    const c = crewCond(crews, 'cm.crew_id');
    return db.query(
      `SELECT m.id AS member_id, m.name, cr.name AS crew_name, COUNT(t.id) AS assignments,
              ROUND(COALESCE(SUM(TIMESTAMPDIFF(MINUTE, t.start_at, t.end_at)), 0) / 60, 1) AS hours,
              SUM(t.status IN ('PLANNED','IN_PROGRESS','ON_HOLD')) AS open_assignments
         FROM members m JOIN crew_memberships cm ON cm.member_id = m.id AND cm.left_at IS NULL AND cm.membership_type = 'FORMAL'
         JOIN crews cr ON cr.id = cm.crew_id
         LEFT JOIN task_assignments a ON a.member_id = m.id AND a.status IN ('ASSIGNED','ACCEPTED')
         LEFT JOIN tasks t ON t.id = a.task_id AND t.start_at BETWEEN ? AND ?
        WHERE m.status IN ('ACTIVE','STANDBY') AND ${c.sql}
        GROUP BY m.id, m.name, cr.name ORDER BY hours DESC, assignments DESC LIMIT ?`, [from, to, ...c.params, req.q.limit]
    );
  });

  api.get('/resources/utilization', {
    summary: '자원 가동률 (기간 대비 배정·사용 시간 비율)',
    reqs: ['FR-22', 'FR-15'], perm: 'stats.read',
    query: { from: period.from, to: period.to, type: { type: 'string', example: 'VEHICLE' } },
    example: [{ resourceId: 1, code: 'VH-001', name: '검정 세단', status: 'AVAILABLE', allocations: 3, allocatedHours: 9, utilizationRate: 0.4 }],
  }, async (req) => {
    const { from, to } = range(req.q);
    const totalHours = (to - from) / 3600000;
    const rows = await db.query(
      `SELECT r.id AS resource_id, r.code, r.name, r.status, COUNT(a.id) AS allocations,
              COALESCE(SUM(TIMESTAMPDIFF(MINUTE, GREATEST(a.start_at, ?), LEAST(a.end_at, ?))), 0) / 60 AS allocated_hours
         FROM resources r JOIN resource_types rt ON rt.id = r.type_id
         LEFT JOIN resource_allocations a ON a.resource_id = r.id AND a.status IN ('RESERVED','IN_USE','RETURNED') AND a.start_at < ? AND a.end_at > ?
        WHERE r.status <> 'RETIRED' ${req.q.type ? 'AND rt.code = ?' : ''}
        GROUP BY r.id, r.code, r.name, r.status ORDER BY allocated_hours DESC`, [from, to, to, from, ...(req.q.type ? [req.q.type] : [])]
    );
    return rows.map((r) => ({ ...r, allocatedHours: Math.round(Number(r.allocatedHours) * 10) / 10, utilizationRate: Math.round((Number(r.allocatedHours) / totalHours) * 10000) / 100 }));
  });

  api.get('/resources/issues', {
    summary: '자원 이슈 통계 (심각도·상태·유형별, 평균 해결 시간)',
    reqs: ['FR-22', 'FR-16'], perm: 'stats.read',
    query: { from: period.from, to: period.to },
    example: { bySeverity: { HIGH: 2, MEDIUM: 1 }, byStatus: { OPEN: 1, RESOLVED: 2 }, byType: { VEHICLE: 2 }, avgResolveHours: 26.5, blockedNow: { NEEDS_INSPECTION: 1, MAINTENANCE: 1, UNAVAILABLE: 1 } },
  }, async (req) => {
    const { from, to } = range(req.q);
    const base = 'FROM resource_issues i JOIN resources r ON r.id = i.resource_id JOIN resource_types rt ON rt.id = r.type_id WHERE i.created_at BETWEEN ? AND ?';
    const [sev, st, ty, avg, blocked] = await Promise.all([
      db.query(`SELECT i.severity AS k, COUNT(*) AS n ${base} GROUP BY i.severity`, [from, to]),
      db.query(`SELECT i.status AS k, COUNT(*) AS n ${base} GROUP BY i.status`, [from, to]),
      db.query(`SELECT rt.code AS k, COUNT(*) AS n ${base} GROUP BY rt.code`, [from, to]),
      db.one(`SELECT AVG(TIMESTAMPDIFF(MINUTE, i.created_at, i.resolved_at)) / 60 AS h ${base} AND i.status = 'RESOLVED'`, [from, to]),
      db.query("SELECT status AS k, COUNT(*) AS n FROM resources WHERE status IN ('NEEDS_INSPECTION','MAINTENANCE','UNAVAILABLE') GROUP BY status"),
    ]);
    return { bySeverity: toMap(sev), byStatus: toMap(st), byType: toMap(ty), avgResolveHours: avg.h === null ? null : Math.round(Number(avg.h) * 10) / 10, blockedNow: toMap(blocked) };
  });

  api.get('/evaluations', {
    summary: '평가 통계 (항목별 평균, 종합 점수 분포, 월별 평균)',
    reqs: ['FR-22', 'FR-18', 'FR-19'], perm: 'stats.read',
    query: period,
    example: { count: 4, avgOverall: 3.9, byCriterion: { loyalty: 4, skill: 3.75 }, distribution: { '1': 0, '2': 0, '3': 2, '4': 2, '5': 0 }, monthly: [{ month: '2026-10', avg: 3.9, count: 4 }] },
  }, async (req) => {
    const crews = await crewScope(req.user, req.q.crewId);
    const { from, to } = range(req.q);
    const memberIds = await scopedMemberIds(crews);
    const match = { status: 'ACTIVE', createdAt: { $gte: from, $lte: to }, ...(memberIds && { memberId: { $in: memberIds } }) };
    const docs = await mongo.col('evaluations').find(match, { projection: { scores: 1, overall: 1, createdAt: 1 } }).toArray();
    const byCriterion = {};
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const monthly = {};
    for (const d of docs) {
      for (const [k, v] of Object.entries(d.scores || {})) { byCriterion[k] = byCriterion[k] || []; byCriterion[k].push(v); }
      distribution[Math.min(5, Math.max(1, Math.round(d.overall)))] += 1;
      const mk = new Date(d.createdAt).toISOString().slice(0, 7);
      monthly[mk] = monthly[mk] || [];
      monthly[mk].push(d.overall);
    }
    const avg = (a) => Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100;
    return {
      count: docs.length, avgOverall: docs.length ? avg(docs.map((d) => d.overall)) : null,
      byCriterion: Object.fromEntries(Object.entries(byCriterion).map(([k, v]) => [k, avg(v)])), distribution,
      monthly: Object.entries(monthly).sort().map(([month, v]) => ({ month, avg: avg(v), count: v.length })),
    };
  });

  api.get('/activities/heatmap', {
    summary: '활동 히트맵 (요일 × 시간대 활동 건수, MongoDB 집계)',
    reqs: ['FR-22', 'DR-04'], perm: 'stats.read',
    query: period,
    example: { cells: [{ dayOfWeek: 2, hour: 9, count: 4 }], total: 60, byType: { FIELD_REPORT: 15 } },
  }, async (req) => {
    const crews = await crewScope(req.user, req.q.crewId);
    const { from, to } = range(req.q);
    const memberIds = await scopedMemberIds(crews);
    const match = { at: { $gte: from, $lte: to }, ...(memberIds && { memberId: { $in: memberIds } }) };
    const [cells, byType] = await Promise.all([
      mongo.col('activities').aggregate([
        { $match: match },
        { $group: { _id: { d: { $dayOfWeek: '$at' }, h: { $hour: '$at' } }, count: { $sum: 1 } } },
        { $sort: { '_id.d': 1, '_id.h': 1 } },
      ]).toArray(),
      mongo.col('activities').aggregate([{ $match: match }, { $group: { _id: '$type', n: { $sum: 1 } } }]).toArray(),
    ]);
    return {
      cells: cells.map((c) => ({ dayOfWeek: c._id.d, hour: c._id.h, count: c.count })),
      total: cells.reduce((s, c) => s + c.count, 0),
      byType: Object.fromEntries(byType.map((t) => [t._id, t.n])),
    };
  });

  api.get('/status-changes', {
    summary: '구성원 변경 추이 (역할·상태·소속·평가 변경 이력의 주별 집계)',
    reqs: ['FR-22', 'BR-10', 'FR-04'], perm: 'stats.read',
    query: period,
    example: { byType: { STATUS: 3, ROLE: 1, CREW: 2 }, statusTransitions: [{ from: 'ACTIVE', to: 'SUSPENDED', count: 1 }], weekly: [{ week: '2026-W41', count: 4 }] },
  }, async (req) => {
    const crews = await crewScope(req.user, req.q.crewId);
    const { from, to } = range(req.q);
    const memberIds = await scopedMemberIds(crews);
    const match = { at: { $gte: from, $lte: to }, ...(memberIds && { memberId: { $in: memberIds } }) };
    const c = mongo.col('memberHistory');
    const [byType, transitions, weekly] = await Promise.all([
      c.aggregate([{ $match: match }, { $group: { _id: '$type', n: { $sum: 1 } } }]).toArray(),
      c.aggregate([{ $match: { ...match, type: 'STATUS' } }, { $group: { _id: { from: '$from', to: '$to' }, n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
      c.aggregate([{ $match: match }, { $group: { _id: { $dateToString: { format: '%G-W%V', date: '$at' } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray(),
    ]);
    return {
      byType: Object.fromEntries(byType.map((x) => [x._id, x.n])),
      statusTransitions: transitions.map((x) => ({ from: x._id.from, to: x._id.to, count: x.n })),
      weekly: weekly.map((x) => ({ week: x._id, count: x.n })),
    };
  });
};
