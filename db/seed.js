/**
 * 스키마 생성 및 데모 데이터 초기화
 *  - 최초 실행 시(roles 테이블이 비어 있을 때) 자동 실행
 *  - POST /api/admin/system/reset-demo 로 언제든 초기 상태로 되돌릴 수 있음
 *  - 모든 데모 계정의 비밀번호: pass1234
 */
const bcrypt = require('bcryptjs');
const db = require('./mysql');
const mongo = require('./mongo');
const schema = require('./schema');
const { DEFAULTS } = require('../services/settings');

const ROLES = [
  [1, 'ASSOCIATE', 'Associate', 1, '일반 사용자. 자신의 정보와 허용된 조직 정보를 조회'],
  [2, 'SOLDIER', 'Soldier', 2, '정식 구성원. 배정된 업무와 자원 이용 수행'],
  [3, 'CAPO', 'Capo', 3, 'Crew 책임자. 담당 Crew의 구성원과 업무 관리'],
  [4, 'UNDERBOSS', 'Underboss', 4, '여러 Crew와 운영 현황을 관리하는 상위 운영 역할'],
  [5, 'BOSS', 'Boss', 5, '조직 전반의 주요 상태와 운영 정보를 확인하는 최고 운영 역할'],
  [6, 'ADMINISTRATOR', 'Administrator', 6, '시스템 계정, 권한, 감사 기록 등 기술적 관리'],
];

const PERMISSIONS = [
  ['member.create', 'MEMBER', '구성원 등록'],
  ['member.update', 'MEMBER', '구성원 기본 정보 수정'],
  ['member.delete', 'MEMBER', '가입대기 구성원 삭제'],
  ['member.role', 'MEMBER', '구성원 역할 변경'],
  ['member.status', 'MEMBER', '구성원 상태 변경'],
  ['member.read', 'MEMBER', '관리 범위 구성원 상세/이력 조회'],
  ['member.discipline', 'MEMBER', '징계 등록/해제'],
  ['promotion.request', 'MEMBER', '승급 요청 등록'],
  ['promotion.review', 'MEMBER', '승급 요청 승인/반려'],
  ['crew.create', 'CREW', 'Crew 생성/해산/복구'],
  ['crew.update', 'CREW', 'Crew 정보 수정'],
  ['crew.appoint', 'CREW', 'Crew 책임자/감독자 지정'],
  ['crew.members', 'CREW', 'Crew 구성원 편성 변경 및 가입 요청 심사'],
  ['crew.announce', 'CREW', 'Crew 공지 관리'],
  ['region.manage', 'CREW', '지역 관리'],
  ['task.create', 'TASK', '업무 등록/복제/삭제'],
  ['task.update', 'TASK', '업무 정보/일정 수정'],
  ['task.assign', 'TASK', '업무 배정 관리'],
  ['task.progress', 'TASK', '업무 진행 상태 변경 및 완료 처리'],
  ['task.result.amend', 'TASK', '완료된 업무 결과 수정 및 재개'],
  ['template.manage', 'TASK', '업무 템플릿 관리'],
  ['meeting.manage', 'TASK', '회의 관리'],
  ['resource.manage', 'RESOURCE', '자원 등록/수정/상태 관리'],
  ['resource.allocate', 'RESOURCE', '자원 배정 및 사용 요청 심사'],
  ['evaluation.write', 'EVALUATION', '평가 작성'],
  ['evaluation.read', 'EVALUATION', '관리 범위 평가 이력 조회'],
  ['evaluation.void', 'EVALUATION', '평가 무효화'],
  ['evaluation.criteria', 'EVALUATION', '평가 항목 관리'],
  ['reputation.adjust', 'EVALUATION', '평판 가감점 부여'],
  ['stats.read', 'ADMIN', '운영 현황/통계 조회'],
  ['audit.read', 'ADMIN', '감사 로그 조회'],
  ['account.manage', 'ADMIN', '계정 잠금/해제/비밀번호 초기화/강제 로그아웃'],
  ['permission.manage', 'ADMIN', '역할별 권한 관리'],
  ['system.manage', 'ADMIN', '시스템 설정/점검/데모 초기화'],
];

const CAPO_PERMS = ['member.read', 'member.status', 'member.role', 'member.discipline', 'promotion.request', 'crew.members', 'crew.announce',
  'task.create', 'task.update', 'task.assign', 'task.progress', 'template.manage', 'meeting.manage', 'resource.allocate',
  'evaluation.write', 'evaluation.read'];
const UNDERBOSS_PERMS = [...CAPO_PERMS, 'member.create', 'member.update', 'promotion.review', 'crew.update', 'crew.appoint',
  'task.result.amend', 'resource.manage', 'evaluation.void', 'reputation.adjust', 'stats.read'];
const ROLE_PERMS = {
  ASSOCIATE: [],
  SOLDIER: [],
  CAPO: CAPO_PERMS,
  UNDERBOSS: UNDERBOSS_PERMS,
  BOSS: [...UNDERBOSS_PERMS, 'crew.create', 'region.manage', 'evaluation.criteria', 'audit.read', 'member.delete'],
  ADMINISTRATOR: ['member.create', 'member.update', 'member.delete', 'member.role', 'member.status', 'member.read', 'evaluation.read',
    'evaluation.criteria', 'region.manage', 'stats.read', 'audit.read', 'account.manage', 'permission.manage', 'system.manage'],
};

const TABLES = ['meeting_attendees', 'meetings', 'resource_issues', 'resource_requests', 'resource_allocations', 'resources', 'resource_types',
  'task_assignments', 'tasks', 'disciplinary_actions', 'crew_join_requests', 'promotion_requests', 'member_skills', 'crew_memberships',
  'crews', 'members', 'regions', 'role_permissions', 'permissions', 'roles'];

async function createSchema() {
  for (const ddl of schema) await db.raw().query(ddl);
}

async function isEmpty() {
  const r = await db.one('SELECT COUNT(*) AS n FROM roles');
  return r.n === 0;
}

async function clearAll() {
  const conn = await db.raw().getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of TABLES) await conn.query(`TRUNCATE TABLE ${t}`);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
  for (const name of Object.keys(mongo.COLLECTIONS)) {
    // JWT 비밀키 문서는 보존 (초기화 후에도 서버 재시작 시 동일한 키 사용)
    await mongo.col(name).deleteMany(name === 'settings' ? { _id: { $ne: 'secrets' } } : {});
  }
}

/* -------------------------------------------------------------------------- */

const H = 3600 * 1000;
const D = 24 * H;
/** 오늘(한국 시간) 기준 dayOffset 일 후 hour 시 (KST, UTC+9) */
function at(dayOffset, hour, minute = 0) {
  const kst = new Date(Date.now() + 9 * H);
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + dayOffset, hour - 9, minute));
}

async function seed() {
  const q = (sql, params) => db.query(sql, params);
  const hash = await bcrypt.hash('pass1234', 8);

  for (const r of ROLES) await q('INSERT INTO roles (id, code, name, level, description) VALUES (?,?,?,?,?)', r);
  for (const p of PERMISSIONS) await q('INSERT INTO permissions (code, category, description) VALUES (?,?,?)', p);
  for (const [role, perms] of Object.entries(ROLE_PERMS)) {
    const roleId = ROLES.find((r) => r[1] === role)[0];
    for (const p of perms) await q('INSERT INTO role_permissions (role_id, permission_code) VALUES (?,?)', [roleId, p]);
  }

  for (const [name, desc] of [['Brooklyn', '동부 항만 인근 상업 지구'], ['Harbor District', '부두 및 물류 창고 지역'], ['Uptown', '북부 주거·상업 지역']]) {
    await q('INSERT INTO regions (name, description) VALUES (?,?)', [name, desc]);
  }

  // [username, name, alias, roleId, status]
  const members = [
    ['admin', '김관리', 'SysAdmin', 6, 'ACTIVE'], // 1
    ['boss', 'Vincenzo Moretti', 'The Don', 5, 'ACTIVE'], // 2
    ['underboss1', 'Marco Bellini', 'The Hand', 4, 'ACTIVE'], // 3
    ['underboss2', 'Luca Ferraro', 'Silver', 4, 'ACTIVE'], // 4
    ['capo1', 'Tony Russo', 'Big T', 3, 'ACTIVE'], // 5
    ['capo2', 'Sal Romano', 'Harbor Sal', 3, 'ACTIVE'], // 6
    ['capo3', 'Nico Greco', 'Nicky', 3, 'ACTIVE'], // 7
    ['soldier1', 'Paulie Conti', 'Paulie', 2, 'ACTIVE'], // 8
    ['soldier2', 'Joey Marino', 'Joey', 2, 'ACTIVE'], // 9
    ['soldier3', 'Frankie Costa', 'Frankie', 2, 'ACTIVE'], // 10
    ['soldier4', 'Rocco Esposito', 'Rocky', 2, 'ACTIVE'], // 11
    ['soldier5', 'Vinnie Gallo', 'Vin', 2, 'ACTIVE'], // 12
    ['soldier6', 'Carlo Rizzi', 'Charlie', 2, 'ACTIVE'], // 13
    ['associate1', 'Danny Lombardi', 'Kid', 1, 'ACTIVE'], // 14
    ['associate2', 'Eddie Ricci', 'Fast Eddie', 1, 'ACTIVE'], // 15
    ['suspended1', 'Mikey Bruno', 'Loose Lips', 2, 'SUSPENDED'], // 16
    ['standby1', 'Tommy DeLuca', 'Quiet Tom', 2, 'STANDBY'], // 17
    ['withdrawn1', 'Bobby Santoro', 'Ex', 2, 'WITHDRAWN'], // 18
    ['pending1', 'Sonny Amato', 'Newbie', 1, 'PENDING'], // 19
  ];
  for (const [i, m] of members.entries()) {
    await q(
      `INSERT INTO members (username, password_hash, name, alias, email, phone, role_id, status, joined_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [m[0], hash, m[1], m[2], `${m[0]}@family.local`, `010-1000-${String(1000 + i).slice(-4)}`, m[3], m[4], new Date(Date.now() - (400 - i * 15) * D)]
    );
  }

  const crews = [
    ['Brooklyn Crew', 1, '브루클린 지역 운영 Crew', 5, 3],
    ['Harbor Crew', 2, '항만 물류 담당 Crew', 6, 3],
    ['Uptown Crew', 3, '업타운 거점 운영 Crew', 7, 4],
  ];
  for (const c of crews) await q('INSERT INTO crews (name, region_id, description, capo_id, underboss_id) VALUES (?,?,?,?,?)', c);

  // [crewId, memberId, type]
  const memberships = [
    [1, 5, 'FORMAL'], [2, 6, 'FORMAL'], [3, 7, 'FORMAL'],
    [1, 8, 'FORMAL'], [1, 9, 'FORMAL'], [2, 10, 'FORMAL'], [2, 11, 'FORMAL'], [3, 12, 'FORMAL'], [3, 13, 'FORMAL'],
    [1, 14, 'FORMAL'], [1, 15, 'AFFILIATE'], [2, 15, 'AFFILIATE'], [1, 16, 'FORMAL'], [2, 17, 'FORMAL'],
  ];
  for (const m of memberships) await q('INSERT INTO crew_memberships (crew_id, member_id, membership_type, joined_at, changed_by) VALUES (?,?,?,?,2)', [m[0], m[1], m[2], new Date(Date.now() - 200 * D)]);
  await q("INSERT INTO crew_memberships (crew_id, member_id, membership_type, joined_at, left_at, left_reason, changed_by) VALUES (3, 18, 'FORMAL', ?, ?, 'WITHDRAWN', 2)", [new Date(Date.now() - 300 * D), new Date(Date.now() - 30 * D)]);

  const skills = [[8, 'driving', 4], [8, 'negotiation', 3], [9, 'security', 4], [9, 'driving', 2], [10, 'logistics', 5], [11, 'security', 3],
    [12, 'negotiation', 4], [13, 'accounting', 4], [14, 'driving', 2], [17, 'logistics', 3]];
  for (const s of skills) await q('INSERT INTO member_skills (member_id, skill, level) VALUES (?,?,?)', s);

  // ---------------------------- 업무 ----------------------------
  // [title, crewId, priority, status, start, end, location, allowConcurrent, createdBy, requiredSkills]
  const tasks = [
    ['물류 창고 정기 점검', 1, 'HIGH', 'PLANNED', at(1, 9), at(1, 12), 'Brooklyn 창고 3동', 0, 5, ['security']], // 1
    ['거래처 미팅 호위', 1, 'NORMAL', 'PLANNED', at(1, 10), at(1, 11), 'Brooklyn 레스토랑', 0, 5, ['security']], // 2 (1번과 시간 겹침)
    ['항만 화물 인수', 2, 'CRITICAL', 'IN_PROGRESS', new Date(Date.now() - 1 * H), new Date(Date.now() + 3 * H), 'Pier 17', 0, 6, ['logistics']], // 3
    ['월간 장부 정리', 1, 'NORMAL', 'COMPLETED', at(-7, 9), at(-7, 17), '본부 사무실', 0, 5, ['accounting']], // 4
    ['신규 거점 답사', 3, 'NORMAL', 'PLANNED', at(2, 13), at(2, 16), 'Uptown 147번가', 0, 7, []], // 5
    ['야간 순찰', 2, 'LOW', 'PLANNED', at(1, 20), at(1, 23), 'Harbor 전 구역', 1, 6, []], // 6 (동시 수행 가능)
    ['납품 경로 재조정', 3, 'HIGH', 'COMPLETED', at(-14, 10), at(-14, 15), 'Uptown 물류센터', 0, 7, ['logistics']], // 7
    ['구역 행사 지원', 1, 'LOW', 'CANCELLED', at(-3, 18), at(-3, 21), 'Brooklyn 광장', 0, 5, []], // 8
    ['보안 장비 교체', 2, 'NORMAL', 'ON_HOLD', at(3, 9), at(3, 12), 'Harbor 창고 A', 0, 6, ['security']], // 9
  ];
  for (const t of tasks) {
    await q(
      `INSERT INTO tasks (title, description, crew_id, priority, status, start_at, end_at, location, allow_concurrent, required_skills, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [t[0], `${t[0]} 업무`, t[1], t[2], t[3], t[4], t[5], t[6], t[7], JSON.stringify(t[9]), t[8], new Date(t[4].getTime() - 5 * D)]
    );
  }
  // 통계용 과거 완료 업무
  const outcomes = ['SUCCESS', 'SUCCESS', 'PARTIAL', 'SUCCESS', 'FAILURE'];
  for (let i = 0; i < 15; i++) {
    const crewId = (i % 3) + 1;
    const s = at(-(20 + i * 3), 10);
    await q(
      `INSERT INTO tasks (title, description, crew_id, priority, status, start_at, end_at, location, created_by, created_at,
         result_outcome, result_summary, result_value, completed_at, completed_by)
       VALUES (?,?,?,?, 'COMPLETED', ?,?,?,?,?,?,?,?,?,?)`,
      [`정기 수금 #${i + 1}`, '정기 업무', crewId, ['LOW', 'NORMAL', 'HIGH'][i % 3], s, new Date(s.getTime() + 4 * H), '구역 순회', 4 + crewId,
        new Date(s.getTime() - 3 * D), outcomes[i % 5], `정기 수금 결과 보고 #${i + 1}`, 1000 * (i + 1), new Date(s.getTime() + 4 * H), 4 + crewId]
    );
  }
  await q("UPDATE tasks SET result_outcome='SUCCESS', result_summary='장부 정리 완료, 누락 없음', result_value=12500, completed_at=end_at, completed_by=5 WHERE id=4");
  await q("UPDATE tasks SET result_outcome='PARTIAL', result_summary='경로 2개 중 1개만 재조정', result_value=4000, completed_at=end_at, completed_by=7 WHERE id=7");

  // [taskId, memberId, role, status, attendance, contribution]
  const assigns = [
    [1, 8, '현장 책임', 'ACCEPTED'], [1, 9, '경비', 'ASSIGNED'],
    [3, 10, '인수 책임', 'ACCEPTED'], [3, 11, '경비', 'ACCEPTED'],
    [4, 8, '장부 검토', 'ACCEPTED', 'PRESENT', 80], [4, 13, '회계', 'ACCEPTED', 'PRESENT', 95],
    [5, 12, '답사', 'ASSIGNED'], [6, 10, '순찰', 'ACCEPTED'],
    [7, 12, '경로 설계', 'ACCEPTED', 'PRESENT', 70], [7, 13, '보조', 'ACCEPTED', 'PARTIAL', 40],
    [9, 11, '설치', 'ASSIGNED'],
  ];
  for (const a of assigns) {
    await q(
      `INSERT INTO task_assignments (task_id, member_id, task_role, instructions, status, assigned_by, attendance, contribution, responded_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [a[0], a[1], a[2], `${a[2]} 역할 수행. 집결 30분 전 도착.`, a[3], 5, a[4] || null, a[5] || null, a[3] === 'ACCEPTED' ? new Date() : null]
    );
  }
  for (let i = 0; i < 15; i++) {
    const taskId = 10 + i;
    const crewId = (i % 3) + 1;
    const pool = { 1: [8, 9], 2: [10, 11], 3: [12, 13] }[crewId];
    for (const m of pool) {
      await q(`INSERT INTO task_assignments (task_id, member_id, task_role, status, assigned_by, attendance, contribution) VALUES (?,?,'수금','ACCEPTED',?, 'PRESENT', ?)`,
        [taskId, m, 4 + crewId, 50 + ((i * 7 + m) % 50)]);
    }
  }

  // ---------------------------- 자원 ----------------------------
  const types = [['VEHICLE', '차량', '업무용 차량', 2], ['WAREHOUSE', '창고', '물류 보관 창고', 3], ['COMM_DEVICE', '통신장비', '무전기/보안 통신 장비', 1],
    ['SAFEHOUSE', '은신처', '비상 대피 거점', 3], ['EQUIPMENT', '장비', '기타 업무 장비', 2]];
  for (const t of types) await q('INSERT INTO resource_types (code, name, description, default_min_level) VALUES (?,?,?,?)', t);
  // [code, name, typeId, crewId, status, location, minLevel]
  const resources = [
    ['VH-001', '검정 세단', 1, 1, 'AVAILABLE', 'Brooklyn 차고', 2], // 1
    ['VH-002', '화물 밴', 1, 2, 'IN_USE', 'Harbor 차고', 2], // 2
    ['VH-003', '구형 트럭', 1, null, 'MAINTENANCE', '중앙 정비소', 2], // 3
    ['WH-001', '부두 창고 A', 2, 2, 'AVAILABLE', 'Pier 12', 3], // 4
    ['CM-001', '무전기 세트 1', 3, null, 'AVAILABLE', '본부 보관실', 1], // 5
    ['CM-002', '무전기 세트 2', 3, null, 'UNAVAILABLE', '본부 보관실', 1], // 6
    ['SH-001', '은신처 - 리틀 이태리', 4, null, 'AVAILABLE', 'Mulberry St.', 3], // 7
    ['EQ-001', '금고 개폐 장비', 5, 1, 'NEEDS_INSPECTION', 'Brooklyn 창고', 2], // 8
    ['VH-004', '오토바이', 1, 3, 'AVAILABLE', 'Uptown 차고', 2], // 9
  ];
  for (const r of resources) {
    await q('INSERT INTO resources (code, name, type_id, crew_id, status, location, min_role_level, description) VALUES (?,?,?,?,?,?,?,?)', [...r, `${r[1]} (${r[0]})`]);
  }
  await q("INSERT INTO resource_allocations (resource_id, task_id, start_at, end_at, status, purpose, allocated_by) VALUES (1, 1, ?, ?, 'RESERVED', '창고 점검 이동', 5)", [at(1, 9), at(1, 12)]);
  await q("INSERT INTO resource_allocations (resource_id, task_id, start_at, end_at, status, purpose, allocated_by, checked_out_at) VALUES (2, 3, ?, ?, 'IN_USE', '화물 운송', 6, ?)", [new Date(Date.now() - 1 * H), new Date(Date.now() + 3 * H), new Date(Date.now() - 1 * H)]);
  await q("INSERT INTO resource_allocations (resource_id, member_id, start_at, end_at, status, purpose, allocated_by, checked_out_at, returned_at, return_condition) VALUES (5, 13, ?, ?, 'RETURNED', '장부 정리 연락용', 5, ?, ?, 'GOOD')", [at(-7, 9), at(-7, 17), at(-7, 9), at(-7, 17)]);
  await q("INSERT INTO resource_requests (resource_id, requester_id, start_at, end_at, purpose) VALUES (5, 9, ?, ?, '창고 점검 시 연락용')", [at(1, 9), at(1, 12)]);
  await q("INSERT INTO resource_issues (resource_id, reported_by, severity, description) VALUES (8, 8, 'HIGH', '다이얼 잠금 장치 오작동')");

  // ---------------------------- 요청 / 징계 / 회의 ----------------------------
  await q("INSERT INTO promotion_requests (member_id, current_role_id, target_role_id, requested_by, reason) VALUES (14, 1, 2, 5, '6개월간 성실 활동, 정식 구성원 승급 추천')");
  await q("INSERT INTO crew_join_requests (crew_id, member_id, membership_type, message) VALUES (3, 19, 'FORMAL', 'Uptown Crew 합류를 희망합니다.')");
  await q("INSERT INTO disciplinary_actions (member_id, action_type, reason, issued_by) VALUES (16, 'SUSPENSION', '조직 정보 외부 유출', 3)");
  await q("INSERT INTO disciplinary_actions (member_id, action_type, reason, issued_by) VALUES (9, 'WARNING', '집결 시간 지각 2회', 5)");
  await q('INSERT INTO meetings (title, agenda, crew_id, location, start_at, end_at, organizer_id) VALUES (?,?,?,?,?,?,?)',
    ['Brooklyn 주간 회의', '이번 주 업무 배정 및 창고 점검 계획', 1, 'Brooklyn 본부', at(2, 18), at(2, 19), 5]);
  for (const m of [5, 8, 9, 14]) await q('INSERT INTO meeting_attendees (meeting_id, member_id, rsvp) VALUES (1, ?, ?)', [m, m === 5 ? 'YES' : 'PENDING']);

  // ---------------------------- MongoDB ----------------------------
  const sys = { id: 2, username: 'boss', role: 'BOSS' };
  await mongo.col('settings').updateOne({ _id: 'system' }, { $set: { ...DEFAULTS, updatedAt: new Date(), updatedBy: 'seed' } }, { upsert: true });
  await mongo.col('evaluationCriteria').insertMany([
    { code: 'loyalty', name: '충성도', description: '조직과 Crew에 대한 헌신', weight: 1.5, active: true, createdAt: new Date() },
    { code: 'skill', name: '업무 역량', description: '업무 수행 능력과 결과', weight: 1.2, active: true, createdAt: new Date() },
    { code: 'discretion', name: '신중함', description: '보안 유지와 언행의 신중함', weight: 1.0, active: true, createdAt: new Date() },
    { code: 'teamwork', name: '협동심', description: '동료와의 협업', weight: 0.8, active: true, createdAt: new Date() },
  ]);
  const evals = [
    [8, 4, 5, { loyalty: 5, skill: 4, discretion: 4, teamwork: 5 }, '꼼꼼한 장부 검토'],
    [13, 4, 5, { loyalty: 4, skill: 5, discretion: 5, teamwork: 4 }, '회계 처리 탁월'],
    [12, 7, 7, { loyalty: 4, skill: 3, discretion: 4, teamwork: 3 }, '경로 재조정 일부 미흡'],
    [13, 7, 7, { loyalty: 3, skill: 3, discretion: 2, teamwork: 3 }, '부분 참여'],
  ];
  for (const [memberId, taskId, by, scores, comment] of evals) {
    const vals = Object.values(scores);
    await mongo.col('evaluations').insertOne({
      memberId, taskId, evaluator: { id: by, username: by === 5 ? 'capo1' : 'capo3', role: 'CAPO' }, scores,
      overall: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100, comment, status: 'ACTIVE', revisions: [],
      createdAt: new Date(Date.now() - 6 * D), updatedAt: new Date(Date.now() - 6 * D),
    });
  }
  await mongo.col('reputationLedger').insertMany([
    { memberId: 8, points: 10, reason: '창고 침입 시도 저지', by: sys, at: new Date(Date.now() - 20 * D) },
    { memberId: 9, points: -5, reason: '집결 지각', by: sys, at: new Date(Date.now() - 10 * D) },
    { memberId: 16, points: -20, reason: '정보 유출', by: sys, at: new Date(Date.now() - 5 * D) },
  ]);
  await mongo.col('memberHistory').insertMany([
    { memberId: 16, type: 'STATUS', from: 'ACTIVE', to: 'SUSPENDED', reason: '조직 정보 외부 유출', by: { id: 3, username: 'underboss1', role: 'UNDERBOSS' }, at: new Date(Date.now() - 5 * D) },
    { memberId: 18, type: 'STATUS', from: 'ACTIVE', to: 'WITHDRAWN', reason: '본인 요청', by: sys, at: new Date(Date.now() - 30 * D) },
    { memberId: 18, type: 'CREW', from: 'Uptown Crew', to: null, reason: 'WITHDRAWN', by: sys, at: new Date(Date.now() - 30 * D) },
    { memberId: 13, type: 'ROLE', from: 'ASSOCIATE', to: 'SOLDIER', reason: '승급', by: sys, at: new Date(Date.now() - 90 * D) },
  ]);
  const taskEvents = [
    [3, 'STATUS_CHANGED', 'PLANNED', 'IN_PROGRESS', 6], [4, 'STATUS_CHANGED', 'PLANNED', 'IN_PROGRESS', 5], [4, 'COMPLETED', 'IN_PROGRESS', 'COMPLETED', 5],
    [8, 'STATUS_CHANGED', 'PLANNED', 'CANCELLED', 5], [9, 'STATUS_CHANGED', 'IN_PROGRESS', 'ON_HOLD', 6],
  ];
  for (const [taskId, event, from, to, by] of taskEvents) {
    await mongo.col('taskHistory').insertOne({ taskId, event, from, to, note: null, by: { id: by, username: `capo${by - 4}`, role: 'CAPO' }, at: new Date(Date.now() - 2 * D) });
  }
  await mongo.col('resourceHistory').insertMany([
    { resourceId: 3, event: 'STATUS_CHANGED', from: 'AVAILABLE', to: 'MAINTENANCE', by: sys, at: new Date(Date.now() - 4 * D), note: '엔진 수리' },
    { resourceId: 2, event: 'CHECKED_OUT', from: 'RESERVED', to: 'IN_USE', by: { id: 6, username: 'capo2', role: 'CAPO' }, at: new Date(Date.now() - 1 * H), allocationId: 2 },
    { resourceId: 5, event: 'RETURNED', from: 'IN_USE', to: 'RETURNED', by: { id: 13, username: 'soldier6', role: 'SOLDIER' }, at: at(-7, 17), allocationId: 3, condition: 'GOOD' },
  ]);
  const acts = [];
  for (let i = 0; i < 60; i++) {
    const memberId = 8 + (i % 6);
    acts.push({ memberId, type: ['FIELD_REPORT', 'TASK_WORK', 'PATROL', 'MEETING'][i % 4], description: `활동 기록 #${i + 1}`, refs: {}, source: 'SEED', at: new Date(Date.now() - (i * 17 % 60) * D - (i % 24) * H) });
  }
  await mongo.col('activities').insertMany(acts);
  await mongo.col('announcements').insertMany([
    { crewId: 1, title: '이번 주 창고 점검 일정', body: '목요일 오전 9시, Brooklyn 창고 3동 집결', pinned: true, author: { id: 5, username: 'capo1', role: 'CAPO' }, createdAt: new Date(), updatedAt: new Date() },
    { crewId: 2, title: '항만 출입 절차 변경', body: '신규 출입증 지참 필수', pinned: false, author: { id: 6, username: 'capo2', role: 'CAPO' }, createdAt: new Date(), updatedAt: new Date() },
  ]);
  await mongo.col('taskComments').insertOne({ taskId: 1, author: { id: 5, username: 'capo1', role: 'CAPO' }, body: '점검 체크리스트 반드시 확인', createdAt: new Date(), updatedAt: new Date() });
  await mongo.col('taskChecklists').insertOne({
    taskId: 1,
    items: [
      { id: '1', text: '출입구 잠금 상태 확인', done: false, updatedAt: new Date() },
      { id: '2', text: 'CCTV 작동 확인', done: false, updatedAt: new Date() },
    ],
    seq: 2,
  });
  await mongo.col('taskTemplates').insertOne({
    name: '정기 수금', description: '구역별 정기 수금 업무', defaults: { priority: 'NORMAL', durationHours: 4, location: '구역 순회', allowConcurrent: false, requiredSkills: ['negotiation'] },
    checklist: ['수금 대상 명단 확인', '수금액 기록', '본부 입금'], createdBy: sys, createdAt: new Date(), updatedAt: new Date(),
  });
  await mongo.col('notifications').insertMany([
    { memberId: 8, type: 'TASK_ASSIGNED', title: '업무 배정', message: '물류 창고 정기 점검 업무에 배정되었습니다.', link: '/api/me/tasks/1', read: false, createdAt: new Date() },
    { memberId: 9, type: 'TASK_ASSIGNED', title: '업무 배정', message: '물류 창고 정기 점검 업무에 배정되었습니다.', link: '/api/me/tasks/1', read: false, createdAt: new Date() },
  ]);
  await mongo.col('meetingMinutes').insertOne({ meetingId: 1, content: '(회의 전)', decisions: [], updatedBy: null, updatedAt: new Date() });
  await mongo.col('auditLogs').insertOne({ at: new Date(), actor: { id: null, username: 'system', role: 'SYSTEM' }, action: 'DEMO_DATA_SEEDED', entity: { type: 'system', id: null }, details: {}, result: 'SUCCESS', ip: null });
}

async function init(config) {
  await createSchema();
  if (config.seedOnEmpty && (await isEmpty())) {
    console.log('[seed] 빈 데이터베이스 감지 - 데모 데이터를 생성합니다.');
    await clearAll();
    await seed();
  }
}

async function resetDemo() {
  await clearAll();
  await seed();
}

module.exports = { init, resetDemo, ROLE_PERMS, PERMISSIONS };
