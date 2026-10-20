App.page(async (root) => {
  const { html, icon, api, badge, can, setHTML, $, on, filterBar, formModal, toast, options, empty, opts } = App;
  const [regions, managed] = await Promise.all([options.regions().catch(() => []), api.get('/api/crews/managed').then((r) => r.data.map((c) => c.id)).catch(() => [])]);

  setHTML(root, html`
    <div class="page-head">
      <div><h1>Crew</h1><p>지역별 Crew 와 책임자, 구성원 규모를 확인합니다.</p></div>
      <div class="actions">${can('crew.create') ? html`<button class="btn primary" data-act="new">${icon('plus')}Crew 생성</button>` : ''}</div>
    </div>
    <div class="card" style="margin-bottom:16px"><div class="toolbar" id="filters" style="border:0"></div></div>
    <div class="grid g-3" id="grid">${App.loading(4)}</div>`);

  const filters = filterBar($('#filters', root), [
    { name: 'q', type: 'search', placeholder: 'Crew 이름 검색' },
    { name: 'regionId', type: 'select', label: '모든 지역', options: regions },
    { name: 'status', type: 'select', label: '모든 상태', options: opts('crew') },
  ], () => load());

  async function load() {
    const r = await api.get('/api/crews', { ...filters.values(), size: 100 });
    setHTML($('#grid', root), r.data.length ? r.data.map((c) => html`
      <a class="card" href="/crews/${c.id}" style="color:inherit;text-decoration:none;display:block">
        <div class="card-b">
          <div class="row"><div class="brand-mark" style="width:38px;height:38px">${c.name.slice(0, 1)}</div>
            <div style="flex:1;min-width:0"><b style="font-size:15.5px">${c.name}</b><div style="color:var(--muted);font-size:12.5px">${App.icon('pin')} ${c.regionName || '지역 미지정'}</div></div>
            ${badge('crew', c.status)}</div>
          <p style="color:var(--muted);min-height:20px;margin:12px 0">${c.description || ''}</p>
          <dl class="dl" style="grid-template-columns:80px 1fr"><dt>책임자</dt><dd>${c.capoName || html`<span class="badge warn">공석</span>`}</dd><dt>감독</dt><dd>${c.underbossName || '-'}</dd><dt>정식 인원</dt><dd><b>${c.memberCount}</b>명</dd></dl>
          ${managed.includes(c.id) ? html`<div style="margin-top:12px"><span class="badge brand plain">${icon('shield')}내 관리 Crew</span></div>` : ''}
        </div>
      </a>`) : html`<div class="card" style="grid-column:1/-1">${empty('조건에 맞는 Crew 가 없습니다', '', 'crew')}</div>`);
  }
  await load();

  on(root, 'click', '[data-act="new"]', async () => {
    const underbosses = await api.get('/api/members', { role: 'UNDERBOSS', status: 'ACTIVE', size: 100 }).then((r) => r.data.map((m) => ({ value: m.id, label: m.name }))).catch(() => []);
    const r = await formModal({ title: 'Crew 생성',
      fields: [{ name: 'name', label: 'Crew 이름', required: true, full: true }, { name: 'regionId', label: '지역', type: 'select', options: regions, numeric: true },
        { name: 'underbossId', label: '감독 Underboss', type: 'select', options: underbosses, numeric: true }, { name: 'description', label: '설명', type: 'textarea', full: true }],
      submitLabel: '생성', onSubmit: (v) => api.post('/api/crews', v) });
    if (r) { toast.ok('Crew 를 생성했습니다.'); location.href = `/crews/${r.data.id}`; }
  });
});
