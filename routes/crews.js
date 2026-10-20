/** Crew 관리 (FR-05, FR-06, BR-01, BR-05, BR-10) */
const db = require('../db/mysql');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const scope = require('../services/scope');
const memberSvc = require('../services/members');

const idParam = { id: { type: 'integer', example: 1, desc: 'Crew ID' } };
const CREW_SELECT = `SELECT c.id, c.name, c.description, c.status, c.region_id, rg.name AS region_name,
  c.capo_id, cp.name AS capo_name, c.underboss_id, ub.name AS underboss_name, c.created_at, c.updated_at,
  (SELECT COUNT(*) FROM crew_memberships x WHERE x.crew_id = c.id AND x.left_at IS NULL AND x.membership_type = 'FORMAL') AS member_count
  FROM crews c LEFT JOIN regions rg ON rg.id = c.region_id LEFT JOIN members cp ON cp.id = c.capo_id LEFT JOIN members ub ON ub.id = c.underboss_id`;
const CREW_EXAMPLE = {
  id: 1, name: 'Brooklyn Crew', description: '브루클린 지역 운영 Crew', status: 'ACTIVE', regionId: 1, regionName: 'Brooklyn',
  capoId: 5, capoName: 'Tony Russo', underbossId: 3, underbossName: 'Marco Bellini', memberCount: 5,
};

async function getCrew(id, t = db) {
  const c = await t.one(`${CREW_SELECT} WHERE c.id = ?`, [id]);
  if (!c) throw E.notFound('Crew', id);
  return c;
}
async function getActiveCrew(id, t = db) {
  const c = await getCrew(id, t);
  if (c.status !== 'ACTIVE') throw E.state(`해산된 Crew(${c.name})입니다.`);
  return c;
}
async function assertViewCrew(user, crewId) {
  const visible = await scope.visibleCrewIds(user);
  if (visible !== null && !visible.includes(Number(crewId))) throw E.forbidden(`Crew(id=${crewId}) 조회 권한이 없습니다.`, 'BR-09');
}

/** 구성원 편성 공통 처리 (BR-01: 정식 소속 1개 제약) */
async function addMembership(t, actor, crew, member, type, reason) {
  if (['WITHDRAWN', 'SUSPENDED'].includes(member.status)) throw E.state(`${member.status} 상태의 구성원은 Crew 에 편성할 수 없습니다.`);
  const existing = await t.query('SELECT cm.crew_id, cm.membership_type, c.name FROM crew_memberships cm JOIN crews c ON c.id = cm.crew_id WHERE cm.member_id = ? AND cm.left_at IS NULL FOR UPDATE', [member.id]);
  if (existing.some((e) => e.crewId === crew.id)) throw E.conflict(`이미 ${crew.name} 에 소속되어 있습니다.`);
  const formal = existing.find((e) => e.membershipType === 'FORMAL');
  if (type === 'FORMAL' && formal) {
    throw E.rule('BR-01', `구성원은 동시에 둘 이상의 Crew 에 정식 소속될 수 없습니다. 현재 소속: ${formal.name}. 이동은 transfer API 를 사용하세요.`, { currentCrewId: formal.crewId });
  }
  await t.query('INSERT INTO crew_memberships (crew_id, member_id, membership_type, changed_by) VALUES (?,?,?,?)', [crew.id, member.id, type, actor.id]);
  await rec.memberHistory(member.id, 'CREW', null, crew.name, actor, reason, { crewId: crew.id, membershipType: type });
}

async function endMembership(t, actor, crew, memberId, reason) {
  const cm = await t.one('SELECT id, membership_type FROM crew_memberships WHERE crew_id = ? AND member_id = ? AND left_at IS NULL FOR UPDATE', [crew.id, memberId]);
  if (!cm) throw E.notFound(`${crew.name} 소속 구성원`, memberId);
  await t.query('UPDATE crew_memberships SET left_at = NOW(), left_reason = ?, changed_by = ? WHERE id = ?', [reason || 'REMOVED', actor.id, cm.id]);
  if (crew.capoId === Number(memberId)) await t.query('UPDATE crews SET capo_id = NULL WHERE id = ?', [crew.id]);
  return cm;
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '07. Crews', base: '/api/crews' });

  api.get('', {
    summary: 'Crew 목록/검색 (지역·상태·책임자 필터)',
    reqs: ['FR-05', 'FR-21', 'NFR-04'],
    query: {
      q: { type: 'string', desc: '이름 검색', example: 'Brooklyn' },
      regionId: { type: 'integer' },
      status: { type: 'string', enum: ['ACTIVE', 'DISSOLVED'] },
      capoId: { type: 'integer' }, underbossId: { type: 'integer' },
    },
    list: { sort: { id: 'c.id', name: 'c.name', createdAt: 'c.created_at', memberCount: 'member_count' }, defaultSort: 'id' },
    example: CREW_EXAMPLE,
  }, async (req) => {
    const where = [];
    const params = [];
    if (req.q.q) { where.push('c.name LIKE ?'); params.push(`%${req.q.q}%`); }
    for (const [k, col] of [['regionId', 'c.region_id'], ['status', 'c.status'], ['capoId', 'c.capo_id'], ['underbossId', 'c.underboss_id']]) {
      if (req.q[k]) { where.push(`${col} = ?`); params.push(req.q[k]); }
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await db.one(`SELECT COUNT(*) AS n FROM crews c ${w}`, params)).n;
    const rows = await db.query(`${CREW_SELECT} ${w} ORDER BY ${req.page.orderBy} LIMIT ? OFFSET ?`, [...params, req.page.size, req.page.offset]);
    return paged(rows, total, req.page);
  });

  api.get('/managed', {
    summary: '내가 관리할 수 있는 Crew 목록',
    reqs: ['FR-06', 'BR-05'],
    example: [CREW_EXAMPLE],
  }, async (req) => {
    const ids = await scope.managedCrewIds(req.user);
    if (ids === null) return db.query(`${CREW_SELECT} WHERE c.status = 'ACTIVE' ORDER BY c.id`);
    if (!ids.length) return [];
    return db.query(`${CREW_SELECT} WHERE c.id IN (?) ORDER BY c.id`, [ids]);
  });

  api.get('/:id', {
    summary: 'Crew 상세 (책임자, 감독자, 인원, 진행 업무 수)',
    reqs: ['FR-05'],
    params: idParam,
    example: { ...CREW_EXAMPLE, openTasks: 2, affiliateCount: 1 },
    errors: [404],
  }, async (req) => {
    const c = await getCrew(req.params.id);
    const extra = await db.one(
      `SELECT (SELECT COUNT(*) FROM tasks WHERE crew_id = ? AND status IN ('PLANNED','IN_PROGRESS','ON_HOLD')) AS open_tasks,
              (SELECT COUNT(*) FROM crew_memberships WHERE crew_id = ? AND left_at IS NULL AND membership_type = 'AFFILIATE') AS affiliate_count`,
      [c.id, c.id]
    );
    return { ...c, ...extra };
  });

  api.post('', {
    summary: 'Crew 생성',
    reqs: ['FR-05', 'FR-20'], perm: 'crew.create', status: 201,
    body: {
      name: { type: 'string', required: true, maxLength: 50, example: 'Queens Crew' },
      regionId: { type: 'integer', example: 1 },
      description: { type: 'string', maxLength: 255, example: '퀸즈 지역 신규 Crew' },
      underbossId: { type: 'integer', example: 4, desc: '감독 Underboss (선택)' },
    },
    example: { ...CREW_EXAMPLE, id: 4, name: 'Queens Crew', capoId: null, memberCount: 0 },
    errors: [{ status: 409, code: 'CONFLICT', message: '이미 존재하는 값입니다(중복).' }],
  }, async (req) => {
    if (req.body.underbossId) {
      const ub = await memberSvc.getMember(req.body.underbossId);
      if (ub.role !== 'UNDERBOSS' || ub.status !== 'ACTIVE') throw E.state('감독자는 활동중인 UNDERBOSS 여야 합니다.');
    }
    const r = await db.query('INSERT INTO crews (name, region_id, description, underboss_id) VALUES (?,?,?,?)',
      [req.body.name, req.body.regionId || null, req.body.description || null, req.body.underbossId || null]);
    await rec.audit(req.user, 'CREW_CREATED', 'crew', r.insertId, req.body, 'SUCCESS', req.ip);
    return getCrew(r.insertId);
  });

  api.patch('/:id', {
    summary: 'Crew 정보 수정 (이름/지역/설명)',
    reqs: ['FR-05', 'BR-05'], perm: 'crew.update', partial: true,
    params: idParam,
    body: {
      name: { type: 'string', maxLength: 50, example: 'Brooklyn Crew' },
      regionId: { type: 'integer', nullable: true, example: 1 },
      description: { type: 'string', maxLength: 255, nullable: true, example: '브루클린 및 인근 지역 담당' },
    },
    example: CREW_EXAMPLE,
    errors: [403, 404],
  }, async (req) => {
    const c = await getActiveCrew(req.params.id);
    await scope.assertManageCrew(req.user, c.id);
    const map = { name: 'name', regionId: 'region_id', description: 'description' };
    const keys = Object.keys(req.body);
    await db.query(`UPDATE crews SET ${keys.map((k) => `${map[k]} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => req.body[k]), c.id]);
    await rec.audit(req.user, 'CREW_UPDATED', 'crew', c.id, req.body, 'SUCCESS', req.ip);
    return getCrew(c.id);
  });

  api.delete('/:id', {
    summary: 'Crew 해산 (정식 구성원이 없고 진행 업무가 없을 때만)',
    reqs: ['FR-05', 'FR-20'], perm: 'crew.create',
    params: idParam,
    query: { reason: { type: 'string', maxLength: 255, example: '지역 통합' } },
    example: { ...CREW_EXAMPLE, status: 'DISSOLVED', memberCount: 0 },
    errors: [404, { status: 422, code: 'INVALID_STATE', message: '소속 구성원 또는 진행 중 업무가 있어 해산할 수 없습니다.' }],
  }, async (req) => {
    const c = await getActiveCrew(req.params.id);
    const busy = await db.one(
      `SELECT (SELECT COUNT(*) FROM crew_memberships WHERE crew_id = ? AND left_at IS NULL AND membership_type = 'FORMAL') AS members,
              (SELECT COUNT(*) FROM tasks WHERE crew_id = ? AND status IN ('PLANNED','IN_PROGRESS','ON_HOLD')) AS tasks`, [c.id, c.id]
    );
    if (busy.members || busy.tasks) throw E.state('소속 구성원 또는 진행 중 업무가 있어 해산할 수 없습니다.', busy);
    await db.tx(async (t) => {
      await t.query("UPDATE crew_memberships SET left_at = NOW(), left_reason = 'CREW_DISSOLVED', changed_by = ? WHERE crew_id = ? AND left_at IS NULL", [req.user.id, c.id]);
      await t.query("UPDATE crews SET status = 'DISSOLVED', capo_id = NULL WHERE id = ?", [c.id]);
    });
    await rec.audit(req.user, 'CREW_DISSOLVED', 'crew', c.id, { reason: req.q.reason }, 'SUCCESS', req.ip);
    return getCrew(c.id);
  });

  api.post('/:id/restore', {
    summary: '해산된 Crew 복구',
    reqs: ['FR-05', 'FR-20'], perm: 'crew.create',
    params: idParam,
    example: { ...CREW_EXAMPLE, status: 'ACTIVE' },
    errors: [404, 422],
  }, async (req) => {
    const c = await getCrew(req.params.id);
    if (c.status !== 'DISSOLVED') throw E.state('해산 상태의 Crew 만 복구할 수 있습니다.');
    await db.query("UPDATE crews SET status = 'ACTIVE' WHERE id = ?", [c.id]);
    await rec.audit(req.user, 'CREW_RESTORED', 'crew', c.id, {}, 'SUCCESS', req.ip);
    return getCrew(c.id);
  });

  api.put('/:id/capo', {
    summary: 'Crew 책임자(Capo) 지정',
    description: '지정 대상은 CAPO 역할의 활동중 구성원이어야 하며, 다른 Crew 에 정식 소속되어 있다면 이 Crew 로 이동된다(BR-01 유지). 기존 책임자는 해제된다.',
    reqs: ['FR-05', 'BR-01', 'BR-10'], perm: 'crew.appoint',
    params: idParam,
    body: { memberId: { type: 'integer', required: true, example: 5 } },
    example: CREW_EXAMPLE,
    errors: [403, 404, 422],
  }, async (req) => {
    const c = await getActiveCrew(req.params.id);
    await scope.assertManageCrew(req.user, c.id);
    const m = await memberSvc.getMember(req.body.memberId);
    if (m.role !== 'CAPO') throw E.state(`Capo 로 지정하려면 대상의 역할이 CAPO 여야 합니다. (현재 ${m.role})`);
    if (m.status !== 'ACTIVE') throw E.state('활동중인 구성원만 책임자로 지정할 수 있습니다.');
    const other = await db.one("SELECT id, name FROM crews WHERE capo_id = ? AND id <> ? AND status = 'ACTIVE'", [m.id, c.id]);
    if (other) throw E.conflict(`이미 다른 Crew(${other.name})의 책임자입니다.`);
    await db.tx(async (t) => {
      const cur = await t.one("SELECT crew_id FROM crew_memberships WHERE member_id = ? AND left_at IS NULL AND membership_type = 'FORMAL' FOR UPDATE", [m.id]);
      if (!cur || cur.crewId !== c.id) {
        if (cur) {
          const from = await getCrew(cur.crewId, t);
          await endMembership(t, req.user, from, m.id, `TRANSFER_TO_${c.id}`);
        }
        await addMembership(t, req.user, c, m, 'FORMAL', '책임자 지정');
      }
      await t.query('UPDATE crews SET capo_id = ? WHERE id = ?', [m.id, c.id]);
    });
    await rec.memberHistory(m.id, 'CREW', null, `${c.name} Capo`, req.user, '책임자 지정', { crewId: c.id, position: 'CAPO' });
    await rec.audit(req.user, 'CREW_CAPO_APPOINTED', 'crew', c.id, { from: c.capoId, to: m.id }, 'SUCCESS', req.ip);
    await rec.notify(m.id, 'CREW_CHANGED', '책임자 지정', `${c.name} 의 책임자로 지정되었습니다.`);
    return getCrew(c.id);
  });

  api.delete('/:id/capo', {
    summary: 'Crew 책임자 해제 (공석 처리)',
    reqs: ['FR-05', 'BR-10'], perm: 'crew.appoint',
    params: idParam,
    example: { ...CREW_EXAMPLE, capoId: null, capoName: null },
    errors: [403, 404, 422],
  }, async (req) => {
    const c = await getActiveCrew(req.params.id);
    await scope.assertManageCrew(req.user, c.id);
    if (!c.capoId) throw E.state('책임자가 지정되어 있지 않습니다.');
    if (c.capoId === req.user.id) throw E.forbidden('자기 자신의 책임자 지위는 해제할 수 없습니다.', 'BR-04');
    await db.query('UPDATE crews SET capo_id = NULL WHERE id = ?', [c.id]);
    await rec.memberHistory(c.capoId, 'CREW', `${c.name} Capo`, null, req.user, '책임자 해제', { crewId: c.id });
    await rec.audit(req.user, 'CREW_CAPO_REMOVED', 'crew', c.id, { capoId: c.capoId }, 'SUCCESS', req.ip);
    return getCrew(c.id);
  });

  api.put('/:id/underboss', {
    summary: 'Crew 감독 Underboss 지정/변경',
    reqs: ['FR-05', 'FR-06'], perm: 'crew.create',
    params: idParam,
    body: { memberId: { type: 'integer', required: true, nullable: true, example: 4, desc: 'null 이면 감독자 해제' } },
    example: { ...CREW_EXAMPLE, underbossId: 4, underbossName: 'Luca Ferraro' },
    errors: [404, 422],
  }, async (req) => {
    const c = await getActiveCrew(req.params.id);
    if (req.body.memberId !== null) {
      const m = await memberSvc.getMember(req.body.memberId);
      if (m.role !== 'UNDERBOSS' || m.status !== 'ACTIVE') throw E.state('감독자는 활동중인 UNDERBOSS 여야 합니다.');
    }
    await db.query('UPDATE crews SET underboss_id = ? WHERE id = ?', [req.body.memberId, c.id]);
    await rec.audit(req.user, 'CREW_UNDERBOSS_CHANGED', 'crew', c.id, { from: c.underbossId, to: req.body.memberId }, 'SUCCESS', req.ip);
    return getCrew(c.id);
  });

  api.get('/:id/members', {
    summary: 'Crew 구성원 목록 (정식/준소속 구분)',
    reqs: ['FR-05', 'FR-02'],
    params: idParam,
    query: { membershipType: { type: 'string', enum: ['FORMAL', 'AFFILIATE'] }, status: { type: 'string', enum: memberSvc.STATUSES } },
    example: [{ memberId: 8, username: 'soldier1', name: 'Paulie Conti', role: 'SOLDIER', status: 'ACTIVE', membershipType: 'FORMAL', joinedAt: '2026-04-01T00:00:00.000Z', isCapo: false }],
    errors: [403, 404],
  }, async (req) => {
    const c = await getCrew(req.params.id);
    await assertViewCrew(req.user, c.id);
    const where = ['cm.crew_id = ?', 'cm.left_at IS NULL'];
    const params = [c.id];
    if (req.q.membershipType) { where.push('cm.membership_type = ?'); params.push(req.q.membershipType); }
    if (req.q.status) { where.push('m.status = ?'); params.push(req.q.status); }
    const rows = await db.query(
      `SELECT m.id AS member_id, m.username, m.name, m.alias, r.code AS role, m.status, cm.membership_type, cm.joined_at
         FROM crew_memberships cm JOIN members m ON m.id = cm.member_id JOIN roles r ON r.id = m.role_id
        WHERE ${where.join(' AND ')} ORDER BY r.level DESC, m.name`, params
    );
    return rows.map((r) => ({ ...r, isCapo: r.memberId === c.capoId }));
  });

  api.post('/:id/members', {
    summary: 'Crew 에 구성원 편성 (정식/준소속)',
    description: 'BR-01: 정식(FORMAL) 소속은 1개만 가능. BR-05: 요청자가 관리하는 Crew 에만 편성 가능. 다른 Crew 정식 소속자는 transfer API 로 이동해야 한다.',
    reqs: ['FR-06', 'BR-01', 'BR-05', 'BR-10'], perm: 'crew.members', status: 201,
    params: idParam,
    body: {
      memberId: { type: 'integer', required: true, example: 17 },
      membershipType: { type: 'string', enum: ['FORMAL', 'AFFILIATE'], default: 'FORMAL', example: 'FORMAL' },
      reason: { type: 'string', maxLength: 255, example: '신규 편성' },
    },
    example: { crewId: 1, memberId: 17, membershipType: 'FORMAL' },
    errors: [403, 404, { status: 409, rule: 'BR-01', message: '구성원은 동시에 둘 이상의 Crew 에 정식 소속될 수 없습니다.' }],
    verify: 'capo1 로그인 → POST /api/crews/1/members {memberId:10} (Harbor 정식 소속) → 409 BR-01 / capo1 → POST /api/crews/2/members → 403 BR-05',
  }, async (req) => {
    const c = await getActiveCrew(req.params.id);
    await scope.assertManageCrew(req.user, c.id, 'BR-05');
    const m = await memberSvc.getMember(req.body.memberId);
    await db.tx((t) => addMembership(t, req.user, c, m, req.body.membershipType, req.body.reason || '편성'));
    await rec.audit(req.user, 'CREW_MEMBER_ADDED', 'crew', c.id, { memberId: m.id, membershipType: req.body.membershipType }, 'SUCCESS', req.ip);
    await rec.notify(m.id, 'CREW_CHANGED', 'Crew 편성', `${c.name} 에 ${req.body.membershipType === 'FORMAL' ? '정식' : '준'}소속으로 편성되었습니다.`);
    return { crewId: c.id, memberId: m.id, membershipType: req.body.membershipType };
  });

  api.delete('/:id/members/:memberId', {
    summary: 'Crew 에서 구성원 제외',
    reqs: ['FR-06', 'BR-05', 'BR-10'], perm: 'crew.members',
    params: { ...idParam, memberId: { type: 'integer', example: 9 } },
    query: { reason: { type: 'string', maxLength: 255, example: '편성 조정' } },
    example: { crewId: 1, memberId: 9, removed: true },
    errors: [403, 404],
  }, async (req) => {
    const c = await getActiveCrew(req.params.id);
    await scope.assertManageCrew(req.user, c.id, 'BR-05');
    const m = await memberSvc.getMember(req.params.memberId);
    if (m.id === req.user.id) throw E.forbidden('자기 자신을 Crew 에서 제외할 수 없습니다.', 'BR-04');
    memberSvc.assertHigherThan(req.user, m, '소속');
    await db.tx((t) => endMembership(t, req.user, c, m.id, req.q.reason || 'REMOVED'));
    await rec.memberHistory(m.id, 'CREW', c.name, null, req.user, req.q.reason || '제외', { crewId: c.id });
    await rec.audit(req.user, 'CREW_MEMBER_REMOVED', 'crew', c.id, { memberId: m.id, reason: req.q.reason }, 'SUCCESS', req.ip);
    return { crewId: c.id, memberId: m.id, removed: true };
  });

  api.post('/:id/members/:memberId/transfer', {
    summary: '구성원을 다른 Crew 로 이동 (정식 소속 원자적 변경)',
    description: '출발/도착 Crew 모두 요청자의 관리 범위여야 한다(BR-05). 소속 종료와 신규 소속이 하나의 트랜잭션으로 처리되어 BR-01 이 항상 유지된다.',
    reqs: ['FR-03', 'FR-06', 'BR-01', 'BR-05', 'BR-10'], perm: 'crew.members',
    params: { ...idParam, memberId: { type: 'integer', example: 9 } },
    body: {
      targetCrewId: { type: 'integer', required: true, example: 2 },
      reason: { type: 'string', maxLength: 255, example: '항만 인력 보강' },
    },
    example: { memberId: 9, fromCrewId: 1, toCrewId: 2 },
    errors: [403, 404, 409, 422],
  }, async (req) => {
    const from = await getActiveCrew(req.params.id);
    const to = await getActiveCrew(req.body.targetCrewId);
    if (from.id === to.id) throw E.badRequest('같은 Crew 로는 이동할 수 없습니다.');
    await scope.assertManageCrew(req.user, from.id, 'BR-05');
    await scope.assertManageCrew(req.user, to.id, 'BR-05');
    const m = await memberSvc.getMember(req.params.memberId);
    memberSvc.assertHigherThan(req.user, m, '소속');
    await db.tx(async (t) => {
      const cm = await endMembership(t, req.user, from, m.id, `TRANSFER_TO_${to.id}`);
      if (cm.membershipType !== 'FORMAL') throw E.state('정식 소속 구성원만 이동할 수 있습니다.');
      await t.query("UPDATE crew_memberships SET left_at = NOW(), left_reason = 'TRANSFER', changed_by = ? WHERE crew_id = ? AND member_id = ? AND left_at IS NULL", [req.user.id, to.id, m.id]);
      await addMembership(t, req.user, to, m, 'FORMAL', req.body.reason || `${from.name} → ${to.name} 이동`);
    });
    await rec.audit(req.user, 'CREW_MEMBER_TRANSFERRED', 'member', m.id, { from: from.id, to: to.id, reason: req.body.reason }, 'SUCCESS', req.ip);
    await rec.notify(m.id, 'CREW_CHANGED', 'Crew 이동', `${from.name} → ${to.name} 로 이동되었습니다.`);
    return { memberId: m.id, fromCrewId: from.id, toCrewId: to.id };
  });

  api.get('/:id/membership-history', {
    summary: 'Crew 구성원 편성 변경 이력 (가입/제외/이동)',
    reqs: ['FR-06', 'BR-10', 'FR-19'],
    params: idParam,
    query: { from: { type: 'datetime' }, to: { type: 'datetime' } },
    list: { sort: { joinedAt: 'cm.joined_at', leftAt: 'cm.left_at' }, defaultSort: '-joinedAt' },
    example: { id: 1, memberId: 8, memberName: 'Paulie Conti', membershipType: 'FORMAL', joinedAt: '2026-04-01T00:00:00.000Z', leftAt: null, leftReason: null, changedBy: 'boss' },
    errors: [403, 404],
  }, async (req) => {
    const c = await getCrew(req.params.id);
    await scope.assertManageCrew(req.user, c.id, 'BR-09');
    const where = ['cm.crew_id = ?'];
    const params = [c.id];
    if (req.q.from) { where.push('(cm.joined_at >= ? OR cm.left_at >= ?)'); params.push(req.q.from, req.q.from); }
    if (req.q.to) { where.push('cm.joined_at <= ?'); params.push(req.q.to); }
    const w = where.join(' AND ');
    const total = (await db.one(`SELECT COUNT(*) AS n FROM crew_memberships cm WHERE ${w}`, params)).n;
    const rows = await db.query(
      `SELECT cm.id, cm.member_id, m.name AS member_name, cm.membership_type, cm.joined_at, cm.left_at, cm.left_reason, cb.username AS changed_by
         FROM crew_memberships cm JOIN members m ON m.id = cm.member_id LEFT JOIN members cb ON cb.id = cm.changed_by
        WHERE ${w} ORDER BY ${req.page.orderBy} LIMIT ? OFFSET ?`, [...params, req.page.size, req.page.offset]
    );
    return paged(rows, total, req.page);
  });

  api.get('/:id/stats', {
    summary: 'Crew 운영 현황 (구성원 상태 분포, 업무 상태 분포, 완료율, 평균 기여도)',
    reqs: ['FR-22', 'FR-05', 'FR-11'],
    params: idParam,
    query: { from: { type: 'datetime', desc: '업무 집계 시작' }, to: { type: 'datetime', desc: '업무 집계 종료' } },
    example: { crewId: 1, membersByStatus: { ACTIVE: 4, SUSPENDED: 1 }, tasksByStatus: { PLANNED: 2, COMPLETED: 6 }, completionRate: 75, successRate: 66.7, avgContribution: 72.5, resources: 2 },
    errors: [403, 404],
  }, async (req) => {
    const c = await getCrew(req.params.id);
    await scope.assertManageCrew(req.user, c.id, 'BR-09');
    const tw = ['crew_id = ?'];
    const tp = [c.id];
    if (req.q.from) { tw.push('start_at >= ?'); tp.push(req.q.from); }
    if (req.q.to) { tw.push('start_at <= ?'); tp.push(req.q.to); }
    const [ms, ts, outc, contrib, res] = await Promise.all([
      db.query('SELECT m.status, COUNT(*) AS n FROM crew_memberships cm JOIN members m ON m.id = cm.member_id WHERE cm.crew_id = ? AND cm.left_at IS NULL GROUP BY m.status', [c.id]),
      db.query(`SELECT status, COUNT(*) AS n FROM tasks WHERE ${tw.join(' AND ')} GROUP BY status`, tp),
      db.query(`SELECT result_outcome, COUNT(*) AS n FROM tasks WHERE ${tw.join(' AND ')} AND status = 'COMPLETED' GROUP BY result_outcome`, tp),
      db.one(`SELECT AVG(a.contribution) AS avg FROM task_assignments a JOIN tasks t ON t.id = a.task_id WHERE t.crew_id = ? AND a.contribution IS NOT NULL`, [c.id]),
      db.one('SELECT COUNT(*) AS n FROM resources WHERE crew_id = ? AND status <> \'RETIRED\'', [c.id]),
    ]);
    const tasksByStatus = Object.fromEntries(ts.map((r) => [r.status, r.n]));
    const done = tasksByStatus.COMPLETED || 0;
    const closed = done + (tasksByStatus.CANCELLED || 0);
    const success = (outc.find((o) => o.resultOutcome === 'SUCCESS') || { n: 0 }).n;
    return {
      crewId: c.id, crewName: c.name,
      membersByStatus: Object.fromEntries(ms.map((r) => [r.status, r.n])),
      tasksByStatus,
      outcomes: Object.fromEntries(outc.map((r) => [r.resultOutcome, r.n])),
      completionRate: closed ? Math.round((done / closed) * 1000) / 10 : null,
      successRate: done ? Math.round((success / done) * 1000) / 10 : null,
      avgContribution: contrib.avg === null ? null : Math.round(Number(contrib.avg) * 10) / 10,
      resources: res.n,
    };
  });
};

module.exports.helpers = { getCrew, getActiveCrew, addMembership, assertViewCrew };
