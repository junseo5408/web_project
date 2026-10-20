/** 업무 협업: 코멘트 / 체크리스트 (MongoDB, FR-09, FR-10, BR-06) */
const mongo = require('../db/mongo');
const db = require('../db/mysql');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const scope = require('../services/scope');
const taskSvc = require('../services/tasks');

const taskId = { type: 'integer', example: 1, desc: '업무 ID' };
const COMMENT_EXAMPLE = { id: '6716...', taskId: 1, author: { id: 5, username: 'capo1', role: 'CAPO' }, body: '점검 체크리스트 반드시 확인', createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z' };
const CHECK_EXAMPLE = { taskId: 1, items: [{ id: '1', text: '출입구 잠금 상태 확인', done: true, doneBy: 'soldier1' }], progress: { done: 1, total: 2 } };

async function getChecklist(id) {
  const doc = await mongo.col('taskChecklists').findOne({ taskId: id });
  const items = doc ? doc.items : [];
  return { taskId: id, items, progress: { done: items.filter((i) => i.done).length, total: items.length } };
}

function assertOpen(task) {
  if (task.status === 'COMPLETED') throw E.rule('BR-06', '완료된 업무의 기록은 변경할 수 없습니다.');
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '13. Task Comments & Checklist', base: '/api/tasks' });

  /* ------------------------------ 코멘트 ------------------------------ */
  api.get('/:id/comments', {
    summary: '업무 코멘트 목록',
    reqs: ['FR-09', 'DR-04'],
    params: { id: taskId },
    list: { sort: { createdAt: 'createdAt' }, defaultSort: 'createdAt' },
    example: COMMENT_EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    const task = await taskSvc.getVisibleTask(req.user, req.params.id);
    const c = mongo.col('taskComments');
    const [items, total] = await Promise.all([c.find({ taskId: task.id }).sort(req.page.mongoSort).skip(req.page.offset).limit(req.page.size).toArray(), c.countDocuments({ taskId: task.id })]);
    return paged(items.map(mongo.out), total, req.page);
  });

  api.post('/:id/comments', {
    summary: '업무 코멘트 작성 (업무 조회 권한자)',
    reqs: ['FR-09', 'DR-04'], status: 201,
    params: { id: taskId },
    body: { body: { type: 'string', required: true, maxLength: 2000, example: '현장 도착했습니다.' } },
    example: COMMENT_EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    const task = await taskSvc.getVisibleTask(req.user, req.params.id);
    const doc = { taskId: task.id, author: rec.actorOf(req.user), body: req.body.body, createdAt: new Date(), updatedAt: new Date() };
    const r = await mongo.col('taskComments').insertOne(doc);
    return mongo.out({ _id: r.insertedId, ...doc });
  });

  api.patch('/:id/comments/:commentId', {
    summary: '내 코멘트 수정 (작성자 본인)',
    reqs: ['FR-09'],
    params: { id: taskId, commentId: { type: 'objectId', example: '6716aa000000000000000001' } },
    body: { body: { type: 'string', required: true, maxLength: 2000, example: '현장 도착 (10분 지연)' } },
    example: COMMENT_EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    const c = await mongo.col('taskComments').findOne({ _id: mongo.oid(req.params.commentId), taskId: req.params.id });
    if (!c) throw E.notFound('코멘트', req.params.commentId);
    if (c.author.id !== req.user.id) throw E.forbidden('작성자 본인만 수정할 수 있습니다.');
    await mongo.col('taskComments').updateOne({ _id: c._id }, { $set: { body: req.body.body, updatedAt: new Date(), edited: true } });
    return mongo.out(await mongo.col('taskComments').findOne({ _id: c._id }));
  });

  api.delete('/:id/comments/:commentId', {
    summary: '코멘트 삭제 (작성자 또는 업무 관리자)',
    reqs: ['FR-09'],
    params: { id: taskId, commentId: { type: 'objectId', example: '6716aa000000000000000001' } },
    example: { id: '6716aa000000000000000001', deleted: true },
    errors: [403, 404],
  }, async (req) => {
    const c = await mongo.col('taskComments').findOne({ _id: mongo.oid(req.params.commentId), taskId: req.params.id });
    if (!c) throw E.notFound('코멘트', req.params.commentId);
    if (c.author.id !== req.user.id) {
      const task = await taskSvc.getTask(req.params.id);
      await scope.assertManageCrew(req.user, task.crewId, 'BR-09');
    }
    await mongo.col('taskComments').deleteOne({ _id: c._id });
    return { id: req.params.commentId, deleted: true };
  });

  /* ---------------------------- 체크리스트 ---------------------------- */
  api.get('/:id/checklist', {
    summary: '업무 체크리스트 조회 (진행률 포함)',
    reqs: ['FR-09', 'FR-10'],
    params: { id: taskId },
    example: CHECK_EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    const task = await taskSvc.getVisibleTask(req.user, req.params.id);
    return getChecklist(task.id);
  });

  api.post('/:id/checklist', {
    summary: '체크리스트 항목 추가 (업무 관리자)',
    reqs: ['FR-07', 'FR-09'], perm: 'task.update', status: 201,
    params: { id: taskId },
    body: { text: { type: 'string', required: true, maxLength: 200, example: '비상 연락망 확인' } },
    example: CHECK_EXAMPLE,
    errors: [403, 404, 409],
  }, async (req) => {
    const task = await taskSvc.getManagedTask(req.user, req.params.id);
    assertOpen(task);
    const doc = await mongo.col('taskChecklists').findOneAndUpdate(
      { taskId: task.id }, { $inc: { seq: 1 }, $setOnInsert: { items: [] } }, { upsert: true, returnDocument: 'after' }
    );
    const seq = (doc.value || doc).seq;
    await mongo.col('taskChecklists').updateOne({ taskId: task.id }, { $push: { items: { id: String(seq), text: req.body.text, done: false, updatedAt: new Date() } } });
    return getChecklist(task.id);
  });

  api.patch('/:id/checklist/:itemId', {
    summary: '체크리스트 항목 완료 체크/수정 (참여자: 체크만, 관리자: 문구 수정)',
    reqs: ['FR-09', 'FR-10', 'BR-06'], partial: true,
    params: { id: taskId, itemId: { type: 'string', maxLength: 10, example: '1' } },
    body: {
      done: { type: 'boolean', example: true },
      text: { type: 'string', maxLength: 200, example: '출입구 및 비상구 잠금 확인' },
    },
    example: CHECK_EXAMPLE,
    errors: [403, 404, 409],
  }, async (req) => {
    const task = await taskSvc.getVisibleTask(req.user, req.params.id);
    assertOpen(task);
    const isManager = req.user.perms.has('task.update') && (await scope.canManageCrew(req.user, task.crewId));
    const isAssignee = !!(await db.one("SELECT id FROM task_assignments WHERE task_id = ? AND member_id = ? AND status IN ('ASSIGNED','ACCEPTED')", [task.id, req.user.id]));
    if (req.body.text !== undefined && !isManager) throw E.forbidden('항목 문구는 업무 관리자만 수정할 수 있습니다.');
    if (!isManager && !isAssignee) throw E.forbidden('업무 참여자 또는 관리자만 체크할 수 있습니다.');
    const set = { 'items.$.updatedAt': new Date() };
    if (req.body.done !== undefined) { set['items.$.done'] = req.body.done; set['items.$.doneBy'] = req.body.done ? req.user.username : null; }
    if (req.body.text !== undefined) set['items.$.text'] = req.body.text;
    const r = await mongo.col('taskChecklists').updateOne({ taskId: task.id, 'items.id': req.params.itemId }, { $set: set });
    if (!r.matchedCount) throw E.notFound('체크리스트 항목', req.params.itemId);
    return getChecklist(task.id);
  });

  api.delete('/:id/checklist/:itemId', {
    summary: '체크리스트 항목 삭제 (업무 관리자)',
    reqs: ['FR-07'], perm: 'task.update',
    params: { id: taskId, itemId: { type: 'string', maxLength: 10, example: '2' } },
    example: CHECK_EXAMPLE,
    errors: [403, 404, 409],
  }, async (req) => {
    const task = await taskSvc.getManagedTask(req.user, req.params.id);
    assertOpen(task);
    const r = await mongo.col('taskChecklists').updateOne({ taskId: task.id }, { $pull: { items: { id: req.params.itemId } } });
    if (!r.modifiedCount) throw E.notFound('체크리스트 항목', req.params.itemId);
    return getChecklist(task.id);
  });
};
