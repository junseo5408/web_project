App.page(async (root) => {
  const { html, icon, api, fmt, badge, can, ME, setHTML, empty, chart, $ } = App;
  const today = new Date();
  const days = ['일', '월', '화', '수', '목', '금', '토'];

  setHTML(root, html`
    <div class="page-head">
      <div><h1>안녕하세요, ${ME.name}님</h1><p>${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일 (${days[today.getDay()]}) · ${App.L.role[ME.role]}</p></div>
      <div class="actions">
        ${can('task.create') ? html`<a class="btn primary" href="/tasks?new=1">${icon('plus')}업무 등록</a>` : ''}
        <a class="btn" href="/tasks?mine=1">${icon('tasks')}내 업무</a>
      </div>
    </div>
    <div class="grid g-4" id="kpi-me">${App.loading(2)}</div>
    <div id="kpi-org"></div>
    <div class="grid g-main mt">
      <div class="stack">
        <div class="card"><div class="card-h"><h3>처리할 일</h3></div><div class="card-b flush" id="inbox">${App.loading(2)}</div></div>
        <div class="card"><div class="card-h"><h3>다가오는 내 일정 <span class="sub">7일 이내</span></h3><a href="/calendar" class="btn sm ghost">캘린더 ${icon('right')}</a></div><div class="card-b flush" id="upcoming">${App.loading()}</div></div>
        <div id="charts"></div>
      </div>
      <div class="stack">
        <div class="card"><div class="card-h"><h3>최근 알림</h3><a href="/notifications" class="btn sm ghost">전체 ${icon('right')}</a></div><div class="card-b flush" id="notis">${App.loading()}</div></div>
        <div class="card"><div class="card-h"><h3>예정된 회의</h3><a href="/meetings" class="btn sm ghost">전체 ${icon('right')}</a></div><div class="card-b flush" id="meetings">${App.loading(2)}</div></div>
        <div class="card"><div class="card-h"><h3>사용 중인 자원</h3><a href="/allocations" class="btn sm ghost">전체 ${icon('right')}</a></div><div class="card-b flush" id="allocs">${App.loading(2)}</div></div>
      </div>
    </div>`);

  const kpi = (label, value, hint, tone = '', ic = 'activity') => html`<div class="card kpi ${tone}"><div class="label">${icon(ic)}${label}</div><div class="value">${value}</div>${hint ? html`<div class="hint">${hint}</div>` : ''}</div>`;

  const [me, dash, inbox, notis] = await Promise.all([
    api.get('/api/me'), api.get('/api/me/dashboard'), api.get('/api/me/inbox'), api.get('/api/me/notifications', { size: 6 }),
  ]);
  const a = me.data.activity;
  setHTML($('#kpi-me', root), html`
    ${kpi('진행 예정 · 진행중 업무', a.openAssignments, '나에게 배정된 업무', '', 'tasks')}
    ${kpi('완료한 업무', a.completedTasks, '누적', 'ok', 'checkCircle')}
    ${kpi('사용 · 예약 중 자원', a.activeAllocations, '반납 전 자원 포함', '', 'key')}
    ${kpi('평판 점수', a.reputation >= 0 ? `+${a.reputation}` : a.reputation, '가감점 누계', a.reputation < 0 ? 'bad' : '', 'star')}`);

  const items = inbox.data.items.filter((i) => i.type !== 'NOTIFICATION');
  setHTML($('#inbox', root), items.length
    ? html`<ul class="list">${items.map((i) => html`<li><span class="badge warn plain">${i.count}</span><div class="grow"><div class="title">${i.label}</div></div><a class="btn sm" href="${i.link}">처리하기</a></li>`)}</ul>`
    : empty('처리할 일이 없습니다', '새로운 배정·요청이 생기면 여기에 표시됩니다.', 'checkCircle'));

  setHTML($('#upcoming', root), dash.data.upcoming.length
    ? html`<ul class="list">${dash.data.upcoming.map((t) => html`<li>
        <div style="text-align:center;min-width:48px"><div style="font-size:11px;color:var(--muted)">${new Date(t.startAt).getMonth() + 1}월</div><div style="font-size:20px;font-weight:700;line-height:1">${new Date(t.startAt).getDate()}</div></div>
        <div class="grow"><a class="title" href="/tasks/${t.taskId}" style="color:inherit">${t.title}</a><div class="desc">${fmt.range(t.startAt, t.endAt)}</div></div>
        ${badge('task', t.status)} ${t.assignmentStatus === 'ASSIGNED' ? badge('assign', 'ASSIGNED') : ''}</li>`)}</ul>`
    : empty('7일 이내 일정이 없습니다', '', 'calendar'));

  setHTML($('#notis', root), notis.data.length
    ? html`<ul class="list">${notis.data.map((n) => html`<li class="${n.read ? '' : 'unread'}"><div class="grow"><div class="title">${n.title}</div><div class="desc">${n.message}</div></div><span class="desc" style="white-space:nowrap">${fmt.rel(n.createdAt)}</span>${App.uiLink(n.link) ? html`<a class="btn sm ghost" href="${App.uiLink(n.link)}">${icon('right')}</a>` : ''}</li>`)}</ul>`
    : empty('알림이 없습니다', '', 'bell'));

  setHTML($('#meetings', root), dash.data.meetings.length
    ? html`<ul class="list">${dash.data.meetings.map((m) => html`<li><div class="grow"><div class="title">${m.title}</div><div class="desc">${fmt.full(m.startAt)}</div></div>${badge('rsvp', m.rsvp)}</li>`)}</ul>`
    : empty('예정된 회의가 없습니다', '', 'meeting'));

  setHTML($('#allocs', root), dash.data.allocations.length
    ? html`<ul class="list">${dash.data.allocations.map((x) => html`<li><div class="grow"><div class="title">${x.code} ${x.name}</div><div class="desc">${fmt.range(x.startAt, x.endAt)}</div></div>${badge('alloc', x.status)}</li>`)}</ul>`
    : empty('사용 중인 자원이 없습니다', '', 'key'));

  if (!can('stats.read')) return;
  const [ov, trend, crews] = await Promise.all([api.get('/api/stats/overview'), api.get('/api/stats/tasks/trend', { interval: 'week' }), api.get('/api/stats/crews')]);
  const o = ov.data;
  const pend = o.pendingRequests.resource + o.pendingRequests.promotion + o.pendingRequests.join;
  setHTML($('#kpi-org', root), html`
    <h3 style="margin:26px 0 12px;font-size:15px">조직 운영 현황 <span style="color:var(--muted);font-weight:400;font-size:13px">${o.scope === 'ALL' ? '전체' : '관리 Crew 기준'}</span></h3>
    <div class="grid g-4">
      ${kpi('활동중 구성원', `${o.members.active} / ${o.members.total}`, `정지 ${o.members.suspended} · 가입대기 ${o.members.pending}`, '', 'users')}
      ${kpi('진행 예정 · 진행중 업무', o.tasks.open, `진행중 ${o.tasks.inProgress} · 최근 30일 완료 ${o.tasks.completedLast30Days}`, '', 'tasks')}
      ${kpi('기한 경과 업무', o.tasks.overdue, '종료 시각이 지났지만 미완료', o.tasks.overdue ? 'bad' : 'ok', 'alert')}
      ${kpi('점검 필요 · 사용 불가 자원', o.resources.blocked, `미해결 이슈 ${o.openIssues} · 대기 요청 ${pend}`, o.resources.blocked ? 'warn' : 'ok', 'wrench')}
    </div>`);
  setHTML($('#charts', root), html`<div class="grid g-2">
      <div class="card"><div class="card-h"><h3>업무 추이 <span class="sub">주별</span></h3></div><div class="card-b"><div class="chart-box"><canvas id="c-trend"></canvas></div></div></div>
      <div class="card"><div class="card-h"><h3>Crew 별 업무 완료율</h3></div><div class="card-b"><div class="chart-box"><canvas id="c-crews"></canvas></div></div></div>
    </div>`);
  const t = trend.data.slice(-12);
  chart($('#c-trend', root), 'line', { labels: t.map((x) => x.bucket.replace(/^\d{4}-/, '')), datasets: [{ label: '생성', data: t.map((x) => x.created) }, { label: '완료', data: t.map((x) => x.completed) }] });
  chart($('#c-crews', root), 'bar', { labels: crews.data.map((c) => c.crewName), datasets: [{ label: '완료율(%)', data: crews.data.map((c) => c.completionRate || 0) }, { label: '성공률(%)', data: crews.data.map((c) => c.successRate || 0) }] }, { scales: { y: { beginAtZero: true, max: 100 } } });
});
