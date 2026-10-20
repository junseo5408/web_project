/**
 * 기술 보고서의 "기능 확인 방법"을 그대로 실행하여 검증한다.
 * 사용법: (서버 실행 중) node scripts/verify-report.js [http://localhost:3000] [요구사항ID...]
 */
const requirements = require('../docs/requirements');

const BASE = process.argv[2] && process.argv[2].startsWith('http') ? process.argv[2] : 'http://localhost:3000';
const only = process.argv.slice(2).filter((a) => !a.startsWith('http'));

async function call(method, path, token, body, raw) {
  const res = await fetch(BASE + encodeURI(path).replace(/%25/g, '%'), {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* non-JSON */ }
  return { status: res.status, json, text };
}

function fill(value, saved) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_, n, f) => {
      const v = saved[n] && saved[n][f];
      return v instanceof Date ? v.toISOString() : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, saved));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, saved)]));
  return value;
}

(async () => {
  let passed = 0;
  let failed = 0;
  const list = requirements.filter((r) => r.steps.length && (!only.length || only.includes(r.id)));
  for (const req of list) {
    const tokens = {};
    const login = async (u) => {
      if (!tokens[u]) {
        const r = await call('POST', '/api/auth/login', null, { username: u, password: 'pass1234' });
        if (r.status !== 200) throw new Error(`로그인 실패: ${u} ${r.text}`);
        tokens[u] = r.json.data.token;
      }
      return tokens[u];
    };
    await call('POST', '/api/admin/system/reset-demo', await login('admin'), { confirm: 'RESET' });
    const saved = {};
    const results = [];
    for (const [i, s] of req.steps.entries()) {
      const token = s.as ? await login(s.as) : null;
      const r = await call(s.method, fill(s.path, saved), token, fill(s.body, saved), s.raw);
      let ok = r.status === s.expect;
      if (ok && s.rule) ok = !!(r.json && r.json.error && r.json.error.details && r.json.error.details.rule === s.rule);
      if (ok && s.assert) { try { ok = !!s.assert(r.json); } catch (e) { ok = false; } }
      if (s.save && r.json) saved[s.save] = r.json.data;
      results.push(ok ? null : `    step ${i + 1} [${s.as || '-'}] ${s.method} ${s.path} → expected ${s.expect}${s.rule ? ' ' + s.rule : ''}, got ${r.status} ${r.text.slice(0, 200)}`);
      if (!ok) failed++; else passed++;
    }
    const bad = results.filter(Boolean);
    console.log(`${bad.length ? 'FAIL' : 'PASS'} ${req.id} (${req.steps.length} steps)`);
    bad.forEach((b) => console.log(b));
  }
  // 검증 후 데모 데이터를 초기 상태로 되돌림
  const a = await call('POST', '/api/auth/login', null, { username: 'admin', password: 'pass1234' });
  await call('POST', '/api/admin/system/reset-demo', a.json.data.token, { confirm: 'RESET' });
  console.log(`\n총 ${passed + failed} 단계 중 ${passed} 통과, ${failed} 실패`);
  process.exitCode = failed ? 1 : 0;
})();
