App.page(async (root) => {
  const { html, raw, icon, api, fmt, badge, setHTML, $, $$, on, L, formModal, toast, run, empty, tabs, avatar, ME } = App;
  const TARGET_PAGE = { tasks: '/tasks', members: '/members', resources: '/resources', crews: '/crews' };

  async function load() {
    const [me, perms] = await Promise.all([api.get('/api/me'), api.get('/api/auth/permissions')]);
    const m = me.data;
    setHTML(root, html`
      <div class="card"><div class="card-b"><div class="hero">${avatar(m.name, 'lg')}
        <div style="flex:1"><h1>${m.name} ${m.alias ? html`<span style="font-weight:400;color:var(--muted);font-size:16px">“${m.alias}”</span>` : ''}</h1>
          <div class="meta"><span class="badge brand plain">${L.role[m.role]}</span>${badge('member', m.status)}<span>@${m.username}</span><span>·</span>
            <span>${m.crews.length ? m.crews.map((c) => `${c.crewName}(${L.membership[c.membershipType]})`).join(', ') : '무소속'}</span></div></div>
        <div class="row"><a class="btn" href="/members/${m.id}">${icon('user')}구성원 프로필</a><button class="btn" data-act="profile">${icon('edit')}연락처 수정</button><button class="btn primary" data-act="password">${icon('key')}비밀번호 변경</button></div>
      </div></div></div>
      <div class="grid g-4 mt">
        <div class="card kpi"><div class="label">진행 업무</div><div class="value">${m.activity.openAssignments}</div></div>
        <div class="card kpi ok"><div class="label">완료 업무</div><div class="value">${m.activity.completedTasks}</div></div>
        <div class="card kpi"><div class="label">사용 · 예약 자원</div><div class="value">${m.activity.activeAllocations}</div></div>
        <div class="card kpi"><div class="label">평판 가감점</div><div class="value">${m.activity.reputation}</div></div>
      </div>
      <div class="mt" id="tabs"></div>`);

    tabs($('#tabs', root), [
      { key: 'info', label: '계정 정보', render: (p) => setHTML(p, html`<div class="grid g-2">
        <div class="card"><div class="card-h"><h3>연락처</h3></div><div class="card-b"><dl class="dl"><dt>이메일</dt><dd>${m.email || '-'}</dd><dt>연락처</dt><dd>${m.phone || '-'}</dd><dt>가입일</dt><dd>${fmt.date(m.joinedAt)}</dd><dt>최근 로그인</dt><dd>${fmt.full(m.lastLoginAt)}</dd></dl></div></div>
        <div class="card"><div class="card-h"><h3>권한</h3><span class="sub">관리 범위: ${perms.data.scope === 'ALL' ? '조직 전체' : perms.data.scope === 'CREWS' ? `Crew ${perms.data.managedCrewIds.join(', ')}` : '본인'}</span></div>
          <div class="card-b">${perms.data.permissions.length ? perms.data.permissions.map((p) => html`<span class="tag">${p}</span>`) : html`<span style="color:var(--muted)">권한 코드 없음 — 본인 정보와 배정 업무를 사용할 수 있습니다.</span>`}</div></div></div>`) },
      { key: 'notify', label: '알림 설정', render: notify },
      { key: 'logins', label: '로그인 이력', render: logins },
      { key: 'filters', label: '저장한 검색', render: savedFilters },
    ]);
    root._m = m;
  }

  async function notify(p) {
    const r = (await api.get('/api/me/notification-settings')).data;
    const NAMES = { TASK_ASSIGNED: '업무 배정', TASK_UNASSIGNED: '배정 해제', TASK_STATUS: '업무 상태 변경', ASSIGNMENT_DECLINED: '배정 거절', ROLE_CHANGED: '역할 변경', STATUS_CHANGED: '계정 상태 변경', CREW_CHANGED: '소속 변경', EVALUATION: '평가 · 평판', RESOURCE: '자원', REQUEST_REVIEWED: '요청 처리 결과', ANNOUNCEMENT: 'Crew 공지', MEETING: '회의', DISCIPLINE: '징계', BROADCAST: '전체 공지' };
    setHTML(p, html`<div class="card"><div class="card-h"><h3>받을 알림</h3><button class="btn sm primary" data-act="save-notify">저장</button></div><div class="card-b"><div class="grid g-3">
      ${r.availableTypes.map((t) => html`<label class="check"><input type="checkbox" class="nt" value="${t}" ${r.mutedTypes.includes(t) ? '' : raw('checked')}> ${NAMES[t] || t}</label>`)}</div></div></div>`);
  }
  async function logins(p) {
    const r = await api.get('/api/auth/login-history', { size: 30 });
    setHTML(p, html`<div class="card"><div class="card-b flush">${r.data.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>시각</th><th>이벤트</th><th>결과</th><th>IP</th><th>브라우저</th></tr></thead><tbody>
      ${r.data.map((h) => html`<tr><td>${fmt.full(h.at)}</td><td>${h.event}</td><td>${h.result === 'SUCCESS' ? badge('audit', 'SUCCESS') : html`<span class="badge bad">${h.reason || '실패'}</span>`}</td><td class="mono">${h.ip || '-'}</td><td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h.userAgent || '-'}</td></tr>`)}
      </tbody></table></div>` : empty('로그인 이력이 없습니다')}</div></div>`);
  }
  async function savedFilters(p) {
    const r = await api.get('/api/me/saved-filters');
    setHTML(p, html`<div class="card"><div class="card-h"><h3>저장한 검색 조건</h3><button class="btn sm" data-act="new-filter">${icon('plus')}현재 업무 조건 저장</button></div><div class="card-b flush">${r.data.length ? html`<ul class="list">${r.data.map((f) => {
      const qs = new URLSearchParams(Object.entries(f.query).map(([k, v]) => [k, String(v)])).toString();
      return html`<li><span class="badge plain">${f.target}</span><div class="grow"><div class="title">${f.name}</div><div class="desc mono">${qs}</div></div>
        <a class="btn sm" href="${TARGET_PAGE[f.target]}?${qs}">열기</a><button class="btn sm ghost" data-del-filter="${f.id}">${icon('trash')}</button></li>`;
    })}</ul>` : empty('저장한 검색 조건이 없습니다', '자주 쓰는 업무 검색 조건을 저장해 두고 바로 열 수 있습니다.', 'search')}</div></div>`);
  }

  on(root, 'click', '[data-del-filter]', (e, b) => run(() => api.del(`/api/me/saved-filters/${b.dataset.delFilter}`), { then: () => load() }));
  on(root, 'click', 'button[data-act]', async (e, b) => {
    const m = root._m;
    if (b.dataset.act === 'profile') {
      const r = await formModal({ title: '연락처 수정', subtitle: '역할·상태·소속은 관리자만 변경할 수 있습니다.', values: m,
        fields: [{ name: 'alias', label: '별칭', emptyAsNull: true }, { name: 'phone', label: '연락처', emptyAsNull: true }, { name: 'email', label: '이메일', type: 'email', full: true, emptyAsNull: true }],
        onSubmit: (v) => api.patch('/api/me', v) });
      if (r) { toast.ok('저장했습니다.'); load(); }
    }
    if (b.dataset.act === 'password') {
      const r = await formModal({ title: '비밀번호 변경', subtitle: '변경하면 다른 기기의 세션은 모두 만료되며, 다시 로그인해야 합니다.',
        fields: [{ name: 'currentPassword', label: '현재 비밀번호', type: 'password', required: true, full: true }, { name: 'newPassword', label: '새 비밀번호 (8자 이상)', type: 'password', required: true, full: true }, { name: 'confirm', label: '새 비밀번호 확인', type: 'password', required: true, full: true }],
        submitLabel: '변경', onSubmit: (v) => {
          if (v.newPassword !== v.confirm) throw new App.ApiError(400, { code: 'VALIDATION_ERROR', message: '새 비밀번호 확인이 일치하지 않습니다.', details: [{ field: 'confirm', message: '일치하지 않습니다.' }] });
          return api.put('/api/auth/password', { currentPassword: v.currentPassword, newPassword: v.newPassword });
        } });
      if (r) { toast.ok('비밀번호를 변경했습니다. 다시 로그인하세요.'); setTimeout(() => { location.href = '/login'; }, 1200); }
    }
    if (b.dataset.act === 'save-notify') {
      const muted = $$('.nt', root).filter((i) => !i.checked).map((i) => i.value);
      run(() => api.put('/api/me/notification-settings', { mutedTypes: muted }), { success: '알림 설정을 저장했습니다.' });
    }
    if (b.dataset.act === 'new-filter') {
      const r = await formModal({ title: '업무 검색 조건 저장', subtitle: '업무 화면에서 사용할 조건을 저장합니다.',
        fields: [{ name: 'name', label: '이름', required: true, full: true, placeholder: '예) 긴급 진행 업무' }, { name: 'status', label: '상태', type: 'select', options: App.opts('task') }, { name: 'priority', label: '중요도', type: 'select', options: App.opts('priority') }, { name: 'q', label: '검색어' }],
        onSubmit: ({ name, ...q }) => api.post('/api/me/saved-filters', { name, target: 'tasks', query: Object.keys(q).length ? q : { mine: '1' } }) });
      if (r) { toast.ok('저장했습니다.'); load(); }
    }
  });
  await load();
  void ME;
});
