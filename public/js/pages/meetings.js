App.page(async (root) => {
  const { html, icon, api, fmt, badge, can, ME, setHTML, $, on, DataTable, filterBar, formModal, modal, toast, run, options, empty, opts } = App;

  setHTML(root, html`
    <div class="page-head">
      <div><h1>회의</h1><p>내가 참석·주관하거나 관리하는 Crew 의 회의입니다.</p></div>
      <div class="actions">${can('meeting.manage') ? html`<button class="btn primary" data-act="new">${icon('plus')}회의 생성</button>` : ''}</div>
    </div>
    <div class="card"><div class="toolbar" id="filters"></div><div id="table"></div></div>`);

  const filters = filterBar($('#filters', root), [
    { name: 'status', type: 'select', label: '모든 상태', options: opts('meeting') },
  ], () => table.load(1));
  const table = new DataTable($('#table', root), {
    url: '/api/meetings', sort: '-startAt', params: () => filters.values(), empty: '회의가 없습니다.',
    columns: [
      { label: '회의', render: (m) => html`<a href="#" data-open="${m.id}"><b>${m.title}</b></a><span class="sub">${m.agenda || ''}</span>` },
      { label: 'Crew', render: (m) => m.crewName || '조직 전체' },
      { label: '일시', sort: 'startAt', render: (m) => html`${fmt.range(m.startAt, m.endAt)}<span class="sub">${m.location || ''}</span>` },
      { label: '주관', render: (m) => m.organizerName },
      { label: '참석자', cls: 'num', render: (m) => m.attendeeCount },
      { label: '상태', render: (m) => badge('meeting', m.status) },
    ],
  });
  table.load(1);

  async function open(id) {
    const r = await api.get(`/api/meetings/${id}`);
    const m = r.data;
    const manage = can('meeting.manage') && (m.organizerId === ME.id || ME.level >= 3);
    const me = m.attendees.find((a) => a.memberId === ME.id);
    const dlg = modal({
      title: m.title, subtitle: `${fmt.range(m.startAt, m.endAt)} · ${m.location || '장소 미정'} · ${m.crewName || '조직 전체'}`, size: 'lg',
      body: html`
        <div class="row" style="margin-bottom:12px">${badge('meeting', m.status)} <span style="color:var(--muted)">주관: ${m.organizerName}</span></div>
        ${m.agenda ? html`<p style="white-space:pre-wrap;margin-top:0">${m.agenda}</p>` : ''}
        ${me && m.status === 'SCHEDULED' ? html`<div class="notice info" style="margin-bottom:14px">${icon('bell')}<div style="flex:1">내 응답: <b>${App.L.rsvp[me.rsvp][0]}</b></div>
          ${['YES', 'MAYBE', 'NO'].map((v) => html`<button class="btn sm ${me.rsvp === v ? 'primary' : ''}" data-rsvp="${v}">${App.L.rsvp[v][0]}</button>`)}</div>` : ''}
        <h4 style="margin:6px 0 8px">참석자 (${m.attendees.length})</h4>
        <ul class="list" style="border:1px solid var(--line);border-radius:8px">${m.attendees.map((a) => html`<li>${App.person(a.name)}<span class="spacer"></span>${badge('rsvp', a.rsvp)}
          ${manage && m.status === 'SCHEDULED' && a.memberId !== m.organizerId ? html`<button class="btn sm ghost" data-remove="${a.memberId}">${icon('x')}</button>` : ''}</li>`)}</ul>
        ${manage && m.status === 'SCHEDULED' ? html`<button class="btn sm mt" data-add>${icon('plus')}참석자 추가</button>` : ''}
        <h4 style="margin:18px 0 8px">회의록</h4>
        ${m.minutes && m.minutes.content ? html`<div class="card"><div class="card-b"><p style="white-space:pre-wrap;margin:0">${m.minutes.content}</p>
          ${(m.minutes.decisions || []).length ? html`<ul style="margin:10px 0 0;padding-left:18px">${m.minutes.decisions.map((d) => html`<li>${d}</li>`)}</ul>` : ''}</div></div>` : empty('작성된 회의록이 없습니다', '', 'audit')}`,
      actions: [
        ...(manage && m.status === 'SCHEDULED' ? [{ label: '회의 취소', kind: 'danger', onClick: ({ close }) => run(() => api.del(`/api/meetings/${m.id}`), { confirm: { title: '회의 취소', message: '참석자에게 취소 알림이 전송됩니다.', danger: true }, success: '회의를 취소했습니다.', then: () => { close(); table.load(); } }) }] : []),
        ...(manage && m.status !== 'CANCELLED' ? [{ label: '회의록 작성', onClick: async ({ close }) => {
          close();
          const ok = await formModal({ title: '회의록', size: 'lg', values: { content: (m.minutes && m.minutes.content) || '', decisions: ((m.minutes && m.minutes.decisions) || []).join('\n') },
            fields: [{ name: 'content', label: '내용', type: 'textarea', required: true, full: true, rows: 8 }, { name: 'decisions', label: '결정사항 (한 줄에 하나)', type: 'textarea', full: true }],
            onSubmit: (v) => api.put(`/api/meetings/${m.id}/minutes`, { content: v.content, decisions: (v.decisions || '').split('\n').map((s) => s.trim()).filter(Boolean) }) });
          if (ok) { toast.ok('회의록을 저장했습니다.'); table.load(); }
        } }] : []),
        { label: '닫기', kind: 'primary', onClick: ({ close }) => close() },
      ],
    });
    on(dlg.el, 'click', '[data-rsvp]', (e, b) => run(() => api.post(`/api/meetings/${m.id}/rsvp`, { rsvp: b.dataset.rsvp }), { success: '응답했습니다.', then: () => { dlg.close(); open(id); } }));
    on(dlg.el, 'click', '[data-remove]', (e, b) => run(() => api.del(`/api/meetings/${m.id}/attendees/${b.dataset.remove}`), { then: () => { dlg.close(); open(id); } }));
    on(dlg.el, 'click', '[data-add]', async () => {
      dlg.close();
      const ok = await formModal({ title: '참석자 추가', fields: [{ name: 'memberId', label: '구성원', type: 'select', required: true, full: true, numeric: true, options: () => options.members() }], submitLabel: '추가', onSubmit: (v) => api.post(`/api/meetings/${m.id}/attendees`, v) });
      if (ok) toast.ok('추가했습니다.');
      open(id);
    });
  }

  on(root, 'click', '[data-open]', (e, a) => { e.preventDefault(); open(a.dataset.open).catch(toast.error); });
  on(root, 'click', '[data-act="new"]', async () => {
    const managed = await options.crews(true);
    const members = await options.members();
    const start = new Date(Date.now() + 86400000); start.setMinutes(0, 0, 0);
    const r = await formModal({
      title: '회의 생성', size: 'lg', values: { startAt: start.toISOString(), endAt: new Date(start.getTime() + 3600000).toISOString(), crewId: managed[0] && managed[0].value },
      fields: [
        { name: 'title', label: '회의명', required: true, full: true },
        { name: 'crewId', label: 'Crew', type: 'select', options: managed, numeric: true, placeholder: '조직 전체 (Underboss 이상)' },
        { name: 'location', label: '장소' },
        { name: 'startAt', label: '시작', type: 'datetime', required: true },
        { name: 'endAt', label: '종료', type: 'datetime', required: true },
        { name: 'attendeeIds', label: '참석자', type: 'multi', full: true, options: members.map((x) => ({ ...x, value: String(x.value) })) },
        { name: 'agenda', label: '안건', type: 'textarea', full: true },
      ],
      submitLabel: '생성', onSubmit: (v) => api.post('/api/meetings', { ...v, attendeeIds: (v.attendeeIds || []).map(Number) }),
    });
    if (r) { toast.ok('회의를 생성하고 참석자에게 알림을 보냈습니다.'); table.load(1); }
  });
});
