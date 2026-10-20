App.page(async (root) => {
  const { html, icon, api, fmt, badge, setHTML, $, on, L, DataTable, filterBar, modal } = App;

  setHTML(root, html`
    <div class="page-head"><div><h1>감사 로그</h1><p>중요 상태 변경, 관리 활동, 권한 거부 시도가 모두 기록됩니다 (FR-20).</p></div>
      <div class="actions"><button class="btn" data-act="csv">${icon('download')}CSV 내보내기</button></div></div>
    <div class="grid g-4" id="summary">${App.loading(2)}</div>
    <div class="card mt"><div class="toolbar" id="filters"></div><div id="table"></div></div>`);

  const filters = filterBar($('#filters', root), [
    { name: 'actor', type: 'search', placeholder: '행위자 아이디' },
    { name: 'action', type: 'search', placeholder: '행위 (예: MEMBER_ROLE_CHANGED)' },
    { name: 'entityType', type: 'select', label: '모든 대상', options: ['member', 'crew', 'task', 'resource', 'role', 'region', 'evaluation', 'account', 'system', 'api'].map((v) => ({ value: v, label: v })) },
    { name: 'result', type: 'select', label: '모든 결과', options: [{ value: 'SUCCESS', label: '성공' }, { value: 'DENIED', label: '거부' }] },
    { name: 'from', type: 'date', label: '시작일' },
    { name: 'to', type: 'date', label: '종료일' },
  ], () => { table.load(1); summary(); });
  const params = () => {
    const f = filters.values();
    return { ...f, action: f.action ? f.action.toUpperCase() : undefined, from: f.from ? new Date(`${f.from}T00:00:00`) : undefined, to: f.to ? new Date(`${f.to}T23:59:59`) : undefined };
  };

  async function summary() {
    const p = params();
    const r = (await api.get('/api/audit-logs/summary', { from: p.from, to: p.to })).data;
    setHTML($('#summary', root), html`
      <div class="card kpi"><div class="label">전체 기록</div><div class="value">${fmt.num(r.total)}</div></div>
      <div class="card kpi bad"><div class="label">권한 거부</div><div class="value">${fmt.num(r.byResult.DENIED || 0)}</div><div class="hint">직접 URL 접근 등 차단된 시도</div></div>
      <div class="card kpi"><div class="label">가장 많은 행위</div><div class="value" style="font-size:16px;margin-top:10px">${r.byAction[0] ? r.byAction[0].action : '-'}</div><div class="hint">${r.byAction[0] ? `${r.byAction[0].count}건` : ''}</div></div>
      <div class="card kpi"><div class="label">최다 행위자</div><div class="value" style="font-size:16px;margin-top:10px">${r.topActors[0] ? r.topActors[0].username : '-'}</div><div class="hint">${r.topActors[0] ? `${r.topActors[0].count}건` : ''}</div></div>`);
  }

  const table = new DataTable($('#table', root), {
    url: '/api/audit-logs', sort: '-at', params, size: 30,
    columns: [
      { label: '시각', sort: 'at', render: (l) => html`<span style="white-space:nowrap">${fmt.full(l.at)}</span>` },
      { label: '행위자', render: (l) => html`<b>${l.actor.username}</b><span class="sub">${L.role[l.actor.role] || l.actor.role}</span>` },
      { label: '행위', sort: 'action', render: (l) => html`<span class="mono">${l.action}</span>` },
      { label: '대상', render: (l) => html`${l.entity.type}${l.entity.id ? html` <span class="mono" style="color:var(--muted)">${l.entity.id}</span>` : ''}` },
      { label: '결과', render: (l) => badge('audit', l.result) },
      { label: '', render: (l) => html`<button class="btn sm ghost" data-detail="${l.id}">상세</button>` },
    ],
  });
  table.load(1);
  summary();

  on(root, 'click', '[data-detail]', (e, b) => {
    const l = table.rows.find((x) => x.id === b.dataset.detail);
    modal({ title: l.action, subtitle: `${fmt.full(l.at)} · ${l.actor.username} · IP ${l.ip || '-'}`, size: 'lg',
      body: html`<pre class="mono" style="white-space:pre-wrap;background:var(--bg);padding:12px;border-radius:8px;font-size:12px">${JSON.stringify({ entity: l.entity, result: l.result, details: l.details }, null, 2)}</pre>`,
      actions: [{ label: '닫기', kind: 'primary', onClick: ({ close }) => close() }] });
  });
  on(root, 'click', '[data-act="csv"]', () => {
    const p = new URLSearchParams(Object.entries(params()).filter(([, v]) => v).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
    location.href = `/api/audit-logs/export?${p}`;
  });
});
