App.page(async (root) => {
  const { html, icon, api, fmt, badge, can, setHTML, $, on, L, opts, DataTable, filterBar, formModal, toast, options, empty } = App;
  const [types, crews] = await Promise.all([options.resourceTypes().catch(() => []), options.crews().catch(() => [])]);
  const manager = can(['resource.manage', 'resource.allocate']);

  setHTML(root, html`
    <div class="page-head">
      <div><h1>공용 자원</h1><p>내 역할 등급과 소속에 따라 이용할 수 있는 자원만 표시됩니다.</p></div>
      <div class="actions">
        <button class="btn" data-act="available">${icon('search')}시간대별 이용 가능 자원</button>
        ${can('resource.manage') ? html`<button class="btn primary" data-act="new">${icon('plus')}자원 등록</button>` : ''}
      </div>
    </div>
    ${manager ? html`<div id="attention" style="margin-bottom:16px"></div>` : ''}
    <div class="card"><div class="toolbar" id="filters"></div><div id="table"></div></div>`);

  if (manager) {
    api.get('/api/resources/attention').then((r) => {
      const { blocked, overdueReturns } = r.data;
      if (!blocked.length && !overdueReturns.length) return;
      setHTML($('#attention', root), html`<div class="grid g-2">
        <div class="card"><div class="card-h"><h3>${icon('wrench')} 점검 필요 · 사용 불가 <span class="sub">${blocked.length}건 · 신규 배정 차단 (BR-08)</span></h3></div>
          <div class="card-b flush"><ul class="list">${blocked.slice(0, 5).map((x) => html`<li><div class="grow"><a class="title" href="/resources/${x.id}" style="color:inherit">${x.code} ${x.name}</a><div class="desc">${x.location || ''}${x.openIssues ? ` · 미해결 이슈 ${x.openIssues}건` : ''}</div></div>${badge('resource', x.status)}</li>`)}</ul></div></div>
        <div class="card"><div class="card-h"><h3>${icon('clock')} 반납 지연 <span class="sub">${overdueReturns.length}건</span></h3></div>
          <div class="card-b flush">${overdueReturns.length ? html`<ul class="list">${overdueReturns.slice(0, 5).map((x) => html`<li><div class="grow"><div class="title">${x.resourceCode} ${x.resourceName}</div><div class="desc">반납 예정 ${fmt.full(x.endAt)}</div></div><span class="badge bad">${x.overdueHours}시간 지연</span></li>`)}</ul>` : empty('반납 지연 자원이 없습니다', '', 'checkCircle')}</div></div>
      </div>`);
    }).catch(() => {});
  }

  const filters = filterBar($('#filters', root), [
    { name: 'q', type: 'search', placeholder: '코드 · 이름 · 위치' },
    { name: 'type', type: 'select', label: '모든 유형', options: types },
    { name: 'status', type: 'select', label: '모든 상태', options: opts('resource') },
    { name: 'crewId', type: 'select', label: '모든 소유', options: crews },
    { name: 'usable', type: 'select', label: '정상/불가 전체', options: [{ value: 'true', label: '정상 자원만' }, { value: 'false', label: '사용 불가 · 점검 필요만' }] },
  ], () => table.load(1));

  const table = new DataTable($('#table', root), {
    url: '/api/resources', sort: 'code', params: () => filters.values(), rowHref: (r) => `/resources/${r.id}`,
    columns: [
      { label: '자원', sort: 'code', render: (r) => html`<b>${r.name}</b><span class="sub mono">${r.code}</span>` },
      { label: '유형', render: (r) => r.typeName },
      { label: '상태', sort: 'status', render: (r) => badge('resource', r.status) },
      { label: '소유', render: (r) => r.crewName || '조직 공용' },
      { label: '위치', render: (r) => r.location || '-' },
      { label: '이용 등급', render: (r) => html`<span class="tag">Lv.${r.minRoleLevel}+</span>` },
      { label: '최근 변경', sort: 'updatedAt', render: (r) => fmt.rel(r.updatedAt) },
    ],
  });
  table.load(1);

  on(root, 'click', '[data-act]', async (e, b) => {
    if (b.dataset.act === 'available') {
      const start = new Date(Date.now() + 3600000); start.setMinutes(0, 0, 0);
      let list = null;
      await formModal({ title: '이용 가능한 자원 찾기', subtitle: '권한 등급 · 자원 상태 · 기존 예약을 모두 고려합니다 (FR-14, BR-07, BR-08).',
        values: { startAt: start.toISOString(), endAt: new Date(start.getTime() + 2 * 3600000).toISOString() },
        fields: [{ name: 'startAt', label: '시작', type: 'datetime', required: true }, { name: 'endAt', label: '종료', type: 'datetime', required: true }, { name: 'type', label: '유형', type: 'select', options: types }],
        submitLabel: '조회', onSubmit: async (v) => { list = (await api.get('/api/resources/available', v)).data; list.query = v; } });
      if (!list) return;
      App.modal({ title: `이용 가능 자원 ${list.length}건`, subtitle: fmt.range(list.query.startAt, list.query.endAt), size: 'lg',
        body: list.length ? html`<ul class="list" style="border:1px solid var(--line);border-radius:8px">${list.map((x) => html`<li><div class="grow"><a class="title" href="/resources/${x.id}">${x.code} ${x.name}</a><div class="desc">${x.typeName} · ${x.crewName || '조직 공용'} · ${x.location || ''}</div></div>${badge('resource', x.status)}</li>`)}</ul>` : empty('해당 시간대에 이용 가능한 자원이 없습니다'),
        actions: [{ label: '닫기', kind: 'primary', onClick: ({ close }) => close() }] });
    }
    if (b.dataset.act === 'new') {
      const managed = await options.crews(true).catch(() => []);
      const r = await formModal({ title: '자원 등록', size: 'lg',
        fields: [{ name: 'code', label: '자원 코드', required: true, placeholder: 'VH-005', help: '영문 대문자·숫자·-' }, { name: 'name', label: '이름', required: true },
          { name: 'typeCode', label: '유형', type: 'select', required: true, options: types }, { name: 'crewId', label: '소유 Crew', type: 'select', options: managed, numeric: true, placeholder: '조직 공용 (Underboss 이상)' },
          { name: 'location', label: '위치' }, { name: 'minRoleLevel', label: '이용 최소 등급 (1~6)', type: 'number', min: 1, max: 6, help: '비우면 유형 기본값' },
          { name: 'description', label: '설명', type: 'textarea', full: true }],
        submitLabel: '등록', onSubmit: (v) => api.post('/api/resources', { ...v, code: (v.code || '').toUpperCase() }) });
      if (r) { toast.ok('자원을 등록했습니다.'); location.href = `/resources/${r.data.id}`; }
    }
  });
  void L;
});
