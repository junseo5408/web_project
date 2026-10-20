/** 회의 관리 (SQL: 회의/참석자, MongoDB: 회의록) - Crew 운영 활동 */
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const E = require('../lib/errors');
const rec = require('../lib/records');
const { defineModule, paged } = require('../lib/api');
const scope = require('../services/scope');

const idParam = { id: { type: 'integer', example: 1, desc: '회의 ID' } };
const EXAMPLE = {
  id: 1, title: 'Brooklyn 주간 회의', agenda: '이번 주 업무 배정', crewId: 1, crewName: 'Brooklyn Crew', location: 'Brooklyn 본부',
  startAt: '2026-10-20T18:00:00.000Z', endAt: '2026-10-20T19:00:00.000Z', status: 'SCHEDULED', organizerId: 5, organizerName: 'Tony Russo', attendeeCount: 4,
};
const SELECT = `SELECT mt.*, c.name AS crew_name, o.name AS organizer_name,
  (SELECT COUNT(*) FROM meeting_attendees a WHERE a.meeting_id = mt.id) AS attendee_count
  FROM meetings mt LEFT JOIN crews c ON c.id = mt.crew_id JOIN members o ON o.id = mt.organizer_id`;

async function getMeeting(id) {
  const m = await db.one(`${SELECT} WHERE mt.id = ?`, [id]);
  if (!m) throw E.notFound('회의', id);
  return m;
}
async function canView(user, m) {
  if (m.organizerId === user.id) return true;
  if (await db.one('SELECT 1 AS x FROM meeting_attendees WHERE meeting_id = ? AND member_id = ?', [m.id, user.id])) return true;
  return m.crewId ? scope.canManageCrew(user, m.crewId) : scope.isAll(user);
}
async function assertManage(user, m) {
  if (m.organizerId === user.id) return;
  if (m.crewId && (await scope.canManageCrew(user, m.crewId))) return;
  if (!m.crewId && scope.isAll(user)) return;
  throw E.forbidden('회의를 관리할 권한이 없습니다.');
}
function assertScheduled(m) {
  if (m.status !== 'SCHEDULED') throw E.state(`${m.status} 상태의 회의는 변경할 수 없습니다.`);
}

module.exports = (app) => {
  const api = defineModule(app, { tag: '15. Meetings', base: '/api/meetings' });

  api.get('', {
    summary: '회의 목록 (내가 참석/주관하거나 관리 Crew 회의)',
    reqs: ['FR-21', 'FR-09'],
    query: { from: { type: 'datetime' }, to: { type: 'datetime' }, crewId: { type: 'integer' }, status: { type: 'string', enum: ['SCHEDULED', 'CANCELLED', 'DONE'] } },
    list: { sort: { startAt: 'mt.start_at', id: 'mt.id' }, defaultSort: 'startAt' },
    example: EXAMPLE,
  }, async (req) => {
    const where = [];
    const params = [];
    const managed = await scope.managedCrewIds(req.user);
    if (managed !== null) {
      const parts = ['mt.organizer_id = ?', 'EXISTS (SELECT 1 FROM meeting_attendees a WHERE a.meeting_id = mt.id AND a.member_id = ?)'];
      params.push(req.user.id, req.user.id);
      if (managed.length) { parts.push('mt.crew_id IN (?)'); params.push(managed); }
      where.push(`(${parts.join(' OR ')})`);
    }
    if (req.q.from) { where.push('mt.end_at >= ?'); params.push(req.q.from); }
    if (req.q.to) { where.push('mt.start_at <= ?'); params.push(req.q.to); }
    if (req.q.crewId) { where.push('mt.crew_id = ?'); params.push(req.q.crewId); }
    if (req.q.status) { where.push('mt.status = ?'); params.push(req.q.status); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await db.one(`SELECT COUNT(*) AS n FROM meetings mt ${w}`, params)).n;
    const rows = await db.query(`${SELECT} ${w} ORDER BY ${req.page.orderBy} LIMIT ? OFFSET ?`, [...params, req.page.size, req.page.offset]);
    return paged(rows, total, req.page);
  });

  api.get('/:id', {
    summary: '회의 상세 (참석자 응답 현황, 회의록 포함)',
    reqs: ['FR-09'],
    params: idParam,
    example: { ...EXAMPLE, attendees: [{ memberId: 8, name: 'Paulie Conti', rsvp: 'YES' }], minutes: { content: '...', decisions: ['창고 점검 목요일 확정'] } },
    errors: [403, 404],
  }, async (req) => {
    const m = await getMeeting(req.params.id);
    if (!(await canView(req.user, m))) throw E.forbidden('회의 조회 권한이 없습니다.');
    const [attendees, minutes] = await Promise.all([
      db.query('SELECT a.member_id, mb.name, a.rsvp, a.responded_at FROM meeting_attendees a JOIN members mb ON mb.id = a.member_id WHERE a.meeting_id = ? ORDER BY mb.name', [m.id]),
      mongo.col('meetingMinutes').findOne({ meetingId: m.id }, { projection: { _id: 0 } }),
    ]);
    return { ...m, attendees, minutes };
  });

  api.post('', {
    summary: '회의 생성 (참석자 초대 및 알림)',
    reqs: ['FR-05', 'FR-09'], perm: 'meeting.manage', status: 201,
    body: {
      title: { type: 'string', required: true, maxLength: 100, example: 'Harbor 긴급 회의' },
      agenda: { type: 'string', maxLength: 2000, example: '항만 출입 절차 변경 대응' },
      crewId: { type: 'integer', example: 2 },
      location: { type: 'string', maxLength: 100, example: 'Harbor 사무실' },
      startAt: { type: 'datetime', required: true, example: '2026-10-21T18:00:00Z' },
      endAt: { type: 'datetime', required: true, example: '2026-10-21T19:00:00Z' },
      attendeeIds: { type: 'array', items: 'integer', maxItems: 100, example: [10, 11] },
    },
    example: EXAMPLE,
    errors: [403],
  }, async (req) => {
    const b = req.body;
    if (b.endAt <= b.startAt) throw E.badRequest('endAt 은 startAt 이후여야 합니다.');
    if (b.crewId) await scope.assertManageCrew(req.user, b.crewId);
    else if (!scope.isAll(req.user) && req.user.role !== 'UNDERBOSS') throw E.forbidden('Crew 를 지정하지 않은 회의는 Underboss 이상만 생성할 수 있습니다.');
    const id = await db.tx(async (t) => {
      const r = await t.query('INSERT INTO meetings (title, agenda, crew_id, location, start_at, end_at, organizer_id) VALUES (?,?,?,?,?,?,?)',
        [b.title, b.agenda || null, b.crewId || null, b.location || null, b.startAt, b.endAt, req.user.id]);
      const ids = [...new Set([req.user.id, ...(b.attendeeIds || [])])];
      const valid = await t.query("SELECT id FROM members WHERE id IN (?) AND status IN ('ACTIVE','STANDBY')", [ids]);
      if (valid.length !== ids.length) throw E.badRequest('참석자 중 존재하지 않거나 활동중이 아닌 구성원이 있습니다.');
      await t.query('INSERT INTO meeting_attendees (meeting_id, member_id, rsvp) VALUES ?', [ids.map((m) => [r.insertId, m, m === req.user.id ? 'YES' : 'PENDING'])]);
      return r.insertId;
    });
    await mongo.col('meetingMinutes').insertOne({ meetingId: id, content: '', decisions: [], updatedBy: null, updatedAt: new Date() });
    await rec.notify((b.attendeeIds || []).filter((x) => x !== req.user.id), 'MEETING', '회의 초대', `'${b.title}' 회의에 초대되었습니다.`, `/api/meetings/${id}`);
    return getMeeting(id);
  });

  api.patch('/:id', {
    summary: '회의 정보/일정 수정',
    reqs: ['FR-09'], perm: 'meeting.manage', partial: true,
    params: idParam,
    body: {
      title: { type: 'string', maxLength: 100 }, agenda: { type: 'string', maxLength: 2000, nullable: true },
      location: { type: 'string', maxLength: 100, nullable: true, example: 'Brooklyn 본부 2층' },
      startAt: { type: 'datetime' }, endAt: { type: 'datetime' },
    },
    example: EXAMPLE,
    errors: [403, 404, 422],
  }, async (req) => {
    const m = await getMeeting(req.params.id);
    await assertManage(req.user, m);
    assertScheduled(m);
    const start = req.body.startAt || m.startAt;
    const end = req.body.endAt || m.endAt;
    if (new Date(end) <= new Date(start)) throw E.badRequest('endAt 은 startAt 이후여야 합니다.');
    const col = { title: 'title', agenda: 'agenda', location: 'location', startAt: 'start_at', endAt: 'end_at' };
    const keys = Object.keys(req.body);
    await db.query(`UPDATE meetings SET ${keys.map((k) => `${col[k]} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => req.body[k]), m.id]);
    const att = await db.query('SELECT member_id FROM meeting_attendees WHERE meeting_id = ? AND member_id <> ?', [m.id, req.user.id]);
    await rec.notify(att.map((a) => a.memberId), 'MEETING', '회의 변경', `'${m.title}' 회의 정보가 변경되었습니다.`, `/api/meetings/${m.id}`);
    return getMeeting(m.id);
  });

  api.delete('/:id', {
    summary: '회의 취소',
    reqs: ['FR-09'], perm: 'meeting.manage',
    params: idParam,
    example: { ...EXAMPLE, status: 'CANCELLED' },
    errors: [403, 404, 422],
  }, async (req) => {
    const m = await getMeeting(req.params.id);
    await assertManage(req.user, m);
    assertScheduled(m);
    await db.query("UPDATE meetings SET status = 'CANCELLED' WHERE id = ?", [m.id]);
    const att = await db.query('SELECT member_id FROM meeting_attendees WHERE meeting_id = ? AND member_id <> ?', [m.id, req.user.id]);
    await rec.notify(att.map((a) => a.memberId), 'MEETING', '회의 취소', `'${m.title}' 회의가 취소되었습니다.`);
    return getMeeting(m.id);
  });

  api.post('/:id/attendees', {
    summary: '회의 참석자 추가',
    reqs: ['FR-09'], perm: 'meeting.manage', status: 201,
    params: idParam,
    body: { memberId: { type: 'integer', required: true, example: 15 } },
    example: { meetingId: 1, memberId: 15, rsvp: 'PENDING' },
    errors: [403, 404, 409, 422],
  }, async (req) => {
    const m = await getMeeting(req.params.id);
    await assertManage(req.user, m);
    assertScheduled(m);
    const mb = await db.one("SELECT id, status FROM members WHERE id = ?", [req.body.memberId]);
    if (!mb) throw E.notFound('구성원', req.body.memberId);
    if (!['ACTIVE', 'STANDBY'].includes(mb.status)) throw E.state(`${mb.status} 상태의 구성원은 초대할 수 없습니다.`);
    await db.query('INSERT INTO meeting_attendees (meeting_id, member_id) VALUES (?, ?)', [m.id, mb.id]);
    await rec.notify(mb.id, 'MEETING', '회의 초대', `'${m.title}' 회의에 초대되었습니다.`, `/api/meetings/${m.id}`);
    return { meetingId: m.id, memberId: mb.id, rsvp: 'PENDING' };
  });

  api.delete('/:id/attendees/:memberId', {
    summary: '회의 참석자 제외',
    reqs: ['FR-09'], perm: 'meeting.manage',
    params: { ...idParam, memberId: { type: 'integer', example: 15 } },
    example: { meetingId: 1, memberId: 15, removed: true },
    errors: [403, 404],
  }, async (req) => {
    const m = await getMeeting(req.params.id);
    await assertManage(req.user, m);
    assertScheduled(m);
    if (req.params.memberId === m.organizerId) throw E.state('주관자는 제외할 수 없습니다.');
    const r = await db.query('DELETE FROM meeting_attendees WHERE meeting_id = ? AND member_id = ?', [m.id, req.params.memberId]);
    if (!r.affectedRows) throw E.notFound('참석자', req.params.memberId);
    return { meetingId: m.id, memberId: req.params.memberId, removed: true };
  });

  api.post('/:id/rsvp', {
    summary: '회의 참석 여부 응답 (초대된 본인)',
    reqs: ['FR-09'],
    params: idParam,
    body: { rsvp: { type: 'string', required: true, enum: ['YES', 'NO', 'MAYBE'], example: 'YES' } },
    example: { meetingId: 1, memberId: 8, rsvp: 'YES' },
    errors: [403, 404, 422],
  }, async (req) => {
    const m = await getMeeting(req.params.id);
    assertScheduled(m);
    const r = await db.query('UPDATE meeting_attendees SET rsvp = ?, responded_at = NOW() WHERE meeting_id = ? AND member_id = ?', [req.body.rsvp, m.id, req.user.id]);
    if (!r.affectedRows) throw E.forbidden('초대받은 회의에만 응답할 수 있습니다.');
    return { meetingId: m.id, memberId: req.user.id, rsvp: req.body.rsvp };
  });

  api.put('/:id/minutes', {
    summary: '회의록 작성/갱신 (MongoDB, 결정사항 포함, 시작 이후 작성 시 DONE 처리)',
    reqs: ['DR-04', 'FR-20'], perm: 'meeting.manage',
    params: idParam,
    body: {
      content: { type: 'string', required: true, maxLength: 20000, example: '창고 점검 일정 및 인원 확정' },
      decisions: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 50, example: ['창고 점검 목요일 09시 확정', 'VH-001 차량 사용'] },
    },
    example: { meetingId: 1, content: '창고 점검 일정 및 인원 확정', decisions: ['창고 점검 목요일 09시 확정'], updatedBy: 'capo1', status: 'DONE' },
    errors: [403, 404, 422],
  }, async (req) => {
    const m = await getMeeting(req.params.id);
    await assertManage(req.user, m);
    if (m.status === 'CANCELLED') throw E.state('취소된 회의입니다.');
    await mongo.col('meetingMinutes').updateOne({ meetingId: m.id },
      { $set: { content: req.body.content, decisions: req.body.decisions || [], updatedBy: req.user.username, updatedAt: new Date() } }, { upsert: true });
    if (m.status === 'SCHEDULED' && new Date(m.startAt) <= new Date()) await db.query("UPDATE meetings SET status = 'DONE' WHERE id = ?", [m.id]);
    const after = await getMeeting(m.id);
    return { meetingId: m.id, content: req.body.content, decisions: req.body.decisions || [], updatedBy: req.user.username, status: after.status };
  });
};
