/** 감사 로그 (MongoDB, FR-20, BR-10) */
const mongo = require('../db/mongo');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const { toCsv } = require('../lib/util');

const EXAMPLE = {
  id: '671c...', at: '2026-10-18T09:00:00.000Z', actor: { id: 5, username: 'capo1', role: 'CAPO' }, action: 'MEMBER_ROLE_CHANGED',
  entity: { type: 'member', id: '14' }, details: { from: 'ASSOCIATE', to: 'SOLDIER' }, result: 'SUCCESS', ip: '::1',
};
const filterQuery = {
  actorId: { type: 'integer' }, actor: { type: 'string', desc: '사용자명' },
  action: { type: 'string', example: 'MEMBER_ROLE_CHANGED' },
  entityType: { type: 'string', enum: ['member', 'crew', 'task', 'resource', 'role', 'region', 'evaluation', 'criterion', 'resourceType', 'system', 'api', 'account'] },
  entityId: { type: 'string' },
  result: { type: 'string', enum: ['SUCCESS', 'DENIED'] },
  from: { type: 'datetime' }, to: { type: 'datetime' },
};
function buildFilter(q) {
  const f = {};
  if (q.actorId) f['actor.id'] = q.actorId;
  if (q.actor) f['actor.username'] = q.actor;
  if (q.action) f.action = q.action;
  if (q.entityType) f['entity.type'] = q.entityType;
  if (q.entityId) f['entity.id'] = q.entityId;
  if (q.result) f.result = q.result;
  if (q.from || q.to) f.at = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
  return f;
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '25. Audit Logs', base: '/api/audit-logs' });

  api.get('', {
    summary: '감사 로그 조회 (행위자·행위·대상·결과·기간)',
    description: '중요 상태 변경, 관리 활동, 권한 거부(DENIED) 시도가 모두 기록된다.',
    reqs: ['FR-20', 'BR-10', 'BR-09', 'NFR-04'], perm: 'audit.read',
    query: filterQuery,
    list: { sort: { at: 'at', action: 'action' }, defaultSort: '-at' },
    example: EXAMPLE,
    verify: 'soldier1 로 관리 API 호출(403) 후 admin 으로 GET /api/audit-logs?result=DENIED → 거부 기록 확인',
  }, async (req) => {
    const f = buildFilter(req.q);
    const c = mongo.col('auditLogs');
    const [items, total] = await Promise.all([c.find(f).sort(req.page.mongoSort).skip(req.page.offset).limit(req.page.size).toArray(), c.countDocuments(f)]);
    return paged(items.map(mongo.out), total, req.page);
  });

  api.get('/summary', {
    summary: '감사 로그 집계 (행위별·결과별·일자별 건수, 상위 행위자)',
    reqs: ['FR-20', 'FR-22'], perm: 'audit.read',
    query: { from: { type: 'datetime' }, to: { type: 'datetime' } },
    example: { total: 42, byResult: { SUCCESS: 38, DENIED: 4 }, byAction: [{ action: 'TASK_CREATED', count: 5 }], daily: [{ date: '2026-10-18', count: 12 }], topActors: [{ username: 'capo1', count: 9 }] },
  }, async (req) => {
    const f = buildFilter(req.q);
    const c = mongo.col('auditLogs');
    const [byResult, byAction, daily, topActors, total] = await Promise.all([
      c.aggregate([{ $match: f }, { $group: { _id: '$result', n: { $sum: 1 } } }]).toArray(),
      c.aggregate([{ $match: f }, { $group: { _id: '$action', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 30 }]).toArray(),
      c.aggregate([{ $match: f }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$at' } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray(),
      c.aggregate([{ $match: f }, { $group: { _id: '$actor.username', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }]).toArray(),
      c.countDocuments(f),
    ]);
    return {
      total,
      byResult: Object.fromEntries(byResult.map((x) => [x._id, x.n])),
      byAction: byAction.map((x) => ({ action: x._id, count: x.n })),
      daily: daily.map((x) => ({ date: x._id, count: x.n })),
      topActors: topActors.map((x) => ({ username: x._id, count: x.n })),
    };
  });

  api.get('/export', {
    summary: '감사 로그 CSV 내보내기 (최대 10,000건)',
    reqs: ['FR-20'], perm: 'audit.read', produces: 'text/csv',
    query: filterQuery,
    example: 'at,actor,role,action,entityType,entityId,result,details\n2026-10-18T09:00:00.000Z,capo1,CAPO,MEMBER_ROLE_CHANGED,member,14,SUCCESS,...',
  }, async (req, res) => {
    const docs = await mongo.col('auditLogs').find(buildFilter(req.q)).sort({ at: -1 }).limit(10000).toArray();
    await rec.audit(req.user, 'AUDIT_EXPORTED', 'system', null, { count: docs.length }, 'SUCCESS', req.ip);
    const rows = docs.map((d) => ({ at: d.at, actor: d.actor.username, role: d.actor.role, action: d.action, entityType: d.entity.type, entityId: d.entity.id, result: d.result, details: d.details }));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
    res.send(toCsv(rows, ['at', 'actor', 'role', 'action', 'entityType', 'entityId', 'result', 'details']));
  });

  api.get('/:id', {
    summary: '감사 로그 상세',
    reqs: ['FR-20'], perm: 'audit.read',
    params: { id: { type: 'objectId', example: '671caa000000000000000001' } },
    example: EXAMPLE,
    errors: [404],
  }, async (req) => {
    const d = await mongo.col('auditLogs').findOne({ _id: mongo.oid(req.params.id) });
    if (!d) throw E.notFound('감사 로그', req.params.id);
    return mongo.out(d);
  });
};
