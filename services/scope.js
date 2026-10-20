/**
 * 관리 범위(Scope) 판단 (BR-05, BR-09, FR-06, FR-21)
 *  - Boss / Administrator : 조직 전체
 *  - Underboss            : 자신이 감독(underboss_id)하거나 직접 책임지는 Crew
 *  - Capo                 : 자신이 책임자(capo_id)인 Crew
 *  - Soldier / Associate  : 관리 범위 없음 (자신이 소속된 Crew 정보 조회만 가능)
 */
const db = require('../db/mysql');
const E = require('../lib/errors');

const isAll = (user) => user.role === 'BOSS' || user.role === 'ADMINISTRATOR';

/** 관리 가능한 Crew id 목록. null = 전체 */
async function managedCrewIds(user) {
  if (isAll(user)) return null;
  if (user.role === 'UNDERBOSS') {
    const rows = await db.query("SELECT id FROM crews WHERE (underboss_id = ? OR capo_id = ?) AND status = 'ACTIVE'", [user.id, user.id]);
    return rows.map((r) => r.id);
  }
  if (user.role === 'CAPO') {
    const rows = await db.query("SELECT id FROM crews WHERE capo_id = ? AND status = 'ACTIVE'", [user.id]);
    return rows.map((r) => r.id);
  }
  return [];
}

/** 조회 가능한 Crew id 목록 (관리 범위 + 본인 소속). null = 전체 */
async function visibleCrewIds(user) {
  const managed = await managedCrewIds(user);
  if (managed === null) return null;
  return [...new Set([...managed, ...(user.crewId ? [user.crewId] : []), ...(user.affiliateCrewIds || [])])];
}

/** SQL 조건절 생성: ids=null 이면 전체 허용 */
function inCrews(ids, column) {
  if (ids === null) return { sql: '1=1', params: [] };
  if (!ids.length) return { sql: '1=0', params: [] };
  return { sql: `${column} IN (?)`, params: [ids] };
}

async function canManageCrew(user, crewId) {
  const ids = await managedCrewIds(user);
  return ids === null || ids.includes(Number(crewId));
}

async function assertManageCrew(user, crewId, rule = 'BR-05') {
  if (!(await canManageCrew(user, crewId))) {
    throw E.forbidden(`Crew(id=${crewId})는 ${user.role}(${user.username})의 관리 범위가 아닙니다.`, rule);
  }
}

async function memberFormalCrew(memberId, t = db) {
  const row = await t.one(
    "SELECT crew_id FROM crew_memberships WHERE member_id = ? AND left_at IS NULL AND membership_type = 'FORMAL'",
    [memberId]
  );
  return row ? row.crewId : null;
}

async function canManageMember(user, memberId) {
  if (isAll(user)) return true;
  const crewId = await memberFormalCrew(memberId);
  if (!crewId) return user.level >= 4; // 무소속 구성원은 Underboss 이상이 관리
  return canManageCrew(user, crewId);
}

async function assertManageMember(user, memberId, rule = 'BR-05') {
  if (!(await canManageMember(user, memberId))) {
    throw E.forbidden(`구성원(id=${memberId})은 관리 범위 밖입니다.`, rule);
  }
}

/** 구성원 정보 조회 가능 여부: 본인, 관리 범위, 같은 Crew 소속 */
async function canViewMember(user, memberId) {
  if (Number(memberId) === user.id) return true;
  if (await canManageMember(user, memberId)) return true;
  const crews = await db.query('SELECT crew_id FROM crew_memberships WHERE member_id = ? AND left_at IS NULL', [memberId]);
  const visible = await visibleCrewIds(user);
  return crews.some((c) => visible === null || visible.includes(c.crewId));
}

async function assertViewMember(user, memberId) {
  if (!(await canViewMember(user, memberId))) throw E.forbidden(`구성원(id=${memberId}) 정보 조회 권한이 없습니다.`, 'BR-09');
}

module.exports = {
  isAll, managedCrewIds, visibleCrewIds, inCrews, canManageCrew, assertManageCrew,
  memberFormalCrew, canManageMember, assertManageMember, canViewMember, assertViewMember,
};
