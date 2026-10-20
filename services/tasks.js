/**
 * 업무 관련 업무 규칙 (FR-07~FR-12, BR-02, BR-03, BR-06)
 */
const db = require('../db/mysql');
const E = require('../lib/errors');
const scope = require('./scope');
const { getSettings } = require('./settings');

const STATUSES = ['PLANNED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];
const OPEN_STATUSES = ['PLANNED', 'IN_PROGRESS', 'ON_HOLD'];
/** 진행 상태 전이 규칙 (COMPLETED 는 결과 입력이 필요한 /complete API 로만 가능) */
const TRANSITIONS = {
  PLANNED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'CANCELLED'],
  ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: ['PLANNED'],
};

const TASK_COLUMNS = `t.id, t.title, t.description, t.crew_id, c.name AS crew_name, t.priority, t.status, t.start_at, t.end_at,
  t.location, t.allow_concurrent, t.required_skills, t.result_outcome, t.result_summary, t.result_value,
  t.completed_at, t.completed_by, t.created_by, t.created_at, t.updated_at`;

async function getTask(id, t = db, { lock = false } = {}) {
  const task = await t.one(
    `SELECT ${TASK_COLUMNS} FROM tasks t JOIN crews c ON c.id = t.crew_id WHERE t.id = ?${lock ? ' FOR UPDATE' : ''}`,
    [id]
  );
  if (!task) throw E.notFound('업무', id);
  return task;
}

/** 업무 조회 권한: 관리 범위 Crew, 배정된 본인, 같은 Crew 의 Soldier */
async function canViewTask(user, task) {
  if (await scope.canManageCrew(user, task.crewId)) return true;
  const a = await db.one("SELECT id FROM task_assignments WHERE task_id = ? AND member_id = ? AND status <> 'REMOVED'", [task.id, user.id]);
  if (a) return true;
  return user.role === 'SOLDIER' && user.crewId === task.crewId;
}

async function getVisibleTask(user, id) {
  const task = await getTask(id);
  if (!(await canViewTask(user, task))) throw E.forbidden(`업무(id=${id})를 조회할 권한이 없습니다.`, 'BR-09');
  return task;
}

async function getManagedTask(user, id, t = db, opts) {
  const task = await getTask(id, t, opts);
  await scope.assertManageCrew(user, task.crewId, 'BR-09');
  return task;
}

/** SQL 조건: 사용자가 볼 수 있는 업무 */
async function visibilityFilter(user, alias = 't') {
  const managed = await scope.managedCrewIds(user);
  if (managed === null) return { sql: '1=1', params: [] };
  const parts = [`EXISTS (SELECT 1 FROM task_assignments va WHERE va.task_id = ${alias}.id AND va.member_id = ? AND va.status <> 'REMOVED')`];
  const params = [user.id];
  if (managed.length) { parts.push(`${alias}.crew_id IN (?)`); params.push(managed); }
  if (user.role === 'SOLDIER' && user.crewId) { parts.push(`${alias}.crew_id = ?`); params.push(user.crewId); }
  return { sql: `(${parts.join(' OR ')})`, params };
}

/** BR-03: 구성원의 기존 배정 중 동일 시간대에 겹치는(동시 수행 불가) 업무 */
async function findScheduleConflicts(t, memberId, startAt, endAt, allowConcurrent, excludeTaskId = 0) {
  return t.query(
    `SELECT t.id AS task_id, t.title, t.start_at, t.end_at, t.allow_concurrent
       FROM task_assignments a JOIN tasks t ON t.id = a.task_id
      WHERE a.member_id = ? AND a.status IN ('ASSIGNED','ACCEPTED')
        AND t.status IN ('PLANNED','IN_PROGRESS','ON_HOLD')
        AND t.start_at < ? AND t.end_at > ? AND t.id <> ?
        AND NOT (t.allow_concurrent = 1 AND ? = 1)`,
    [memberId, endAt, startAt, excludeTaskId, allowConcurrent ? 1 : 0]
  );
}

/** 배정 가능 여부 검사 (BR-02, BR-03, 최대 동시 배정 수) - member 행은 FOR UPDATE 로 잠근 상태여야 함 */
async function assertAssignable(t, member, task) {
  if (!['ACTIVE', 'STANDBY'].includes(member.status)) {
    throw E.rule('BR-02', `${member.status} 상태의 구성원(${member.name})은 새로운 업무에 배정될 수 없습니다.`, { memberId: member.id, status: member.status });
  }
  if (!OPEN_STATUSES.includes(task.status)) {
    throw E.state(`${task.status} 상태의 업무에는 구성원을 배정할 수 없습니다.`);
  }
  const conflicts = await findScheduleConflicts(t, member.id, task.startAt, task.endAt, task.allowConcurrent, task.id);
  if (conflicts.length) {
    throw E.rule('BR-03', `구성원(${member.name})에게 동일 시간대에 이미 배정된 업무가 있습니다.`, { memberId: member.id, conflicts });
  }
  const { maxActiveAssignmentsPerMember } = await getSettings();
  const cnt = await t.one(
    `SELECT COUNT(*) AS n FROM task_assignments a JOIN tasks t ON t.id = a.task_id
      WHERE a.member_id = ? AND a.status IN ('ASSIGNED','ACCEPTED') AND t.status IN ('PLANNED','IN_PROGRESS','ON_HOLD')`,
    [member.id]
  );
  if (cnt.n >= maxActiveAssignmentsPerMember) {
    throw E.conflict(`구성원의 진행 중 업무가 최대치(${maxActiveAssignmentsPerMember})에 도달했습니다.`, { setting: 'maxActiveAssignmentsPerMember' });
  }
}

/** 업무 생성 (업무 등록 / 복제 / 템플릿 공통) */
async function createTask(t, user, d) {
  await scope.assertManageCrew(user, d.crewId, 'BR-09');
  const crew = await t.one("SELECT id FROM crews WHERE id = ? AND status = 'ACTIVE'", [d.crewId]);
  if (!crew) throw E.notFound('활성 Crew', d.crewId);
  if (new Date(d.endAt) <= new Date(d.startAt)) throw E.badRequest('endAt 은 startAt 이후여야 합니다.');
  const r = await t.query(
    `INSERT INTO tasks (title, description, crew_id, priority, start_at, end_at, location, allow_concurrent, required_skills, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [d.title, d.description || null, d.crewId, d.priority || 'NORMAL', new Date(d.startAt), new Date(d.endAt), d.location || null,
      d.allowConcurrent ? 1 : 0, JSON.stringify(d.requiredSkills || []), user.id]
  );
  return r.insertId;
}

async function activeAssigneeIds(taskId, t = db) {
  const rows = await t.query("SELECT member_id FROM task_assignments WHERE task_id = ? AND status IN ('ASSIGNED','ACCEPTED')", [taskId]);
  return rows.map((r) => r.memberId);
}

module.exports = {
  STATUSES, PRIORITIES, OPEN_STATUSES, TRANSITIONS, TASK_COLUMNS,
  getTask, canViewTask, getVisibleTask, getManagedTask, visibilityFilter,
  findScheduleConflicts, assertAssignable, activeAssigneeIds, createTask,
};
