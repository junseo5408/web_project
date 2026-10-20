/**
 * 기술 보고서 생성기
 *  - API 레지스트리(routes), 요구사항 카탈로그(docs/requirements.js), 스키마(db/schema.js)로부터
 *    docs/technical-report.html (인쇄/PDF 저장용) 을 생성한다. DB 연결은 필요 없다.
 * 사용법: node scripts/generate-report.js
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const { registry } = require('../lib/api');
const requirements = require('../docs/requirements');
const schema = require('../db/schema');
const { ROLE_PERMS, PERMISSIONS } = require('../db/seed');
const mongo = require('../db/mongo');

require('../routes')(express());

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const json = (v) => esc(JSON.stringify(v, null, 2));
const ROLES = ['ASSOCIATE', 'SOLDIER', 'CAPO', 'UNDERBOSS', 'BOSS', 'ADMINISTRATOR'];
const GROUP_TITLE = { FR: '기능 요구사항', BR: '업무 규칙', DR: '데이터 요구사항', AR: 'REST API 요구사항', NFR: '비기능 요구사항', CR: '기술 제약조건' };

const MONGO_DOCS = {
  auditLogs: ['관리 활동·중요 상태 변경·권한 거부 감사 로그 (FR-20)', 'at, actor{id,username,role}, action, entity{type,id}, details{}, result(SUCCESS|DENIED), ip'],
  memberHistory: ['구성원 역할/소속/상태/평가/평판/징계 변경 이력 (BR-10)', 'memberId, type(ROLE|CREW|STATUS|EVALUATION|REPUTATION|DISCIPLINE), from, to, reason, by{}, at, (effects, vacated…)'],
  taskHistory: ['업무 상태·일정·배정·결과 변경 이력 (FR-10)', 'taskId, event, from, to, note, by{}, at, (memberId, outcome…)'],
  resourceHistory: ['자원 등록·상태 변경·배정·체크아웃·반납·이슈 이력 (FR-15)', 'resourceId, event, from, to, by{}, at, (allocationId, condition, reason…)'],
  evaluations: ['평가 (FR-18) – 평가 항목이 바뀌어도 스키마 변경 불필요', 'memberId, taskId, evaluator{}, scores{항목코드:점수}, overall, comment, status, revisions[], createdAt'],
  evaluationCriteria: ['평가 항목 및 가중치', 'code, name, description, weight, active'],
  reputationLedger: ['평판 가감점 원장', 'memberId, points, reason, by{}, at'],
  activities: ['구성원 활동 기록 (현장 보고 등 자유 형식)', 'memberId, type, description, refs{taskId}, location, details{}, source, at'],
  taskComments: ['업무 코멘트', 'taskId, author{}, body, createdAt, updatedAt, edited'],
  taskChecklists: ['업무 체크리스트 (가변 길이 항목 배열)', 'taskId(unique), items[{id,text,done,doneBy,updatedAt}], seq'],
  taskTemplates: ['업무 템플릿 (구조화된 기본값 + 체크리스트)', 'name, description, defaults{priority,durationHours,location,allowConcurrent,requiredSkills}, checklist[]'],
  announcements: ['Crew 공지', 'crewId, title, body, pinned, author{}, createdAt'],
  notifications: ['사용자 알림', 'memberId, type, title, message, link, read, createdAt'],
  loginHistory: ['로그인/로그아웃 이력 및 실패 기록', 'memberId, username, event, result, reason, ip, userAgent, at'],
  revokedTokens: ['로그아웃된 토큰 (TTL 인덱스로 만료 시 자동 삭제)', 'jti(unique), memberId, expiresAt'],
  settings: ['시스템 운영 설정', '_id=system, evaluationEditWindowHours, maxActiveAssignmentsPerMember, loginLockThreshold, …'],
  savedFilters: ['사용자별 저장된 검색 조건', 'memberId, name, target, query{}'],
  notificationPrefs: ['알림 수신 거부 설정', 'memberId(unique), mutedTypes[]'],
  meetingMinutes: ['회의록 (자유 형식 본문 + 결정사항)', 'meetingId(unique), content, decisions[], updatedBy, updatedAt'],
};

function paramRows(e) {
  const rows = [];
  for (const [n, s] of Object.entries(e.params || {})) rows.push(['path', n, s, true]);
  for (const [n, s] of Object.entries(e.query || {})) rows.push(['query', n, s, !!s.required]);
  if (e.list) {
    rows.push(['query', 'page', { type: 'integer', desc: '페이지 번호 (기본 1)' }, false]);
    rows.push(['query', 'size', { type: 'integer', desc: '페이지 크기 (기본 20, 최대 100)' }, false]);
    rows.push(['query', 'sort', { type: 'string', desc: `정렬: ${Object.keys(e.list.sort).join(', ')} (내림차순 '-', 기본 ${e.list.defaultSort})` }, false]);
  }
  return rows;
}
const typeText = (s) => `${s.type || 'string'}${s.type === 'array' && s.items ? `<${typeof s.items === 'string' ? s.items : s.items.type || 'object'}>` : ''}`;
const constraint = (s) => [s.enum && `값: ${s.enum.join(' | ')}`, s.items && s.items.enum && `값: ${s.items.enum.join(' | ')}`, s.min !== undefined && `≥${s.min}`, s.max !== undefined && `≤${s.max}`,
  s.maxLength && `최대 ${s.maxLength}자`, s.default !== undefined && `기본 ${JSON.stringify(s.default)}`, s.nullable && 'null 허용'].filter(Boolean).join(', ');
const authText = (e) => (e.auth === false ? '공개' : e.perm ? `로그인 + 권한 ${[].concat(e.perm).join(' 또는 ')}` : '로그인 사용자');

function stepText(s) {
  if (s.raw !== undefined) {
    return `<code>curl -X ${s.method} http://localhost:${config.port}${esc(s.path)} -H "Authorization: Bearer {${s.as} 토큰}" -H "Content-Type: application/json" -d '${esc(s.raw)}'</code>`;
  }
  const p = esc(decodeURIComponent(s.path)).replace(/\{\{(\w+)\.(\w+)\}\}/g, '<em>(앞 단계 응답의 $2)</em>');
  let body = '';
  if (s.body) body = `<pre class="mini">${esc(JSON.stringify(s.body)).replace(/\{\{(\w+)\.(\w+)\}\}/g, '(앞 단계 응답의 $2 값)')}</pre>`;
  return `<span class="m m-${s.method}">${s.method}</span> <code>${p}</code>${body}`;
}

function build() {
  const reqApis = {};
  for (const e of registry) for (const r of e.reqs || []) (reqApis[r] = reqApis[r] || []).push(e);
  const tags = [...new Set(registry.map((e) => e.tag))];
  const totalSteps = requirements.reduce((n, r) => n + r.steps.length, 0);
  const tableNames = schema.map((d) => d.match(/TABLE IF NOT EXISTS (\w+)/)[1]);
  const methodCount = registry.reduce((m, e) => ({ ...m, [e.method]: (m[e.method] || 0) + 1 }), {});

  const h = [];
  h.push(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>The Family 통합 정보시스템 - 기술 보고서</title><style>${CSS}</style></head><body>`);

  // 표지
  h.push(`<section class="cover">
    <div class="eyebrow">2026 중간고사 · Node.js &amp; SQL &amp; MongoDB</div>
    <h1>The Family 통합 정보시스템<br><small>기술 보고서</small></h1>
    <table class="kv"><tr><th>학번</th><td>${esc(config.studentId)}</td></tr><tr><th>이름</th><td>(이름 기입)</td></tr>
    <tr><th>제출 경로</th><td>~/midterm (실행: <code>node app.js</code>)</td></tr>
    <tr><th>구현 규모</th><td>REST API ${registry.length}개 · MySQL 테이블 ${tableNames.length}개 · MongoDB 컬렉션 ${Object.keys(mongo.COLLECTIONS).length}개 · 웹 화면(EJS) 21개</td></tr>
    <tr><th>검증</th><td>요구사항 ${requirements.length}개 · 확인 절차 ${totalSteps}단계 자동 검증 통과 (scripts/verify-report.js)</td></tr></table>
  </section>`);

  // 목차
  h.push(`<section><h2>목차</h2><ol class="toc">
    <li>개요</li><li>실행 및 테스트 환경</li><li>시스템 구조 · 웹 화면 · 운영 보안</li><li>역할 · 권한 설계</li><li>상태 체계</li><li>데이터베이스 설계</li>
    <li>업무 규칙 구현</li><li>API 공통 규격</li><li>요구사항 추적표</li><li>기능 확인 방법 (테스트 절차)</li><li>전체 API 명세 (${registry.length}개)</li></ol></section>`);

  // 1. 개요
  h.push(`<section><h2>1. 개요</h2>
  <p>The Family 는 여러 지역의 Crew 와 구성원을 운영하는 조직이다. 구성원 정보·Crew 소속·업무 배정·공용 자원·활동/평가 기록이 분산 관리되어 발생하는
  정보 불일치, 중복 배정, 자원 기록 누락, 권한 오남용, 이력 추적 문제를 해결하기 위해 하나의 웹 기반 통합 정보시스템을 설계·구현하였다.</p>
  <h3>설계 원칙</h3><ul>
  <li><b>요구사항 중심 설계</b>: 모든 API 는 정의 시점에 연결 요구사항(reqs)을 명시하며, 같은 정의로부터 라우팅·입력 검증·권한 검사·Swagger 문서·요구사항 추적표가 자동 생성된다.</li>
  <li><b>서버 측 규칙 보장</b>: 권한(역할별 권한 코드 + 관리 범위)과 업무 규칙(BR-01~10)을 서버의 서비스 계층에서 검사하고, 동시 요청은 DB 행 잠금(SELECT … FOR UPDATE)과 UNIQUE 제약으로 보장한다.</li>
  <li><b>데이터 특성별 DB 분리</b>: 관계·일관성이 중요한 데이터는 MySQL, 시간에 따라 계속 증가하거나 구조가 유연한 이력·기록 데이터는 MongoDB 에 저장한다.</li>
  <li><b>재현 가능한 테스트</b>: 최초 실행 시 데모 데이터가 자동 생성되며, 데모 초기화 API 로 언제든 동일한 상태에서 본 보고서의 확인 절차를 반복할 수 있다.</li></ul>
  <h3>기술 스택</h3><table><tr><th>구분</th><th>사용 기술</th></tr>
  <tr><td>서버</td><td>Node.js, Express 4, EJS (서버 사이드 렌더링)</td></tr>
  <tr><td>DB</td><td>MySQL 8 (mysql2), MongoDB (공식 드라이버 6.x)</td></tr>
  <tr><td>인증</td><td>JWT (jsonwebtoken), bcryptjs 비밀번호 해시, 토큰 폐기 목록 + 토큰 버전</td></tr>
  <tr><td>문서화</td><td>OpenAPI 3.0 자동 생성 + swagger-ui-express (/api-docs)</td></tr></table>
  <h3>API 구성</h3><table><tr><th>Method</th>${Object.keys(methodCount).map((m) => `<th>${m}</th>`).join('')}<th>합계</th></tr>
  <tr><td>개수</td>${Object.values(methodCount).map((n) => `<td>${n}</td>`).join('')}<td><b>${registry.length}</b></td></tr></table>
  <table><tr><th>모듈 (Swagger 태그)</th><th>API 수</th><th>모듈</th><th>API 수</th></tr>
  ${chunk(tags.map((t) => [t, registry.filter((e) => e.tag === t).length]), 2).map((row) => `<tr>${row.map(([t, n]) => `<td>${esc(t)}</td><td>${n}</td>`).join('')}</tr>`).join('')}</table>
  </section>`);

  // 2. 실행
  h.push(`<section><h2>2. 실행 및 테스트 환경</h2>
  <h3>2.1 실행</h3><pre>cd ~/midterm
node app.js</pre>
  <p>실행 시 MySQL 데이터베이스·테이블과 MongoDB 인덱스를 자동 생성하고, DB 가 비어 있으면 데모 데이터를 자동 입력한다. 콘솔에 다음이 출력된다.</p>
  <pre>=== The Family 통합 정보시스템 (학번 ${esc(config.studentId)}) ===
  웹 화면    : http://localhost:${config.port}/
  Swagger UI : http://localhost:${config.port}/api-docs
  등록된 REST API : ${registry.length}개</pre>
  <h3>2.2 설정 (config/index.js)</h3><table><tr><th>항목</th><th>값 (기본)</th><th>환경변수</th></tr>
  <tr><td>학번</td><td>${esc(config.studentId)}</td><td>STUDENT_ID</td></tr>
  <tr><td>MySQL</td><td>${esc(config.mysql.host)}:${config.mysql.port} / DB <b>${esc(config.mysql.database)}</b></td><td>MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD</td></tr>
  <tr><td>MongoDB</td><td>${esc(config.mongo.uri)} / DB <b>${esc(config.mongo.dbName)}</b></td><td>MONGO_URI</td></tr>
  <tr><td>포트</td><td>${config.port}</td><td>PORT</td></tr></table>
  <h3>2.3 데모 계정 (비밀번호 모두 <code>pass1234</code>)</h3>
  <table><tr><th>ID</th><th>아이디</th><th>역할</th><th>상태</th><th>소속 / 비고</th></tr>
  ${DEMO.map((d) => `<tr>${d.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>
  <h3>2.4 주요 데모 데이터</h3><table><tr><th>대상</th><th>내용</th></tr>
  <tr><td>Crew</td><td>1 Brooklyn Crew (Capo capo1, 감독 underboss1) · 2 Harbor Crew (Capo capo2, 감독 underboss1) · 3 Uptown Crew (Capo capo3, 감독 underboss2)</td></tr>
  <tr><td>업무</td><td>1 물류 창고 정기 점검 (Brooklyn, 내일 09~12시, soldier1·soldier2 배정, VH-001 예약) · 2 거래처 미팅 호위 (Brooklyn, 내일 10~11시, 1번과 시간 겹침, 미배정)<br>
  3 항만 화물 인수 (Harbor, 진행중, soldier3·soldier4) · 4 월간 장부 정리 (완료) · 5 신규 거점 답사 (Uptown) · 6 야간 순찰 (동시 수행 가능) · 7 완료 · 8 취소 · 9 보류(ON_HOLD) · 10~24 과거 완료 업무(통계용)</td></tr>
  <tr><td>자원</td><td>1 VH-001 검정 세단(정상, Brooklyn) · 2 VH-002 화물 밴(사용중) · 3 VH-003 구형 트럭(정비중) · 4 WH-001 창고(등급3) · 5 CM-001 무전기(정상) · 6 CM-002 무전기(사용불가) · 7 SH-001 은신처(등급3) · 8 EQ-001 금고 장비(점검필요) · 9 VH-004 오토바이(Uptown)</td></tr>
  <tr><td>요청</td><td>승급 요청 #1 (associate1 → SOLDIER, capo1 요청) · 가입 요청 #1 (pending1 → Uptown) · 자원 사용 요청 #1 (soldier2 → CM-001)</td></tr></table>
  <h3>2.5 Swagger UI 테스트 방법</h3><ol>
  <li>브라우저에서 <code>http://{서버주소}:${config.port}/api-docs</code> 접속</li>
  <li><b>01. Auth → POST /api/auth/login</b> → Try it out → Body 에 <code>{"username":"boss","password":"pass1234"}</code> → Execute → 응답의 <code>data.token</code> 복사</li>
  <li>우측 상단 <b>Authorize</b> → 토큰 붙여넣기 → Authorize. (다른 계정으로 바꿀 때는 Logout 후 새 토큰 입력)</li>
  <li>확인할 API → Try it out → Parameter/Body 입력 → Execute → 응답 코드와 본문 확인</li>
  <li><b>각 요구사항 확인 전에 데모 데이터를 초기화</b>: admin 토큰으로 <code>POST /api/admin/system/reset-demo</code> Body <code>{"confirm":"RESET"}</code> 실행 (모든 ID 가 본 보고서와 동일해짐)</li></ol>
  </section>`);

  // 3. 구조
  h.push(`<section><h2>3. 시스템 구조</h2>
  <h3>3.1 디렉터리 구성 (CR-05)</h3><pre>${esc(TREE)}</pre>
  <h3>3.2 요청 처리 흐름</h3><pre>${esc(FLOW)}</pre>
  <h3>3.3 웹 화면 (EJS + REST API)</h3>
  <p>모든 업무 기능은 웹 화면에서 사용할 수 있다. 레이아웃·메뉴는 서버가 EJS 로 사용자 권한에 맞게 렌더링하고, 권한이 없는 화면은 서버에서 403 으로 차단한다.
  화면의 조회·변경은 본 보고서의 REST API 를 그대로 호출하므로, 화면과 API 에 동일한 권한·업무 규칙이 적용된다(버튼 숨김은 편의 기능일 뿐 서버가 최종 판단).</p>
  <table class="compact"><tr><th>화면</th><th>경로</th><th>주요 기능</th><th>요구사항</th><th>접근</th></tr>
  ${SCREENS.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>
  ${SHOTS.map(([file, caption]) => { const f = path.join(__dirname, '..', 'docs', 'screenshots', `${file}.png`); return fs.existsSync(f) ? `<figure class="shot"><img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}" alt="${esc(caption)}"><figcaption>${esc(caption)}</figcaption></figure>` : ''; }).join('')}
  <h3>3.4 운영 · 보안</h3><table><tr><th style="width:180px">항목</th><th>구현</th></tr>
  ${SECURITY.map(([a, b]) => `<tr><td><b>${esc(a)}</b></td><td>${esc(b)}</td></tr>`).join('')}</table></section>`);

  // 4. 역할 · 권한
  h.push(`<section><h2>4. 역할 · 권한 설계</h2>
  <h3>4.1 역할 등급</h3><table><tr><th>등급</th><th>역할</th><th>관리 범위 (scope)</th><th>설명</th></tr>
  <tr><td>1</td><td>ASSOCIATE</td><td>본인</td><td>본인 정보와 소속 Crew 기본 정보 조회, 배정된 활동 참여</td></tr>
  <tr><td>2</td><td>SOLDIER</td><td>본인 (소속 Crew 업무 조회)</td><td>배정 업무 수행, 자원 사용 요청·체크아웃·반납</td></tr>
  <tr><td>3</td><td>CAPO</td><td>자신이 책임자인 Crew</td><td>담당 Crew 구성원·업무·자원 배정 관리</td></tr>
  <tr><td>4</td><td>UNDERBOSS</td><td>감독(underboss_id)하는 Crew + 무소속 구성원</td><td>여러 Crew 운영, 승급 승인, 결과 수정, 통계</td></tr>
  <tr><td>5</td><td>BOSS</td><td>조직 전체</td><td>조직 전반 운영·감사</td></tr>
  <tr><td>6</td><td>ADMINISTRATOR</td><td>조직 전체 (기술 관리)</td><td>계정·권한·시스템 설정·감사 기록</td></tr></table>
  <p>권한 판정 = <b>① 권한 코드</b>(역할별 권한 매트릭스, DB role_permissions, 관리자가 API 로 변경 가능) <b>+ ② 관리 범위</b>(services/scope.js) <b>+ ③ 업무 규칙</b>(BR-04 등급 비교 등).</p>
  <h3>4.2 역할별 권한 매트릭스 (초기값)</h3><table class="compact"><tr><th>권한 코드</th><th>설명</th>${['Associate', 'Soldier', 'Capo', 'Underboss', 'Boss', 'Admin'].map((r) => `<th>${r}</th>`).join('')}</tr>
  ${PERMISSIONS.map(([code, , desc]) => `<tr><td><code>${code}</code></td><td>${esc(desc)}</td>${ROLES.map((r) => `<td class="c">${ROLE_PERMS[r].includes(code) ? '●' : ''}</td>`).join('')}</tr>`).join('')}</table>
  <p class="note">권한 코드가 필요 없는 API(본인 정보, 배정 업무, 알림 등)는 로그인한 모든 사용자가 사용하되, 데이터 범위는 서버에서 본인/소속 Crew 로 제한된다.</p></section>`);

  // 5. 상태 체계
  h.push(`<section><h2>5. 상태 체계</h2>${STATE_TABLES}</section>`);

  // 6. DB
  h.push(`<section><h2>6. 데이터베이스 설계</h2>
  <h3>6.1 SQL / MongoDB 역할 분담 (DR-05)</h3><table><tr><th>DB</th><th>저장 데이터</th><th>선택 이유</th></tr>
  <tr><td><b>MySQL</b><br>${esc(config.mysql.database)}</td><td>계정·역할·권한, 구성원, 지역, Crew, Crew 소속, 기술, 승급/가입 요청, 징계, 업무, 업무 배정, 자원 유형/자원, 자원 배정/요청/이슈, 회의/참석자</td>
  <td>엔터티 간 관계(FK)와 일관성이 핵심이며, 업무 규칙(정식 소속 1개, 시간 중복 금지)을 트랜잭션·행 잠금·UNIQUE/CHECK 제약으로 보장해야 함</td></tr>
  <tr><td><b>MongoDB</b><br>${esc(config.mongo.dbName)}</td><td>감사 로그, 구성원/업무/자원 변경 이력, 평가·평가 항목·평판, 활동 기록, 코멘트·체크리스트·템플릿·공지, 알림, 로그인 이력, 설정, 회의록</td>
  <td>시간에 따라 계속 증가(append-only)하고, 문서마다 구조가 다르거나 확장되는 데이터(평가 항목, 활동 상세, 이력 부가 정보)에 적합. 시간 인덱스로 조회</td></tr></table>
  <p>하나의 기능 흐름에서 두 DB 를 함께 사용한다. 예) 업무 완료: MySQL tasks/task_assignments 갱신 + MongoDB task_history·activities·notifications 기록.</p>
  <h3>6.2 MySQL 테이블 (${tableNames.length}개)</h3>
  <p>주요 제약: <code>crew_memberships.active_formal_key</code>(UNIQUE, 생성 컬럼) → BR-01, <code>task_assignments.active_key</code>(UNIQUE) → 동일 업무 중복 배정 방지, <code>CHECK(end_at &gt; start_at)</code>, 모든 관계 FK.</p>
  ${schema.map((ddl) => `<pre class="ddl">${esc(ddl.replace(/\n {4}/g, '\n  '))}</pre>`).join('')}
  <h3>6.3 MongoDB 컬렉션 (${Object.keys(mongo.COLLECTIONS).length}개)</h3><table class="compact"><tr><th>컬렉션</th><th>용도</th><th>주요 필드</th></tr>
  ${Object.entries(mongo.COLLECTIONS).map(([k, v]) => `<tr><td><code>${v}</code></td><td>${esc((MONGO_DOCS[k] || [])[0])}</td><td>${esc((MONGO_DOCS[k] || [])[1])}</td></tr>`).join('')}</table>
  </section>`);

  // 7. 업무 규칙
  h.push(`<section><h2>7. 업무 규칙 구현</h2><table><tr><th style="width:60px">ID</th><th style="width:30%">규칙</th><th>서버 측 구현</th></tr>
  ${requirements.filter((r) => r.group === 'BR').map((r) => `<tr><td><b>${r.id}</b></td><td>${esc(r.title)}</td><td>${esc(r.impl)}</td></tr>`).join('')}</table>
  <p>업무 규칙 위반 응답 예: <code>409 { "success": false, "error": { "code": "BUSINESS_RULE_VIOLATION", "message": "...", "details": { "rule": "BR-03", "conflicts": [...] } } }</code></p></section>`);

  // 8. 공통 규격
  h.push(`<section><h2>8. API 공통 규격</h2>
  <h3>8.1 응답 형식 (AR-05, NFR-05)</h3><pre>성공: { "success": true, "message": "...", "data": { ... }, "meta": { "page": 1, "size": 20, "total": 42, "totalPages": 3 } }
실패: { "success": false, "error": { "code": "VALIDATION_ERROR", "message": "입력값이 올바르지 않습니다.", "details": [ ... ] } }</pre>
  <h3>8.2 오류 코드 (AR-04)</h3><table><tr><th>HTTP</th><th>code</th><th>의미</th></tr>
  <tr><td>400</td><td>VALIDATION_ERROR</td><td>필수값 누락·형식 오류·잘못된 JSON·허용되지 않는 정렬 기준 (details 에 필드별 사유)</td></tr>
  <tr><td>401</td><td>UNAUTHORIZED</td><td>토큰 없음/만료/로그아웃/강제 로그아웃/잠긴 계정</td></tr>
  <tr><td>403</td><td>FORBIDDEN</td><td>권한 코드 없음 또는 관리 범위 밖 (details.rule: BR-09, BR-04, BR-05)</td></tr>
  <tr><td>404</td><td>NOT_FOUND</td><td>대상 없음 / 존재하지 않는 API</td></tr>
  <tr><td>409</td><td>BUSINESS_RULE_VIOLATION / CONFLICT</td><td>업무 규칙 위반(details.rule) / 중복 데이터</td></tr>
  <tr><td>422</td><td>INVALID_STATE</td><td>현재 상태에서 허용되지 않는 전이·작업</td></tr></table>
  <h3>8.3 인증 · 목록 조회</h3><ul>
  <li>인증: <code>Authorization: Bearer {JWT}</code> (EJS 화면은 httpOnly 쿠키). 매 요청마다 DB 에서 최신 역할·상태·잠금·토큰 버전을 확인한다.</li>
  <li>목록: <code>page</code>, <code>size</code>(최대 100), <code>sort</code>(허용 필드, <code>-</code> 접두사 = 내림차순) + 리소스별 필터. 다중 값 필터는 쉼표로 구분 (예: <code>status=PLANNED,IN_PROGRESS</code>).</li>
  <li>일시: ISO-8601 (UTC). 예) <code>2026-10-20T09:00:00Z</code></li></ul></section>`);

  // 9. 추적표
  h.push(`<section><h2>9. 요구사항 추적표</h2><p>요구사항별로 구현 API, 구현 위치(소스 파일:줄), 확인 방법을 정리하였다. 확인 방법의 상세 절차는 10장에 있다.</p>`);
  for (const g of Object.keys(GROUP_TITLE)) {
    h.push(`<h3>${GROUP_TITLE[g]}</h3><table class="trace"><tr><th style="width:62px">Requirement ID</th><th style="width:60px">Method</th><th>API</th><th style="width:165px">구현 위치</th><th style="width:28%">확인방법</th></tr>`);
    for (const r of requirements.filter((x) => x.group === g)) {
      const apis = reqApis[r.id] || [];
      const verify = r.steps.length
        ? `10장 ${r.id} 절차 (${r.steps.length}단계)<br><span class="muted">${esc(r.steps.filter((s) => s.see || s.rule).slice(0, 2).map((s) => `${s.method} ${decodeURIComponent(s.path).replace(/\{\{.*?\}\}/g, '…')} → ${s.expect}${s.rule ? ' ' + s.rule : ''}`).join(' / '))}</span>`
        : `10장 ${r.id} 절차 (수동 확인)`;
      const n = Math.max(apis.length, 1);
      if (!apis.length) {
        h.push(`<tr><td><b>${r.id}</b></td><td>-</td><td>${esc(r.impl)}</td><td>${esc(implLocation(r.id))}</td><td>${verify}</td></tr>`);
        continue;
      }
      apis.forEach((e, i) => {
        h.push(`<tr>${i === 0 ? `<td rowspan="${n}"><b>${r.id}</b></td>` : ''}<td><span class="m m-${e.method}">${e.method}</span></td><td><code>${esc(e.path)}</code><br><span class="muted">${e.id} ${esc(e.summary)}</span></td><td><code class="loc">${esc(e.location)}</code></td>${i === 0 ? `<td rowspan="${n}">${verify}</td>` : ''}</tr>`);
      });
    }
    h.push('</table>');
  }
  h.push('</section>');

  // 10. 확인 방법
  h.push(`<section><h2>10. 기능 확인 방법 (테스트 절차)</h2>
  <div class="callout"><b>공통 준비</b><ol>
  <li><code>node app.js</code> 로 서버 실행 → <code>http://{서버주소}:${config.port}/api-docs</code> 접속</li>
  <li><b>각 요구사항(아래 소제목) 확인을 시작할 때마다</b> admin 으로 로그인하여 <code>POST /api/admin/system/reset-demo</code> Body <code>{"confirm":"RESET"}</code> 실행 → 데모 데이터 초기화</li>
  <li>각 단계의 <b>[계정]</b> 으로 <code>POST /api/auth/login</code> (비밀번호 <code>pass1234</code>) → 받은 token 을 Authorize 에 입력. <b>[인증 없음]</b> 은 Authorize 를 Logout 한 상태로 실행</li>
  <li>표의 Method / URL / Body 로 실행하고 <b>기대 결과</b>(HTTP 상태 코드, 업무 규칙 ID = 응답의 <code>error.details.rule</code>, 확인 내용)를 확인</li></ol>
  <p>모든 절차는 <code>node scripts/verify-report.js</code> 로 동일하게 자동 실행·검증되었다 (총 ${totalSteps}단계 전체 통과).</p></div>`);
  for (const g of Object.keys(GROUP_TITLE)) {
    h.push(`<h3>${GROUP_TITLE[g]}</h3>`);
    for (const r of requirements.filter((x) => x.group === g)) {
      h.push(`<div class="req"><h4>${r.id} <span>${esc(r.title)}</span></h4><p class="impl"><b>구현:</b> ${esc(r.impl)}</p>`);
      if (r.steps.length) {
        h.push(`<table class="steps"><tr><th style="width:28px">#</th><th style="width:80px">계정</th><th>요청</th><th style="width:30%">기대 결과</th></tr>
        ${r.steps.map((s, i) => `<tr><td>${i + 1}</td><td>${s.as ? `<b>${s.as}</b>` : '인증 없음'}</td><td>${stepText(s)}</td>
        <td><b>${s.expect}</b>${s.rule ? ` <span class="rule">${s.rule}</span>` : ''}${s.see ? `<br>${esc(s.see)}` : ''}${s.save ? '<br><span class="muted">(응답 값을 다음 단계에서 사용)</span>' : ''}</td></tr>`).join('')}</table>`);
      }
      if (r.manual) h.push(`<ol class="manual">${r.manual.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>`);
      h.push('</div>');
    }
  }
  h.push('</section>');

  // 11. API 명세
  h.push(`<section><h2>11. 전체 API 명세 (${registry.length}개)</h2><p>모든 API 는 Swagger UI(/api-docs)에서 동일한 내용으로 확인·실행할 수 있다. 성공 응답은 <code>{ success, message, data, meta? }</code> 로 감싸진다.</p>`);
  for (const tag of tags) {
    h.push(`<h3>${esc(tag)}</h3>`);
    for (const e of registry.filter((x) => x.tag === tag)) {
      const rows = paramRows(e);
      h.push(`<div class="api"><div class="api-h"><span class="id">${e.id}</span><span class="m m-${e.method}">${e.method}</span> <code>${esc(e.path)}</code></div>
      <p><b>${esc(e.summary)}</b>${e.description ? `<br><span class="muted">${esc(e.description)}</span>` : ''}</p>
      <p class="meta"><b>요구사항</b> ${(e.reqs || []).join(', ')} &nbsp;·&nbsp; <b>권한</b> ${esc(authText(e))}${e.scope ? ` (${esc(e.scope)})` : ''} &nbsp;·&nbsp; <b>성공</b> ${e.status || 200}${e.produces ? ` ${e.produces}` : ''} &nbsp;·&nbsp; <b>구현 위치</b> <code class="loc">${esc(e.location)}</code></p>`);
      if (rows.length) {
        h.push(`<table class="compact"><tr><th>위치</th><th>이름</th><th>타입</th><th>필수</th><th>설명 / 제약</th></tr>
        ${rows.map(([where, n, s, req]) => `<tr><td>${where}</td><td><code>${n}</code></td><td>${esc(typeText(s))}</td><td>${req ? 'Y' : ''}</td><td>${esc([s.desc, constraint(s), s.example !== undefined ? `예: ${JSON.stringify(s.example)}` : ''].filter(Boolean).join(' · '))}</td></tr>`).join('')}</table>`);
      }
      if (e.body) {
        h.push(`<table class="compact"><tr><th>Body 필드</th><th>타입</th><th>필수</th><th>설명 / 제약</th></tr>
        ${Object.entries(e.body).map(([n, s]) => `<tr><td><code>${n}</code></td><td>${esc(typeText(s))}</td><td>${s.required && !e.partial ? 'Y' : ''}</td><td>${esc([s.desc, constraint(s)].filter(Boolean).join(' · '))}</td></tr>`).join('')}</table>
        ${e.partial ? '<p class="muted">부분 수정: 변경할 필드만 1개 이상 전달</p>' : ''}`);
      }
      const reqEx = e.body ? `<div class="ex"><span>Request 예시</span><pre>${json(e.bodyExample || Object.fromEntries(Object.entries(e.body).filter(([, s]) => s.example !== undefined).map(([n, s]) => [n, s.example])))}</pre></div>` : '';
      const resp = e.produces === 'text/csv' ? esc(e.example) : json(e.list ? { success: true, data: [e.example], meta: { page: 1, size: 20, total: 1, totalPages: 1 } } : { success: true, data: e.example });
      h.push(`<div class="ex-row">${reqEx}<div class="ex"><span>Response 예시 (${e.status || 200})</span><pre>${resp}</pre></div></div>`);
      const errs = [...new Set([...(e.params || e.query || e.body ? [400] : []), ...(e.auth !== false ? [401] : []), ...(e.perm ? [403] : []),
        ...(e.errors || []).map((x) => (typeof x === 'number' ? x : x.status))])].sort();
      const custom = (e.errors || []).filter((x) => typeof x === 'object');
      h.push(`<p class="errs"><b>오류 응답:</b> ${errs.join(', ')}${custom.length ? ` — ${custom.map((c) => `${c.status}${c.rule ? ' ' + c.rule : ''}: ${esc(c.message)}`).join(' / ')}` : ''}</p></div>`);
    }
  }
  h.push('</section></body></html>');
  return h.join('\n');
}

function implLocation(id) {
  return { 'CR-01': 'app.js, package.json', 'CR-02': 'routes/pages.js, views/*.ejs', 'CR-04': 'lib/api.js (buildSwaggerSpec), app.js', 'CR-05': '전체 디렉터리 구조', 'CR-06': 'app.js, db/seed.js' }[id] || '';
}
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

const DEMO = [
  [1, 'admin', 'ADMINISTRATOR', 'ACTIVE', '시스템 관리자'], [2, 'boss', 'BOSS', 'ACTIVE', '조직 전체'],
  [3, 'underboss1', 'UNDERBOSS', 'ACTIVE', 'Brooklyn·Harbor 감독'], [4, 'underboss2', 'UNDERBOSS', 'ACTIVE', 'Uptown 감독'],
  [5, 'capo1', 'CAPO', 'ACTIVE', 'Brooklyn Crew 책임자'], [6, 'capo2', 'CAPO', 'ACTIVE', 'Harbor Crew 책임자'], [7, 'capo3', 'CAPO', 'ACTIVE', 'Uptown Crew 책임자'],
  [8, 'soldier1', 'SOLDIER', 'ACTIVE', 'Brooklyn'], [9, 'soldier2', 'SOLDIER', 'ACTIVE', 'Brooklyn (경고 1회)'], [10, 'soldier3', 'SOLDIER', 'ACTIVE', 'Harbor'],
  [11, 'soldier4', 'SOLDIER', 'ACTIVE', 'Harbor'], [12, 'soldier5', 'SOLDIER', 'ACTIVE', 'Uptown'], [13, 'soldier6', 'SOLDIER', 'ACTIVE', 'Uptown'],
  [14, 'associate1', 'ASSOCIATE', 'ACTIVE', 'Brooklyn (승급 요청 대상)'], [15, 'associate2', 'ASSOCIATE', 'ACTIVE', 'Brooklyn·Harbor 준소속'],
  [16, 'suspended1', 'SOLDIER', 'SUSPENDED', 'Brooklyn (정지 징계)'], [17, 'standby1', 'SOLDIER', 'STANDBY', 'Harbor'],
  [18, 'withdrawn1', 'SOLDIER', 'WITHDRAWN', '탈퇴 (로그인 불가)'], [19, 'pending1', 'ASSOCIATE', 'PENDING', '무소속, Uptown 가입 요청 중'],
];

const SCREENS = [
  ['로그인', '/login', '로그인, 데모 계정 자동 입력, 로그인 실패 제한', 'FR-23, NFR-03', '공개'],
  ['대시보드', '/dashboard', '개인 KPI, 처리할 일(배정 응답·승인·평가 대기), 7일 일정, 알림, 회의, 조직 KPI·차트', 'FR-02, FR-09, FR-22', '전체 (조직 KPI 는 stats.read)'],
  ['업무', '/tasks', '기간·Crew·상태·중요도·담당자 탐색, 내 업무, 등록, 템플릿 등록, CSV', 'FR-07, FR-12, FR-21', '전체 (범위 적용)'],
  ['업무 상세', '/tasks/:id', '상태 전이, 완료(결과·참여 기록), 결과 수정·재개, 배정(후보 추천)·교체·해제, 수락/거절, 자원 배정·사용·반납, 체크리스트, 코멘트, 이력', 'FR-07~11, BR-02, BR-03, BR-06, BR-07', '전체 (범위 적용)'],
  ['캘린더', '/calendar', '월간 업무 일정, Crew·내 업무 필터', 'FR-09, FR-12', '전체'],
  ['회의', '/meetings', '회의 생성, 참석 응답, 참석자 관리, 회의록', 'FR-05, FR-09', '전체'],
  ['구성원', '/members', '검색·필터·정렬, 등록, CSV (범위 밖 연락처 비공개)', 'FR-01, FR-21', '전체 (범위 적용)'],
  ['구성원 상세', '/members/:id', '역할·상태 변경, 승급 요청, 징계, 평판 가감, 기술, 업무·일정·평가·변경·소속·징계 이력', 'FR-03, FR-04, FR-19, BR-04, BR-10', '전체 (범위 적용)'],
  ['Crew', '/crews, /crews/:id', 'Crew 현황, 편성·제외·이동, 책임자·감독 지정, 공지, 가입 요청 심사, 운영 현황, 편성 이력', 'FR-05, FR-06, BR-01, BR-05', '전체 (관리 기능은 범위)'],
  ['공용 자원', '/resources, /resources/:id', '자원 검색, 시간대별 이용 가능 자원, 관리 필요 자원, 등록·상태 변경, 배정, 사용 요청, 이상 신고·해결, 예약·이력', 'FR-13~17, BR-07, BR-08', '전체 (등급 적용)'],
  ['자원 사용', '/allocations', '내/관리 자원 예약·사용·반납, 반납 지연, 내 사용 요청', 'FR-15, FR-17', '전체'],
  ['요청 · 승인', '/approvals', '자원 사용·Crew 가입·승급 요청 승인/반려/취소', 'FR-03, FR-06, FR-17', '전체'],
  ['평가 · 평판', '/evaluations', '평가 대기, 평가 작성·수정·무효화, 평판 순위, 평가 항목 관리', 'FR-18, FR-19', '전체 (기능별 권한)'],
  ['운영 현황', '/stats', '기간·Crew 별 KPI, 업무 추이, 상태 분포, Crew 비교, 자원 가동률, 업무량, 활동 히트맵, 변경 추이', 'FR-22', 'stats.read'],
  ['감사 로그', '/audit', '행위자·행위·대상·결과·기간 조회, 집계, CSV, 상세', 'FR-20', 'audit.read'],
  ['계정 관리', '/admin/accounts', '잠금·해제, 비밀번호 초기화, 강제 로그아웃, 로그인 이력, 실패 탐지', 'FR-23', 'account.manage'],
  ['권한 관리', '/admin/roles', '역할별 권한 매트릭스 편집 (즉시 반영)', 'FR-23, BR-09', 'permission.manage'],
  ['시스템 설정', '/admin/system', '운영 정책, 무결성 점검, DB 현황, 공지 발송, 데모 초기화', 'FR-23, DR-05', 'system.manage'],
  ['알림 · 내 정보', '/notifications, /me', '알림 확인·삭제, 연락처·비밀번호 변경, 알림 수신 설정, 로그인 이력, 저장한 검색', 'FR-02, FR-09', '전체'],
];
const SHOTS = [
  ['login', '로그인 화면'], ['dashboard', '대시보드 (Boss)'], ['task-detail', '업무 상세 (Capo)'],
  ['assign', '배정 후보 추천 - 정지·시간 중복 구성원 자동 제외 (BR-02, BR-03)'], ['rule-violation', '업무 규칙 위반 안내 - 정식 소속 중복 (BR-01)'],
  ['member-history', '구성원 변경 이력 (BR-10)'], ['stats', '운영 현황 (FR-22)'], ['forbidden', '권한 없는 화면 직접 접근 차단 (BR-09)'],
];
const SECURITY = [
  ['인증', 'JWT(8시간) + httpOnly 쿠키(화면). 매 요청마다 DB 에서 계정 상태·잠금·토큰 버전·권한을 확인하여 정지·탈퇴·잠금·강제 로그아웃이 즉시 반영됨'],
  ['비밀키 관리', 'JWT 서명키를 소스에 두지 않고 최초 실행 시 난수로 생성해 MongoDB 에 보관 (JWT_SECRET 환경변수로 지정 가능)'],
  ['비밀번호', 'bcrypt 해시, 8자 이상, 변경 시 다른 세션 만료, 관리자 초기화 시 임시 비밀번호'],
  ['무차별 대입 방지', '계정별 연속 실패 시 자동 잠금(설정값) + IP·아이디별 실패 횟수 제한(10분 20회 / IP 60회, 429)'],
  ['CSRF', '쿠키로 인증된 변경 요청은 X-Requested-With 헤더 필수 (다른 사이트의 form 전송 차단), SameSite=Lax 쿠키'],
  ['보안 헤더', 'Content-Security-Policy(인라인 스크립트 금지), X-Frame-Options, X-Content-Type-Options, Referrer-Policy'],
  ['입력 검증', '모든 API 의 path/query/body 를 스키마로 검증·형변환, 미정의 필드 제거, SQL 은 전부 파라미터 바인딩, 화면 출력은 자동 이스케이프'],
  ['권한 오남용 방지', '권한 코드 + 관리 범위 + 등급 비교(BR-04)를 서버에서 검사, 거부 시도는 감사 로그(DENIED)에 기록'],
  ['동시성', '배정·자원 예약·소속 변경을 트랜잭션 + 행 잠금으로 처리, DB UNIQUE 제약으로 이중 보장'],
  ['주기 작업', '5분마다 오래된 자원 요청 자동 만료, 종료된 회의 완료 처리, 반납 지연 알림'],
  ['안정성', '전역 오류 처리(서버 비정상 종료 방지), 포트 사용 중이면 다음 포트로 자동 실행, SIGINT/SIGTERM 시 정상 종료, gzip 압축, 접근 로그'],
  ['운영 모드', 'DEMO_MODE=false 로 실행하면 데모 초기화 API 비활성화'],
];

const TREE = `midterm/
├── app.js                 # 진입점 (node app.js) - DB 연결, 스키마/시드, 라우트, Swagger, EJS
├── config/index.js        # 학번, DB 접속 정보, JWT 설정
├── db/
│   ├── mysql.js           # MySQL 풀, 쿼리/트랜잭션 헬퍼 (UTC 세션)
│   ├── mongo.js           # MongoDB 연결, 컬렉션/인덱스
│   ├── schema.js          # MySQL 테이블 DDL (20개)
│   └── seed.js            # 역할·권한 매트릭스, 데모 데이터, 초기화
├── lib/
│   ├── api.js             # API 레지스트리 → 라우팅/검증/권한/Swagger/추적표 자동 생성
│   ├── validate.js        # 요청 검증·형변환, 페이지/정렬 해석
│   ├── auth.js            # JWT 인증, 권한 코드 검사, CSRF 방어
│   ├── security.js        # 보안 헤더, 로그인 실패 제한, 접근 로그, 비밀키 관리
│   ├── errors.js          # 공통 오류 타입
│   ├── errorHandler.js    # 전역 오류 처리 (일관된 오류 응답, 거부 감사 기록)
│   ├── records.js         # MongoDB 이력/감사/알림 기록 헬퍼
│   └── util.js
├── services/              # 업무 규칙 (BR-01~BR-10)
│   ├── scope.js           # 역할별 관리/조회 범위
│   ├── members.js         # 상태 전이, 역할 변경 규칙
│   ├── tasks.js           # 업무 전이, 시간 중복 검사, 배정 가능 검사
│   ├── resources.js       # 자원 상태, 배정 중복/사용불가 검사
│   ├── reputation.js      # 평판 점수 계산
│   ├── jobs.js            # 주기 작업 (요청 만료, 회의 완료, 반납 지연 알림)
│   └── settings.js        # 운영 설정
├── routes/                # 기능별 REST API (26개 모듈) + pages.js(화면 라우터·권한별 메뉴)
├── views/                 # EJS 템플릿 (layout, login, error, catalog)
├── public/
│   ├── css/app.css        # 디자인 시스템
│   └── js/                # core.js(API·폼·테이블·차트 공통) + pages/*.js(21개 화면)
├── docs/requirements.js   # 요구사항 카탈로그 + 확인 절차 (보고서·자동 검증 공용)
└── scripts/               # generate-report.js, verify-report.js`;

const FLOW = `요청 → express.json → [authenticate: JWT 검증 → 폐기 토큰 확인(MongoDB) → 최신 계정/역할/상태/권한 로딩(MySQL)]
     → [requirePerm: 권한 코드 검사] → [validator: path/query/body 검증·형변환·불필요 필드 제거, 페이지/정렬 해석]
     → handler → services (관리 범위 · 업무 규칙 검사, 트랜잭션 + 행 잠금)
     → MySQL 반영 + MongoDB 이력/감사/알림 기록
     → 응답 { success, message, data, meta }  /  오류 → errorHandler → { success:false, error:{ code, message, details } }`;

const STATE_TABLES = `
<h3>5.1 구성원 상태 (FR-04)</h3><table><tr><th>상태</th><th>의미</th><th>허용 전이</th><th>효과</th></tr>
<tr><td>PENDING</td><td>가입대기</td><td>ACTIVE, WITHDRAWN</td><td>조회만 가능, 업무 배정 불가</td></tr>
<tr><td>ACTIVE</td><td>활동중</td><td>STANDBY, SUSPENDED, WITHDRAWN</td><td>정상</td></tr>
<tr><td>STANDBY</td><td>대기</td><td>ACTIVE, SUSPENDED, WITHDRAWN</td><td>업무 배정 가능(대기 인력)</td></tr>
<tr><td>SUSPENDED</td><td>정지</td><td>ACTIVE, STANDBY, WITHDRAWN</td><td>쓰기 작업 차단, 새 업무 배정 불가(BR-02)</td></tr>
<tr><td>WITHDRAWN</td><td>탈퇴</td><td>(Administrator 만 STANDBY 복구)</td><td>로그인 불가, 소속 종료·미완료 배정 해제·예약 취소·세션 만료</td></tr></table>
<h3>5.2 업무 상태 (FR-10)</h3><table><tr><th>상태</th><th>허용 전이</th><th>비고</th></tr>
<tr><td>PLANNED</td><td>IN_PROGRESS, CANCELLED</td><td>등록 직후</td></tr>
<tr><td>IN_PROGRESS</td><td>ON_HOLD, CANCELLED, (COMPLETED: /complete)</td><td>완료는 결과·참여 기록 입력 필수</td></tr>
<tr><td>ON_HOLD</td><td>IN_PROGRESS, CANCELLED</td><td></td></tr>
<tr><td>COMPLETED</td><td>(IN_PROGRESS: /reopen, Underboss 이상)</td><td>결과 보호 (BR-06)</td></tr>
<tr><td>CANCELLED</td><td>PLANNED (참여자 일정 재검사)</td><td>취소 시 자원 예약 자동 취소</td></tr></table>
<p>배정 상태: ASSIGNED(배정) → ACCEPTED(수락) / DECLINED(거절) / REMOVED(해제)</p>
<h3>5.3 자원 상태 (FR-13, FR-16)</h3><table><tr><th>상태</th><th>구분</th><th>수동 전이</th></tr>
<tr><td>AVAILABLE</td><td>정상</td><td>NEEDS_INSPECTION, MAINTENANCE, UNAVAILABLE, RETIRED</td></tr>
<tr><td>IN_USE</td><td>정상(사용중, 체크아웃/반납으로 자동 관리)</td><td>NEEDS_INSPECTION, UNAVAILABLE</td></tr>
<tr><td>NEEDS_INSPECTION</td><td>사용 불가 계열 (이상 신고·파손 반납 시 자동)</td><td>AVAILABLE, MAINTENANCE, UNAVAILABLE, RETIRED</td></tr>
<tr><td>MAINTENANCE</td><td>사용 불가 계열</td><td>AVAILABLE, NEEDS_INSPECTION, UNAVAILABLE, RETIRED</td></tr>
<tr><td>UNAVAILABLE</td><td>사용 불가 계열 (분실 반납 시 자동)</td><td>AVAILABLE, MAINTENANCE, RETIRED</td></tr>
<tr><td>RETIRED</td><td>폐기</td><td>-</td></tr></table>
<p>자원 배정 상태: RESERVED(예약) → IN_USE(체크아웃) → RETURNED(반납, GOOD/DAMAGED/LOST) / CANCELLED(취소)</p>
<p>요청 상태(승급·가입·자원 사용): PENDING → APPROVED / REJECTED / CANCELLED</p>`;

const CSS = `
@page { size: A4; margin: 14mm 12mm; }
body { font-family: "Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; color: #1d1d1f; font-size: 10.5pt; line-height: 1.55; max-width: 1100px; margin: 0 auto; padding: 24px; }
h1 { font-size: 26pt; margin: 8px 0 24px; line-height: 1.25; } h1 small { font-size: 16pt; color: #7a1f1f; }
h2 { font-size: 16pt; border-bottom: 2px solid #7a1f1f; padding-bottom: 4px; margin-top: 32px; page-break-before: always; }
h3 { font-size: 12.5pt; margin: 22px 0 8px; color: #7a1f1f; } h4 { margin: 0 0 4px; font-size: 11pt; } h4 span { font-weight: 400; }
.cover { padding-top: 120px; } .cover .eyebrow { color: #7a1f1f; font-weight: 700; letter-spacing: .04em; }
section:first-of-type h2 { page-break-before: auto; }
table { width: 100%; border-collapse: collapse; margin: 6px 0 12px; font-size: 9.5pt; page-break-inside: auto; }
tr { page-break-inside: avoid; }
th, td { border: 1px solid #d9d6cf; padding: 4px 6px; vertical-align: top; text-align: left; word-break: break-word; }
th { background: #f3f1ec; }
table.compact td, table.compact th { font-size: 8.5pt; padding: 3px 5px; }
table.kv th { width: 110px; } td.c { text-align: center; color: #7a1f1f; }
code { font-family: Consolas, "D2Coding", monospace; font-size: 0.92em; background: #f3f1ec; padding: 0 3px; border-radius: 3px; }
pre { background: #f7f6f2; border: 1px solid #e4e2dc; padding: 8px 10px; font-size: 8.5pt; white-space: pre-wrap; word-break: break-word; border-radius: 4px; }
pre.ddl { font-size: 7.8pt; } pre.mini { margin: 4px 0 0; padding: 4px 6px; font-size: 8pt; }
.m { font-weight: 700; font-size: 8.5pt; padding: 0 4px; border-radius: 3px; color: #fff; }
.m-GET { background: #1e5aa8; } .m-POST { background: #1f7a3a; } .m-PUT { background: #8a5a00; } .m-PATCH { background: #b06f00; } .m-DELETE { background: #a12020; }
.muted { color: #6b6b70; font-size: 8.5pt; } .note { color: #555; font-size: 9pt; }
.rule { background: #7a1f1f; color: #fff; padding: 0 4px; border-radius: 3px; font-size: 8.5pt; }
.callout { background: #fbf7ef; border: 1px solid #e8dcc2; padding: 8px 14px; border-radius: 6px; margin-bottom: 14px; }
.req { margin: 14px 0 18px; } .req h4, .req .impl { page-break-after: avoid; } .impl { margin: 2px 0 6px; font-size: 9.5pt; }
.api { border: 1px solid #e4e2dc; border-radius: 6px; padding: 8px 12px; margin: 10px 0; }
.api-h, .api > p, .api table.kv { page-break-after: avoid; } .ex pre { page-break-inside: avoid; }
.api-h { font-size: 11pt; margin-bottom: 4px; } .api-h .id { font-weight: 700; color: #7a1f1f; margin-right: 8px; }
td code.loc, .loc { white-space: nowrap; font-size: 8pt; }
.ex-row { display: flex; gap: 10px; } .ex-row .ex { flex: 1 1 0; min-width: 0; }
.api p { margin: 4px 0; } .meta { font-size: 9pt; background: #faf9f6; padding: 3px 6px; border-radius: 4px; } .ex span { font-size: 8.5pt; font-weight: 700; color: #555; } .errs { font-size: 9pt; }
.toc li { margin: 3px 0; }
.shot { margin: 14px 0 18px; page-break-inside: avoid; } .shot img { width: 100%; border: 1px solid #d9d6cf; border-radius: 6px; } .shot figcaption { font-size: 9pt; color: #6b6b70; text-align: center; margin-top: 4px; }`;

const out = path.join(__dirname, '..', 'docs', 'technical-report.html');
fs.writeFileSync(out, build());
console.log(`보고서 생성: ${out} (API ${registry.length}개, 요구사항 ${requirements.length}개)`);
process.exit(0);
