/**
 * 요구사항 카탈로그 + 확인 절차
 *  - scripts/generate-report.js 가 이 데이터로 기술 보고서의 "요구사항 추적표"와 "기능 확인 방법"을 생성한다.
 *  - scripts/verify-report.js 가 이 절차를 그대로 실행하여, 보고서에 적힌 절차가 실제로 동작함을 검증한다.
 *
 * step 형식: { as: 로그인 계정(null=인증 없음), method, path, body?, expect: HTTP 상태, rule?: 업무규칙 ID, see?: 확인할 내용, assert?: 응답 검증 함수, save?: 응답 data 저장 이름 }
 * 경로/본문의 {{name.field}} 는 앞 단계에서 save 한 응답 값으로 치환된다.
 * 모든 요구사항 확인 전에 데모 데이터 초기화(POST /api/admin/system/reset-demo)를 먼저 실행한다.
 */
const S = (as, method, path, opts = {}) => ({ as, method, path, ...opts });
const F = '2030-01-10T09:00:00Z';
const T = '2030-01-10T18:00:00Z';

module.exports = [
  /* ============================== 기능 요구사항 ============================== */
  {
    id: 'FR-01', group: 'FR', title: '시스템 구성원의 기본 정보를 등록하고 관리할 수 있어야 한다.',
    impl: 'MySQL members 테이블에 계정·기본 정보를 저장. 관리자 등록(POST /api/members), 본인 가입 신청(POST /api/auth/register, PENDING 상태), 정보 수정(PATCH /api/members/{id}, PATCH /api/me), 기술 관리.',
    steps: [
      S('boss', 'POST', '/api/members', { body: { username: 'soldier7', password: 'pass1234', name: 'Gino Vitale', role: 'SOLDIER', crewId: 1 }, expect: 201, see: 'data.id = 20, role = SOLDIER', assert: (j) => j.data.id === 20 && j.data.role === 'SOLDIER' }),
      S('boss', 'PATCH', '/api/members/20', { body: { phone: '010-9999-0000', alias: 'Gino' }, expect: 200, see: 'data.phone = 010-9999-0000', assert: (j) => j.data.phone === '010-9999-0000' }),
      S(null, 'POST', '/api/auth/register', { body: { username: 'newcomer1', password: 'pass1234', name: '홍길동' }, expect: 201, see: 'data.status = PENDING (가입대기)', assert: (j) => j.data.status === 'PENDING' }),
      S('boss', 'GET', '/api/members?status=PENDING', { expect: 200, see: 'newcomer1, pending1 이 조회됨', assert: (j) => j.data.some((m) => m.username === 'newcomer1') }),
    ],
  },
  {
    id: 'FR-02', group: 'FR', title: '구성원은 자신의 현재 소속, 역할, 상태 및 허용된 범위의 활동 정보를 확인할 수 있어야 한다.',
    impl: 'GET /api/me 가 소속 Crew·역할·상태·활동 요약을, /api/me/dashboard 가 일정·알림·요청을, /api/auth/permissions 가 권한과 관리 범위를 반환.',
    steps: [
      S('soldier1', 'GET', '/api/me', { expect: 200, see: 'role = SOLDIER, statusLabel = 활동중, crews[0].crewName = Brooklyn Crew', assert: (j) => j.data.role === 'SOLDIER' && j.data.crews[0].crewName === 'Brooklyn Crew' }),
      S('soldier1', 'GET', '/api/auth/permissions', { expect: 200, see: 'scope = SELF (관리 범위 없음)', assert: (j) => j.data.scope === 'SELF' }),
      S('soldier1', 'GET', '/api/members/8/crew-history', { expect: 200, see: '본인 소속 이력 1건', assert: (j) => j.data.length === 1 }),
      S('soldier1', 'GET', '/api/me/dashboard', { expect: 200, see: 'upcoming 에 1번 업무(물류 창고 정기 점검)', assert: (j) => j.data.upcoming.some((t) => t.taskId === 1) }),
    ],
  },
  {
    id: 'FR-03', group: 'FR', title: '권한을 가진 사용자는 구성원의 역할, 상태 또는 소속 정보를 변경할 수 있어야 한다.',
    impl: '역할 변경 PATCH /api/members/{id}/role, 상태 변경 PATCH /api/members/{id}/status, 소속 이동 POST /api/crews/{id}/members/{memberId}/transfer. 모두 권한(member.role / member.status / crew.members)과 관리 범위를 서버에서 검사.',
    steps: [
      S('capo1', 'PATCH', '/api/members/14/role', { body: { role: 'SOLDIER', reason: '승급' }, expect: 200, see: 'from = ASSOCIATE, to = SOLDIER', assert: (j) => j.data.to === 'SOLDIER' }),
      S('capo1', 'PATCH', '/api/members/9/status', { body: { status: 'STANDBY', reason: '휴가' }, expect: 200, see: 'from = ACTIVE, to = STANDBY', assert: (j) => j.data.to === 'STANDBY' }),
      S('underboss1', 'POST', '/api/crews/1/members/9/transfer', { body: { targetCrewId: 2, reason: '인력 보강' }, expect: 200, see: 'fromCrewId = 1, toCrewId = 2' }),
      S('underboss1', 'GET', '/api/members/9/crew-history', { expect: 200, see: 'Brooklyn(leftAt 기록) → Harbor 이력 2건', assert: (j) => j.data.length === 2 }),
    ],
  },
  {
    id: 'FR-04', group: 'FR', title: '구성원은 활동중, 대기, 정지, 탈퇴 등 운영상 필요한 상태로 구분하여 관리할 수 있어야 한다.',
    impl: '상태 체계: PENDING(가입대기) / ACTIVE(활동중) / STANDBY(대기) / SUSPENDED(정지) / WITHDRAWN(탈퇴). 허용 전이표를 서버에서 검사하며, 탈퇴 시 소속 종료·배정 해제·예약 취소·세션 만료를 함께 처리.',
    steps: [
      S('boss', 'GET', '/api/members/8/status-transitions', { expect: 200, see: 'allowed = [STANDBY, SUSPENDED, WITHDRAWN]', assert: (j) => j.data.allowed.includes('SUSPENDED') }),
      S('boss', 'PATCH', '/api/members/8/status', { body: { status: 'SUSPENDED', reason: '조사' }, expect: 200 }),
      S('boss', 'PATCH', '/api/members/18/status', { body: { status: 'ACTIVE' }, expect: 422, see: 'WITHDRAWN → ACTIVE 전이 불가 (INVALID_STATE)' }),
      S('boss', 'GET', '/api/members?status=SUSPENDED', { expect: 200, see: 'soldier1(8), suspended1(16) 2명', assert: (j) => j.meta.total === 2 }),
    ],
  },
  {
    id: 'FR-05', group: 'FR', title: '시스템은 하나 이상의 Crew를 관리할 수 있어야 하며, 각 Crew의 책임자와 구성원을 확인할 수 있어야 한다.',
    impl: 'MySQL crews(책임자 capo_id, 감독 underboss_id, 지역 region_id) + crew_memberships. Crew 생성/조회/구성원 목록/책임자 지정 API 제공.',
    steps: [
      S('soldier1', 'GET', '/api/crews', { expect: 200, see: 'Crew 3개', assert: (j) => j.meta.total === 3 }),
      S('soldier1', 'GET', '/api/crews/1', { expect: 200, see: 'capoName = Tony Russo, underbossName = Marco Bellini', assert: (j) => j.data.capoName === 'Tony Russo' }),
      S('soldier1', 'GET', '/api/crews/1/members', { expect: 200, see: 'capo1(isCapo=true) 포함 구성원 목록', assert: (j) => j.data.some((m) => m.isCapo) }),
      S('boss', 'POST', '/api/crews', { body: { name: 'Queens Crew', regionId: 1, underbossId: 4 }, expect: 201 }),
      S('boss', 'PUT', '/api/crews/4/capo', { body: { memberId: 7 }, expect: 409, see: 'capo3 은 이미 Uptown Crew 책임자 (CONFLICT)' }),
    ],
  },
  {
    id: 'FR-06', group: 'FR', title: '권한을 가진 사용자는 자신이 관리할 수 있는 범위에서 Crew의 구성원 편성을 변경할 수 있어야 한다.',
    impl: 'Crew 편성 추가/제외/이동 API. 요청자의 관리 범위(Capo=담당 Crew, Underboss=감독 Crew, Boss=전체)를 services/scope.js 에서 판정.',
    steps: [
      S('capo1', 'DELETE', '/api/crews/1/members/14?reason=편성 조정', { expect: 200, see: 'removed = true' }),
      S('capo1', 'POST', '/api/crews/1/members', { body: { memberId: 14, membershipType: 'FORMAL' }, expect: 201 }),
      S('capo1', 'GET', '/api/crews/1/membership-history', { expect: 200, see: 'associate1 의 제외(leftAt)·재편성 이력', assert: (j) => j.data.filter((r) => r.memberId === 14).length === 2 }),
      S('capo1', 'POST', '/api/crews/2/members', { body: { memberId: 17 }, expect: 403, rule: 'BR-05', see: '담당하지 않는 Harbor Crew 편성 거부' }),
    ],
  },
  {
    id: 'FR-07', group: 'FR', title: '권한을 가진 사용자는 새로운 업무를 등록하고 업무의 기본 정보와 일정, 중요도, 상태를 관리할 수 있어야 한다.',
    impl: 'MySQL tasks. 등록·기본정보 수정·일정 변경(충돌 재검사)·상태 변경을 별도 API 로 분리. 담당 Crew 범위 밖 업무 등록은 403.',
    steps: [
      S('capo1', 'POST', '/api/tasks', { body: { title: '신규 거래처 실사', crewId: 1, priority: 'HIGH', startAt: '2030-03-02T09:00:00Z', endAt: '2030-03-02T12:00:00Z', location: 'Brooklyn 5번가' }, expect: 201, see: 'data.id = 25, status = PLANNED', assert: (j) => j.data.id === 25 && j.data.status === 'PLANNED' }),
      S('capo1', 'PATCH', '/api/tasks/25', { body: { priority: 'CRITICAL', description: '우선 처리' }, expect: 200, see: 'priority = CRITICAL', assert: (j) => j.data.priority === 'CRITICAL' }),
      S('capo1', 'PATCH', '/api/tasks/25/schedule', { body: { startAt: '2030-03-03T09:00:00Z', endAt: '2030-03-03T11:00:00Z' }, expect: 200 }),
      S('capo1', 'PATCH', '/api/tasks/25/status', { body: { status: 'IN_PROGRESS' }, expect: 200, see: 'from = PLANNED, to = IN_PROGRESS' }),
      S('capo1', 'POST', '/api/tasks', { body: { title: '타 Crew 업무', crewId: 2, startAt: '2030-03-02T09:00:00Z', endAt: '2030-03-02T12:00:00Z' }, expect: 403, see: '관리하지 않는 Harbor Crew 업무 등록 거부' }),
    ],
  },
  {
    id: 'FR-08', group: 'FR', title: '하나의 업무에는 한 명 이상의 구성원이 참여할 수 있어야 한다.',
    impl: 'MySQL task_assignments (업무 N : 구성원 M). 업무 내 역할·지시사항·응답 상태·참여 기록 관리.',
    steps: [
      S('capo1', 'POST', '/api/tasks/2/assignments', { body: { memberId: 14, taskRole: '운전' }, expect: 201 }),
      S('capo1', 'POST', '/api/tasks/2/assignments', { body: { memberId: 15, taskRole: '경비' }, expect: 201 }),
      S('capo1', 'GET', '/api/tasks/2/assignments', { expect: 200, see: '참여 구성원 2명', assert: (j) => j.data.length === 2 }),
    ],
  },
  {
    id: 'FR-09', group: 'FR', title: '구성원은 자신에게 배정된 업무와 해당 업무에서 자신이 확인해야 할 정보를 조회할 수 있어야 한다.',
    impl: 'GET /api/me/tasks (수락 필요·체크리스트 미완료 등 actionRequired), GET /api/me/tasks/{taskId} (역할·지시사항·동료·자원·체크리스트·코멘트 브리핑), 배정 수락/거절, 알림.',
    steps: [
      S('soldier2', 'GET', '/api/me/tasks', { expect: 200, see: '1번 업무, actionRequired 에 "배정 수락/거절 응답 필요"', assert: (j) => j.data[0].actionRequired.length > 0 }),
      S('soldier2', 'GET', '/api/me/tasks/1', { expect: 200, see: 'myAssignment.taskRole = 경비, resources 에 VH-001, checklist 2건', assert: (j) => j.data.myAssignment.taskRole === '경비' && j.data.checklist.length === 2 }),
      S('soldier2', 'POST', '/api/me/assignments/2/accept', { expect: 200, see: 'status = ACCEPTED' }),
      S('soldier2', 'GET', '/api/me/notifications', { expect: 200, see: 'TASK_ASSIGNED 알림', assert: (j) => j.data.some((n) => n.type === 'TASK_ASSIGNED') }),
      S('soldier2', 'GET', '/api/me/tasks/3', { expect: 403, see: '배정되지 않은 업무 브리핑 조회 거부' }),
    ],
  },
  {
    id: 'FR-10', group: 'FR', title: '업무의 진행 상태는 수행 과정에 따라 변경될 수 있어야 하며, 변경 이력을 추후 확인할 수 있어야 한다.',
    impl: '상태 전이표(PLANNED→IN_PROGRESS→ON_HOLD/COMPLETED…)를 서버에서 검사. 모든 변경은 MongoDB task_history 에 기록되고 status-history / timeline API 로 조회.',
    steps: [
      S('capo2', 'GET', '/api/tasks/9/transitions', { expect: 200, see: 'current = ON_HOLD, allowed = [IN_PROGRESS, CANCELLED]', assert: (j) => j.data.current === 'ON_HOLD' }),
      S('capo2', 'PATCH', '/api/tasks/9/status', { body: { status: 'IN_PROGRESS', reason: '부품 도착, 작업 재개' }, expect: 200 }),
      S('capo2', 'PATCH', '/api/tasks/9/status', { body: { status: 'PLANNED' }, expect: 422, see: 'IN_PROGRESS → PLANNED 전이 불가' }),
      S('capo2', 'GET', '/api/tasks/9/status-history', { expect: 200, see: 'STATUS_CHANGED 이력 2건 (ON_HOLD→IN_PROGRESS 포함)', assert: (j) => j.data.some((h) => h.from === 'ON_HOLD' && h.to === 'IN_PROGRESS') }),
    ],
  },
  {
    id: 'FR-11', group: 'FR', title: '완료된 업무의 결과와 참여 기록은 이후 평가 및 운영 현황 확인에 활용할 수 있어야 한다.',
    impl: 'POST /api/tasks/{id}/complete 로 결과(성공/부분/실패, 요약, 성과값)와 참여자별 출석·기여도를 저장. 결과 조회·구성원 참여 이력·평가 대기 목록·통계에 활용.',
    steps: [
      S('capo2', 'POST', '/api/tasks/3/complete', { body: { outcome: 'SUCCESS', summary: '화물 인수 완료', value: 15000, participation: [{ memberId: 10, attendance: 'PRESENT', contribution: 90 }, { memberId: 11, attendance: 'PRESENT', contribution: 70 }] }, expect: 200, see: 'status = COMPLETED, resultOutcome = SUCCESS' }),
      S('capo2', 'GET', '/api/tasks/3/result', { expect: 200, see: '참여자 2명의 attendance / contribution', assert: (j) => j.data.participants.length === 2 }),
      S('capo2', 'GET', '/api/members/10/assignments?taskStatus=COMPLETED', { expect: 200, see: '3번 업무 contribution = 90', assert: (j) => j.data.some((a) => a.taskId === 3 && a.contribution === 90) }),
      S('capo2', 'GET', '/api/evaluations/pending', { expect: 200, see: '3번 업무 참여자(10, 11)가 평가 대기 목록에 표시', assert: (j) => j.data.some((p) => p.taskId === 3) }),
      S('boss', 'GET', '/api/stats/crews', { expect: 200, see: 'Crew 별 완료율·성공률·성과값(totalValue) 반영' }),
    ],
  },
  {
    id: 'FR-12', group: 'FR', title: '권한을 가진 사용자는 특정 기간, Crew, 상태, 담당 구성원 등을 기준으로 업무를 탐색할 수 있어야 한다.',
    impl: 'GET /api/tasks 가 from/to(기간), crewId, status(다중), priority(다중), memberId(담당자), q(검색어), overdue, unassigned 필터와 정렬·페이지를 지원. 역할별 조회 범위 자동 적용.',
    steps: [
      S('boss', 'GET', '/api/tasks?crewId=1&status=PLANNED,IN_PROGRESS,ON_HOLD&sort=startAt', { expect: 200, see: '모든 결과 crewId = 1', assert: (j) => j.data.length > 0 && j.data.every((t) => t.crewId === 1) }),
      S('boss', 'GET', '/api/tasks?memberId=8', { expect: 200, see: 'soldier1 이 배정된 1번 업무', assert: (j) => j.data.some((t) => t.id === 1) }),
      S('boss', 'GET', '/api/tasks?from=2020-01-01T00:00:00Z&to=2035-12-31T00:00:00Z&priority=HIGH,CRITICAL&sort=-priority', { expect: 200, see: 'HIGH/CRITICAL 업무만', assert: (j) => j.data.every((t) => ['HIGH', 'CRITICAL'].includes(t.priority)) }),
      S('boss', 'GET', '/api/tasks?q=창고', { expect: 200, see: '제목/설명/장소에 "창고" 포함 업무', assert: (j) => j.meta.total >= 1 }),
      S('capo1', 'GET', '/api/tasks?crewId=2', { expect: 200, see: '관리 범위 밖 Crew → 0건', assert: (j) => j.meta.total === 0 }),
    ],
  },
  {
    id: 'FR-13', group: 'FR', title: '조직에서 공동으로 사용하는 자원을 등록하고 현재 상태를 관리할 수 있어야 한다.',
    impl: 'MySQL resources / resource_types. 자원 등록·수정·상태 변경(정상/사용중/점검필요/정비중/사용불가/폐기). 상태 변경은 MongoDB resource_history 에 기록.',
    steps: [
      S('underboss1', 'POST', '/api/resources', { body: { code: 'VH-005', name: '소형 승합차', typeCode: 'VEHICLE', crewId: 1, location: 'Brooklyn 차고' }, expect: 201, see: 'data.id = 10, status = AVAILABLE', assert: (j) => j.data.id === 10 }),
      S('underboss1', 'PATCH', '/api/resources/10', { body: { location: 'Harbor 차고' }, expect: 200 }),
      S('underboss1', 'PATCH', '/api/resources/10/status', { body: { status: 'MAINTENANCE', reason: '정기 정비' }, expect: 200, see: 'from = AVAILABLE, to = MAINTENANCE' }),
      S('underboss1', 'GET', '/api/resources?status=MAINTENANCE', { expect: 200, see: 'VH-003, VH-005', assert: (j) => j.meta.total === 2 }),
    ],
  },
  {
    id: 'FR-14', group: 'FR', title: '사용자는 자신의 권한과 자원의 상태에 따라 이용 가능한 자원을 확인할 수 있어야 한다.',
    impl: '자원마다 이용 최소 역할 등급(minRoleLevel)과 소유 Crew 를 두고, 조회 시 서버에서 필터링. /api/resources/available 은 상태·기존 배정까지 고려.',
    steps: [
      S('soldier1', 'GET', '/api/resources', { expect: 200, see: '등급 3 자원(창고/은신처)과 타 Crew 자원 제외', assert: (j) => j.data.every((r) => r.minRoleLevel <= 2 && (r.crewId === null || r.crewId === 1)) }),
      S('soldier1', 'GET', '/api/resources/available?startAt=2030-01-01T00:00:00Z&endAt=2030-01-01T02:00:00Z', { expect: 200, see: '사용 가능한(usable=true) 자원만', assert: (j) => j.data.every((r) => r.usable) }),
      S('soldier1', 'GET', '/api/resources/4', { expect: 403, see: '등급 3 창고(WH-001) 접근 거부' }),
      S('boss', 'GET', '/api/resources/4', { expect: 200 }),
    ],
  },
  {
    id: 'FR-15', group: 'FR', title: '자원의 사용, 반환 및 상태 변경 이력은 추후 확인할 수 있어야 한다.',
    impl: '배정(예약)→체크아웃(사용)→반납 흐름을 MySQL resource_allocations 에 저장하고, 모든 이벤트를 MongoDB resource_history 에 기록.',
    steps: [
      S('boss', 'POST', '/api/allocations', { body: { resourceId: 5, memberId: 8, startAt: F, endAt: T, purpose: '연락용' }, expect: 201, see: 'data.id = 4, status = RESERVED', assert: (j) => j.data.id === 4 }),
      S('soldier1', 'POST', '/api/allocations/4/checkout', { expect: 200, see: 'status = IN_USE' }),
      S('soldier1', 'POST', '/api/allocations/4/return', { body: { condition: 'GOOD', note: '이상 없음' }, expect: 200, see: 'status = RETURNED, resourceStatus = AVAILABLE' }),
      S('boss', 'GET', '/api/resources/5/history', { expect: 200, see: 'ALLOCATED, CHECKED_OUT, RETURNED 이벤트', assert: (j) => ['ALLOCATED', 'CHECKED_OUT', 'RETURNED'].every((e) => j.data.some((h) => h.event === e)) }),
      S('boss', 'GET', '/api/allocations?resourceId=5', { expect: 200, see: '사용 기록 2건(과거 1 + 신규 1)', assert: (j) => j.meta.total === 2 }),
    ],
  },
  {
    id: 'FR-16', group: 'FR', title: '사용 불가 또는 점검이 필요한 자원은 정상 자원과 구분하여 관리되어야 한다.',
    impl: 'NEEDS_INSPECTION / MAINTENANCE / UNAVAILABLE / RETIRED 상태를 정상 자원과 구분(usable=false). 이상 신고 시 자동으로 점검 필요 전환, /api/resources/attention 에서 별도 관리, 해결 처리 시 복구.',
    steps: [
      S('boss', 'GET', '/api/resources/attention', { expect: 200, see: 'blocked 에 VH-003(정비중), CM-002(사용불가), EQ-001(점검필요)', assert: (j) => j.data.blocked.length === 3 }),
      S('boss', 'GET', '/api/resources?usable=false', { expect: 200, see: '사용 불가 계열 자원 3건', assert: (j) => j.meta.total === 3 }),
      S('soldier1', 'POST', '/api/resources/1/issues', { body: { severity: 'MEDIUM', description: '타이어 경고등 점등' }, expect: 201, see: 'resourceStatus = NEEDS_INSPECTION', assert: (j) => j.data.resourceStatus === 'NEEDS_INSPECTION' }),
      S('capo1', 'POST', '/api/allocations', { body: { resourceId: 1, memberId: 8, startAt: F, endAt: T }, expect: 409, rule: 'BR-08', see: '점검 필요 자원 배정 거부' }),
      S('underboss1', 'POST', '/api/resource-issues/2/resolve', { body: { resolution: '점검 완료' }, expect: 200, see: 'status = RESOLVED, resourceStatus = AVAILABLE', assert: (j) => j.data.resourceStatus === 'AVAILABLE' }),
    ],
  },
  {
    id: 'FR-17', group: 'FR', title: '권한을 가진 사용자는 업무 수행에 필요한 자원을 업무 또는 구성원에게 배정할 수 있어야 한다.',
    impl: 'POST /api/allocations (업무 또는 구성원 지정, 업무 배정 시 일정 자동 적용). 구성원은 사용 요청(POST /api/resource-requests)을 하고 관리자가 승인하면 배정 생성.',
    steps: [
      S('capo3', 'POST', '/api/allocations', { body: { resourceId: 9, taskId: 5, purpose: '답사 이동' }, expect: 201, see: '5번 업무 일정으로 VH-004 예약' }),
      S('capo1', 'POST', '/api/resource-requests/1/approve', { body: { comment: '승인' }, expect: 200, see: 'status = APPROVED, allocationId 생성', assert: (j) => j.data.status === 'APPROVED' && j.data.allocationId }),
      S('soldier2', 'GET', '/api/me/dashboard', { expect: 200, see: 'allocations 에 CM-001(무전기 세트 1)', assert: (j) => j.data.allocations.some((a) => a.code === 'CM-001') }),
    ],
  },
  {
    id: 'FR-18', group: 'FR', title: '구성원의 활동 결과를 바탕으로 평가 또는 평판 정보를 기록할 수 있어야 한다.',
    impl: 'MongoDB evaluations(항목별 점수·가중 평균·수정 이력), evaluation_criteria(평가 항목/가중치), reputation_ledger(평판 가감점). 완료 업무 참여자만 업무 기반 평가 가능.',
    steps: [
      S('capo2', 'POST', '/api/tasks/3/complete', { body: { outcome: 'SUCCESS', summary: '화물 인수 완료' }, expect: 200 }),
      S('capo2', 'POST', '/api/evaluations', { body: { memberId: 10, taskId: 3, scores: { loyalty: 4, skill: 5, discretion: 4, teamwork: 4 }, comment: '화물 인수 책임 완수' }, expect: 201, see: 'overall(가중 평균) 자동 계산', assert: (j) => j.data.overall > 4 }),
      S('underboss1', 'POST', '/api/members/8/reputation-adjustments', { body: { points: 5, reason: '위기 상황 신속 대응' }, expect: 201 }),
      S('soldier3', 'GET', '/api/evaluations', { expect: 200, see: '본인 평가 조회 (평가자 이름은 익명)', assert: (j) => j.data.length === 1 && !j.data[0].evaluator.username }),
    ],
  },
  {
    id: 'FR-19', group: 'FR', title: '권한을 가진 사용자는 필요한 범위에서 구성원의 활동 및 평가 이력을 확인할 수 있어야 한다.',
    impl: 'evaluation.read / member.read 권한 + 관리 범위 내 구성원에 대해서만 평가·평판·참여 이력·활동 기록 조회 허용.',
    steps: [
      S('capo1', 'GET', '/api/evaluations?memberId=8', { expect: 200, see: 'soldier1 평가 1건', assert: (j) => j.meta.total === 1 }),
      S('capo1', 'GET', '/api/members/8/reputation', { expect: 200, see: 'evaluationAverage, ledgerPoints, attendanceRate, score' }),
      S('capo1', 'GET', '/api/activities?memberId=8', { expect: 200, see: 'soldier1 활동 기록', assert: (j) => j.meta.total > 0 }),
      S('capo1', 'GET', '/api/members/10/reputation', { expect: 403, see: '관리 범위 밖(Harbor) 구성원 평판 조회 거부' }),
      S('soldier1', 'GET', '/api/members/9/reputation', { expect: 403, see: '권한 없는 사용자 거부' }),
    ],
  },
  {
    id: 'FR-20', group: 'FR', title: '시스템은 중요 상태 변경과 관리 활동을 추후 확인할 수 있도록 기록해야 한다.',
    impl: 'MongoDB audit_logs 에 행위자·행위·대상·상세·결과(SUCCESS/DENIED)·IP 기록. 권한 거부 시도도 자동 기록. 조회·집계·CSV 내보내기 제공.',
    steps: [
      S('capo1', 'PATCH', '/api/members/14/role', { body: { role: 'SOLDIER', reason: '승급' }, expect: 200 }),
      S('soldier1', 'GET', '/api/admin/accounts', { expect: 403 }),
      S('admin', 'GET', '/api/audit-logs?action=MEMBER_ROLE_CHANGED', { expect: 200, see: 'capo1 의 역할 변경 기록', assert: (j) => j.data.some((l) => l.actor.username === 'capo1') }),
      S('admin', 'GET', '/api/audit-logs?result=DENIED', { expect: 200, see: 'soldier1 의 거부된 접근 기록', assert: (j) => j.data.some((l) => l.actor.username === 'soldier1') }),
      S('admin', 'GET', '/api/audit-logs/summary', { expect: 200, see: '행위별/결과별/일자별 집계' }),
    ],
  },
  {
    id: 'FR-21', group: 'FR', title: '사용자는 권한 범위 내에서 구성원, Crew, 업무, 자원 등의 정보를 검색하거나 조건에 따라 조회할 수 있어야 한다.',
    impl: '통합 검색(/api/search), 자동완성, 대상별 목록 API 의 필터·정렬·페이지. 모든 검색에 역할별 조회 범위가 SQL 조건으로 적용.',
    steps: [
      S('soldier1', 'GET', '/api/search?q=Brooklyn', { expect: 200, see: 'crews/tasks/members/resources 별 결과', assert: (j) => j.data.counts.crews >= 1 }),
      S('capo1', 'GET', '/api/members?q=Paulie&sort=name', { expect: 200, see: 'soldier1(Paulie Conti)', assert: (j) => j.meta.total === 1 }),
      S('boss', 'GET', '/api/resources?q=세단', { expect: 200, see: 'VH-001 검정 세단', assert: (j) => j.data[0].code === 'VH-001' }),
      S('boss', 'GET', '/api/crews?q=Harbor', { expect: 200, assert: (j) => j.meta.total === 1 }),
      S('soldier1', 'GET', '/api/members?crewId=3', { expect: 200, see: '권한 범위 밖(Uptown) 구성원 0건', assert: (j) => j.meta.total === 0 }),
    ],
  },
  {
    id: 'FR-22', group: 'FR', title: '관리자는 기간, Crew, 구성원 상태, 업무 상태 등 시스템에 축적된 정보를 기반으로 운영 현황을 확인할 수 있어야 한다.',
    impl: '/api/stats/* 11종 (KPI 요약, 구성원 분포, Crew 비교, 업무 분포/추이, 업무량, 자원 가동률/이슈, 평가, 활동 히트맵, 상태 변경 추이). Underboss 는 감독 Crew 범위로 자동 제한.',
    steps: [
      S('admin', 'GET', '/api/stats/overview', { expect: 200, see: 'members / tasks / resources KPI' }),
      S('boss', 'GET', '/api/stats/crews?from=2026-01-01T00:00:00Z', { expect: 200, see: 'Crew 3개 비교', assert: (j) => j.data.length === 3 }),
      S('boss', 'GET', '/api/stats/tasks?crewId=1', { expect: 200, see: 'byStatus / byPriority / byOutcome' }),
      S('boss', 'GET', '/api/stats/members', { expect: 200, see: '상태별·역할별·Crew별 구성원 분포', assert: (j) => j.data.byStatus.ACTIVE > 0 }),
      S('boss', 'GET', '/api/stats/tasks/trend?interval=month', { expect: 200 }),
      S('underboss2', 'GET', '/api/stats/overview', { expect: 200, see: 'scope = [3] (감독 Crew 만)', assert: (j) => Array.isArray(j.data.scope) && j.data.scope.length === 1 }),
      S('soldier1', 'GET', '/api/stats/overview', { expect: 403 }),
    ],
  },
  {
    id: 'FR-23', group: 'FR', title: '관리자는 계정 및 권한과 관련된 필요한 관리 기능을 수행할 수 있어야 한다.',
    impl: '계정 목록·잠금/해제·비밀번호 초기화·강제 로그아웃·아이디 변경·로그인 이력·실패 탐지, 역할별 권한 매트릭스 관리(즉시 반영), 시스템 설정, 무결성 점검, 데모 초기화.',
    steps: [
      S('admin', 'GET', '/api/admin/accounts?sort=-lastLoginAt', { expect: 200 }),
      S('admin', 'POST', '/api/admin/accounts/9/lock', { body: { reason: '보안 조사' }, expect: 200, see: 'isLocked = true' }),
      S(null, 'POST', '/api/auth/login', { body: { username: 'soldier2', password: 'pass1234' }, expect: 401, see: '잠긴 계정 로그인 차단' }),
      S('admin', 'POST', '/api/admin/accounts/9/unlock', { expect: 200 }),
      S('capo1', 'GET', '/api/stats/overview', { expect: 403, see: 'Capo 는 기본적으로 통계 권한 없음' }),
      S('admin', 'POST', '/api/roles/CAPO/permissions', { body: { permission: 'stats.read' }, expect: 201 }),
      S('capo1', 'GET', '/api/stats/overview', { expect: 200, see: '권한 부여가 즉시 반영됨' }),
      S('admin', 'PATCH', '/api/admin/settings', { body: { maxActiveAssignmentsPerMember: 3 }, expect: 200 }),
    ],
  },

  /* ============================== 업무 규칙 ============================== */
  {
    id: 'BR-01', group: 'BR', title: '하나의 구성원은 동시에 둘 이상의 Crew에 정식 소속될 수 없다.',
    impl: '① 서버: 편성/가입승인/이동 시 기존 정식 소속을 FOR UPDATE 로 잠그고 검사. ② DB: crew_memberships 의 생성 컬럼 active_formal_key 에 UNIQUE 제약 → 어떤 경로로도 위반 불가. 이동은 소속 종료+신규 소속을 하나의 트랜잭션으로 처리.',
    steps: [
      S('capo1', 'POST', '/api/crews/1/members', { body: { memberId: 10 }, expect: 409, rule: 'BR-01', see: 'Harbor Crew 정식 소속인 soldier3 의 정식 편성 거부' }),
      S('capo1', 'POST', '/api/crews/1/members', { body: { memberId: 10, membershipType: 'AFFILIATE' }, expect: 201, see: '정식이 아닌 준소속(AFFILIATE)은 허용' }),
      S('underboss1', 'POST', '/api/crews/2/members/10/transfer', { body: { targetCrewId: 1, reason: '정식 이동' }, expect: 200, see: '이동(transfer)으로는 정식 소속 변경 가능' }),
      S('admin', 'GET', '/api/admin/integrity-check', { expect: 200, see: "checks['BR-01 multipleFormalCrews'] = [] (위반 0건)", assert: (j) => j.data.checks['BR-01 multipleFormalCrews'].length === 0 }),
    ],
  },
  {
    id: 'BR-02', group: 'BR', title: '정지 또는 탈퇴 상태의 구성원은 새로운 업무에 배정될 수 없다.',
    impl: '배정 트랜잭션에서 구성원 행을 FOR UPDATE 로 잠근 뒤 상태 검사(SUSPENDED/WITHDRAWN/PENDING 거부). 정지 징계 시 상태 자동 전환, 탈퇴 시 기존 미완료 배정 자동 해제.',
    steps: [
      S('capo1', 'POST', '/api/tasks/2/assignments', { body: { memberId: 16 }, expect: 409, rule: 'BR-02', see: '정지(SUSPENDED) 구성원 suspended1 배정 거부' }),
      S('boss', 'POST', '/api/tasks/5/assignments', { body: { memberId: 18 }, expect: 409, rule: 'BR-02', see: '탈퇴(WITHDRAWN) 구성원 배정 거부' }),
      S('capo1', 'POST', '/api/members/9/disciplinary-actions', { body: { actionType: 'SUSPENSION', reason: '보고 누락' }, expect: 201, see: 'statusChange.to = SUSPENDED', assert: (j) => j.data.statusChange.to === 'SUSPENDED' }),
      S('capo1', 'POST', '/api/tasks/2/assignments', { body: { memberId: 9 }, expect: 409, rule: 'BR-02', see: '방금 정지된 soldier2 배정 거부' }),
      S('capo1', 'POST', '/api/tasks/2/assignments', { body: { memberId: 14 }, expect: 201, see: '활동중 구성원은 정상 배정' }),
    ],
  },
  {
    id: 'BR-03', group: 'BR', title: '동일 시간대에 동시에 수행할 수 없는 업무가 하나의 구성원에게 중복 배정되어서는 안 된다.',
    impl: '배정·인원교체·일정변경·취소복구 시 구성원의 진행 전/중 업무와 시간 구간 겹침(start<기존end AND end>기존start)을 검사. 두 업무가 모두 allowConcurrent=true 인 경우만 예외. 구성원 행 잠금으로 동시 요청에도 1건만 성공.',
    steps: [
      S('capo1', 'GET', '/api/tasks/1', { expect: 200, save: 't1', see: '1번 업무의 startAt / endAt 확인 (soldier1 배정됨)' }),
      S('capo1', 'POST', '/api/tasks/2/assignments', { body: { memberId: 8 }, expect: 409, rule: 'BR-03', see: '1번 업무와 시간이 겹치는 2번 업무에 soldier1 배정 거부 (details.conflicts 에 1번 업무)' }),
      S('capo1', 'GET', '/api/tasks/2/candidates', { expect: 200, see: '후보 목록에 soldier1(8) 제외', assert: (j) => !j.data.some((c) => c.memberId === 8) }),
      S('capo1', 'POST', '/api/tasks', { body: { title: '중복 시간 업무', crewId: 1, startAt: '{{t1.startAt}}', endAt: '{{t1.endAt}}' }, expect: 201, see: '1번 업무와 같은 시간의 새 업무(id = 25)' }),
      S('capo1', 'POST', '/api/tasks/25/assignments', { body: { memberId: 8 }, expect: 409, rule: 'BR-03' }),
      S('capo1', 'POST', '/api/tasks/25/assignments', { body: { memberId: 14 }, expect: 201, see: '일정이 비어 있는 associate1 은 배정 가능' }),
      S('capo1', 'PATCH', '/api/tasks/2/schedule', { body: { startAt: '2030-04-01T09:00:00Z', endAt: '2030-04-01T10:00:00Z' }, expect: 200 }),
      S('capo1', 'POST', '/api/tasks/2/assignments', { body: { memberId: 8 }, expect: 201, see: '일정을 옮긴 뒤에는 배정 가능' }),
    ],
  },
  {
    id: 'BR-04', group: 'BR', title: '구성원은 자신보다 높은 권한을 가진 사용자의 역할을 임의로 변경할 수 없다.',
    impl: '역할/상태/징계/계정 변경 시 대상의 현재 등급과 부여할 역할 등급이 모두 요청자보다 낮아야 함(Administrator 예외). 자기 자신 변경 금지. Capo 는 Associate↔Soldier 만 변경.',
    steps: [
      S('capo1', 'PATCH', '/api/members/3/role', { body: { role: 'SOLDIER' }, expect: 403, rule: 'BR-04', see: 'Capo → Underboss 역할 변경 거부' }),
      S('capo1', 'PATCH', '/api/members/14/role', { body: { role: 'CAPO' }, expect: 403, rule: 'BR-04', see: '자신과 같은 등급 부여 거부' }),
      S('capo1', 'PATCH', '/api/members/5/role', { body: { role: 'SOLDIER' }, expect: 403, rule: 'BR-04', see: '자기 자신 역할 변경 거부' }),
      S('underboss1', 'PATCH', '/api/members/2/status', { body: { status: 'SUSPENDED' }, expect: 403, rule: 'BR-04', see: 'Underboss → Boss 상태 변경 거부' }),
      S('capo1', 'PATCH', '/api/members/14/role', { body: { role: 'SOLDIER', reason: '승급' }, expect: 200, see: '하위 구성원은 변경 가능' }),
    ],
  },
  {
    id: 'BR-05', group: 'BR', title: 'Crew 책임자는 자신이 관리하지 않는 Crew의 구성원 편성을 임의로 변경할 수 없다.',
    impl: '모든 편성 API(추가/제외/이동/가입승인/책임자 지정)에서 services/scope.js 의 assertManageCrew 로 대상 Crew(이동은 출발·도착 모두)가 관리 범위인지 검사.',
    steps: [
      S('capo1', 'POST', '/api/crews/2/members', { body: { memberId: 17 }, expect: 403, rule: 'BR-05', see: 'Harbor Crew 편성 거부' }),
      S('capo1', 'DELETE', '/api/crews/2/members/11', { expect: 403, rule: 'BR-05', see: 'Harbor Crew 구성원 제외 거부' }),
      S('capo1', 'POST', '/api/crews/1/members/9/transfer', { body: { targetCrewId: 2 }, expect: 403, rule: 'BR-05', see: '도착 Crew 가 관리 범위 밖이므로 이동 거부' }),
      S('capo2', 'DELETE', '/api/crews/2/members/17', { expect: 200, see: '자신의 Crew 는 편성 변경 가능' }),
    ],
  },
  {
    id: 'BR-06', group: 'BR', title: '완료된 업무의 핵심 결과 정보는 일반 구성원이 임의로 변경할 수 없어야 한다.',
    impl: '완료 업무의 기본정보·일정·상태·배정·체크리스트 변경을 서버에서 차단. 결과 수정/재개는 task.result.amend 권한(Underboss 이상)만 가능하며 사유와 변경 전 값이 이력에 남음. 기록된 참여 결과의 재수정도 동일.',
    steps: [
      S('capo2', 'POST', '/api/tasks/3/complete', { body: { outcome: 'SUCCESS', summary: '화물 인수 완료', participation: [{ memberId: 11, attendance: 'PRESENT', contribution: 90 }] }, expect: 200 }),
      S('soldier3', 'PATCH', '/api/tasks/3/result', { body: { outcome: 'FAILURE', reason: '변경 시도' }, expect: 403, see: '일반 구성원 결과 수정 거부' }),
      S('capo2', 'PATCH', '/api/tasks/3/result', { body: { outcome: 'FAILURE', reason: '변경 시도' }, expect: 403, see: 'Capo 도 결과 수정 권한 없음' }),
      S('capo2', 'PATCH', '/api/tasks/3', { body: { title: '제목 변경' }, expect: 409, rule: 'BR-06', see: '완료 업무 정보 변경 거부' }),
      S('capo2', 'PUT', '/api/tasks/3/assignments/11/participation', { body: { attendance: 'ABSENT', contribution: 0 }, expect: 409, rule: 'BR-06', see: '기록된 참여 결과 재수정 거부' }),
      S('underboss1', 'PATCH', '/api/tasks/3/result', { body: { value: 14000, reason: '정산 반영' }, expect: 200, see: 'Underboss 는 사유와 함께 수정 가능' }),
      S('underboss1', 'GET', '/api/tasks/3/status-history?event=RESULT_AMENDED', { expect: 200, see: 'from(변경 전 값) / to / note(사유) 기록', assert: (j) => j.data.length === 1 && j.data[0].note === '정산 반영' }),
    ],
  },
  {
    id: 'BR-07', group: 'BR', title: '이미 사용 중인 자원은 동일 시간대에 다른 업무 또는 사용자에게 중복 배정될 수 없다.',
    impl: '배정·기간변경·요청승인·업무 일정변경 시 자원 행을 FOR UPDATE 로 잠그고 RESERVED/IN_USE 배정과 시간 겹침 검사. 체크아웃 시 미반납 사용자가 있으면 거부.',
    steps: [
      S('capo1', 'POST', '/api/allocations', { body: { resourceId: 1, taskId: 2 }, expect: 409, rule: 'BR-07', see: '1번 업무에 예약된 VH-001 을 시간이 겹치는 2번 업무에 배정 거부' }),
      S('boss', 'POST', '/api/allocations', { body: { resourceId: 9, memberId: 12, startAt: '2030-02-01T10:00:00Z', endAt: '2030-02-01T12:00:00Z' }, expect: 201 }),
      S('boss', 'POST', '/api/allocations', { body: { resourceId: 9, memberId: 13, startAt: '2030-02-01T11:00:00Z', endAt: '2030-02-01T13:00:00Z' }, expect: 409, rule: 'BR-07', see: '11~12시 겹침' }),
      S('boss', 'POST', '/api/allocations', { body: { resourceId: 9, memberId: 13, startAt: '2030-02-01T12:00:00Z', endAt: '2030-02-01T14:00:00Z' }, expect: 201, see: '겹치지 않는 연속 시간은 허용' }),
    ],
  },
  {
    id: 'BR-08', group: 'BR', title: '사용 불가 상태의 자원은 새로운 업무에 배정할 수 없다.',
    impl: 'NEEDS_INSPECTION / MAINTENANCE / UNAVAILABLE / RETIRED 자원은 배정·기간변경·사용요청·체크아웃 모두 거부.',
    steps: [
      S('boss', 'POST', '/api/allocations', { body: { resourceId: 3, taskId: 5 }, expect: 409, rule: 'BR-08', see: '정비중(MAINTENANCE) VH-003 배정 거부' }),
      S('boss', 'POST', '/api/allocations', { body: { resourceId: 6, memberId: 8, startAt: F, endAt: T }, expect: 409, rule: 'BR-08', see: '사용 불가(UNAVAILABLE) CM-002' }),
      S('soldier1', 'POST', '/api/resource-requests', { body: { resourceId: 8, startAt: F, endAt: T, purpose: '금고 작업' }, expect: 409, rule: 'BR-08', see: '점검 필요(NEEDS_INSPECTION) EQ-001 사용 요청 거부' }),
      S('underboss1', 'PATCH', '/api/resources/3/status', { body: { status: 'AVAILABLE', reason: '정비 완료' }, expect: 200 }),
      S('boss', 'POST', '/api/allocations', { body: { resourceId: 3, taskId: 5 }, expect: 201, see: '정상 상태로 복구 후 배정 가능' }),
    ],
  },
  {
    id: 'BR-09', group: 'BR', title: '권한이 없는 사용자는 제한된 조직 정보 또는 관리 기능에 직접 URL로 접근하더라도 작업을 수행할 수 없어야 한다.',
    impl: '모든 보호 API 에 인증 미들웨어 + 권한 코드 검사 + 데이터 범위 검사를 서버에서 적용(화면 표시와 무관). 매 요청마다 DB 에서 최신 역할/상태/잠금/토큰버전을 확인. 거부 시도는 감사 로그에 DENIED 로 기록.',
    steps: [
      S(null, 'GET', '/api/members', { expect: 401, see: '토큰 없이 접근 거부' }),
      S('soldier1', 'GET', '/api/audit-logs', { expect: 403, rule: 'BR-09' }),
      S('soldier1', 'DELETE', '/api/members/19', { expect: 403, rule: 'BR-09', see: '관리 기능 URL 직접 호출 거부' }),
      S('associate1', 'PATCH', '/api/admin/settings', { body: { loginLockThreshold: 3 }, expect: 403, rule: 'BR-09' }),
      S('capo1', 'GET', '/api/tasks/3', { expect: 403, rule: 'BR-09', see: '다른 Crew 업무 상세 조회 거부' }),
      S('admin', 'GET', '/api/audit-logs?result=DENIED', { expect: 200, see: '위 거부 시도들이 DENIED 로 기록됨', assert: (j) => j.meta.total >= 4 }),
    ],
  },
  {
    id: 'BR-10', group: 'BR', title: '구성원의 역할, 소속, 상태 및 평가와 관련된 주요 변경 이력은 추후 확인할 수 있어야 한다.',
    impl: '역할·소속·상태·평가·평판·징계 변경을 MongoDB member_history 에 이전 값/새 값/사유/변경자/시각과 함께 기록. 소속 이력은 MySQL crew_memberships(joined_at/left_at)에도 보존.',
    steps: [
      S('capo1', 'PATCH', '/api/members/14/role', { body: { role: 'SOLDIER', reason: '승급' }, expect: 200 }),
      S('underboss1', 'POST', '/api/crews/1/members/14/transfer', { body: { targetCrewId: 2, reason: '항만 지원' }, expect: 200 }),
      S('capo2', 'PATCH', '/api/members/14/status', { body: { status: 'STANDBY', reason: '대기 발령' }, expect: 200 }),
      S('capo2', 'GET', '/api/members/14/history', { expect: 200, see: 'ROLE / CREW / STATUS 이력 (from, to, reason, by, at)', assert: (j) => ['ROLE', 'CREW', 'STATUS'].every((t) => j.data.some((h) => h.type === t)) }),
      S('boss', 'GET', '/api/stats/status-changes', { expect: 200, see: '변경 유형별 집계' }),
    ],
  },

  /* ============================== 데이터 요구사항 ============================== */
  {
    id: 'DR-01', group: 'DR', title: '계정, 권한, 구성원, Crew 소속 및 상태 사이의 관계가 일관성 있게 유지되어야 한다.',
    impl: 'MySQL InnoDB 의 FK, UNIQUE(생성 컬럼), CHECK, ENUM 제약과 트랜잭션으로 일관성 보장. roles–role_permissions–permissions, members–crew_memberships–crews 관계.',
    steps: [
      S('admin', 'GET', '/api/admin/integrity-check', { expect: 200, see: 'ok = true', assert: (j) => j.data.ok === true }),
      S('boss', 'DELETE', '/api/regions/1', { expect: 422, see: 'Crew 가 참조 중인 지역 삭제 거부' }),
      S('boss', 'DELETE', '/api/members/8', { expect: 422, see: '이력이 있는 구성원은 삭제 대신 WITHDRAWN 처리' }),
      S('boss', 'GET', '/api/roles/CAPO/permissions', { expect: 200, see: '역할-권한 매트릭스' }),
    ],
  },
  {
    id: 'DR-02', group: 'DR', title: '업무와 참여 구성원 사이의 관계를 확인할 수 있어야 한다.',
    impl: 'MySQL task_assignments (task_id, member_id FK, 활성 배정 중복 방지 UNIQUE).',
    steps: [
      S('boss', 'GET', '/api/tasks/1', { expect: 200, see: 'assignees 2명', assert: (j) => j.data.assignees.length === 2 }),
      S('boss', 'GET', '/api/tasks/1/assignments', { expect: 200 }),
      S('boss', 'GET', '/api/members/8/assignments', { expect: 200, see: 'soldier1 이 참여한 업무 목록', assert: (j) => j.meta.total >= 2 }),
    ],
  },
  {
    id: 'DR-03', group: 'DR', title: '공용 자원의 현재 상태와 사용 이력을 모두 확인할 수 있어야 한다.',
    impl: '현재 상태: MySQL resources.status + 활성 배정. 사용 이력: MySQL resource_allocations(배정/사용/반납 레코드) + MongoDB resource_history(이벤트 로그).',
    steps: [
      S('boss', 'GET', '/api/resources/2', { expect: 200, see: 'status = IN_USE, currentUse.allocationId = 2', assert: (j) => j.data.status === 'IN_USE' && j.data.currentUse }),
      S('boss', 'GET', '/api/resources/2/history', { expect: 200, see: 'CHECKED_OUT 이벤트' }),
      S('boss', 'GET', '/api/allocations?resourceId=2', { expect: 200, assert: (j) => j.meta.total === 1 }),
    ],
  },
  {
    id: 'DR-04', group: 'DR', title: '시간에 따라 지속적으로 생성되는 활동, 상태 변경, 기록 및 평가 정보를 저장할 수 있어야 한다.',
    impl: 'MongoDB 컬렉션: activities, member_history, task_history, resource_history, evaluations, audit_logs, notifications, login_history 등 (스키마 유연, 시간 인덱스).',
    steps: [
      S('boss', 'GET', '/api/activities?size=5', { expect: 200, see: '활동 기록 60건 이상', assert: (j) => j.meta.total >= 60 }),
      S('soldier1', 'POST', '/api/activities', { body: { type: 'PATROL', description: '창고 주변 순찰', details: { checkpoints: 4, incidents: 0 } }, expect: 201, see: '자유 형식 details 저장' }),
      S('boss', 'GET', '/api/members/16/history', { expect: 200, see: 'ACTIVE → SUSPENDED 이력' }),
      S('boss', 'GET', '/api/evaluations', { expect: 200, assert: (j) => j.meta.total === 4 }),
    ],
  },
  {
    id: 'DR-05', group: 'DR', title: '데이터의 특성에 따라 SQL와 MongoDB를 적절히 사용해야 하며, 두 DB를 모두 실제 기능에서 사용해야 한다.',
    impl: 'MySQL: 관계·일관성이 중요한 20개 테이블. MongoDB: 계속 증가하거나 구조가 유연한 19개 컬렉션. 대부분의 기능 흐름(예: 업무 완료)이 두 DB 를 함께 사용.',
    steps: [
      S('admin', 'GET', '/api/admin/system/info', { expect: 200, see: 'mysql.tables (20개) 와 mongo.collections 데이터 건수', assert: (j) => Object.keys(j.data.mysql.tables).length === 20 }),
    ],
  },
  {
    id: 'DR-06', group: 'DR', title: '각 데이터베이스의 이름에는 본인의 학번이 포함되어야 하며, 필요한 Table 혹은 Collection의 구조를 직접 설계해야 한다.',
    impl: 'MySQL DB: family_{학번}, MongoDB DB: family_log_{학번} (config/index.js 의 STUDENT_ID).',
    steps: [
      S('admin', 'GET', '/api/admin/system/info', { expect: 200, see: 'mysql.database, mongo.database 에 학번 포함', assert: (j) => j.data.mysql.database.includes(j.data.studentId) && j.data.mongo.database.includes(j.data.studentId) }),
    ],
  },

  /* ============================== REST API 요구사항 ============================== */
  {
    id: 'AR-01', group: 'AR', title: '각 API는 담당 기능의 목적에 적합한 HTTP Method를 사용해야 한다.',
    impl: '조회 GET, 생성 POST(201), 전체 교체 PUT, 부분 수정 PATCH, 삭제/취소 DELETE, 상태 전이 동작(승인·완료·체크아웃 등)은 하위 리소스 POST.',
    steps: [S(null, 'GET', '/api/api-catalog?tag=Tasks', { expect: 200, see: '업무 API 의 Method 구성 확인' })],
  },
  {
    id: 'AR-02', group: 'AR', title: 'Path Parameter, Query Parameter, Header, Request Body는 데이터의 의미와 요청 목적에 맞게 사용해야 한다.',
    impl: '식별자=Path, 필터·정렬·페이지=Query, 인증 토큰=Authorization Header, 생성/변경 데이터=JSON Body.',
    steps: [
      S('boss', 'GET', '/api/tasks/1', { expect: 200, see: 'Path Parameter' }),
      S('boss', 'GET', '/api/tasks?status=PLANNED&sort=-startAt', { expect: 200, see: 'Query Parameter' }),
      S('capo1', 'POST', '/api/tasks/1/comments', { body: { body: '현장 확인 완료' }, expect: 201, see: 'Request Body + Authorization Header' }),
    ],
  },
  {
    id: 'AR-03', group: 'AR', title: '검색과 조회 기능은 필요한 경우 필터링, 정렬, 검색 및 페이지 단위 조회 등의 방법을 제공해야 한다.',
    impl: '목록 API 공통: page, size(최대 100), sort(허용 필드, -접두사 내림차순) + 리소스별 필터. 응답 meta 에 page/size/total/totalPages.',
    steps: [
      S('boss', 'GET', '/api/members?q=o&status=ACTIVE&sort=-joinedAt&page=2&size=5', { expect: 200, see: 'meta.page = 2, data 5건 이하', assert: (j) => j.meta.page === 2 && j.data.length <= 5 }),
      S('boss', 'GET', '/api/tasks?sort=unknown', { expect: 400, see: '허용되지 않은 정렬 기준' }),
    ],
  },
  {
    id: 'AR-04', group: 'AR', title: 'API는 정상 요청뿐 아니라 잘못된 입력, 존재하지 않는 대상, 권한 부족 및 업무 규칙 위반을 적절한 방식으로 처리해야 한다.',
    impl: '400 VALIDATION_ERROR(필드별 details) / 401 / 403 FORBIDDEN(rule) / 404 NOT_FOUND / 409 BUSINESS_RULE_VIOLATION(rule) / 422 INVALID_STATE.',
    steps: [
      S('capo1', 'POST', '/api/tasks', { body: { title: 'x' }, expect: 400, see: 'details 에 crewId/startAt/endAt 누락', assert: (j) => j.error.details.length === 3 }),
      S('boss', 'GET', '/api/tasks/99999', { expect: 404 }),
      S('soldier1', 'GET', '/api/audit-logs', { expect: 403 }),
      S('capo1', 'POST', '/api/tasks/2/assignments', { body: { memberId: 8 }, expect: 409, rule: 'BR-03' }),
      S('capo1', 'PATCH', '/api/tasks/1/status', { body: { status: 'ON_HOLD' }, expect: 422 }),
    ],
  },
  {
    id: 'AR-05', group: 'AR', title: 'API 요청과 응답의 형식과 오류 표현은 서비스 전반에서 일관된 방식으로 설계되어야 한다.',
    impl: '성공 { success:true, message, data, meta? } / 실패 { success:false, error:{ code, message, details } } 를 lib/api.js 와 lib/errorHandler.js 에서 일괄 생성.',
    steps: [
      S('boss', 'GET', '/api/crews/1', { expect: 200, see: 'success = true, data', assert: (j) => j.success === true }),
      S('boss', 'GET', '/api/crews/999', { expect: 404, see: 'success = false, error.code = NOT_FOUND', assert: (j) => j.success === false && j.error.code === 'NOT_FOUND' }),
    ],
  },
  {
    id: 'AR-06', group: 'AR', title: '전체 시스템에는 200개 이상의 유효한 REST API가 구현되어야 한다.',
    impl: 'lib/api.js 레지스트리에 등록된 API 수가 Swagger 와 카탈로그에 그대로 표시된다.',
    steps: [S(null, 'GET', '/api/api-catalog', { expect: 200, see: 'total ≥ 200', assert: (j) => j.data.total >= 200 })],
  },
  {
    id: 'AR-07', group: 'AR', title: '동일한 동작을 URL, 이름 또는 Parameter만 바꾸어 반복 구현한 경우 서로 다른 API로 인정하지 않는다.',
    impl: '각 API 는 서로 다른 업무 동작을 수행하도록 설계(예: 상태 변경 vs 완료 처리(결과 입력) vs 결과 수정(권한·이력) vs 재개). 단순 필터 차이는 하나의 목록 API 의 Query Parameter 로 통합.',
    steps: [S(null, 'GET', '/api/api-catalog', { expect: 200, see: '각 API 의 summary 와 연결 요구사항 확인' })],
  },
  {
    id: 'AR-08', group: 'AR', title: '구현된 각 API는 최소 하나 이상의 시스템 요구사항과 연결하여 설명할 수 있어야 한다.',
    impl: '모든 API 정의에 reqs 배열이 필수로 있으며 Swagger 설명·카탈로그·본 보고서 추적표에 자동 반영.',
    steps: [S(null, 'GET', '/api/api-catalog?req=BR-03', { expect: 200, see: 'BR-03 과 연결된 API 목록', assert: (j) => j.data.count > 0 && j.data.items.every((i) => i.reqs.length > 0) })],
  },

  /* ============================== 비기능 요구사항 ============================== */
  {
    id: 'NFR-01', group: 'NFR', title: '사용자가 수행한 주요 작업의 성공 또는 실패 여부를 명확히 확인할 수 있어야 한다.',
    impl: '모든 응답에 success 플래그와 message, HTTP 상태 코드. 실패 시 error.code / message / details(위반 규칙 포함).',
    steps: [
      S('capo1', 'PATCH', '/api/tasks/1/status', { body: { status: 'IN_PROGRESS' }, expect: 200, see: 'success = true, message' }),
      S('capo1', 'PATCH', '/api/tasks/1/status', { body: { status: 'IN_PROGRESS' }, expect: 422, see: 'success = false, error.message 에 허용되지 않는 전이 안내' }),
    ],
  },
  {
    id: 'NFR-02', group: 'NFR', title: '잘못된 입력 또는 비정상 요청으로 인해 서버 프로세스가 비정상적으로 종료되어서는 안 된다.',
    impl: '모든 핸들러 예외를 전역 오류 처리기로 전달, JSON 파싱 오류·DB 오류를 4xx 로 변환, unhandledRejection/uncaughtException 기록 후 계속 실행.',
    steps: [
      S('capo1', 'POST', '/api/tasks', { raw: '{"title": "broken', expect: 400, see: '잘못된 JSON → 400 (curl 로 확인)' }),
      S('boss', 'GET', '/api/tasks/abc', { expect: 400 }),
      S('boss', 'GET', `/api/members?q=${encodeURIComponent("' OR 1=1 --")}`, { expect: 200, see: 'SQL 인젝션 문자열도 안전하게 처리(0건)', assert: (j) => j.meta.total === 0 }),
      S(null, 'GET', '/api/health', { expect: 200, see: 'status = UP (서버 정상 동작 유지)' }),
    ],
  },
  {
    id: 'NFR-03', group: 'NFR', title: '권한 검사는 화면 표시 여부와 무관하게 서버 측에서도 적용되어야 한다.',
    impl: 'BR-09 와 동일. 웹 화면은 메뉴·버튼을 권한별로 숨기지만(편의), 화면 접근과 모든 데이터 처리는 서버가 다시 검사한다. 쿠키 인증 요청은 CSRF 방어 헤더가 없으면 거부된다.',
    steps: [
      S('soldier1', 'POST', '/api/members', { body: { username: 'hacker', password: 'pass1234', name: 'x' }, expect: 403 }),
      S('soldier1', 'PATCH', '/api/members/8/role', { body: { role: 'BOSS' }, expect: 403, see: '자기 권한 상승 시도 거부' }),
    ],
  },
  {
    id: 'NFR-04', group: 'NFR', title: '데이터 수가 증가하더라도 사용자가 필요한 정보를 탐색할 수 있는 방법을 제공해야 한다.',
    impl: '페이지 단위 조회, 필터·정렬, 통합 검색·자동완성, 검색 조건 저장, MySQL/MongoDB 인덱스.',
    steps: [
      S('boss', 'GET', '/api/activities?page=3&size=10&sort=-at', { expect: 200, assert: (j) => j.meta.page === 3 && j.meta.totalPages >= 6 }),
      S('boss', 'GET', '/api/search/suggest?q=Pa', { expect: 200 }),
      S('capo1', 'POST', '/api/me/saved-filters', { body: { name: '긴급 업무', target: 'tasks', query: { priority: 'HIGH,CRITICAL', status: 'PLANNED' } }, expect: 201, see: 'url 에 저장된 검색 조건' }),
    ],
  },
  {
    id: 'NFR-05', group: 'NFR', title: '서비스 전반의 API 응답과 오류 메시지는 가능한 일관된 형태를 가져야 한다.',
    impl: 'AR-05 와 동일. Swagger 의 모든 응답 예시도 동일한 SuccessResponse / ErrorResponse 스키마 사용.',
    steps: [
      S('boss', 'GET', '/api/resources/999', { expect: 404, assert: (j) => j.error.code === 'NOT_FOUND' }),
      S('boss', 'GET', '/api/evaluations/abc', { expect: 400, assert: (j) => j.error.code === 'VALIDATION_ERROR' }),
    ],
  },

  /* ============================== 기술 제약조건 ============================== */
  { id: 'CR-01', group: 'CR', title: '서버는 Node.js와 Express를 기반으로 구현한다.', impl: 'Express 4 기반 (package.json). app.js 진입점.', steps: [S(null, 'GET', '/api/health', { expect: 200 })] },
  { id: 'CR-02', group: 'CR', title: '서버 사이드 rendering이 필요한 화면은 EJS 템플릿 엔진을 사용한다.', impl: 'views/layout.ejs(공통 레이아웃·권한별 메뉴), login.ejs, error.ejs, catalog.ejs. 21개 업무 화면을 서버가 EJS 로 렌더링하며, 권한이 없는 화면은 서버에서 403 으로 차단한다. 화면의 데이터 처리는 동일한 REST API 를 호출한다 (public/js/pages/*.js).', steps: [], manual: ['브라우저에서 http://{서버주소}:3000/ 접속 → 로그인 화면 (데모 계정 버튼 클릭 시 자동 입력)', 'capo1 / pass1234 로그인 → 대시보드 (개인 KPI·처리할 일·일정·알림)', '좌측 "업무" → 업무 2번 → "배정" → 시간 충돌 없는 후보만 추천됨 (BR-02, BR-03)', '좌측 "Crew" → Brooklyn Crew → 구성원·공지·가입 요청·운영 현황 탭', 'soldier1 로 로그인 후 주소창에 /admin/accounts 직접 입력 → "접근 권한이 없습니다" (서버 403, BR-09)', 'boss 로 로그인 → Crew → Brooklyn Crew → 구성원 편성 → Frankie Costa(Harbor) 정식 편성 → BR-01 위반 메시지 표시'] },
  { id: 'CR-03', group: 'CR', title: 'SQL 및 Mongo DB를 모두 사용한다.', impl: 'mysql2 + mongodb 드라이버 (db/mysql.js, db/mongo.js). DR-05 참고.', steps: [S('admin', 'GET', '/api/admin/system/info', { expect: 200 })] },
  { id: 'CR-04', group: 'CR', title: '개발된 모든 API는 Swagger로 문서화한다.', impl: 'API 정의로부터 OpenAPI 3.0 문서를 자동 생성 (lib/api.js), swagger-ui-express 로 /api-docs 제공. 각 API 에 목적·Parameter·Body·응답 예시·오류 예시 포함.', steps: [], manual: ['브라우저에서 http://{서버주소}:3000/api-docs 접속', 'POST /api/auth/login 실행 → token 복사 → Authorize 에 입력', '임의의 API → Try it out → Execute'] },
  { id: 'CR-05', group: 'CR', title: '프로젝트 코드는 기능별 책임을 고려하여 적절히 분리한다.', impl: 'config / db(연결·스키마·시드) / lib(API 레지스트리·검증·인증·보안·오류·기록) / services(업무 규칙·주기 작업) / routes(기능별 API 26개 모듈 + 화면 라우터) / views(EJS) / public(화면 스크립트·스타일) 로 분리.', steps: [] },
  { id: 'CR-06', group: 'CR', title: "제출된 프로젝트는 지정된 Ubuntu 환경에서 'node app.js' 명령 하나로 실행될 수 있어야 한다.", impl: 'node_modules 포함 제출. 최초 실행 시 DB·테이블·인덱스 자동 생성 및 데모 데이터 자동 입력.', steps: [], manual: ['cd ~/midterm', 'node app.js', '콘솔에 "등록된 REST API : N개" 출력 확인'] },
];
