App.page(async (root) => {
  const { html, icon, api, fmt, badge, can, ME, setHTML, $, on, L, formModal, toast, run, empty, tabs, person } = App;

  setHTML(root, html`
    <div class="page-head"><div><h1>요청 · 승인</h1><p>자원 사용 요청, Crew 가입 요청, 승급 요청을 한 곳에서 처리합니다. 본인이 올린 요청도 여기서 확인할 수 있습니다.</p></div></div>
    <div id="tabs"></div>`);

  const reviewBtns = (kind, id) => html`<button class="btn sm primary" data-review="${kind}" data-op="approve" data-id="${id}">${icon('check')}승인</button><button class="btn sm danger" data-review="${kind}" data-op="reject" data-id="${id}">반려</button>`;
  const statusFilter = (k) => html`<div class="toolbar"><div class="seg" data-seg="${k}"><button data-v="PENDING" class="on">대기</button><button data-v="">전체</button></div></div>`;
  const state = { res: 'PENDING', join: 'PENDING', promo: 'PENDING' };

  async function resourceTab(p) {
    const r = await api.get('/api/resource-requests', { status: state.res, size: 100 });
    setHTML(p, html`<div class="card">${statusFilter('res')}<div class="card-b flush">${r.data.length ? html`<ul class="list">${r.data.map((q) => html`<li>
      ${person(q.requesterName, q.requesterId === ME.id ? '내 요청' : '')}
      <div class="grow"><div class="title"><a href="/resources/${q.resourceId}">${q.resourceCode} ${q.resourceName}</a></div><div class="desc">${fmt.range(q.startAt, q.endAt)} · ${q.purpose}${q.reviewComment ? ` · ${q.reviewComment}` : ''}</div></div>
      ${badge('req', q.status)}
      ${q.status === 'PENDING' && q.requesterId !== ME.id && can('resource.allocate') ? reviewBtns('resource-requests', q.id) : ''}
      ${q.status === 'PENDING' && q.requesterId === ME.id ? html`<button class="btn sm ghost" data-cancel="resource-requests" data-id="${q.id}">취소</button>` : ''}</li>`)}</ul>` : empty('요청이 없습니다', '', 'inbox')}</div></div>`);
    paintSeg(p, 'res');
  }
  async function joinTab(p) {
    const r = await api.get('/api/join-requests', { status: state.join, size: 100 });
    setHTML(p, html`<div class="card">${statusFilter('join')}<div class="card-b flush">${r.data.length ? html`<ul class="list">${r.data.map((j) => html`<li>
      ${person(j.memberName, (L.member[j.memberStatus] || [])[0])}
      <div class="grow"><div class="title"><a href="/crews/${j.crewId}">${j.crewName}</a> · ${L.membership[j.membershipType]} 가입</div><div class="desc">${j.message || ''} · ${fmt.rel(j.createdAt)}${j.reviewComment ? ` · ${j.reviewComment}` : ''}</div></div>
      ${badge('req', j.status)}
      ${j.status === 'PENDING' && j.memberId !== ME.id && can('crew.members') ? reviewBtns('join-requests', j.id) : ''}
      ${j.status === 'PENDING' && j.memberId === ME.id ? html`<button class="btn sm ghost" data-cancel="join-requests" data-id="${j.id}">취소</button>` : ''}</li>`)}</ul>` : empty('요청이 없습니다', '', 'inbox')}</div></div>`);
    paintSeg(p, 'join');
  }
  async function promoTab(p) {
    const r = await api.get('/api/promotion-requests', { status: state.promo, size: 100 });
    setHTML(p, html`<div class="card">${statusFilter('promo')}<div class="card-b flush">${r.data.length ? html`<ul class="list">${r.data.map((q) => html`<li>
      ${person(q.memberName, `${L.role[q.currentRole]} → ${L.role[q.targetRole]}`, `/members/${q.memberId}`)}
      <div class="grow"><div class="title">${q.reason}</div><div class="desc">요청: ${q.requestedByName} · ${fmt.rel(q.createdAt)}${q.reviewComment ? ` · ${q.reviewComment}` : ''}</div></div>
      ${badge('req', q.status)}
      ${q.status === 'PENDING' && q.requestedBy !== ME.id && can('promotion.review') ? reviewBtns('promotion-requests', q.id) : ''}
      ${q.status === 'PENDING' && q.requestedBy === ME.id ? html`<button class="btn sm ghost" data-cancel="promotion-requests" data-id="${q.id}">취소</button>` : ''}</li>`)}</ul>` : empty('요청이 없습니다', '', 'inbox')}</div></div>`);
    paintSeg(p, 'promo');
  }
  function paintSeg(p, k) { $$seg(p, k); }
  function $$seg(p, k) { const s = $(`[data-seg="${k}"]`, p); if (s) [...s.children].forEach((b) => b.classList.toggle('on', b.dataset.v === state[k])); }

  const t = tabs($('#tabs', root), [
    { key: 'resource', label: '자원 사용 요청', render: resourceTab },
    { key: 'join', label: 'Crew 가입 요청', render: joinTab },
    { key: 'promotion', label: '승급 요청', show: can(['promotion.request', 'promotion.review']), render: promoTab },
  ]);

  on(root, 'click', '[data-seg] button', (e, b) => { state[b.parentElement.dataset.seg] = b.dataset.v; t.reload(); });
  on(root, 'click', '[data-cancel]', (e, b) => run(() => api.del(`/api/${b.dataset.cancel}/${b.dataset.id}`), { confirm: { title: '요청 취소', message: '요청을 취소하시겠습니까?' }, success: '취소했습니다.', then: () => t.reload() }));
  on(root, 'click', '[data-review]', async (e, b) => {
    const approve = b.dataset.op === 'approve';
    const notes = { 'resource-requests': '승인 시 자원 중복(BR-07)·사용 불가(BR-08)를 다시 검사한 뒤 배정됩니다.', 'join-requests': '승인 시 Crew 에 편성되며 정식 소속은 하나만 허용됩니다 (BR-01).', 'promotion-requests': '승인 시 역할이 변경되며, 대상과 목표 역할보다 높은 권한이 필요합니다 (BR-04).' };
    const r = await formModal({ title: approve ? '요청 승인' : '요청 반려', subtitle: approve ? notes[b.dataset.review] : '반려 사유가 요청자에게 전달됩니다.', danger: !approve,
      fields: [{ name: 'comment', label: approve ? '코멘트 (선택)' : '반려 사유', required: !approve, full: true, type: 'textarea' }],
      submitLabel: approve ? '승인' : '반려', onSubmit: (v) => api.post(`/api/${b.dataset.review}/${b.dataset.id}/${b.dataset.op}`, v) });
    if (r) { toast.ok(approve ? '승인했습니다.' : '반려했습니다.'); App.refreshInbox(); t.reload(); }
  });
});
