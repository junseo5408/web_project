App.page(async (root, params) => {
  const { html, icon, api, fmt, badge, can, ME, setHTML, $, on, L, formModal, toast, run, empty, options } = App;
  const id = params.id;
  const base = `/api/resources/${id}`;
  const managed = await api.get('/api/crews/managed').then((r) => r.data.map((c) => c.id)).catch(() => []);
  const EVENT = { REGISTERED: '자원 등록', UPDATED: '정보 수정', STATUS_CHANGED: '상태 변경', ALLOCATED: '배정(예약)', RESCHEDULED: '예약 기간 변경', CANCELLED: '예약 취소', CHECKED_OUT: '사용 시작', RETURNED: '반납', ISSUE_REPORTED: '이상 신고', ISSUE_RESOLVED: '이슈 해결' };
  const MANUAL = { AVAILABLE: ['NEEDS_INSPECTION', 'MAINTENANCE', 'UNAVAILABLE', 'RETIRED'], IN_USE: ['NEEDS_INSPECTION', 'UNAVAILABLE'], NEEDS_INSPECTION: ['AVAILABLE', 'MAINTENANCE', 'UNAVAILABLE', 'RETIRED'], MAINTENANCE: ['AVAILABLE', 'NEEDS_INSPECTION', 'UNAVAILABLE', 'RETIRED'], UNAVAILABLE: ['AVAILABLE', 'MAINTENANCE', 'RETIRED'], RETIRED: [] };

  async function load() {
    const [r, av, hist] = await Promise.all([api.get(base), api.get(`${base}/availability`, { to: new Date(Date.now() + 14 * 86400000) }), api.get(`${base}/history`, { size: 40 })]);
    const x = r.data;
    const manage = (x.crewId ? managed.includes(x.crewId) : ME.level >= 4);
    const blocked = !x.usable;
    const acts = [];
    if (x.status !== 'RETIRED') {
      if (can('resource.allocate') && !blocked) acts.push(html`<button class="btn primary" data-act="allocate">${icon('key')}배정</button>`);
      if (!blocked && ['ACTIVE', 'STANDBY'].includes(ME.status)) acts.push(html`<button class="btn" data-act="request">${icon('send')}사용 요청</button>`);
      acts.push(html`<button class="btn" data-act="issue">${icon('alert')}이상 신고</button>`);
      if (can('resource.manage') && manage) acts.push(html`<button class="btn" data-act="status">${icon('flag')}상태 변경</button><button class="btn" data-act="edit">${icon('edit')}수정</button>`);
    }
    setHTML(root, html`
      <a href="/resources" class="btn ghost sm" style="margin-bottom:12px">${icon('back')}자원 목록</a>
      <div class="card"><div class="card-b"><div class="hero">
        <div class="brand-mark" style="width:56px;height:56px;background:${blocked ? '#a95c06' : ''}">${icon('box')}</div>
        <div style="flex:1;min-width:0"><h1>${x.name} <span class="mono" style="font-size:14px;color:var(--muted);font-weight:500">${x.code}</span></h1>
          <div class="meta">${badge('resource', x.status)} <span>${x.typeName}</span><span>·</span><span>${x.crewName || '조직 공용'}</span><span>·</span>${icon('pin')}<span>${x.location || '-'}</span><span>·</span><span class="tag">이용 Lv.${x.minRoleLevel}+</span></div>
          ${blocked ? html`<div class="notice warn" style="margin-top:12px">${icon('alert')}<div>현재 <b>${L.resource[x.status][0]}</b> 상태로 새로운 배정·사용이 차단됩니다 (BR-08).</div></div>` : ''}
        </div>
        <div class="row" style="justify-content:flex-end">${acts}</div>
      </div></div></div>
      <div class="grid g-main mt">
        <div class="stack">
          <div class="card"><div class="card-h"><h3>사용 · 예약 현황 <span class="sub">앞으로 14일</span></h3></div><div class="card-b flush">
            ${x.currentUse ? html`<div class="notice info" style="margin:14px 18px 0">${icon('key')}<div>현재 사용중 · 배정 #${x.currentUse.allocationId} · ${fmt.range(x.currentUse.startAt, x.currentUse.endAt)}</div></div>` : ''}
            ${av.data.busy.length ? html`<ul class="list">${av.data.busy.map((b) => html`<li><div class="grow"><div class="title">${fmt.range(b.startAt, b.endAt)}</div>
              <div class="desc">${b.taskId ? html`<a href="/tasks/${b.taskId}">업무 #${b.taskId}</a>` : `구성원 #${b.memberId}`}</div></div>${badge('alloc', b.status)}</li>`)}</ul>` : empty('예약이 없습니다', '이 기간 동안 자유롭게 이용할 수 있습니다.', 'calendar')}</div></div>
          <div class="card"><div class="card-h"><h3>사용 · 상태 변경 이력</h3><span class="sub">FR-15</span></div><div class="card-b">${hist.data.length ? html`<ul class="timeline">${hist.data.map((h) => html`<li>
            <span class="dot ${h.event === 'RETURNED' ? 'ok' : h.event === 'ISSUE_REPORTED' ? 'bad' : h.event === 'STATUS_CHANGED' ? 'warn' : 'brand'}"></span>
            <div class="t">${EVENT[h.event] || h.event}${h.event === 'STATUS_CHANGED' ? html`: ${(L.resource[h.from] || [h.from])[0]} → ${(L.resource[h.to] || [h.to])[0]}` : ''}${h.condition ? html` · ${h.condition}` : ''}</div>
            <div class="s">${h.by.username} · ${fmt.full(h.at)}${h.reason ? ` · ${h.reason}` : ''}${h.note ? ` · ${h.note}` : ''}</div></li>`)}</ul>` : empty('이력이 없습니다')}</div></div>
        </div>
        <div class="stack">
          <div class="card"><div class="card-h"><h3>자원 정보</h3></div><div class="card-b"><dl class="dl">
            <dt>코드</dt><dd class="mono">${x.code}</dd><dt>유형</dt><dd>${x.typeName}</dd><dt>소유</dt><dd>${x.crewId ? html`<a href="/crews/${x.crewId}">${x.crewName}</a>` : '조직 공용'}</dd>
            <dt>설명</dt><dd>${x.description || '-'}</dd><dt>등록일</dt><dd>${fmt.date(x.createdAt)}</dd><dt>최근 변경</dt><dd>${fmt.rel(x.updatedAt)}</dd></dl></div></div>
          <div class="card"><div class="card-h"><h3>미해결 이슈</h3></div><div class="card-b flush">${x.openIssues.length ? html`<ul class="list">${x.openIssues.map((i) => html`<li>${badge('severity', i.severity)}
            <div class="grow"><div class="title">${i.description}</div><div class="desc">${fmt.full(i.createdAt)}</div></div>
            ${can('resource.manage') && manage ? html`<button class="btn sm" data-resolve="${i.id}">해결</button>` : ''}</li>`)}</ul>` : empty('미해결 이슈가 없습니다', '', 'checkCircle')}</div></div>
        </div>
      </div>`);
    root._x = x;
  }
  const reload = () => load().catch(toast.error);

  on(root, 'click', '[data-resolve]', async (e, b) => {
    const r = await formModal({ title: '이슈 해결 처리', subtitle: '다른 미해결 이슈가 없으면 자원 상태가 복구됩니다.',
      fields: [{ name: 'resolution', label: '조치 내용', type: 'textarea', required: true, full: true }, { name: 'restoreStatus', label: '해결 후 상태', type: 'select', required: true, value: 'AVAILABLE', options: ['AVAILABLE', 'MAINTENANCE', 'UNAVAILABLE', 'RETIRED'].map((s) => ({ value: s, label: L.resource[s][0] })) }],
      submitLabel: '해결', onSubmit: (v) => api.post(`/api/resource-issues/${b.dataset.resolve}/resolve`, v) });
    if (r) { toast.ok('이슈를 해결했습니다.'); reload(); }
  });

  on(root, 'click', 'button[data-act]', async (e, b) => {
    const x = root._x;
    const start = new Date(Date.now() + 3600000); start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 3 * 3600000);
    let r;
    switch (b.dataset.act) {
      case 'allocate': {
        const [members, tasks] = await Promise.all([options.members(), api.get('/api/tasks', { status: 'PLANNED,IN_PROGRESS,ON_HOLD', sort: 'startAt', size: 100 })]);
        r = await formModal({ title: `${x.name} 배정`, subtitle: '업무 또는 구성원 중 하나를 선택하세요. 업무를 선택하면 업무 일정이 기본 적용됩니다.', size: 'lg',
          values: { startAt: start.toISOString(), endAt: end.toISOString() },
          fields: [{ name: 'taskId', label: '업무', type: 'select', numeric: true, full: true, placeholder: '업무 선택 안 함', options: tasks.data.map((t) => ({ value: t.id, label: `#${t.id} ${t.title} · ${fmt.range(t.startAt, t.endAt)}` })) },
            { name: 'memberId', label: '또는 구성원', type: 'select', numeric: true, full: true, placeholder: '구성원 선택 안 함', options: members },
            { name: 'startAt', label: '시작 (구성원 배정 시)', type: 'datetime' }, { name: 'endAt', label: '종료', type: 'datetime' }, { name: 'purpose', label: '목적', full: true }],
          submitLabel: '배정', onSubmit: (v) => api.post('/api/allocations', v.taskId ? { resourceId: x.id, taskId: v.taskId, purpose: v.purpose } : { ...v, resourceId: x.id }) });
        break;
      }
      case 'request':
        r = await formModal({ title: `${x.name} 사용 요청`, subtitle: '관리자가 승인하면 배정됩니다. 처리되지 않으면 자동 만료됩니다.', values: { startAt: start.toISOString(), endAt: end.toISOString() },
          fields: [{ name: 'startAt', label: '시작', type: 'datetime', required: true }, { name: 'endAt', label: '종료', type: 'datetime', required: true }, { name: 'purpose', label: '사용 목적', required: true, full: true }],
          submitLabel: '요청', onSubmit: (v) => api.post('/api/resource-requests', { ...v, resourceId: x.id }) });
        break;
      case 'issue':
        r = await formModal({ title: '이상 신고', subtitle: '정상 자원은 점검 필요 상태로 전환되어 새 배정이 차단됩니다.',
          fields: [{ name: 'severity', label: '심각도', type: 'select', required: true, value: 'MEDIUM', options: App.opts('severity') }, { name: 'description', label: '내용', type: 'textarea', required: true, full: true }],
          submitLabel: '신고', onSubmit: (v) => api.post(`${base}/issues`, v) });
        break;
      case 'status':
        r = await formModal({ title: '자원 상태 변경', subtitle: `현재 ${L.resource[x.status][0]} · 사용중(IN_USE)은 체크아웃/반납으로 자동 관리됩니다.`,
          fields: [{ name: 'status', label: '새 상태', type: 'select', required: true, full: true, options: MANUAL[x.status].map((s) => ({ value: s, label: L.resource[s][0] })) },
            { name: 'reason', label: '사유', required: true, full: true }, { name: 'cancelReservations', label: '사용 불가 전환 시 기존 예약도 취소', type: 'checkbox', full: true }],
          submitLabel: '변경', onSubmit: (v) => api.patch(`${base}/status`, v) });
        if (r && r.data.affectedReservations.length && !r.data.cancelledReservations) toast(`기존 예약 ${r.data.affectedReservations.length}건이 남아 있습니다. 확인이 필요합니다.`, 'bad');
        break;
      case 'edit':
        r = await formModal({ title: '자원 정보 수정', values: x,
          fields: [{ name: 'name', label: '이름', required: true }, { name: 'location', label: '위치', emptyAsNull: true }, { name: 'minRoleLevel', label: '이용 최소 등급', type: 'number', min: 1, max: 6 },
            { name: 'description', label: '설명', type: 'textarea', full: true, emptyAsNull: true }],
          onSubmit: (v) => api.patch(base, v) });
        break;
      default:
    }
    if (r) { toast.ok('처리했습니다.'); reload(); }
  });

  await load();
  void run;
});
