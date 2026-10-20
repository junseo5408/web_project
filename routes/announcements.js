/** Crew 공지 (MongoDB, FR-05) */
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const scope = require('../services/scope');
const { helpers: crewHelpers } = require('./crews');

const EXAMPLE = { id: '6714...', crewId: 1, title: '이번 주 창고 점검 일정', body: '목요일 오전 9시 집결', pinned: true, author: { id: 5, username: 'capo1', role: 'CAPO' }, createdAt: '2026-10-18T00:00:00.000Z' };
const params = { id: { type: 'integer', example: 1, desc: 'Crew ID' }, annId: { type: 'objectId', example: '6714aa000000000000000001' } };

async function getAnnouncement(crewId, annId) {
  const doc = await mongo.col('announcements').findOne({ _id: mongo.oid(annId), crewId: Number(crewId) });
  if (!doc) throw E.notFound('공지', annId);
  return doc;
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '10. Crew Announcements', base: '/api/crews' });

  api.get('/:id/announcements', {
    summary: 'Crew 공지 목록 (고정 공지 우선)',
    reqs: ['FR-05', 'FR-02'],
    params: { id: params.id },
    query: { q: { type: 'string', desc: '제목/본문 검색' } },
    list: { sort: { createdAt: 'createdAt' }, defaultSort: '-createdAt' },
    example: EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    const crew = await crewHelpers.getCrew(req.params.id);
    await crewHelpers.assertViewCrew(req.user, crew.id);
    const f = { crewId: crew.id };
    if (req.q.q) {
      const rx = new RegExp(req.q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      f.$or = [{ title: rx }, { body: rx }];
    }
    const c = mongo.col('announcements');
    const [items, total] = await Promise.all([
      c.find(f).sort({ pinned: -1, ...req.page.mongoSort }).skip(req.page.offset).limit(req.page.size).toArray(),
      c.countDocuments(f),
    ]);
    return paged(items.map(mongo.out), total, req.page);
  });

  api.get('/:id/announcements/:annId', {
    summary: 'Crew 공지 상세',
    reqs: ['FR-05'],
    params,
    example: EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    await crewHelpers.assertViewCrew(req.user, req.params.id);
    return mongo.out(await getAnnouncement(req.params.id, req.params.annId));
  });

  api.post('/:id/announcements', {
    summary: 'Crew 공지 등록 (소속 구성원에게 알림)',
    reqs: ['FR-05', 'FR-06'], perm: 'crew.announce', status: 201,
    params: { id: params.id },
    body: {
      title: { type: 'string', required: true, maxLength: 100, example: '주간 회의 장소 변경' },
      body: { type: 'string', required: true, maxLength: 5000, example: '이번 주 회의는 Brooklyn 본부 2층에서 진행합니다.' },
      pinned: { type: 'boolean', default: false, example: false },
    },
    example: EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    const crew = await crewHelpers.getActiveCrew(req.params.id);
    await scope.assertManageCrew(req.user, crew.id);
    const doc = { crewId: crew.id, ...req.body, author: rec.actorOf(req.user), createdAt: new Date(), updatedAt: new Date() };
    const r = await mongo.col('announcements').insertOne(doc);
    const members = await db.query('SELECT member_id FROM crew_memberships WHERE crew_id = ? AND left_at IS NULL', [crew.id]);
    await rec.notify(members.map((m) => m.memberId).filter((id) => id !== req.user.id), 'ANNOUNCEMENT', `[${crew.name}] ${req.body.title}`, req.body.body.slice(0, 100), `/api/crews/${crew.id}/announcements/${r.insertedId}`);
    return mongo.out({ _id: r.insertedId, ...doc });
  });

  api.patch('/:id/announcements/:annId', {
    summary: 'Crew 공지 수정 / 고정 설정',
    reqs: ['FR-05'], perm: 'crew.announce', partial: true,
    params,
    body: {
      title: { type: 'string', maxLength: 100, example: '주간 회의 장소 변경(수정)' },
      body: { type: 'string', maxLength: 5000 },
      pinned: { type: 'boolean', example: true },
    },
    example: EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    await scope.assertManageCrew(req.user, req.params.id);
    const doc = await getAnnouncement(req.params.id, req.params.annId);
    await mongo.col('announcements').updateOne({ _id: doc._id }, { $set: { ...req.body, updatedAt: new Date(), updatedBy: rec.actorOf(req.user) } });
    return mongo.out(await getAnnouncement(req.params.id, req.params.annId));
  });

  api.delete('/:id/announcements/:annId', {
    summary: 'Crew 공지 삭제',
    reqs: ['FR-05'], perm: 'crew.announce',
    params,
    example: { id: '6714aa000000000000000001', deleted: true },
    errors: [403, 404],
  }, async (req) => {
    await scope.assertManageCrew(req.user, req.params.id);
    const doc = await getAnnouncement(req.params.id, req.params.annId);
    await mongo.col('announcements').deleteOne({ _id: doc._id });
    await rec.audit(req.user, 'ANNOUNCEMENT_DELETED', 'crew', req.params.id, { title: doc.title }, 'SUCCESS', req.ip);
    return { id: req.params.annId, deleted: true };
  });
};
