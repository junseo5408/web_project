App.page(async (root) => {
  const { html, icon, api, fmt, badge, can, ME, setHTML, $, on, L, opts, DataTable, filterBar, formModal, toast, options, person } = App;
  const crews = await options.crews().catch(() => []);

  setHTML(root, html`
    <div class="page-head">
      <div><h1>구성원</h1><p>${ME.level >= 5 ? '조직 전체' : ME.level >= 3 ? '관리 범위 Crew' : '소속 Crew'} 구성원을 조회합니다. 관리 범위 밖 구성원의 연락처는 표시되지 않습니다.</p></div>
      <div class="actions">
        ${can('member.read') ? html`<button class="btn" data-act="csv">${icon('download')}CSV</button>` : ''}
        ${can('member.create') ? html`<button class="btn primary" data-act="new">${icon('plus')}구성원 등록</button>` : ''}
      </div>
    </div>
    <div class="card"><div class="toolbar" id="filters"></div><div id="table"></div></div>`);

  const filters = filterBar($('#filters', root), [
    { name: 'q', type: 'search', placeholder: '이름 · 아이디 · 별칭' },
    { name: 'role', type: 'select', label: '모든 역할', options: options.roles() },
    { name: 'status', type: 'select', label: '모든 상태', options: opts('member') },
    { name: 'crewId', type: 'select', label: '모든 Crew', options: crews },
    { name: 'skill', type: 'search', placeholder: '보유 기술' },
    { name: 'unaffiliated', type: 'toggle', label: '무소속만' },
  ], () => table.load(1));
  const params = () => { const f = filters.values(); return { ...f, unaffiliated: f.unaffiliated ? 'true' : undefined }; };

  const table = new DataTable($('#table', root), {
    url: '/api/members', sort: 'name', params, rowHref: (m) => `/members/${m.id}`,
    columns: [
      { label: '구성원', sort: 'name', render: (m) => person(m.name, `${m.username}${m.alias ? ` · ${m.alias}` : ''}`) },
      { label: '역할', sort: 'level', render: (m) => html`<span class="badge brand plain">${L.role[m.role]}</span>` },
      { label: '상태', sort: 'status', render: (m) => html`${badge('member', m.status)}${m.isLocked ? html` <span class="badge bad plain">${icon('lock')}잠김</span>` : ''}` },
      { label: '소속 Crew', render: (m) => m.crewName || html`<span style="color:var(--muted-2)">무소속</span>` },
      { label: '연락처', render: (m) => (m.limited ? html`<span style="color:var(--muted-2)">비공개</span>` : html`${m.phone || '-'}<span class="sub">${m.email || ''}</span>`) },
      { label: '가입일', sort: 'joinedAt', render: (m) => fmt.date(m.joinedAt) },
    ],
  });
  table.load(1);

  on(root, 'click', '[data-act]', async (e, b) => {
    if (b.dataset.act === 'csv') {
      const p = new URLSearchParams(Object.entries(params()).filter(([, v]) => v));
      location.href = `/api/members/export?${p}`;
      return;
    }
    const managed = await options.crews(true).catch(() => []);
    const maxRole = ME.role === 'ADMINISTRATOR' ? 6 : ME.level - 1;
    const r = await formModal({
      title: '구성원 등록', subtitle: '자신보다 낮은 역할로만 등록할 수 있습니다 (BR-04).', size: 'lg', values: { role: 'ASSOCIATE', status: 'ACTIVE' },
      fields: [
        { name: 'name', label: '이름', required: true }, { name: 'alias', label: '별칭' },
        { name: 'username', label: '로그인 아이디', required: true, help: '영문·숫자·_ 3~30자' }, { name: 'password', label: '초기 비밀번호', type: 'password', required: true, help: '8자 이상' },
        { name: 'role', label: '역할', type: 'select', required: true, options: options.roles(maxRole) },
        { name: 'status', label: '상태', type: 'select', required: true, options: opts('member').filter((o) => ['PENDING', 'ACTIVE', 'STANDBY'].includes(o.value)) },
        { name: 'crewId', label: '정식 소속 Crew', type: 'select', options: managed, numeric: true, placeholder: '무소속' },
        { name: 'birthDate', label: '생년월일', type: 'date' },
        { name: 'email', label: '이메일', type: 'email' }, { name: 'phone', label: '연락처' },
        { name: 'notes', label: '메모', type: 'textarea', full: true },
      ],
      submitLabel: '등록', onSubmit: (v) => api.post('/api/members', v),
    });
    if (r) { toast.ok('구성원을 등록했습니다.'); location.href = `/members/${r.data.id}`; }
  });
});
