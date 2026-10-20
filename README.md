# The Family 통합 정보시스템

구성원·Crew·업무 배정·공용 자원·평가·감사 기록을 역할별 권한 아래에서 관리하는 웹 시스템.
Node.js + Express + EJS + MySQL + MongoDB.

- 웹 화면 21개 (`/`) — 대시보드, 업무·캘린더·회의, 구성원·Crew, 자원·자원 사용, 요청·승인, 평가, 운영 현황, 감사 로그, 계정·권한·시스템 관리
- REST API 221개 (Swagger UI: `/api-docs`, 요구사항 추적표: `/catalog`)
- MySQL 테이블 20개 / MongoDB 컬렉션 19개

## 실행

```bash
cd ~/midterm
node app.js
```

최초 실행 시 데이터베이스·테이블·인덱스를 자동 생성하고 데모 데이터를 입력한다. Node.js 16.20 이상.

## 설정 (`config/index.js` 또는 환경변수)

| 항목 | 기본값 | 환경변수 |
|---|---|---|
| 학번 (DB 이름에 사용) | `202600000` → **본인 학번으로 변경** | `STUDENT_ID` |
| MySQL | `127.0.0.1:3306`, `root` / `root1234` | `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD` |
| MongoDB | `mongodb://127.0.0.1:27017` | `MONGO_URI` |
| 포트 | `3000` (사용 중이면 3001~3010 자동 시도) | `PORT` |
| JWT 비밀키 | 최초 실행 시 난수 생성 후 MongoDB 보관 | `JWT_SECRET` |
| 데모 초기화 API | 허용 | `DEMO_MODE=false` 로 비활성화 |
| 프록시 뒤 실행 | 사용 안 함 | `TRUST_PROXY=true` |
| 로컬 DB 자동 시작 (`~/.local/opt` 설치본이 있을 때만) | 사용 | `AUTO_START_DB=false` 로 비활성화 |

DB 이름: MySQL `family_{학번}`, MongoDB `family_log_{학번}`

## 데모 계정 (비밀번호 `pass1234`)

| 계정 | 역할 | 비고 |
|---|---|---|
| `admin` | Administrator | 계정·권한·시스템 관리 |
| `boss` | Boss | 조직 전체 |
| `underboss1`, `underboss2` | Underboss | Brooklyn·Harbor / Uptown 감독 |
| `capo1`, `capo2`, `capo3` | Capo | 각 Crew 책임자 |
| `soldier1`~`soldier6` | Soldier | |
| `associate1`, `associate2` | Associate | |
| `suspended1`, `standby1`, `pending1` | | 정지 / 대기 / 가입대기 |
| `withdrawn1` | | 탈퇴 (로그인 불가) |

데모 데이터 초기화: 시스템 설정 화면 또는 admin 으로 `POST /api/admin/system/reset-demo` `{"confirm":"RESET"}`

## 보안 · 운영

- JWT + httpOnly 쿠키, 매 요청 DB 기준 계정 상태·권한 재확인 (정지·잠금·강제 로그아웃 즉시 반영)
- 권한 코드 + 관리 범위(담당·감독 Crew) + 등급 비교를 서버에서 검사, 거부 시도는 감사 로그에 기록
- 로그인 실패 시 계정 자동 잠금 + IP·아이디별 실패 횟수 제한, CSRF 방어, CSP 등 보안 헤더
- 트랜잭션 + 행 잠금 + DB UNIQUE 제약으로 업무 규칙(정식 소속 1개, 시간 중복 금지) 동시성 보장
- 주기 작업: 자원 요청 자동 만료, 종료 회의 완료 처리, 반납 지연 알림
- 전역 오류 처리, 포트 자동 재시도, 정상 종료(SIGINT/SIGTERM), gzip, 접근 로그

## 디렉터리

```
app.js              진입점
config/             설정
db/                 MySQL/MongoDB 연결, 스키마, 시드
lib/                API 레지스트리(라우팅·검증·Swagger 자동 생성), 인증, 보안, 오류 처리, 기록
services/           업무 규칙 (권한 범위, 상태 전이, 시간 중복, 자원 배정), 주기 작업
routes/             기능별 REST API 모듈 + 화면 라우터(pages.js)
views/              EJS 템플릿
public/             디자인 시스템(css), 화면 스크립트(js/core.js, js/pages/*.js)
docs/               요구사항 카탈로그, 기술 보고서(HTML/PDF), 화면 캡처
scripts/            보고서 생성 / 확인 절차 자동 검증
```

## 보고서 / 검증

```bash
node scripts/generate-report.js    # docs/technical-report.html 생성
node scripts/verify-report.js      # (서버 실행 중) 보고서의 확인 절차를 그대로 실행·검증
```
