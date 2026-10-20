/**
 * 시스템 설정
 *  - 학번(STUDENT_ID)은 반드시 본인 학번으로 변경해야 합니다. (DR-06: DB 이름에 학번 포함)
 *  - DB 접속 정보는 강의 자료의 서버 환경에 맞게 아래 기본값을 수정하거나 환경변수로 덮어쓸 수 있습니다.
 */
const STUDENT_ID = process.env.STUDENT_ID || '202217639';

module.exports = {
  studentId: STUDENT_ID,
  port: Number(process.env.PORT || 3000),

  mysql: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || 'root1234',
    database: process.env.MYSQL_DATABASE || `family_${STUDENT_ID}`,
  },

  mongo: {
    uri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017',
    dbName: process.env.MONGO_DB || `family_log_${STUDENT_ID}`,
  },

  jwt: {
    secret: null, // 시작 시 JWT_SECRET 환경변수 또는 MongoDB 에 보관된 난수 비밀키로 설정 (lib/security.js)
    expiresIn: '8h',
  },

  // 데모 데이터 초기화 API 허용 여부 (운영 환경에서는 DEMO_MODE=false 로 비활성화)
  demoMode: process.env.DEMO_MODE !== 'false',

  // 리버스 프록시(Nginx 등) 뒤에서 실행할 때 실제 클라이언트 IP 사용
  trustProxy: process.env.TRUST_PROXY === 'true',

  // 최초 실행 시(DB가 비어 있을 때) 데모 데이터 자동 생성
  seedOnEmpty: process.env.SEED_ON_EMPTY !== 'false',
};
