App.page(async (root) => {
  const { html, icon, api, fmt, badge, ME, setHTML, $, on, L, DataTable, filterBar, formModal, toast, run, modal, options, empty } = App;

  setHTML(root, html`
    <div class="page-head"><div><h1>계정 관리</h1><p>계정 잠금·해제, 비밀번호 초기화, 강제 로그아웃과 로그인 보안 현황을 관리합니다.</p></div></div>
    <div class="grid g-main">
      <div class="card"><div class="toolbar" id="filters"></div><div id="table"></div></div>
      <div class="card"><div class="card-h"><h3>${icon('alert')} 로그인 실패 (24시간)</h3></div><div class="card-b flush" id="failed">${App.loading(3)}</div></div>
    </div>`);

  const filters = filterBar($('#filters', root), [
    { name: 'q', type: 'search', placeholder: '아이디 · 이름' },
    { name: 'role', type: 'select', label: '모든 역할', options: options.roles() },
    { name: 'locked', type: 'select', label: '잠금 전체', options: [{ value: 'true', label: '잠긴 계정' }, { value: 'false', label: '정상 계정' }] },
    { name: 'inactiveDays', type: 'select', label: '최근 접속 전체', options: [{ value: 30, label: '30일 이상 미접속' }, { value: 90, label: '90일 이상 미접속' }] },
  ], () => table.load(1));

  const table = new DataTable($('#table', root), {
    url: '/api/admin/accounts', sort: 'id', params: () => filters.values(),
    columns: [
      { label: '계정', sort: 'username', render: (a) => App.person(a.name, a.username, `/members/${a.id}`) },
      { label: '역할', render: (a) => L.role[a.role] },
      { label: '상태', render: (a) => html`${badge('member', a.status)}${a.isLocked ? html` <span class="badge bad" title="${a.lockedReason || ''}">${icon('lock')}잠김</span>` : ''}` },
      { label: '로그인 실패', sort: 'failedLogins', cls: 'num', render: (a) => (a.failedLogins ? html`<b style="color:var(--bad)">${a.failedLogins}</b>` : 0) },
      { label: '최근 로그인', sort: 'lastLoginAt', render: (a) => (a.lastLoginAt ? fmt.rel(a.lastLoginAt) : '-') },
      { label: '', render: (a) => (a.id === ME.id ? html`<span class="badge plain">본인</span>` : html`<div class="row" style="justify-content:flex-end;flex-wrap:nowrap">
        ${a.isLocked ? html`<button class="btn sm" data-act="unlock" data-id="${a.id}">${icon('unlock')}해제</button>` : html`<button class="btn sm" data-act="lock" data-id="${a.id}">${icon('lock')}잠금</button>`}
        <button class="btn sm ghost" data-act="reset" data-id="${a.id}" title="비밀번호 초기화">${icon('key')}</button>
        <button class="btn sm ghost" data-act="logout" data-id="${a.id}" title="강제 로그아웃">${icon('logout')}</button>
        <button class="btn sm ghost" data-act="history" data-id="${a.id}" title="로그인 이력">${icon('clock')}</button></div>`) },
    ],
  });
  table.load(1);

  async function failed() {
    const r = (await api.get('/api/admin/security/failed-logins', { hours: 24, threshold: 3 })).data;
    setHTML($('#failed', root), r.byAccount.length ? html`<ul class="list">${r.byAccount.map((x) => html`<li><div class="grow"><div class="title">${x.username}</div><div class="desc">${(x.reasons || []).join(', ')} · 마지막 ${fmt.rel(x.lastAt)}</div></div>
      <span class="badge ${x.suspicious ? 'bad' : 'warn'}">${x.failures}회</span></li>`)}</ul>` : empty('최근 24시간 로그인 실패가 없습니다', '', 'shield'));
  }
  failed();

  on(root, 'click', 'button[data-act]', async (e, b) => {
    const id = b.dataset.id;
    const a = table.rows.find((x) => String(x.id) === id);
    const base = `/api/admin/accounts/${id}`;
    switch (b.dataset.act) {
      case 'lock': {
        const r = await formModal({ title: `${a.username} 계정 잠금`, subtitle: '로그인이 차단되고 기존 세션이 즉시 만료됩니다.', danger: true, fields: [{ name: 'reason', label: '사유', required: true, full: true }], submitLabel: '잠금', onSubmit: (v) => api.post(`${base}/lock`, v) });
        if (r) { toast.ok('잠갔습니다.'); table.load(); }
        break;
      }
      case 'unlock': run(() => api.post(`${base}/unlock`), { success: '잠금을 해제했습니다.', then: () => { table.load(); failed(); } }); break;
      case 'logout': run(() => api.post(`${base}/force-logout`), { confirm: { title: '강제 로그아웃', message: `${a.username} 의 모든 세션을 만료시킵니다.` }, success: '모든 세션을 만료했습니다.' }); break;
      case 'reset': {
        const r = await run(() => api.post(`${base}/reset-password`), { confirm: { title: '비밀번호 초기화', message: `${a.username} 의 비밀번호를 임시 비밀번호로 초기화합니다.`, danger: true } });
        if (r) modal({ title: '임시 비밀번호 발급', subtitle: '이 화면을 닫으면 다시 확인할 수 없습니다. 안전한 경로로 전달하세요.', body: html`<div style="font-size:22px;font-family:var(--mono);text-align:center;padding:14px;background:var(--bg);border-radius:8px">${r.data.temporaryPassword}</div>`, actions: [{ label: '확인', kind: 'primary', onClick: ({ close }) => close() }] });
        break;
      }
      case 'history': {
        const r = await api.get(`${base}/login-history`, { size: 30 });
        modal({ title: `${a.username} 로그인 이력`, size: 'lg', body: r.data.length ? html`<table class="tbl"><thead><tr><th>시각</th><th>이벤트</th><th>결과</th><th>IP</th></tr></thead><tbody>
          ${r.data.map((h) => html`<tr><td>${fmt.full(h.at)}</td><td>${h.event}</td><td>${h.result === 'SUCCESS' ? badge('audit', 'SUCCESS') : html`<span class="badge bad">${h.reason || '실패'}</span>`}</td><td class="mono">${h.ip || '-'}</td></tr>`)}</tbody></table>` : empty('이력이 없습니다'),
          actions: [{ label: '닫기', kind: 'primary', onClick: ({ close }) => close() }] });
        break;
      }
      default:
    }
  });
});
