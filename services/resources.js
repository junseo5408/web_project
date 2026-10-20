/**
 * 공용 자원 관련 업무 규칙 (FR-13~FR-17, BR-07, BR-08)
 */
const db = require('../db/mysql');
const E = require('../lib/errors');
const rec = require('../lib/records');

const STATUSES = ['AVAILABLE', 'IN_USE', 'NEEDS_INSPECTION', 'MAINTENANCE', 'UNAVAILABLE', 'RETIRED'];
/** FR-16: 사용 불가 / 점검 필요 자원 - 새 배정 불가 (BR-08) */
const BLOCKED = ['NEEDS_INSPECTION', 'MAINTENANCE', 'UNAVAILABLE', 'RETIRED'];
/** 관리자가 수동으로 지정할 수 있는 상태 (IN_USE 는 체크아웃/반납으로 자동 관리) */
const MANUAL_TRANSITIONS = {
  AVAILABLE: ['NEEDS_INSPECTION', 'MAINTENANCE', 'UNAVAILABLE', 'RETIRED'],
  IN_USE: ['NEEDS_INSPECTION', 'UNAVAILABLE'],
  NEEDS_INSPECTION: ['AVAILABLE', 'MAINTENANCE', 'UNAVAILABLE', 'RETIRED'],
  MAINTENANCE: ['AVAILABLE', 'NEEDS_INSPECTION', 'UNAVAILABLE', 'RETIRED'],
  UNAVAILABLE: ['AVAILABLE', 'MAINTENANCE', 'RETIRED'],
  RETIRED: [],
};
const ACTIVE_ALLOC = ['RESERVED', 'IN_USE'];

const RESOURCE_COLUMNS = `r.id, r.code, r.name, r.type_id, rt.code AS type_code, rt.name AS type_name, r.crew_id, c.name AS crew_name,
  r.status, r.location, r.min_role_level, r.description, r.created_at, r.updated_at`;
const RESOURCE_FROM = 'resources r JOIN resource_types rt ON rt.id = r.type_id LEFT JOIN crews c ON c.id = r.crew_id';

async function getResource(id, t = db, { lock = false } = {}) {
  if (lock) await t.query('SELECT id FROM resources WHERE id = ? FOR UPDATE', [id]);
  const r = await t.one(`SELECT ${RESOURCE_COLUMNS} FROM ${RESOURCE_FROM} WHERE r.id = ?`, [id]);
  if (!r) throw E.notFound('자원', id);
  return r;
}

/** BR-07: 동일 자원의 동일 시간대 활성 배정 */
async function findAllocationConflicts(t, resourceId, startAt, endAt, excludeIds = []) {
  return t.query(
    `SELECT id, task_id, member_id, start_at, end_at, status FROM resource_allocations
      WHERE resource_id = ? AND status IN ('RESERVED','IN_USE') AND start_at < ? AND end_at > ?
        AND id NOT IN (?)`,
    [resourceId, endAt, startAt, excludeIds.length ? excludeIds : [0]]
  );
}

/** 자원 배정 생성 (FR-17, BR-07, BR-08) - 트랜잭션 내부에서 호출 */
async function allocate(t, actor, { resourceId, taskId = null, memberId = null, startAt, endAt, purpose = null }) {
  const resource = await getResource(resourceId, t, { lock: true });
  if (BLOCKED.includes(resource.status)) {
    throw E.rule('BR-08', `사용 불가 상태(${resource.status})의 자원은 배정할 수 없습니다.`, { resourceId, status: resource.status });
  }
  if (!taskId && !memberId) throw E.badRequest('taskId 또는 memberId 중 하나는 필요합니다.');
  if (taskId) {
    const task = await t.one('SELECT id, status, start_at, end_at FROM tasks WHERE id = ?', [taskId]);
    if (!task) throw E.notFound('업무', taskId);
    if (!['PLANNED', 'IN_PROGRESS', 'ON_HOLD'].includes(task.status)) throw E.state(`${task.status} 상태의 업무에는 자원을 배정할 수 없습니다.`);
    startAt = startAt || task.startAt;
    endAt = endAt || task.endAt;
  }
  if (memberId) {
    const m = await t.one('SELECT id, status FROM members WHERE id = ?', [memberId]);
    if (!m) throw E.notFound('구성원', memberId);
    if (['SUSPENDED', 'WITHDRAWN', 'PENDING'].includes(m.status)) {
      throw E.rule('BR-02', `${m.status} 상태의 구성원에게는 자원을 배정할 수 없습니다.`, { memberId });
    }
  }
  if (!startAt || !endAt) throw E.badRequest('startAt, endAt 이 필요합니다.');
  if (new Date(startAt) >= new Date(endAt)) throw E.badRequest('endAt 은 startAt 보다 이후여야 합니다.');

  const conflicts = await findAllocationConflicts(t, resourceId, startAt, endAt);
  if (conflicts.length) {
    throw E.rule('BR-07', `자원(${resource.name})은 해당 시간대에 이미 배정되어 있습니다.`, { resourceId, conflicts });
  }
  const r = await t.query(
    `INSERT INTO resource_allocations (resource_id, task_id, member_id, start_at, end_at, purpose, allocated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [resourceId, taskId, memberId, new Date(startAt), new Date(endAt), purpose, actor.id]
  );
  await rec.resourceHistory(resourceId, 'ALLOCATED', null, 'RESERVED', actor, { allocationId: r.insertId, taskId, memberId, startAt, endAt });
  return getAllocation(r.insertId, t);
}

async function getAllocation(id, t = db) {
  const a = await t.one(
    `SELECT a.*, r.name AS resource_name, r.code AS resource_code, tk.title AS task_title, m.name AS member_name
       FROM resource_allocations a JOIN resources r ON r.id = a.resource_id
       LEFT JOIN tasks tk ON tk.id = a.task_id LEFT JOIN members m ON m.id = a.member_id
      WHERE a.id = ?`,
    [id]
  );
  if (!a) throw E.notFound('자원 배정', id);
  return a;
}

/** 체크아웃/반납 이후 자원 상태 동기화 */
async function syncInUse(t, resourceId, actor) {
  const r = await t.one('SELECT status FROM resources WHERE id = ?', [resourceId]);
  const inUse = await t.one("SELECT COUNT(*) AS n FROM resource_allocations WHERE resource_id = ? AND status = 'IN_USE'", [resourceId]);
  let next = r.status;
  if (inUse.n > 0 && r.status === 'AVAILABLE') next = 'IN_USE';
  if (inUse.n === 0 && r.status === 'IN_USE') next = 'AVAILABLE';
  if (next !== r.status) {
    await t.query('UPDATE resources SET status = ? WHERE id = ?', [next, resourceId]);
    await rec.resourceHistory(resourceId, 'STATUS_CHANGED', r.status, next, actor, { auto: true });
  }
  return next;
}

module.exports = {
  STATUSES, BLOCKED, MANUAL_TRANSITIONS, ACTIVE_ALLOC, RESOURCE_COLUMNS, RESOURCE_FROM,
  getResource, findAllocationConflicts, allocate, getAllocation, syncInUse,
};
