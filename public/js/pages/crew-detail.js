App.page(async (root, params) => {
  const { html, icon, api, fmt, badge, can, ME, setHTML, $, on, L, formModal, toast, run, empty, tabs, person, options, chart } = App;
  const id = params.id;
  const base = `/api/crews/${id}`;
  const managed = await api.get('/api/crews/managed').then((r) => r.data.map((c) => c.id)).catch(() => []);
  const manage = managed.includes(id);

  async function load() {
    const c = (await api.get(base)).data;
    const acts = [];
    if (c.status === 'ACTIVE') {
      if (manage && can('crew.members')) acts.push(html`<button class="btn primary" data-act="add">${icon('plus')}구성원 편성</button>`);
      if (manage && can('crew.appoint')) acts.push(html`<button class="btn" data-act="capo">${icon('shield')}책임자 지정</button>`);
      if (can('crew.create')) acts.push(html`<button class="btn" data-act="underboss">${icon('user')}감독 지정</button>`);
      if (manage && can('crew.update')) acts.push(html`<button class="btn" data-act="edit">${icon('edit')}수정</button>`);
      if (can('crew.create')) acts.push(html`<button class="btn danger" data-act="dissolve">${icon('ban')}해산</button>`);
    } else if (can('crew.create')) acts.push(html`<button class="btn" data-act="restore">${icon('refresh')}복구</button>`);
    const isMember = ME.crewId === id;

    setHTML(root, html`
      <a href="/crews" class="btn ghost sm" style="margin-bottom:12px">${icon('back')}Crew 목록</a>
      <div class="card"><div class="card-b"><div class="hero">
        <div class="brand-mark" style="width:56px;height:56px;font-size:22px">${c.name.slice(0, 1)}</div>
        <div style="flex:1;min-width:0"><h1>${c.name}</h1>
          <div class="meta">${badge('crew', c.status)} ${icon('pin')}${c.regionName || '지역 미지정'} <span>·</span> 책임자 ${c.capoId ? html`<a href="/members/${c.capoId}">${c.capoName}</a>` : html`<span class="badge warn">공석</span>`}
            <span>·</span> 감독 ${c.underbossName || '-'} <span>·</span> 정식 ${c.memberCount}명 · 준소속 ${c.affiliateCount}명 · 진행 업무 ${c.openTasks}건</div>
          ${c.description ? html`<p style="margin:8px 0 0;color:var(--ink-2)">${c.description}</p>` : ''}
        </div>
        <div class="row" style="justify-content:flex-end">${acts}${!manage && !isMember && c.status === 'ACTIVE' ? html`<button class="btn" data-act="join">${icon('send')}가입 요청</button>` : ''}</div>
      </div></div></div>
      <div class="mt" id="tabs"></div>`);

    tabs($('#tabs', root), [
      { key: 'members', label: '구성원', count: c.memberCount + c.affiliateCount, render: (p) => members(p, c) },
      { key: 'announcements', label: '공지', render: (p) => announcements(p) },
      { key: 'tasks', label: '업무', render: (p) => tasks(p) },
      { key: 'requests', label: '가입 요청', show: manage && can('crew.members'), render: (p) => requests(p) },
      { key: 'stats', label: '운영 현황', show: manage, render: (p) => stats(p) },
      { key: 'history', label: '편성 이력', show: manage, render: (p) => history(p) },
    ]);
    root._c = c;
  }

  async function members(p, c) {
    const r = await api.get(`${base}/members`);
    setHTML(p, html`<div class="card"><div class="card-b flush"><div class="table-wrap"><table class="tbl"><thead><tr><th>구성원</th><th>역할</th><th>상태</th><th>구분</th><th>합류일</th><th></th></tr></thead><tbody>
      ${r.data.map((m) => html`<tr><td>${person(m.name, m.alias, `/members/${m.memberId}`)}</td><td><span class="badge brand plain">${L.role[m.role]}</span>${m.isCapo ? html` <span class="badge warn plain">책임자</span>` : ''}</td>
        <td>${badge('member', m.status)}</td><td>${L.membership[m.membershipType]}</td><td>${fmt.date(m.joinedAt)}</td>
        <td style="text-align:right;white-space:nowrap">${manage && can('crew.members') && c.status === 'ACTIVE' && m.memberId !== ME.id ? html`
          ${m.membershipType === 'FORMAL' ? html`<button class="btn sm ghost" data-transfer="${m.memberId}" data-name="${m.name}" title="다른 Crew 로 이동">${icon('swap')}</button>` : ''}
          <button class="btn sm ghost" data-remove="${m.memberId}" data-name="${m.name}" title="제외">${icon('x')}</button>` : ''}</td></tr>`)}
      </tbody></table></div></div></div>`);
  }

  async function announcements(p) {
    const r = await api.get(`${base}/announcements`, { size: 30 });
    const canPost = manage && can('crew.announce');
    setHTML(p, html`<div class="card"><div class="card-h"><h3>Crew 공지</h3>${canPost ? html`<button class="btn sm primary" data-post>${icon('plus')}공지 작성</button>` : ''}</div>
      <div class="card-b flush">${r.data.length ? html`<ul class="list">${r.data.map((a) => html`<li style="align-items:flex-start"><div class="grow">
        <div class="title">${a.pinned ? html`<span class="badge warn plain">고정</span> ` : ''}${a.title}</div><p style="margin:4px 0;white-space:pre-wrap">${a.body}</p><div class="desc">${a.author.username} · ${fmt.full(a.createdAt)}</div></div>
        ${canPost ? html`<button class="btn sm ghost" data-pin="${a.id}" data-v="${a.pinned ? '0' : '1'}" title="고정 전환">${icon('pin')}</button><button class="btn sm ghost" data-del-ann="${a.id}" title="삭제">${icon('trash')}</button>` : ''}</li>`)}</ul>` : empty('공지가 없습니다', '', 'bell')}</div></div>`);
  }

  async function tasks(p) {
    const r = await api.get('/api/tasks', { crewId: id, status: 'PLANNED,IN_PROGRESS,ON_HOLD', sort: 'startAt', size: 30 });
    setHTML(p, html`<div class="card"><div class="card-h"><h3>진행 예정 · 진행중 업무</h3><a class="btn sm ghost" href="/tasks?crewId=${id}">전체 보기 ${icon('right')}</a></div><div class="card-b flush">${r.data.length ? html`<ul class="list">${r.data.map((t) => html`<li>
      <div class="grow"><a class="title" href="/tasks/${t.id}" style="color:inherit">${t.title}</a><div class="desc">${fmt.range(t.startAt, t.endAt)} · ${t.assigneeCount}명</div></div>${App.prio(t.priority)} ${badge('task', t.status)}</li>`)}</ul>` : empty('조회 가능한 진행 업무가 없습니다', '', 'tasks')}</div></div>`);
  }

  async function requests(p) {
    const r = await api.get('/api/join-requests', { crewId: id, status: 'PENDING', size: 50 });
    setHTML(p, html`<div class="card"><div class="card-b flush">${r.data.length ? html`<ul class="list">${r.data.map((j) => html`<li>${person(j.memberName, (L.member[j.memberStatus] || [])[0])}
      <div class="grow"><div class="desc">${L.membership[j.membershipType]} 가입 · ${j.message || ''} · ${fmt.rel(j.createdAt)}</div></div>
      <button class="btn sm primary" data-jr="approve" data-id="${j.id}">승인</button><button class="btn sm danger" data-jr="reject" data-id="${j.id}">반려</button></li>`)}</ul>` : empty('대기 중인 가입 요청이 없습니다', '', 'inbox')}</div></div>`);
  }

  async function stats(p) {
    const s = (await api.get(`${base}/stats`)).data;
    setHTML(p, html`<div class="grid g-4">
        <div class="card kpi"><div class="label">업무 완료율</div><div class="value">${fmt.pct(s.completionRate)}</div><div class="hint">완료 / (완료+취소)</div></div>
        <div class="card kpi ok"><div class="label">성공률</div><div class="value">${fmt.pct(s.successRate)}</div></div>
        <div class="card kpi"><div class="label">평균 기여도</div><div class="value">${s.avgContribution === null ? '-' : s.avgContribution}</div></div>
        <div class="card kpi"><div class="label">보유 자원</div><div class="value">${s.resources}</div></div>
      </div>
      <div class="grid g-2 mt">
        <div class="card"><div class="card-h"><h3>업무 상태</h3></div><div class="card-b"><div class="chart-box"><canvas id="c1"></canvas></div></div></div>
        <div class="card"><div class="card-h"><h3>구성원 상태</h3></div><div class="card-b"><div class="chart-box"><canvas id="c2"></canvas></div></div></div>
      </div>`);
    const t = Object.entries(s.tasksByStatus);
    chart($('#c1', p), 'doughnut', { labels: t.map(([k]) => L.task[k][0]), datasets: [{ data: t.map(([, v]) => v) }] });
    const m = Object.entries(s.membersByStatus);
    chart($('#c2', p), 'doughnut', { labels: m.map(([k]) => L.member[k][0]), datasets: [{ data: m.map(([, v]) => v) }] });
  }

  async function history(p) {
    const r = await api.get(`${base}/membership-history`, { size: 100 });
    setHTML(p, html`<div class="card"><div class="card-b flush"><div class="table-wrap"><table class="tbl"><thead><tr><th>구성원</th><th>구분</th><th>합류</th><th>종료</th><th>사유</th><th>처리자</th></tr></thead><tbody>
      ${r.data.map((h) => html`<tr><td><a href="/members/${h.memberId}">${h.memberName}</a></td><td>${L.membership[h.membershipType]}</td><td>${fmt.full(h.joinedAt)}</td><td>${h.leftAt ? fmt.full(h.leftAt) : html`<span class="badge ok">소속중</span>`}</td><td>${h.leftReason || '-'}</td><td>${h.changedBy || '-'}</td></tr>`)}
      </tbody></table></div></div></div>`);
  }

  const reload = () => load().catch(toast.error);

  on(root, 'click', '[data-remove]', async (e, b) => {
    const r = await formModal({ title: `${b.dataset.name} 제외`, danger: true, fields: [{ name: 'reason', label: '사유', full: true }], submitLabel: '제외', onSubmit: (v) => api.del(`${base}/members/${b.dataset.remove}`, v) });
    if (r) { toast.ok('제외했습니다.'); reload(); }
  });
  on(root, 'click', '[data-transfer]', async (e, b) => {
    const targets = (await options.crews(true)).filter((c) => c.value !== id);
    if (!targets.length) return toast('이동할 수 있는 다른 관리 Crew 가 없습니다. (BR-05)', 'bad');
    const r = await formModal({ title: `${b.dataset.name} 이동`, subtitle: '출발·도착 Crew 모두 관리 범위여야 하며, 정식 소속은 하나만 유지됩니다 (BR-01, BR-05).',
      fields: [{ name: 'targetCrewId', label: '도착 Crew', type: 'select', required: true, full: true, options: targets, numeric: true }, { name: 'reason', label: '사유', full: true }],
      submitLabel: '이동', onSubmit: (v) => api.post(`${base}/members/${b.dataset.transfer}/transfer`, v) });
    if (r) { toast.ok('이동했습니다.'); reload(); }
  });
  on(root, 'click', '[data-post]', async () => {
    const r = await formModal({ title: '공지 작성', subtitle: 'Crew 구성원 전원에게 알림이 전송됩니다.', size: 'lg',
      fields: [{ name: 'title', label: '제목', required: true, full: true }, { name: 'body', label: '내용', type: 'textarea', required: true, full: true, rows: 6 }, { name: 'pinned', label: '상단 고정', type: 'checkbox', full: true }],
      submitLabel: '등록', onSubmit: (v) => api.post(`${base}/announcements`, v) });
    if (r) { toast.ok('공지를 등록했습니다.'); reload(); }
  });
  on(root, 'click', '[data-pin]', (e, b) => run(() => api.patch(`${base}/announcements/${b.dataset.pin}`, { pinned: b.dataset.v === '1' }), { then: reload }));
  on(root, 'click', '[data-del-ann]', (e, b) => run(() => api.del(`${base}/announcements/${b.dataset.delAnn}`), { confirm: { title: '공지 삭제', message: '삭제하시겠습니까?', danger: true }, success: '삭제했습니다.', then: reload }));
  on(root, 'click', '[data-jr]', async (e, b) => {
    const approve = b.dataset.jr === 'approve';
    const r = await formModal({ title: approve ? '가입 승인' : '가입 반려', subtitle: approve ? '승인 시 Crew 에 편성되며, 가입대기 계정은 활동중으로 전환됩니다.' : '', danger: !approve,
      fields: [{ name: 'comment', label: approve ? '코멘트' : '반려 사유', required: !approve, full: true }],
      submitLabel: approve ? '승인' : '반려', onSubmit: (v) => api.post(`/api/join-requests/${b.dataset.id}/${b.dataset.jr}`, v) });
    if (r) { toast.ok('처리했습니다.'); App.refreshInbox(); reload(); }
  });

  on(root, 'click', 'button[data-act]', async (e, b) => {
    const c = root._c;
    let r;
    switch (b.dataset.act) {
      case 'add':
        r = await formModal({ title: '구성원 편성', subtitle: '다른 Crew 에 정식 소속된 구성원은 정식 편성할 수 없습니다 (BR-01). 준소속은 가능합니다.',
          fields: [{ name: 'memberId', label: '구성원', type: 'select', required: true, full: true, numeric: true, options: () => options.members({ status: 'ACTIVE,STANDBY,PENDING' }) },
            { name: 'membershipType', label: '구분', type: 'select', required: true, value: 'FORMAL', options: [{ value: 'FORMAL', label: '정식 소속' }, { value: 'AFFILIATE', label: '준소속' }] }, { name: 'reason', label: '사유' }],
          submitLabel: '편성', onSubmit: (v) => api.post(`${base}/members`, v) });
        break;
      case 'capo': {
        const capos = await api.get('/api/members', { role: 'CAPO', status: 'ACTIVE', size: 100 });
        r = await formModal({ title: '책임자 지정', subtitle: '다른 Crew 정식 소속이면 이 Crew 로 함께 이동됩니다.',
          fields: [{ name: 'memberId', label: 'Capo', type: 'select', required: true, full: true, numeric: true, options: capos.data.map((m) => ({ value: m.id, label: `${m.name}${m.crewName ? ` · ${m.crewName}` : ''}` })) }],
          submitLabel: '지정', onSubmit: (v) => api.put(`${base}/capo`, v) });
        break;
      }
      case 'underboss': {
        const ub = await api.get('/api/members', { role: 'UNDERBOSS', status: 'ACTIVE', size: 100 });
        r = await formModal({ title: '감독 Underboss 지정', values: { memberId: c.underbossId },
          fields: [{ name: 'memberId', label: 'Underboss', type: 'select', full: true, numeric: true, emptyAsNull: true, placeholder: '감독자 없음', options: ub.data.map((m) => ({ value: m.id, label: m.name })) }],
          onSubmit: (v) => api.put(`${base}/underboss`, { memberId: v.memberId === undefined ? null : v.memberId }) });
        break;
      }
      case 'edit':
        r = await formModal({ title: 'Crew 정보 수정', values: c,
          fields: [{ name: 'name', label: '이름', required: true, full: true }, { name: 'regionId', label: '지역', type: 'select', numeric: true, emptyAsNull: true, options: () => options.regions() }, { name: 'description', label: '설명', type: 'textarea', full: true, emptyAsNull: true }],
          onSubmit: (v) => api.patch(base, v) });
        break;
      case 'dissolve':
        r = await formModal({ title: 'Crew 해산', subtitle: '정식 구성원과 진행 중 업무가 없어야 해산할 수 있습니다.', danger: true, fields: [{ name: 'reason', label: '사유', full: true }], submitLabel: '해산', onSubmit: (v) => api.del(base, v) });
        break;
      case 'restore': r = await run(() => api.post(`${base}/restore`), { confirm: { title: 'Crew 복구', message: '해산된 Crew 를 다시 운영 상태로 복구합니다.' } }); break;
      case 'join':
        r = await formModal({ title: `${c.name} 가입 요청`, subtitle: '책임자가 승인하면 편성됩니다.',
          fields: [{ name: 'membershipType', label: '구분', type: 'select', required: true, value: ME.crewId ? 'AFFILIATE' : 'FORMAL', options: [{ value: 'FORMAL', label: '정식 소속' }, { value: 'AFFILIATE', label: '준소속' }] }, { name: 'message', label: '메시지', type: 'textarea', full: true }],
          submitLabel: '요청', onSubmit: (v) => api.post(`${base}/join-requests`, v) });
        break;
      default:
    }
    if (r) { toast.ok('처리했습니다.'); reload(); }
  });

  await load();
});
