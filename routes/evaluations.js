/** 평가 / 평판 (MongoDB, FR-18, FR-19, BR-10, DR-04) */
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const scope = require('../services/scope');
const memberSvc = require('../services/members');
const { getSettings } = require('../services/settings');
const { reputationOf } = require('../services/reputation');

const oidParam = { id: { type: 'objectId', example: '6719aa000000000000000001' } };
const EXAMPLE = {
  id: '6719...', memberId: 8, taskId: 4, evaluator: { id: 5, username: 'capo1', role: 'CAPO' }, scores: { loyalty: 5, skill: 4, discretion: 4, teamwork: 5 },
  overall: 4.5, comment: '꼼꼼한 장부 검토', status: 'ACTIVE', revisions: [], createdAt: '2026-10-12T00:00:00.000Z',
};

async function activeCriteria() {
  return mongo.col('evaluationCriteria').find({ active: true }).toArray();
}

/** 가중 평균 계산 및 점수 검증 (1~5 정수, 활성 평가 항목만) */
async function scoreOverall(scores) {
  const criteria = await activeCriteria();
  const keys = Object.keys(scores);
  if (!keys.length) throw E.badRequest('scores 에 하나 이상의 평가 항목 점수를 입력하세요.');
  let sum = 0;
  let w = 0;
  for (const k of keys) {
    const c = criteria.find((x) => x.code === k);
    if (!c) throw E.badRequest(`알 수 없거나 비활성화된 평가 항목: ${k}`, { allowed: criteria.map((x) => x.code) });
    if (!Number.isInteger(scores[k]) || scores[k] < 1 || scores[k] > 5) throw E.badRequest(`scores.${k} 는 1~5 정수여야 합니다.`);
    sum += scores[k] * c.weight;
    w += c.weight;
  }
  return Math.round((sum / w) * 100) / 100;
}

async function getEvaluation(id) {
  const e = await mongo.col('evaluations').findOne({ _id: mongo.oid(id) });
  if (!e) throw E.notFound('평가', id);
  return e;
}

/** 평가 조회 권한: 본인(평가자 익명) / 평가자 / 관리 범위 + evaluation.read */
async function viewEvaluation(user, e) {
  if (e.evaluator.id === user.id) return mongo.out(e);
  if (user.perms.has('evaluation.read') && (await scope.canManageMember(user, e.memberId))) return mongo.out(e);
  if (e.memberId === user.id && e.status === 'ACTIVE') {
    const { evaluator, revisions, ...rest } = mongo.out(e);
    return { ...rest, evaluator: { role: evaluator.role } };
  }
  throw E.forbidden('이 평가를 조회할 권한이 없습니다.', 'BR-09');
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '21. Evaluations & Reputation', base: '/api/evaluations' });

  api.get('', {
    summary: '평가 이력 조회 (구성원·업무·평가자·기간)',
    description: 'evaluation.read 권한자는 관리 범위 구성원의 평가를, 일반 구성원은 본인 평가만(평가자 익명) 조회한다.',
    reqs: ['FR-19', 'FR-18', 'DR-04'],
    query: {
      memberId: { type: 'integer', example: 8 }, taskId: { type: 'integer' }, evaluatorId: { type: 'integer' },
      status: { type: 'string', enum: ['ACTIVE', 'VOIDED'] }, from: { type: 'datetime' }, to: { type: 'datetime' },
      minOverall: { type: 'number', min: 1, max: 5 },
    },
    list: { sort: { createdAt: 'createdAt', overall: 'overall' }, defaultSort: '-createdAt' },
    example: { ...EXAMPLE, memberName: 'Paulie Conti' },
  }, async (req) => {
    const f = {};
    let anonymize = false;
    if (req.user.perms.has('evaluation.read')) {
      const managed = await scope.managedCrewIds(req.user);
      if (managed !== null) {
        const rows = managed.length ? await db.query('SELECT DISTINCT member_id FROM crew_memberships WHERE left_at IS NULL AND crew_id IN (?)', [managed]) : [];
        f.$or = [{ memberId: { $in: rows.map((r) => r.memberId) } }, { 'evaluator.id': req.user.id }];
      }
    } else {
      f.memberId = req.user.id;
      f.status = 'ACTIVE';
      anonymize = true;
    }
    if (req.q.memberId) f.memberId = anonymize ? req.user.id : req.q.memberId;
    if (req.q.taskId) f.taskId = req.q.taskId;
    if (req.q.evaluatorId && !anonymize) f['evaluator.id'] = req.q.evaluatorId;
    if (req.q.status && !anonymize) f.status = req.q.status;
    if (req.q.minOverall) f.overall = { $gte: req.q.minOverall };
    if (req.q.from || req.q.to) f.createdAt = { ...(req.q.from && { $gte: req.q.from }), ...(req.q.to && { $lte: req.q.to }) };
    const c = mongo.col('evaluations');
    const [items, total] = await Promise.all([c.find(f).sort(req.page.mongoSort).skip(req.page.offset).limit(req.page.size).toArray(), c.countDocuments(f)]);
    const ids = [...new Set(items.map((e) => e.memberId))];
    const names = ids.length ? await db.query('SELECT id, name FROM members WHERE id IN (?)', [ids]) : [];
    return paged(items.map((e) => {
      const o = { ...mongo.out(e), memberName: (names.find((n) => n.id === e.memberId) || {}).name || null };
      if (anonymize) { delete o.revisions; o.evaluator = { role: e.evaluator.role }; }
      return o;
    }), total, req.page);
  });

  api.get('/pending', {
    summary: '평가 대기 목록 (관리 범위의 최근 완료 업무 참여자 중 미평가)',
    reqs: ['FR-18', 'FR-11'], perm: 'evaluation.write',
    query: { days: { type: 'integer', min: 1, max: 365, default: 30, desc: '최근 N일 내 완료 업무' } },
    example: [{ taskId: 3, title: '항만 화물 인수', completedAt: '2026-10-18T12:00:00.000Z', memberId: 10, memberName: 'Frankie Costa', attendance: 'PRESENT', contribution: 90 }],
  }, async (req) => {
    const managed = await scope.managedCrewIds(req.user);
    const crewSql = managed === null ? '1=1' : managed.length ? 't.crew_id IN (?)' : '1=0';
    const rows = await db.query(
      `SELECT t.id AS task_id, t.title, t.completed_at, a.member_id, m.name AS member_name, a.attendance, a.contribution
         FROM tasks t JOIN task_assignments a ON a.task_id = t.id JOIN members m ON m.id = a.member_id
        WHERE t.status = 'COMPLETED' AND t.completed_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND a.status IN ('ASSIGNED','ACCEPTED')
          AND a.member_id <> ? AND ${crewSql} ORDER BY t.completed_at DESC`,
      managed && managed.length ? [req.q.days, req.user.id, managed] : [req.q.days, req.user.id]
    );
    if (!rows.length) return [];
    const done = await mongo.col('evaluations').find({ status: 'ACTIVE', taskId: { $in: [...new Set(rows.map((r) => r.taskId))] } }, { projection: { taskId: 1, memberId: 1 } }).toArray();
    return rows.filter((r) => !done.some((d) => d.taskId === r.taskId && d.memberId === r.memberId));
  });

  api.get('/:id', {
    summary: '평가 상세',
    reqs: ['FR-19'],
    params: oidParam,
    example: EXAMPLE,
    errors: [403, 404],
  }, async (req) => viewEvaluation(req.user, await getEvaluation(req.params.id)));

  api.post('', {
    summary: '평가 등록 (업무 결과 기반, 항목별 1~5점, 가중 평균 자동 계산)',
    description: '업무를 지정하면 완료된 업무의 참여자만 평가할 수 있고, 같은 업무·구성원에 대한 유효 평가는 1건만 허용된다. 평가 등록은 구성원 이력(BR-10)에 기록된다.',
    reqs: ['FR-18', 'FR-11', 'BR-10', 'DR-04'], perm: 'evaluation.write', status: 201,
    body: {
      memberId: { type: 'integer', required: true, example: 9 },
      taskId: { type: 'integer', example: 1, desc: '평가 근거 업무 (완료된 업무)' },
      scores: { type: 'object', required: true, example: { loyalty: 4, skill: 4, discretion: 3, teamwork: 5 }, desc: '평가 항목 코드별 1~5점 (GET /api/evaluation-criteria 참고)' },
      comment: { type: 'string', maxLength: 1000, example: '성실하게 경비 업무 수행' },
    },
    bodyExample: { memberId: 10, taskId: 3, scores: { loyalty: 4, skill: 5, discretion: 4, teamwork: 4 }, comment: '화물 인수 책임 완수' },
    example: { ...EXAMPLE, memberId: 10, taskId: 3 },
    errors: [403, 404, 409, 422],
  }, async (req) => {
    const b = req.body;
    const member = await memberSvc.getMember(b.memberId);
    if (member.id === req.user.id) throw E.forbidden('자기 자신을 평가할 수 없습니다.');
    memberSvc.assertHigherThan(req.user, member, '평가');
    await scope.assertManageMember(req.user, member.id);
    if (b.taskId) {
      const t = await db.one('SELECT id, status FROM tasks WHERE id = ?', [b.taskId]);
      if (!t) throw E.notFound('업무', b.taskId);
      if (t.status !== 'COMPLETED') throw E.state('완료된 업무에 대해서만 평가할 수 있습니다.');
      const p = await db.one("SELECT id FROM task_assignments WHERE task_id = ? AND member_id = ? AND status IN ('ASSIGNED','ACCEPTED')", [b.taskId, member.id]);
      if (!p) throw E.state('해당 업무의 참여자가 아닙니다.');
      if (await mongo.col('evaluations').findOne({ taskId: b.taskId, memberId: member.id, status: 'ACTIVE' })) throw E.conflict('이 업무에 대한 해당 구성원의 평가가 이미 존재합니다.');
    }
    const overall = await scoreOverall(b.scores);
    const doc = { memberId: member.id, taskId: b.taskId || null, evaluator: rec.actorOf(req.user), scores: b.scores, overall, comment: b.comment || null, status: 'ACTIVE', revisions: [], createdAt: new Date(), updatedAt: new Date() };
    const r = await mongo.col('evaluations').insertOne(doc);
    await rec.memberHistory(member.id, 'EVALUATION', null, overall, req.user, b.comment, { evaluationId: String(r.insertedId), taskId: doc.taskId });
    await rec.notify(member.id, 'EVALUATION', '평가 등록', `새 평가가 등록되었습니다. (종합 ${overall})`, `/api/evaluations/${r.insertedId}`);
    return mongo.out({ _id: r.insertedId, ...doc });
  });

  api.patch('/:id', {
    summary: '평가 수정 (작성자: 설정된 기간 내 / Underboss 이상: 언제나, 수정 전 내용 보존)',
    reqs: ['FR-18', 'BR-10'], perm: 'evaluation.write', partial: true,
    params: oidParam,
    body: {
      scores: { type: 'object', example: { loyalty: 5, skill: 4, discretion: 4, teamwork: 5 } },
      comment: { type: 'string', maxLength: 1000, example: '재검토 후 상향' },
    },
    example: { ...EXAMPLE, revisions: [{ scores: { loyalty: 4 }, overall: 4.25, comment: '...', revisedAt: '2026-10-18T00:00:00.000Z', revisedBy: 'capo1' }] },
    errors: [403, 404, 422],
  }, async (req) => {
    const e = await getEvaluation(req.params.id);
    if (e.status !== 'ACTIVE') throw E.state('무효화된 평가는 수정할 수 없습니다.');
    const { evaluationEditWindowHours } = await getSettings();
    const isAuthor = e.evaluator.id === req.user.id;
    const withinWindow = Date.now() - new Date(e.createdAt).getTime() <= evaluationEditWindowHours * 3600000;
    if (!(isAuthor && withinWindow) && !req.user.perms.has('evaluation.void')) {
      throw E.forbidden(isAuthor ? `작성 후 ${evaluationEditWindowHours}시간이 지나 수정할 수 없습니다.` : '평가 작성자만 수정할 수 있습니다.');
    }
    await scope.assertManageMember(req.user, e.memberId);
    const set = { updatedAt: new Date() };
    if (req.body.scores) { set.scores = req.body.scores; set.overall = await scoreOverall(req.body.scores); }
    if (req.body.comment !== undefined) set.comment = req.body.comment;
    await mongo.col('evaluations').updateOne({ _id: e._id }, {
      $set: set,
      $push: { revisions: { scores: e.scores, overall: e.overall, comment: e.comment, revisedAt: new Date(), revisedBy: req.user.username } },
    });
    await rec.memberHistory(e.memberId, 'EVALUATION', e.overall, set.overall || e.overall, req.user, '평가 수정', { evaluationId: req.params.id });
    return mongo.out(await getEvaluation(req.params.id));
  });

  api.delete('/:id', {
    summary: '평가 무효화 (삭제하지 않고 VOIDED 처리, 사유 기록)',
    reqs: ['FR-18', 'BR-10', 'FR-20'], perm: 'evaluation.void',
    params: oidParam,
    query: { reason: { type: 'string', required: true, maxLength: 300, example: '평가 근거 오류' } },
    example: { ...EXAMPLE, status: 'VOIDED', voidReason: '평가 근거 오류' },
    errors: [403, 404, 422],
  }, async (req) => {
    const e = await getEvaluation(req.params.id);
    if (e.status !== 'ACTIVE') throw E.state('이미 무효화된 평가입니다.');
    await scope.assertManageMember(req.user, e.memberId);
    await mongo.col('evaluations').updateOne({ _id: e._id }, { $set: { status: 'VOIDED', voidReason: req.q.reason, voidedBy: rec.actorOf(req.user), voidedAt: new Date() } });
    await rec.memberHistory(e.memberId, 'EVALUATION', e.overall, 'VOIDED', req.user, req.q.reason, { evaluationId: req.params.id });
    await rec.audit(req.user, 'EVALUATION_VOIDED', 'evaluation', req.params.id, { memberId: e.memberId, reason: req.q.reason }, 'SUCCESS', req.ip);
    return mongo.out(await getEvaluation(req.params.id));
  });

  api.get('/:id/revisions', {
    summary: '평가 수정 이력',
    reqs: ['FR-19', 'BR-10'], perm: 'evaluation.read',
    params: oidParam,
    example: [{ scores: { loyalty: 4 }, overall: 4.25, comment: '...', revisedAt: '2026-10-18T00:00:00.000Z', revisedBy: 'capo1' }],
    errors: [403, 404],
  }, async (req) => {
    const e = await getEvaluation(req.params.id);
    if (e.evaluator.id !== req.user.id) await scope.assertManageMember(req.user, e.memberId, 'BR-09');
    return e.revisions || [];
  });

  /* ----------------------------- 평가 항목 ----------------------------- */
  const crit = defineModule(app, { tag: '21. Evaluations & Reputation', base: '/api/evaluation-criteria' });
  const CRIT_EXAMPLE = { id: '671a...', code: 'loyalty', name: '충성도', description: '조직과 Crew에 대한 헌신', weight: 1.5, active: true };

  crit.get('', {
    summary: '평가 항목 목록 (코드, 가중치)',
    reqs: ['FR-18'],
    query: { includeInactive: { type: 'boolean', default: false } },
    example: [CRIT_EXAMPLE],
  }, async (req) => (await mongo.col('evaluationCriteria').find(req.q.includeInactive ? {} : { active: true }).sort({ weight: -1 }).toArray()).map(mongo.out));

  crit.post('', {
    summary: '평가 항목 추가',
    reqs: ['FR-18', 'DR-04'], perm: 'evaluation.criteria', status: 201,
    body: {
      code: { type: 'string', required: true, maxLength: 30, pattern: '^[a-z_]+$', example: 'punctuality' },
      name: { type: 'string', required: true, maxLength: 50, example: '시간 엄수' },
      description: { type: 'string', maxLength: 255, example: '집결 시간 준수' },
      weight: { type: 'number', min: 0.1, max: 5, default: 1, example: 0.7 },
    },
    example: { ...CRIT_EXAMPLE, code: 'punctuality', name: '시간 엄수', weight: 0.7 },
    errors: [409],
  }, async (req) => {
    if (await mongo.col('evaluationCriteria').findOne({ code: req.body.code })) throw E.conflict('이미 존재하는 평가 항목 코드입니다.');
    const doc = { ...req.body, active: true, createdAt: new Date() };
    const r = await mongo.col('evaluationCriteria').insertOne(doc);
    await rec.audit(req.user, 'CRITERION_CREATED', 'criterion', req.body.code, req.body, 'SUCCESS', req.ip);
    return mongo.out({ _id: r.insertedId, ...doc });
  });

  crit.patch('/:code', {
    summary: '평가 항목 수정 (이름/설명/가중치/활성 여부)',
    reqs: ['FR-18'], perm: 'evaluation.criteria', partial: true,
    params: { code: { type: 'string', example: 'teamwork' } },
    body: {
      name: { type: 'string', maxLength: 50 }, description: { type: 'string', maxLength: 255 },
      weight: { type: 'number', min: 0.1, max: 5, example: 1.0 }, active: { type: 'boolean', example: true },
    },
    example: CRIT_EXAMPLE,
    errors: [404],
  }, async (req) => {
    const r = await mongo.col('evaluationCriteria').updateOne({ code: req.params.code }, { $set: { ...req.body, updatedAt: new Date() } });
    if (!r.matchedCount) throw E.notFound('평가 항목', req.params.code);
    await rec.audit(req.user, 'CRITERION_UPDATED', 'criterion', req.params.code, req.body, 'SUCCESS', req.ip);
    return mongo.out(await mongo.col('evaluationCriteria').findOne({ code: req.params.code }));
  });

  crit.delete('/:code', {
    summary: '평가 항목 삭제 (평가에 사용된 적 없는 항목만, 그 외는 비활성화)',
    reqs: ['FR-18', 'DR-04'], perm: 'evaluation.criteria',
    params: { code: { type: 'string', example: 'punctuality' } },
    example: { code: 'punctuality', deleted: true },
    errors: [404, 422],
  }, async (req) => {
    const c = await mongo.col('evaluationCriteria').findOne({ code: req.params.code });
    if (!c) throw E.notFound('평가 항목', req.params.code);
    if (await mongo.col('evaluations').findOne({ [`scores.${req.params.code}`]: { $exists: true } })) {
      throw E.state('평가에 사용된 항목은 삭제할 수 없습니다. active=false 로 비활성화하세요.');
    }
    await mongo.col('evaluationCriteria').deleteOne({ _id: c._id });
    return { code: req.params.code, deleted: true };
  });

  /* ----------------------------- 평판 순위 ----------------------------- */
  const rep = defineModule(app, { tag: '21. Evaluations & Reputation', base: '/api/reputation' });
  rep.get('/leaderboard', {
    summary: '평판 순위 (조회 가능한 Crew 구성원 대상)',
    reqs: ['FR-18', 'FR-19', 'FR-22'],
    query: { crewId: { type: 'integer' }, limit: { type: 'integer', min: 1, max: 100, default: 10 } },
    example: [{ rank: 1, memberId: 13, name: 'Carlo Rizzi', crewName: 'Uptown Crew', score: 92, evaluationAverage: 3.9, ledgerPoints: 0, attendanceRate: 94 }],
  }, async (req) => {
    const visible = await scope.visibleCrewIds(req.user);
    if (req.q.crewId && visible !== null && !visible.includes(req.q.crewId)) throw E.forbidden('해당 Crew 조회 권한이 없습니다.');
    const crewIds = req.q.crewId ? [req.q.crewId] : visible;
    if (crewIds !== null && !crewIds.length) return [];
    const members = await db.query(
      `SELECT m.id, m.name, c.name AS crew_name FROM members m JOIN roles r ON r.id = m.role_id
         JOIN crew_memberships cm ON cm.member_id = m.id AND cm.left_at IS NULL AND cm.membership_type = 'FORMAL' JOIN crews c ON c.id = cm.crew_id
        WHERE m.status <> 'WITHDRAWN' AND r.level <= 3 ${crewIds ? 'AND cm.crew_id IN (?)' : ''}`, crewIds ? [crewIds] : []
    );
    const reps = await reputationOf(members.map((m) => m.id));
    return reps.map((r) => ({ ...r, ...members.find((m) => m.id === r.memberId) }))
      .sort((a, b) => b.score - a.score).slice(0, req.q.limit)
      .map((r, i) => ({ rank: i + 1, memberId: r.memberId, name: r.name, crewName: r.crewName, score: r.score, evaluationAverage: r.evaluationAverage, ledgerPoints: r.ledgerPoints, attendanceRate: r.attendanceRate }));
  });
};
