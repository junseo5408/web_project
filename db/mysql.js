const mysql = require('mysql2/promise');
const config = require('../config');
const { camelize } = require('../lib/util');

let pool;

const typeCast = (field, next) => {
  if (field.type === 'TINY' && field.length === 1) {
    const v = field.string();
    return v === null ? null : v === '1';
  }
  if (field.type === 'JSON') {
    const v = field.string('utf8');
    return v === null ? null : JSON.parse(v);
  }
  if (field.type === 'NEWDECIMAL') {
    const v = field.string();
    return v === null ? null : Number(v);
  }
  return next();
};

async function ensureDatabase() {
  const { database, ...conn } = config.mysql;
  const c = await mysql.createConnection(conn);
  try {
    await c.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } catch (e) {
    // CREATE 권한이 없더라도 DB가 이미 존재하면 계속 진행
    console.warn(`[mysql] CREATE DATABASE 실패(${e.code}) - 기존 DB 사용을 시도합니다.`);
  } finally {
    await c.end();
  }
}

async function connect() {
  await ensureDatabase();
  pool = mysql.createPool({
    ...config.mysql,
    connectionLimit: 10,
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
    typeCast,
    charset: 'utf8mb4',
  });
  // 모든 시각은 UTC 로 저장하므로 NOW() 등 SQL 시간 함수도 UTC 기준으로 동작하도록 세션 시간대를 고정
  pool.pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));
  await pool.query('SELECT 1');
  return pool;
}

/** 단건/다건 쿼리. 결과 행은 camelCase로 변환된다. */
async function query(sql, params = [], conn = pool) {
  const [rows] = await conn.query(sql, params);
  return Array.isArray(rows) ? rows.map(camelize) : rows;
}

async function one(sql, params = [], conn = pool) {
  const rows = await query(sql, params, conn);
  return rows[0] || null;
}

/** 트랜잭션 실행: fn(t)에서 t.query / t.one 사용 */
async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const t = {
      query: (sql, params) => query(sql, params, conn),
      one: (sql, params) => one(sql, params, conn),
    };
    const result = await fn(t);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

const raw = () => pool;

module.exports = { connect, query, one, tx, raw };
