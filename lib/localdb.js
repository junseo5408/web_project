/**
 * 로컬 개발 편의: MySQL/MongoDB 포트가 닫혀 있고 ~/.local/opt 에 설치된 실행 파일이 있으면
 * 서버 시작 전에 DB 프로세스를 백그라운드로 띄운다.
 *  - 실행 파일이 없거나 원격 호스트를 쓰는 환경에서는 아무것도 하지 않는다.
 *  - DB 는 app.js 와 분리(detached)되어 실행되므로 서버를 종료해도 계속 켜져 있다.
 *  - AUTO_START_DB=false 로 비활성화.
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = os.homedir();
const OPT = path.join(HOME, '.local/opt');
const VAR = path.join(HOME, '.local/var');
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

function portOpen(host, port, timeout = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function waitPort(host, port, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await portOpen(host, port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function findMongod() {
  if (!fs.existsSync(OPT)) return null;
  const dir = fs.readdirSync(OPT).find((d) => d.startsWith('mongodb-') && fs.existsSync(path.join(OPT, d, 'bin/mongod')));
  return dir ? path.join(OPT, dir, 'bin/mongod') : null;
}

function targets(config) {
  const list = [];
  const mysqld = path.join(OPT, 'mysqlroot/usr/sbin/mysqld');
  if (LOCAL_HOSTS.includes(config.mysql.host) && fs.existsSync(mysqld) && fs.existsSync(path.join(VAR, 'mysql'))) {
    const port = Number(config.mysql.port);
    list.push({
      name: 'mysql', host: '127.0.0.1', port, bin: mysqld,
      env: { LD_LIBRARY_PATH: path.join(OPT, 'mysqlroot/usr/lib/x86_64-linux-gnu') },
      args: ['--no-defaults', `--datadir=${VAR}/mysql`, `--port=${port}`, `--socket=${VAR}/mysql.sock`, '--mysqlx=OFF', '--secure-file-priv=',
        `--lc-messages-dir=${OPT}/mysqlroot/usr/share/mysql`, `--log-error=${VAR}/mysqld.log`, `--pid-file=${VAR}/mysqld.pid`],
    });
  }
  const m = /^mongodb:\/\/([^/:,]+)(?::(\d+))?/.exec(config.mongo.uri);
  const mongod = findMongod();
  if (m && LOCAL_HOSTS.includes(m[1]) && mongod && fs.existsSync(path.join(VAR, 'mongo'))) {
    const port = Number(m[2] || 27017);
    list.push({
      name: 'mongo', host: '127.0.0.1', port, bin: mongod, env: {},
      args: ['--dbpath', `${VAR}/mongo`, '--port', String(port), '--bind_ip', '127.0.0.1', '--logpath', `${VAR}/mongod.log`, '--logappend'],
    });
  }
  return list;
}

async function ensureLocalDatabases(config) {
  if (process.env.AUTO_START_DB === 'false') return;
  for (const t of targets(config)) {
    if (await portOpen(t.host, t.port)) continue;
    console.log(`[localdb] ${t.name} 가 꺼져 있어 자동으로 시작합니다 (포트 ${t.port})...`);
    const child = spawn(t.bin, t.args, { detached: true, stdio: 'ignore', env: { ...process.env, ...t.env } });
    child.on('error', (e) => console.error(`[localdb] ${t.name} 시작 실패: ${e.message}`));
    child.unref();
    if (!(await waitPort(t.host, t.port, 30000))) console.error(`[localdb] ${t.name} 가 30초 안에 응답하지 않습니다. 로그: ${VAR}/${t.name === 'mysql' ? 'mysqld' : 'mongod'}.log`);
  }
}

module.exports = { ensureLocalDatabases };
