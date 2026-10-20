/**
 * 구성원 관련 업무 규칙 (FR-03, FR-04, BR-04, BR-10)
 */
const db = require('../db/mysql');
const E = require('../lib/errors');
const rec = require('../lib/records');
const scope = require('./scope');

/** 구성원 상태 체계 및 허용 전이 (FR-04) */
const STATUSES = ['PENDING', 'ACTIVE', 'STANDBY', 'SUSPENDED', 'WITHDRAWN'];
const STATUS_LABEL = { PENDING: '가입대기', ACTIVE: '활동중', STANDBY: '대기', SUSPENDED: '정지', WITHDRAWN: '탈퇴' };
const STATUS_TRANSITIONS = {
  PENDING: ['ACTIVE', 'WITHDRAWN'],
  ACTIVE: ['STANDBY', 'SUSPENDED', 'WITHDRAWN'],
  STANDBY: ['ACTIVE', 'SUSPENDED', 'WITHDRAWN'],
  SUSPENDED: ['ACTIVE', 'STANDBY', 'WITHDRAWN'],
  WITHDRAWN: [], // Administrator 만 STANDBY 로 복구 가능
};

function allowedTransitions(from, actor) {
  if (from === 'WITHDRAWN' && actor && actor.role === 'ADMINISTRATOR') return ['STANDBY'];
  return STATUS_TRANSITIONS[from] || [];
}

const MEMBER_COLUMNS = `m.id, m.username, m.name, m.alias, m.email, m.phone, m.birth_date, m.status, m.joined_at,
  m.notes, m.is_locked, m.last_login_at, m.created_at, m.updated_at, r.code AS role, r.name AS role_name, r.level`;

async function getMember(id, t = db, { lock = false } = {}) {
  const m = await t.one(
    `SELECT ${MEMBER_COLUMNS} FROM members m JOIN roles r ON r.id = m.role_id WHERE m.id = ?${lock ? ' FOR UPDATE' : ''}`,
    [id]
  );
  if (!m) throw E.notFound('구성원', id);
  return m;
}

async function getRole(code, t = db) {
  const role = await t.one('SELECT * FROM roles WHERE code = ?', [code]);
  if (!role) throw E.notFound('역할', code);
  return role;
}

/** BR-04: 자신보다 높거나 같은 권한의 사용자는 변경할 수 없다 (Administrator 예외) */
function assertHigherThan(actor, target, what = '역할') {
  if (actor.id === target.id) throw E.forbidden(`자기 자신의 ${what}은(는) 변경할 수 없습니다.`, 'BR-04');
  if (actor.role !== 'ADMINISTRATOR' && target.level >= actor.level) {
    throw E.forbidden(
      `자신(${actor.role}, level ${actor.level})보다 높거나 같은 권한을 가진 사용자(${target.role}, level ${target.level})의 ${what}은(는) 변경할 수 없습니다.`,
      'BR-04'
    );
  }
}

async function assertRoleChange(actor, target, newRole) {
  assertHigherThan(actor, target, '역할');
  if (actor.role !== 'ADMINISTRATOR' && newRole.level >= actor.level) {
    throw E.forbidden(`자신과 같거나 높은 역할(${newRole.code})을 부여할 수 없습니다.`, 'BR-04');
  }
  if (actor.role === 'CAPO' && newRole.level > 2) {
    throw E.forbidden('Capo 는 Associate/Soldier 역할만 부여할 수 있습니다.', 'BR-04');
  }
  await scope.assertManageMember(actor, target.id, 'BR-05');
}

/** 역할 변경 실행 (트랜잭션 내부) */
async function applyRoleChange(t, actor, target, newRole, reason) {
  if (target.role === newRole.code) throw E.state(`이미 ${newRole.code} 역할입니다.`);
  await t.query('UPDATE members SET role_id = ? WHERE id = ?', [newRole.id, target.id]);
  // 책임자 역할을 잃으면 책임 Crew 에서 해제
  const vacated = [];
  if (newRole.level < 3) {
    const crews = await t.query('SELECT id FROM crews WHERE capo_id = ?', [target.id]);
    if (crews.length) {
      await t.query('UPDATE crews SET capo_id = NULL WHERE capo_id = ?', [target.id]);
      vacated.push(...crews.map((c) => ({ crewId: c.id, position: 'CAPO' })));
    }
  }
  if (newRole.level < 4) {
    const crews = await t.query('SELECT id FROM crews WHERE underboss_id = ?', [target.id]);
    if (crews.length) {
      await t.query('UPDATE crews SET underboss_id = NULL WHERE underboss_id = ?', [target.id]);
      vacated.push(...crews.map((c) => ({ crewId: c.id, position: 'UNDERBOSS' })));
    }
  }
  await rec.memberHistory(target.id, 'ROLE', target.role, newRole.code, actor, reason, { vacated });
  await rec.audit(actor, 'MEMBER_ROLE_CHANGED', 'member', target.id, { from: target.role, to: newRole.code, reason, vacated });
  await rec.notify(target.id, 'ROLE_CHANGED', '역할 변경', `역할이 ${target.role} → ${newRole.code} 로 변경되었습니다.`, `/api/me`);
  return { memberId: target.id, from: target.role, to: newRole.code, vacatedPositions: vacated };
}

/** 상태 변경 실행 (트랜잭션 내부) - 탈퇴 시 소속/배정/예약 정리 */
async function applyStatusChange(t, actor, target, to, reason) {
  if (!allowedTransitions(target.status, actor).includes(to)) {
    throw E.state(`상태 전이 ${target.status} → ${to} 는 허용되지 않습니다.`, {
      from: target.status, to, allowed: allowedTransitions(target.status, actor),
    });
  }
  const effects = {};
  await t.query('UPDATE members SET status = ? WHERE id = ?', [to, target.id]);
  if (to === 'WITHDRAWN') {
    const ms = await t.query("UPDATE crew_memberships SET left_at = NOW(), left_reason = 'WITHDRAWN', changed_by = ? WHERE member_id = ? AND left_at IS NULL", [actor ? actor.id : null, target.id]);
    const as = await t.query(
      `UPDATE task_assignments a JOIN tasks t ON t.id = a.task_id
          SET a.status = 'REMOVED', a.removed_at = NOW()
        WHERE a.member_id = ? AND a.status IN ('ASSIGNED','ACCEPTED') AND t.status IN ('PLANNED','IN_PROGRESS','ON_HOLD')`,
      [target.id]
    );
    const rs = await t.query("UPDATE resource_allocations SET status = 'CANCELLED' WHERE member_id = ? AND status = 'RESERVED'", [target.id]);
    await t.query('UPDATE crews SET capo_id = NULL WHERE capo_id = ?', [target.id]);
    await t.query('UPDATE crews SET underboss_id = NULL WHERE underboss_id = ?', [target.id]);
    await t.query('UPDATE members SET token_version = token_version + 1 WHERE id = ?', [target.id]);
    Object.assign(effects, { endedMemberships: ms.affectedRows, removedAssignments: as.affectedRows, cancelledReservations: rs.affectedRows });
  }
  await rec.memberHistory(target.id, 'STATUS', target.status, to, actor, reason, { effects });
  await rec.audit(actor, 'MEMBER_STATUS_CHANGED', 'member', target.id, { from: target.status, to, reason, effects });
  await rec.notify(target.id, 'STATUS_CHANGED', '상태 변경', `계정 상태가 ${STATUS_LABEL[target.status]} → ${STATUS_LABEL[to]} 로 변경되었습니다.`);
  return { memberId: target.id, from: target.status, to, effects };
}

module.exports = {
  STATUSES, STATUS_LABEL, STATUS_TRANSITIONS, allowedTransitions, MEMBER_COLUMNS,
  getMember, getRole, assertHigherThan, assertRoleChange, applyRoleChange, applyStatusChange,
};
