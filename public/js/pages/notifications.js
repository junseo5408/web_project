App.page(async (root) => {
  const { html, icon, api, fmt, setHTML, $, on, run, empty, filterBar, toast } = App;
  const TYPES = { TASK_ASSIGNED: '업무 배정', TASK_UNASSIGNED: '배정 해제', TASK_STATUS: '업무 상태', ASSIGNMENT_DECLINED: '배정 거절', ROLE_CHANGED: '역할 변경', STATUS_CHANGED: '상태 변경', CREW_CHANGED: '소속 변경', EVALUATION: '평가', RESOURCE: '자원', REQUEST_REVIEWED: '요청 처리', ANNOUNCEMENT: '공지', MEETING: '회의', DISCIPLINE: '징계', BROADCAST: '전체 공지' };
  let page = 1;

  setHTML(root, html`
    <div class="page-head"><div><h1>알림</h1><p>업무 배정, 요청 처리, 공지 등 나에게 온 알림입니다.</p></div>
      <div class="actions"><a class="btn" href="/me#notify">${icon('settings')}수신 설정</a><button class="btn" data-act="read-all">${icon('check')}모두 읽음</button></div></div>
    <div class="card"><div class="toolbar" id="filters"></div><div id="list"></div><div class="pager" id="pager"></div></div>`);

  const filters = filterBar($('#filters', root), [
    { name: 'type', type: 'select', label: '모든 유형', options: Object.entries(TYPES).map(([value, label]) => ({ value, label })) },
    { name: 'unread', type: 'toggle', label: '읽지 않은 알림만' },
  ], () => { page = 1; load(); });

  async function load() {
    const f = filters.values();
    const r = await api.get('/api/me/notifications', { type: f.type, unread: f.unread ? 'true' : undefined, page, size: 20 });
    setHTML($('#list', root), r.data.length ? html`<ul class="list">${r.data.map((n) => html`<li class="${n.read ? '' : 'unread'}">
      <span class="badge ${n.read ? '' : 'brand'} plain">${TYPES[n.type] || n.type}</span>
      <div class="grow"><div class="title">${n.title}</div><div class="desc">${n.message}</div></div>
      <span class="desc" style="white-space:nowrap" title="${fmt.full(n.createdAt)}">${fmt.rel(n.createdAt)}</span>
      ${App.uiLink(n.link) ? html`<a class="btn sm" href="${App.uiLink(n.link)}" data-open="${n.id}">열기</a>` : ''}
      ${n.read ? '' : html`<button class="btn sm ghost" data-read="${n.id}" title="읽음">${icon('check')}</button>`}
      <button class="btn sm ghost" data-del="${n.id}" title="삭제">${icon('trash')}</button></li>`)}</ul>` : empty('알림이 없습니다', '', 'bell'));
    setHTML($('#pager', root), html`<span>총 ${r.meta.total}건</span><div class="pages"><button data-p="${page - 1}" ${page <= 1 ? App.raw('disabled') : ''}>‹</button><button class="on">${page}</button><button data-p="${page + 1}" ${page >= r.meta.totalPages ? App.raw('disabled') : ''}>›</button></div>`);
    App.refreshInbox();
  }

  on(root, 'click', '[data-p]', (e, b) => { page = +b.dataset.p; load(); });
  on(root, 'click', '[data-read]', (e, b) => run(() => api.patch(`/api/me/notifications/${b.dataset.read}/read`), { then: load }));
  on(root, 'click', '[data-open]', (e, a) => { api.patch(`/api/me/notifications/${a.dataset.open}/read`).catch(() => {}); });
  on(root, 'click', '[data-del]', (e, b) => run(() => api.del(`/api/me/notifications/${b.dataset.del}`), { then: load }));
  on(root, 'click', '[data-act="read-all"]', () => run(() => api.patch('/api/me/notifications/read-all'), { then: (r) => { toast.ok(`${r.data.updated}건을 읽음 처리했습니다.`); load(); } }));
  await load();
});
