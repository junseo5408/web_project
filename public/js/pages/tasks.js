App.page(async (root) => {
  const { html, icon, api, fmt, badge, prio, can, ME, setHTML, $, on, L, opts, DataTable, filterBar, formModal, toast, options, urlState } = App;
  const state = urlState.get();
  let crews = [];
  try { crews = await options.crews(); } catch (e) { crews = []; }

  setHTML(root, html`
    <div class="page-head">
      <div><h1>업무</h1><p>권한 범위 내 업무를 기간·Crew·상태·담당자로 탐색합니다.</p></div>
      <div class="actions">
        ${can(['task.create', 'stats.read']) ? html`<button class="btn" data-act="csv">${icon('download')}CSV</button>` : ''}
        ${can('template.manage') ? html`<button class="btn" data-act="template">${icon('copy')}템플릿으로 등록</button>` : ''}
        ${can('task.create') ? html`<button class="btn primary" data-act="new">${icon('plus')}업무 등록</button>` : ''}
      </div>
    </div>
    <div class="card">
      <div class="toolbar">
        <div class="seg" id="scope"><button data-v="">전체</button><button data-v="1">내 업무</button></div>
        <div id="filters" class="row" style="flex:1"></div>
      </div>
      <div id="table"></div>
    </div>`);

  let mine = state.mine === '1';
  const seg = $('#scope', root);
  const paintSeg = () => [...seg.children].forEach((b) => b.classList.toggle('on', (b.dataset.v === '1') === mine));
  paintSeg();

  const filters = filterBar($('#filters', root), [
    { name: 'q', type: 'search', placeholder: '제목·설명·장소 검색' },
    { name: 'status', type: 'select', label: '모든 상태', options: opts('task') },
    { name: 'priority', type: 'select', label: '모든 중요도', options: opts('priority') },
    { name: 'crewId', type: 'select', label: '모든 Crew', options: crews },
    { name: 'from', type: 'date', label: '시작일' },
    { name: 'to', type: 'date', label: '종료일' },
    { name: 'overdue', type: 'toggle', label: '기한 경과' },
  ], () => table.load(1), { sync: false });

  const params = () => {
    const f = filters.values();
    urlState.set({ ...f, mine: mine ? '1' : '' });
    return {
      q: f.q, status: f.status, priority: f.priority, crewId: f.crewId, overdue: f.overdue ? 'true' : undefined,
      from: f.from ? new Date(`${f.from}T00:00:00`).toISOString() : undefined,
      to: f.to ? new Date(`${f.to}T23:59:59`).toISOString() : undefined,
      memberId: mine ? ME.id : undefined,
    };
  };
  // URL 의 초기 필터값 반영
  Object.entries(state).forEach(([k, v]) => { const el = $(`#filters [name="${k}"]`, root); if (el) { if (el.type === 'checkbox') el.checked = !!v; else el.value = v; } });

  const table = new DataTable($('#table', root), {
    url: '/api/tasks',
    sort: '-startAt',
    params,
    rowHref: (t) => `/tasks/${t.id}`,
    empty: '조건에 맞는 업무가 없습니다.',
    columns: [
      { label: '업무', sort: 'id', render: (t) => html`<b>${t.title}</b><span class="sub">#${t.id}${t.location ? ` · ${t.location}` : ''}</span>` },
      { label: 'Crew', render: (t) => t.crewName },
      { label: '상태', sort: 'status', render: (t) => html`${badge('task', t.status)}${t.status !== 'COMPLETED' && t.status !== 'CANCELLED' && new Date(t.endAt) < new Date() ? html` <span class="badge bad plain">기한 경과</span>` : ''}` },
      { label: '중요도', sort: 'priority', render: (t) => prio(t.priority) },
      { label: '일정', sort: 'startAt', render: (t) => html`${fmt.range(t.startAt, t.endAt)}<span class="sub">${fmt.rel(t.startAt)}</span>` },
      { label: '인원', cls: 'num', render: (t) => t.assigneeCount },
      { label: '결과', render: (t) => (t.resultOutcome ? badge('outcome', t.resultOutcome) : html`<span style="color:var(--muted-2)">-</span>`) },
    ],
  });
  table.load(1);

  on(seg, 'click', 'button', (e, b) => { mine = b.dataset.v === '1'; paintSeg(); table.load(1); });

  async function createTask(values = {}) {
    const managed = await options.crews(true);
    if (!managed.length) return toast('업무를 등록할 수 있는 관리 Crew 가 없습니다.', 'bad');
    const start = new Date(Date.now() + 86400000); start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 2 * 3600000);
    const r = await formModal({
      title: '업무 등록', subtitle: '담당 Crew 범위 안에서만 등록할 수 있습니다.', size: 'lg',
      values: { startAt: start.toISOString(), endAt: end.toISOString(), priority: 'NORMAL', crewId: managed[0].value, ...values },
      fields: [
        { name: 'title', label: '업무명', required: true, full: true, placeholder: '예) 물류 창고 정기 점검' },
        { name: 'crewId', label: '담당 Crew', type: 'select', required: true, options: managed, numeric: true },
        { name: 'priority', label: '중요도', type: 'select', required: true, options: opts('priority') },
        { name: 'startAt', label: '시작', type: 'datetime', required: true },
        { name: 'endAt', label: '종료', type: 'datetime', required: true },
        { name: 'location', label: '장소' },
        { name: 'requiredSkills', label: '필요 기술', placeholder: '쉼표로 구분 (예: security, driving)' },
        { name: 'allowConcurrent', label: '다른 업무와 동시 수행 가능 (시간 중복 배정 허용)', type: 'checkbox', full: true },
        { name: 'description', label: '설명', type: 'textarea', full: true },
      ],
      submitLabel: '등록',
      onSubmit: (v) => api.post('/api/tasks', { ...v, requiredSkills: v.requiredSkills ? v.requiredSkills.split(',').map((s) => s.trim()).filter(Boolean) : [] }),
    });
    if (r) { toast.ok('업무를 등록했습니다.'); location.href = `/tasks/${r.data.id}`; }
  }

  on(root, 'click', '[data-act]', async (e, b) => {
    const act = b.dataset.act;
    if (act === 'new') createTask();
    if (act === 'csv') {
      const p = new URLSearchParams(Object.entries(params()).filter(([, v]) => v !== undefined && v !== ''));
      location.href = `/api/tasks/export?${p}`;
    }
    if (act === 'template') {
      const [tpls, managed] = await Promise.all([api.get('/api/task-templates'), options.crews(true)]);
      if (!tpls.data.length) return toast('등록된 템플릿이 없습니다.', 'bad');
      const r = await formModal({
        title: '템플릿으로 업무 등록', subtitle: '템플릿의 기본값과 체크리스트가 자동으로 적용됩니다.',
        values: { startAt: new Date(Date.now() + 86400000).toISOString() },
        fields: [
          { name: 'templateId', label: '템플릿', type: 'select', required: true, full: true, options: tpls.data.map((t) => ({ value: t.id, label: `${t.name} · ${t.defaults.durationHours || 1}시간 · 체크리스트 ${(t.checklist || []).length}개` })) },
          { name: 'crewId', label: '담당 Crew', type: 'select', required: true, options: managed, numeric: true },
          { name: 'startAt', label: '시작', type: 'datetime', required: true },
          { name: 'title', label: '업무명 (선택)', full: true, placeholder: '비우면 템플릿 이름 사용' },
        ],
        submitLabel: '등록',
        onSubmit: ({ templateId, ...v }) => api.post(`/api/task-templates/${templateId}/instantiate`, v),
      });
      if (r) { toast.ok('업무를 등록했습니다.'); location.href = `/tasks/${r.data.id}`; }
    }
  });

  if (state.new === '1' && can('task.create')) createTask();
  void L;
});
