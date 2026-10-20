/** 업무 템플릿 (MongoDB, FR-07) : 반복 업무를 구조화된 템플릿으로 관리 */
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule } = require('../lib/api');
const taskSvc = require('../services/tasks');

const idParam = { id: { type: 'objectId', example: '6717aa000000000000000001' } };
const EXAMPLE = {
  id: '6717...', name: '정기 수금', description: '구역별 정기 수금 업무',
  defaults: { priority: 'NORMAL', durationHours: 4, location: '구역 순회', allowConcurrent: false, requiredSkills: ['negotiation'] },
  checklist: ['수금 대상 명단 확인', '수금액 기록', '본부 입금'], createdBy: { id: 2, username: 'boss', role: 'BOSS' },
};
const BODY = {
  name: { type: 'string', required: true, maxLength: 100, example: '거점 보안 점검' },
  description: { type: 'string', maxLength: 1000, example: '거점별 보안 상태 점검' },
  defaults: { type: 'object', required: true, example: { priority: 'HIGH', durationHours: 3, location: '각 거점', allowConcurrent: false, requiredSkills: ['security'] }, desc: '{ priority, durationHours, location, allowConcurrent, requiredSkills }' },
  checklist: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 30, example: ['출입문 확인', 'CCTV 확인'] },
};

function validateDefaults(d) {
  if (d.priority && !taskSvc.PRIORITIES.includes(d.priority)) throw E.badRequest(`defaults.priority 허용 값: ${taskSvc.PRIORITIES.join(', ')}`);
  if (d.durationHours !== undefined && (typeof d.durationHours !== 'number' || d.durationHours <= 0 || d.durationHours > 72)) throw E.badRequest('defaults.durationHours 는 0 초과 72 이하 숫자여야 합니다.');
}

async function getTemplate(id) {
  const t = await mongo.col('taskTemplates').findOne({ _id: mongo.oid(id) });
  if (!t) throw E.notFound('업무 템플릿', id);
  return t;
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '14. Task Templates', base: '/api/task-templates' });

  api.get('', {
    summary: '업무 템플릿 목록',
    reqs: ['FR-07'], perm: 'template.manage',
    query: { q: { type: 'string', desc: '이름 검색' } },
    example: [EXAMPLE],
  }, async (req) => {
    const f = req.q.q ? { name: new RegExp(req.q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } : {};
    return (await mongo.col('taskTemplates').find(f).sort({ name: 1 }).toArray()).map(mongo.out);
  });

  api.get('/:id', {
    summary: '업무 템플릿 상세',
    reqs: ['FR-07'], perm: 'template.manage',
    params: idParam,
    example: EXAMPLE,
    errors: [404],
  }, async (req) => mongo.out(await getTemplate(req.params.id)));

  api.post('', {
    summary: '업무 템플릿 등록',
    reqs: ['FR-07'], perm: 'template.manage', status: 201,
    body: BODY,
    example: EXAMPLE,
  }, async (req) => {
    validateDefaults(req.body.defaults);
    const doc = { ...req.body, checklist: req.body.checklist || [], createdBy: rec.actorOf(req.user), createdAt: new Date(), updatedAt: new Date() };
    const r = await mongo.col('taskTemplates').insertOne(doc);
    return mongo.out({ _id: r.insertedId, ...doc });
  });

  api.patch('/:id', {
    summary: '업무 템플릿 수정',
    reqs: ['FR-07'], perm: 'template.manage', partial: true,
    params: idParam,
    body: BODY,
    example: EXAMPLE,
    errors: [404],
  }, async (req) => {
    const t = await getTemplate(req.params.id);
    if (req.body.defaults) validateDefaults(req.body.defaults);
    await mongo.col('taskTemplates').updateOne({ _id: t._id }, { $set: { ...req.body, updatedAt: new Date() } });
    return mongo.out(await getTemplate(req.params.id));
  });

  api.delete('/:id', {
    summary: '업무 템플릿 삭제',
    reqs: ['FR-07'], perm: 'template.manage',
    params: idParam,
    example: { id: '6717aa000000000000000001', deleted: true },
    errors: [404],
  }, async (req) => {
    const t = await getTemplate(req.params.id);
    await mongo.col('taskTemplates').deleteOne({ _id: t._id });
    return { id: req.params.id, deleted: true };
  });

  api.post('/:id/instantiate', {
    summary: '템플릿으로 업무 생성 (기본값 + 체크리스트 자동 적용)',
    reqs: ['FR-07'], perm: ['template.manage', 'task.create'], status: 201,
    params: idParam,
    body: {
      crewId: { type: 'integer', required: true, example: 1 },
      startAt: { type: 'datetime', required: true, example: '2026-10-28T10:00:00Z' },
      title: { type: 'string', maxLength: 100, example: '정기 수금 - 10월 4주차' },
    },
    example: { id: 27, title: '정기 수금 - 10월 4주차', status: 'PLANNED', crewId: 1, checklistItems: 3 },
    errors: [403, 404],
  }, async (req) => {
    const tpl = await getTemplate(req.params.id);
    const d = tpl.defaults || {};
    const start = req.body.startAt;
    const end = new Date(start.getTime() + (d.durationHours || 1) * 3600000);
    const id = await db.tx((t) => taskSvc.createTask(t, req.user, {
      title: req.body.title || tpl.name, description: tpl.description, crewId: req.body.crewId, priority: d.priority,
      startAt: start, endAt: end, location: d.location, allowConcurrent: !!d.allowConcurrent, requiredSkills: d.requiredSkills || [],
    }));
    const items = (tpl.checklist || []).map((text, i) => ({ id: String(i + 1), text, done: false, updatedAt: new Date() }));
    if (items.length) await mongo.col('taskChecklists').insertOne({ taskId: id, items, seq: items.length });
    await rec.taskHistory(id, 'CREATED', null, 'PLANNED', req.user, `템플릿 '${tpl.name}' 사용`);
    return { ...(await taskSvc.getTask(id)), checklistItems: items.length };
  });
};
