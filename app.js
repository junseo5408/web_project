/**
 * The Family 통합 정보시스템 - 진입점
 * 실행: node app.js
 */
if (Number(process.versions.node.split('.')[0]) < 16) {
  console.error(`[startup] Node.js 16 이상이 필요합니다. (현재 ${process.version})`);
  process.exit(1);
}

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const swaggerUi = require('swagger-ui-express');

const config = require('./config');
const mysql = require('./db/mysql');
const mongo = require('./db/mongo');
const seed = require('./db/seed');
const { buildSwaggerSpec, registry } = require('./lib/api');
const errorHandler = require('./lib/errorHandler');
const { AppError } = require('./lib/errors');
const compression = require('compression');
const security = require('./lib/security');
const jobs = require('./services/jobs');

// NFR-02: 예기치 못한 오류가 발생해도 서버 프로세스가 종료되지 않도록 기록만 한다.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

async function main() {
  await require('./lib/localdb').ensureLocalDatabases(config);
  await mysql.connect();
  console.log(`[mysql] connected: ${config.mysql.host}:${config.mysql.port}/${config.mysql.database}`);
  await mongo.connect();
  console.log(`[mongo] connected: ${config.mongo.uri}/${config.mongo.dbName}`);
  await seed.init(config);
  await security.ensureJwtSecret(config);

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(compression());
  app.use(security.securityHeaders);
  app.use(security.accessLog);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
  app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist'), { maxAge: '7d' }));

  require('./routes')(app);

  const spec = buildSwaggerSpec(config);
  app.get('/api-docs.json', (req, res) => res.json(spec));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(spec, {
    customSiteTitle: 'The Family API',
    swaggerOptions: { persistAuthorization: true, docExpansion: 'none', filter: true, tagsSorter: 'alpha' },
  }));

  require('./routes/pages')(app);

  app.use('/api', (req, res, next) => next(new AppError(404, 'NOT_FOUND', `요청한 API(${req.method} ${req.originalUrl})가 존재하지 않습니다.`)));
  app.use(errorHandler);

  const server = await listen(app, config.port, 10);
  jobs.start();

  // 정상 종료: 처리 중인 요청을 마친 뒤 DB 연결을 닫는다
  const shutdown = (signal) => {
    console.log(`\n[shutdown] ${signal} 수신 - 서버를 종료합니다.`);
    server.close(async () => {
      await Promise.allSettled([mysql.raw().end(), mongo.close()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/** 공용 서버에서 포트가 사용 중이면 다음 포트로 자동 재시도 */
function listen(app, port, retries) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`\n=== The Family 통합 정보시스템 (학번 ${config.studentId}) ===`);
      if (port !== config.port) console.log(`  ※ 포트 ${config.port} 이(가) 사용 중이어서 ${port} 포트로 실행했습니다.`);
      console.log(`  웹 화면    : http://localhost:${port}/`);
      console.log(`  Swagger UI : http://localhost:${port}/api-docs`);
      console.log(`  등록된 REST API : ${registry.length}개`);
      console.log(`  데모 계정    : boss / capo1 / soldier1 / admin … (비밀번호 pass1234)\n`);
      resolve(server);
    });
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && retries > 0) return resolve(listen(app, port + 1, retries - 1));
      console.error(`[startup] 포트 ${port} 에서 서버를 시작할 수 없습니다: ${e.code}. PORT 환경변수로 다른 포트를 지정하세요.`);
      process.exit(1);
    });
  });
}

main().catch((e) => {
  console.error('[startup] 서버 시작 실패:', e.message);
  console.error('  → config/index.js 의 MySQL/MongoDB 접속 정보를 확인하세요.');
  process.exit(1);
});
