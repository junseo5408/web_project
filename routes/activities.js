/** 활동 기록 (MongoDB, FR-18, FR-19, DR-04) */
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const E = require('../lib/errors');
const { defineModule, paged } = require('../lib/api');
const scope = require('../services/scope');

const TYPES = ['FIELD_REPORT', 'TASK_WORK', 'PATROL', 'MEETING', 'TRAINING', 'TASK_ACCEPTED', 'TASK_COMPLETED', 'RESOURCE_CHECKOUT'];
const EXAMPLE = { id: '671b...', memberId: 8, type: 'FIELD_REPORT', description: '창고 주변 특이사항 없음', refs: { taskId: 1 }, location: 'Brooklyn 창고', details: { checkpoints: 3 }, source: 'MEMBER', at: '2026-10-18T09:00:00.000Z' };

module.exports = (app) => {
  const api = defineModule(app, { tag: '22. Activities', base: '/api/activities' });

  api.get('', {
    summary: '활동 기록 조회 (본인 또는 관리 범위 구성원)',
    reqs: ['FR-19', 'FR-02', 'DR-04', 'NFR-04'],
    query: {
      memberId: { type: 'integer' }, type: { type: 'string', enum: TYPES },
      from: { type: 'datetime' }, to: { type: 'datetime' }, taskId: { type: 'integer' },
    },
    list: { sort: { at: 'at' }, defaultSort: '-at' },
    example: EXAMPLE,
  }, async (req) => {
    const f = {};
    const managed = req.user.perms.has('member.read') ? await scope.managedCrewIds(req.user) : [];
    if (req.q.memberId) {
      if (req.q.memberId !== req.user.id) {
        if (!req.user.perms.has('member.read')) throw E.forbidden('다른 구성원의 활동 조회 권한(member.read)이 없습니다.');
        await scope.assertManageMember(req.user, req.q.memberId, 'BR-09');
      }
      f.memberId = req.q.memberId;
    } else if (managed !== null) {
      const rows = managed.length ? await db.query('SELECT DISTINCT member_id FROM crew_memberships WHERE left_at IS NULL AND crew_id IN (?)', [managed]) : [];
      f.memberId = { $in: [req.user.id, ...rows.map((r) => r.memberId)] };
    }
    if (req.q.type) f.type = req.q.type;
    if (req.q.taskId) f['refs.taskId'] = req.q.taskId;
    if (req.q.from || req.q.to) f.at = { ...(req.q.from && { $gte: req.q.from }), ...(req.q.to && { $lte: req.q.to }) };
    const c = mongo.col('activities');
    const [items, total] = await Promise.all([c.find(f).sort(req.page.mongoSort).skip(req.page.offset).limit(req.page.size).toArray(), c.countDocuments(f)]);
    return paged(items.map(mongo.out), total, req.page);
  });

  api.get('/:id', {
    summary: '활동 기록 상세',
    reqs: ['FR-19'],
    params: { id: { type: 'objectId', example: '671baa000000000000000001' } },
    example: EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    const a = await mongo.col('activities').findOne({ _id: mongo.oid(req.params.id) });
    if (!a) throw E.notFound('활동 기록', req.params.id);
    if (a.memberId !== req.user.id) {
      if (!req.user.perms.has('member.read')) throw E.forbidden();
      await scope.assertManageMember(req.user, a.memberId, 'BR-09');
    }
    return mongo.out(a);
  });

  api.post('', {
    summary: '내 활동 보고 등록 (현장 보고·순찰·훈련 등, 유연한 상세 정보)',
    reqs: ['FR-18', 'DR-04'], status: 201,
    body: {
      type: { type: 'string', required: true, enum: ['FIELD_REPORT', 'TASK_WORK', 'PATROL', 'MEETING', 'TRAINING'], example: 'FIELD_REPORT' },
      description: { type: 'string', required: true, maxLength: 2000, example: '창고 주변 특이사항 없음' },
      taskId: { type: 'integer', example: 1, desc: '관련 업무 (본인 참여 업무)' },
      location: { type: 'string', maxLength: 100, example: 'Brooklyn 창고' },
      details: { type: 'object', example: { checkpoints: 3, incidents: 0 }, desc: '자유 형식 상세 정보 (MongoDB 유연 스키마)' },
    },
    example: EXAMPLE,
    errors: [403],
  }, async (req) => {
    const b = req.body;
    if (b.taskId) {
      const p = await db.one("SELECT id FROM task_assignments WHERE task_id = ? AND member_id = ? AND status <> 'REMOVED'", [b.taskId, req.user.id]);
      if (!p) throw E.forbidden('본인이 참여한 업무에 대해서만 활동을 기록할 수 있습니다.');
    }
    const doc = { memberId: req.user.id, type: b.type, description: b.description, refs: b.taskId ? { taskId: b.taskId } : {}, location: b.location || null, details: b.details || {}, source: 'MEMBER', at: new Date() };
    const r = await mongo.col('activities').insertOne(doc);
    return mongo.out({ _id: r.insertedId, ...doc });
  });
};
