App.page(async (root) => {
  const { html, icon, api, fmt, badge, can, ME, setHTML, $, on, opts, DataTable, filterBar, formModal, toast, run } = App;

  setHTML(root, html`
    <div class="page-head">
      <div><h1>자원 사용</h1><p>${can('resource.allocate') ? '관리 범위의 자원 배정과 ' : ''}내가 사용하거나 예약한 자원 · 참여 업무의 자원입니다.</p></div>
      <div class="actions"><a class="btn" href="/resources">${icon('box')}자원 찾기</a></div>
    </div>
    <div class="card"><div class="toolbar" id="filters"></div><div id="table"></div></div>
    <div class="card mt"><div class="card-h"><h3>내 사용 요청</h3><span class="sub">승인되면 위 목록에 예약으로 표시됩니다</span></div><div id="requests"></div></div>`);

  const filters = filterBar($('#filters', root), [
    { name: 'status', type: 'select', label: '모든 상태', options: opts('alloc') },
    { name: 'overdue', type: 'toggle', label: '반납 지연만' },
  ], () => table.load(1));

  const table = new DataTable($('#table', root), {
    url: '/api/allocations', sort: '-startAt',
    params: () => { const f = filters.values(); return { status: f.status, overdue: f.overdue ? 'true' : undefined }; },
    empty: '자원 사용 기록이 없습니다.',
    columns: [
      { label: '자원', render: (a) => html`<a href="/resources/${a.resourceId}"><b>${a.resourceName}</b></a><span class="sub mono">${a.resourceCode}</span>` },
      { label: '대상', render: (a) => (a.taskId ? html`<a href="/tasks/${a.taskId}">${a.taskTitle}</a><span class="sub">업무</span>` : html`${a.memberName}<span class="sub">구성원</span>`) },
      { label: '기간', sort: 'startAt', render: (a) => html`${fmt.range(a.startAt, a.endAt)}${a.status === 'IN_USE' && new Date(a.endAt) < new Date() ? html`<span class="sub" style="color:var(--bad)">반납 기한 경과</span>` : ''}` },
      { label: '상태', render: (a) => html`${badge('alloc', a.status)}${a.returnCondition && a.returnCondition !== 'GOOD' ? html` <span class="badge bad plain">${a.returnCondition === 'DAMAGED' ? '파손' : '분실'}</span>` : ''}` },
      { label: '목적', render: (a) => a.purpose || '-' },
      { label: '', render: (a) => html`<div class="row" style="justify-content:flex-end">
        ${a.status === 'RESERVED' ? html`<button class="btn sm" data-act="checkout" data-id="${a.id}">${icon('play')}사용 시작</button><button class="btn sm ghost" data-act="cancel" data-id="${a.id}" title="예약 취소">${icon('x')}</button>` : ''}
        ${a.status === 'IN_USE' ? html`<button class="btn sm primary" data-act="return" data-id="${a.id}">반납</button>` : ''}</div>` },
    ],
  });
  table.load(1);

  const reqTable = new DataTable($('#requests', root), {
    url: '/api/resource-requests', sort: '-createdAt', params: () => ({}), empty: '사용 요청 내역이 없습니다.',
    columns: [
      { label: '자원', render: (q) => html`<a href="/resources/${q.resourceId}">${q.resourceCode} ${q.resourceName}</a>` },
      { label: '요청자', render: (q) => q.requesterName },
      { label: '기간', render: (q) => fmt.range(q.startAt, q.endAt) },
      { label: '목적', render: (q) => q.purpose },
      { label: '상태', render: (q) => html`${badge('req', q.status)}${q.reviewComment ? html`<span class="sub">${q.reviewComment}</span>` : ''}` },
      { label: '', render: (q) => (q.status === 'PENDING' && q.requesterId === ME.id ? html`<button class="btn sm ghost" data-act="cancel-req" data-id="${q.id}">요청 취소</button>` : '') },
    ],
  });
  reqTable.load(1);

  on(root, 'click', 'button[data-act]', async (e, b) => {
    const id = b.dataset.id;
    const act = b.dataset.act;
    if (act === 'checkout') run(() => api.post(`/api/allocations/${id}/checkout`), { success: '사용을 시작했습니다.', then: () => table.load() });
    if (act === 'cancel') run(() => api.del(`/api/allocations/${id}`), { confirm: { title: '예약 취소', message: '이 자원 예약을 취소하시겠습니까?', danger: true }, success: '예약을 취소했습니다.', then: () => table.load() });
    if (act === 'cancel-req') run(() => api.del(`/api/resource-requests/${id}`), { confirm: { title: '요청 취소', message: '사용 요청을 취소하시겠습니까?' }, success: '요청을 취소했습니다.', then: () => reqTable.load() });
    if (act === 'return') {
      const r = await formModal({ title: '자원 반납', subtitle: '파손·분실 시 자원은 자동으로 점검 필요/사용 불가로 전환되고 이슈가 등록됩니다.',
        fields: [{ name: 'condition', label: '반납 상태', type: 'select', required: true, value: 'GOOD', options: [{ value: 'GOOD', label: '정상' }, { value: 'DAMAGED', label: '파손' }, { value: 'LOST', label: '분실' }] }, { name: 'note', label: '메모', full: true }],
        submitLabel: '반납', onSubmit: (v) => api.post(`/api/allocations/${id}/return`, v) });
      if (r) { toast.ok('반납했습니다.'); table.load(); }
    }
  });
});
