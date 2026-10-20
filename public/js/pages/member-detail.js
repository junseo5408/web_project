App.page(async (root, params) => {
  const { html, icon, api, fmt, badge, prio, can, ME, setHTML, $, on, L, opts, formModal, toast, run, empty, tabs, avatar, options } = App;
  const id = params.id;
  const base = `/api/members/${id}`;
  const isSelf = id === ME.id;

  async function load() {
    const [m, tr] = await Promise.all([api.get(base), api.get(`${base}/status-transitions`)]);
    render(m.data, tr.data);
  }

  function render(m, tr) {
    const higher = ME.role === 'ADMINISTRATOR' || m.level < ME.level;
    const acts = [];
    if (!isSelf && higher) {
      if (can('member.update')) acts.push(html`<button class="btn" data-act="edit">${icon('edit')}정보 수정</button>`);
      if (can('member.role')) acts.push(html`<button class="btn" data-act="role">${icon('shield')}역할 변경</button>`);
      if (tr.canChange && tr.allowed.length) acts.push(html`<button class="btn" data-act="status">${icon('flag')}상태 변경</button>`);
      if (can('promotion.request')) acts.push(html`<button class="btn" data-act="promote">${icon('send')}승급 요청</button>`);
      if (can('member.discipline')) acts.push(html`<button class="btn danger" data-act="discipline">${icon('alert')}징계</button>`);
      if (can('reputation.adjust')) acts.push(html`<button class="btn" data-act="reputation">${icon('star')}평판 가감</button>`);
    }
    if (isSelf) acts.push(html`<a class="btn" href="/me">${icon('user')}내 정보 관리</a>`);

    setHTML(root, html`
      <a href="/members" class="btn ghost sm" style="margin-bottom:12px">${icon('back')}구성원 목록</a>
      <div class="card"><div class="card-b"><div class="hero">
        ${avatar(m.name, 'lg')}
        <div style="flex:1;min-width:0">
          <h1>${m.name} ${m.alias ? html`<span style="font-weight:400;color:var(--muted);font-size:16px">“${m.alias}”</span>` : ''}</h1>
          <div class="meta"><span class="badge brand plain">${L.role[m.role]}</span>${badge('member', m.status)}${m.isLocked ? html`<span class="badge bad">계정 잠김</span>` : ''}
            <span>·</span>${m.crewName ? html`<a href="/crews/${m.crewId}">${m.crewName}</a>` : '무소속'}<span>·</span><span>@${m.username}</span></div>
        </div>
        <div class="row" style="justify-content:flex-end">${acts}</div>
      </div></div></div>
      <div class="mt" id="tabs"></div>`);

    tabs($('#tabs', root), [
      { key: 'overview', label: '개요', render: (p) => overview(p, m) },
      { key: 'assignments', label: '업무 이력', show: isSelf || can('member.read') || can('task.assign'), render: (p) => assignments(p) },
      { key: 'schedule', label: '일정', render: (p) => schedule(p) },
      { key: 'reputation', label: '평가 · 평판', show: isSelf || can('evaluation.read'), render: (p) => reputation(p) },
      { key: 'history', label: '변경 이력', show: isSelf || can('member.read'), render: (p) => history(p) },
      { key: 'crews', label: '소속 이력', render: (p) => crewHistory(p) },
      { key: 'discipline', label: '징계', show: can('member.read'), render: (p) => discipline(p) },
    ]);
    root._m = m; root._tr = tr;
  }

  function overview(p, m) {
    const editSkills = isSelf || can('member.update') || can('crew.members');
    setHTML(p, html`<div class="grid g-2">
      <div class="card"><div class="card-h"><h3>기본 정보</h3></div><div class="card-b">${m.limited ? html`<div class="notice info" style="margin-bottom:12px">${icon('lock')}<div>관리 범위 밖 구성원이라 연락처 등 일부 정보가 비공개입니다.</div></div>` : ''}
        <dl class="dl">
          <dt>이메일</dt><dd>${m.email || '-'}</dd><dt>연락처</dt><dd>${m.phone || '-'}</dd><dt>생년월일</dt><dd>${m.birthDate ? fmt.date(m.birthDate) : '-'}</dd>
          <dt>가입일</dt><dd>${fmt.date(m.joinedAt)}</dd><dt>최근 로그인</dt><dd>${m.lastLoginAt ? fmt.rel(m.lastLoginAt) : '-'}</dd><dt>메모</dt><dd style="white-space:pre-wrap">${m.notes || '-'}</dd>
        </dl></div></div>
      <div class="stack">
        <div class="card"><div class="card-h"><h3>소속 Crew</h3></div><div class="card-b flush">${m.crews.length ? html`<ul class="list">${m.crews.map((c) => html`<li><div class="grow"><a class="title" href="/crews/${c.crewId}">${c.crewName}</a><div class="desc">${fmt.date(c.joinedAt)} 부터</div></div><span class="badge ${c.membershipType === 'FORMAL' ? 'brand' : ''} plain">${L.membership[c.membershipType]}</span></li>`)}</ul>` : empty('소속된 Crew 가 없습니다', '', 'crew')}</div></div>
        <div class="card"><div class="card-h"><h3>보유 기술</h3>${editSkills ? html`<button class="btn sm" data-act="skill">${icon('plus')}추가</button>` : ''}</div>
          <div class="card-b">${m.skills.length ? m.skills.map((s) => html`<span class="tag" style="padding:4px 8px">${s.skill} <b>Lv.${s.level}</b>${editSkills ? html` <a href="#" data-del-skill="${s.skill}" title="삭제">×</a>` : ''}</span>`) : html`<span style="color:var(--muted)">등록된 기술이 없습니다.</span>`}</div></div>
      </div></div>`);
  }

  async function assignments(p) {
    const r = await api.get(`${base}/assignments`, { size: 50 });
    setHTML(p, html`<div class="card"><div class="card-b flush">${r.data.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>업무</th><th>업무 상태</th><th>역할</th><th>배정</th><th>출석</th><th class="num">기여도</th><th>결과</th></tr></thead><tbody>
      ${r.data.map((a) => html`<tr class="link" data-href="/tasks/${a.taskId}"><td><a href="/tasks/${a.taskId}"><b>${a.title}</b></a><span class="sub">${fmt.range(a.startAt, a.endAt)}</span></td><td>${badge('task', a.taskStatus)}</td><td>${a.taskRole || '-'}</td><td>${badge('assign', a.status)}</td>
        <td>${L.attendance[a.attendance] || '-'}</td><td class="num">${a.contribution === null ? '-' : a.contribution}</td><td>${a.resultOutcome ? badge('outcome', a.resultOutcome) : '-'}</td></tr>`)}
      </tbody></table></div><div class="pager"><span>총 ${r.meta.total}건 (최근 50건)</span></div>` : empty('업무 이력이 없습니다', '', 'tasks')}</div></div>`);
  }

  async function schedule(p) {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const r = await api.get(`${base}/schedule`, { from, to: new Date(from.getTime() + 30 * 86400000) });
    const kind = { TASK: ['업무', 'brand'], RESOURCE: ['자원', 'info'], MEETING: ['회의', 'warn'] };
    setHTML(p, html`<div class="card"><div class="card-h"><h3>앞으로 30일 일정</h3></div><div class="card-b flush">${r.data.length ? html`<ul class="list">${r.data.map((x) => html`<li>
      <span class="badge ${kind[x.kind][1]}">${kind[x.kind][0]}</span><div class="grow"><div class="title">${x.kind === 'TASK' ? html`<a href="/tasks/${x.refId}" style="color:inherit">${x.title}</a>` : x.title}</div><div class="desc">${fmt.range(x.startAt, x.endAt)}</div></div>
      ${x.exclusive === false ? html`<span class="badge plain">동시 수행 가능</span>` : ''}</li>`)}</ul>` : empty('예정된 일정이 없습니다', '', 'calendar')}</div></div>`);
  }

  async function reputation(p) {
    const [rep, ev] = await Promise.all([api.get(`${base}/reputation`), api.get('/api/evaluations', { memberId: id, size: 50 })]);
    const r = rep.data;
    setHTML(p, html`<div class="grid g-4">
        <div class="card kpi"><div class="label">평판 점수</div><div class="value">${r.score}</div><div class="hint">평가 평균×20 + 가감점</div></div>
        <div class="card kpi"><div class="label">평가 평균</div><div class="value">${r.evaluationAverage === null ? '-' : r.evaluationAverage}</div><div class="hint">${r.evaluationCount}건 · 5점 만점</div></div>
        <div class="card kpi ${r.ledgerPoints < 0 ? 'bad' : ''}"><div class="label">가감점</div><div class="value">${r.ledgerPoints > 0 ? '+' : ''}${r.ledgerPoints}</div></div>
        <div class="card kpi"><div class="label">출석률</div><div class="value">${fmt.pct(r.attendanceRate)}</div><div class="hint">완료 업무 ${r.completedTasks}건</div></div>
      </div>
      <div class="grid g-2 mt">
        <div class="card"><div class="card-h"><h3>평가 기록</h3></div><div class="card-b flush">${ev.data.length ? html`<ul class="list">${ev.data.map((e) => html`<li><div class="grow">
          <div class="title">${e.taskId ? html`<a href="/tasks/${e.taskId}">업무 #${e.taskId}</a>` : '일반 평가'} · 종합 <b>${e.overall}</b></div>
          <div class="desc">${Object.entries(e.scores).map(([k, v]) => `${k} ${v}`).join(' · ')}${e.comment ? ` — ${e.comment}` : ''}</div></div>
          <span class="desc">${e.evaluator.username || L.role[e.evaluator.role]} · ${fmt.date(e.createdAt)}</span>${e.status === 'VOIDED' ? html`<span class="badge">무효</span>` : ''}</li>`)}</ul>` : empty('평가 기록이 없습니다', '', 'star')}</div></div>
        <div class="card"><div class="card-h"><h3>최근 가감점</h3></div><div class="card-b flush">${r.recentAdjustments.length ? html`<ul class="list">${r.recentAdjustments.map((x) => html`<li>
          <span class="badge ${x.points > 0 ? 'ok' : 'bad'} plain">${x.points > 0 ? '+' : ''}${x.points}</span><div class="grow"><div class="title">${x.reason}</div><div class="desc">${x.by.username} · ${fmt.date(x.at)}</div></div></li>`)}</ul>` : empty('가감점 기록이 없습니다', '', 'star')}</div></div>
      </div>`);
  }

  async function history(p) {
    const r = await api.get(`${base}/history`, { size: 100 });
    const val = (type, v) => (v === null || v === undefined ? '없음' : type === 'STATUS' ? (L.member[v] || [v])[0] : type === 'ROLE' ? L.role[v] || v : v);
    const tone = { ROLE: 'brand', STATUS: 'warn', CREW: 'info', EVALUATION: 'ok', REPUTATION: 'ok', DISCIPLINE: 'bad' };
    setHTML(p, html`<div class="card"><div class="card-h"><h3>역할 · 소속 · 상태 · 평가 변경 이력</h3><span class="sub">BR-10</span></div><div class="card-b">${r.data.length ? html`<ul class="timeline">${r.data.map((h) => html`<li><span class="dot ${tone[h.type] || ''}"></span>
      <div class="t">${L.history[h.type] || h.type}: ${val(h.type, h.from)} → ${val(h.type, h.to)}</div>
      <div class="s">${h.by.username} (${L.role[h.by.role] || h.by.role}) · ${fmt.full(h.at)}${h.reason ? ` · ${h.reason}` : ''}</div></li>`)}</ul>` : empty('변경 이력이 없습니다', '', 'audit')}</div></div>`);
  }

  async function crewHistory(p) {
    const r = await api.get(`${base}/crew-history`);
    setHTML(p, html`<div class="card"><div class="card-b flush">${r.data.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>Crew</th><th>구분</th><th>합류</th><th>종료</th><th>사유</th><th>처리자</th></tr></thead><tbody>
      ${r.data.map((c) => html`<tr><td><a href="/crews/${c.crewId}">${c.crewName}</a></td><td>${L.membership[c.membershipType]}</td><td>${fmt.date(c.joinedAt)}</td><td>${c.leftAt ? fmt.date(c.leftAt) : html`<span class="badge ok">현재 소속</span>`}</td><td>${c.leftReason || '-'}</td><td>${c.changedBy || '-'}</td></tr>`)}
      </tbody></table></div>` : empty('소속 이력이 없습니다', '', 'crew')}</div></div>`);
  }

  async function discipline(p) {
    const r = await api.get('/api/disciplinary-actions', { memberId: id, size: 50 });
    setHTML(p, html`<div class="card"><div class="card-b flush">${r.data.length ? html`<ul class="list">${r.data.map((d) => html`<li>${badge('discipline', d.actionType)}
      <div class="grow"><div class="title">${d.reason}</div><div class="desc">${d.issuedByName} · ${fmt.full(d.createdAt)}${d.status === 'REVOKED' ? ` · 해제: ${d.revokeReason}` : ''}</div></div>
      ${d.status === 'ACTIVE' ? html`<span class="badge bad">유효</span>${can('member.discipline') ? html`<button class="btn sm" data-revoke="${d.id}">해제</button>` : ''}` : html`<span class="badge">해제됨</span>`}</li>`)}</ul>` : empty('징계 기록이 없습니다', '', 'shield')}</div></div>`);
  }

  const reload = () => load().catch(toast.error);

  on(root, 'click', '[data-del-skill]', (e, a) => { e.preventDefault(); run(() => api.del(`${base}/skills/${a.dataset.delSkill}`), { then: reload }); });
  on(root, 'click', '[data-revoke]', async (e, b) => {
    const r = await formModal({ title: '징계 해제', subtitle: '정지 징계를 해제하면 다른 정지 징계가 없을 때 활동중으로 복구됩니다.', fields: [{ name: 'reason', label: '해제 사유', type: 'textarea', required: true, full: true }], submitLabel: '해제', onSubmit: (v) => api.post(`/api/disciplinary-actions/${b.dataset.revoke}/revoke`, v) });
    if (r) { toast.ok('징계를 해제했습니다.'); reload(); }
  });
  on(root, 'click', 'tr.link', (e, tr) => { if (!e.target.closest('a')) location.href = tr.dataset.href; });

  on(root, 'click', 'button[data-act]', async (e, b) => {
    const m = root._m;
    const act = b.dataset.act;
    let r;
    if (act === 'edit') {
      r = await formModal({ title: '구성원 정보 수정', size: 'lg', values: m,
        fields: [{ name: 'name', label: '이름', required: true }, { name: 'alias', label: '별칭', emptyAsNull: true }, { name: 'email', label: '이메일', type: 'email', emptyAsNull: true },
          { name: 'phone', label: '연락처', emptyAsNull: true }, { name: 'birthDate', label: '생년월일', type: 'date', emptyAsNull: true }, { name: 'notes', label: '메모', type: 'textarea', full: true, emptyAsNull: true }],
        onSubmit: (v) => api.patch(base, v) });
    }
    if (act === 'role') {
      const max = ME.role === 'ADMINISTRATOR' ? 6 : ME.role === 'CAPO' ? 2 : ME.level - 1;
      r = await formModal({ title: '역할 변경', subtitle: `현재 ${L.role[m.role]} · 자신보다 높거나 같은 역할은 부여할 수 없습니다 (BR-04)`, values: { role: m.role },
        fields: [{ name: 'role', label: '새 역할', type: 'select', required: true, full: true, options: options.roles(max) }, { name: 'reason', label: '사유', full: true }],
        submitLabel: '변경', onSubmit: (v) => api.patch(`${base}/role`, v) });
    }
    if (act === 'status') {
      const tr = root._tr;
      r = await formModal({ title: '상태 변경', subtitle: `현재 ${tr.currentLabel}${tr.allowed.includes('WITHDRAWN') ? ' · 탈퇴 시 소속·미완료 배정·자원 예약이 정리되고 로그인이 차단됩니다' : ''}`, danger: true,
        fields: [{ name: 'status', label: '새 상태', type: 'select', required: true, full: true, options: tr.allowed.map((s) => ({ value: s, label: L.member[s][0] })) }, { name: 'reason', label: '사유', full: true }],
        submitLabel: '변경', onSubmit: (v) => api.patch(`${base}/status`, v) });
    }
    if (act === 'promote') {
      r = await formModal({ title: '승급 요청', subtitle: '상위 권한자(promotion.review)가 승인하면 역할이 변경됩니다.',
        fields: [{ name: 'targetRole', label: '목표 역할', type: 'select', required: true, full: true, options: ['SOLDIER', 'CAPO', 'UNDERBOSS'].filter((x) => ['ASSOCIATE', 'SOLDIER', 'CAPO', 'UNDERBOSS'].indexOf(x) > ['ASSOCIATE', 'SOLDIER', 'CAPO', 'UNDERBOSS'].indexOf(m.role)).map((x) => ({ value: x, label: L.role[x] })) },
          { name: 'reason', label: '추천 사유', type: 'textarea', required: true, full: true }],
        submitLabel: '요청', onSubmit: (v) => api.post('/api/promotion-requests', { ...v, memberId: m.id }) });
    }
    if (act === 'discipline') {
      r = await formModal({ title: '징계 등록', subtitle: '정지(SUSPENSION) 시 상태가 정지로 변경되어 새 업무 배정이 차단됩니다 (BR-02).', danger: true,
        fields: [{ name: 'actionType', label: '구분', type: 'select', required: true, full: true, options: App.opts('discipline') }, { name: 'reason', label: '사유', type: 'textarea', required: true, full: true }],
        submitLabel: '등록', onSubmit: (v) => api.post(`${base}/disciplinary-actions`, v) });
    }
    if (act === 'reputation') {
      r = await formModal({ title: '평판 가감점', fields: [{ name: 'points', label: '점수 (-50 ~ +50)', type: 'number', required: true, min: -50, max: 50 }, { name: 'reason', label: '사유', required: true, full: true }],
        onSubmit: (v) => api.post(`${base}/reputation-adjustments`, v) });
    }
    if (act === 'skill') {
      r = await formModal({ title: '기술 추가', fields: [{ name: 'skill', label: '기술 (영문 소문자)', required: true, placeholder: 'driving' }, { name: 'level', label: '수준 (1~5)', type: 'number', required: true, min: 1, max: 5, value: 3 }],
        onSubmit: (v) => api.put(`${base}/skills/${encodeURIComponent(v.skill.toLowerCase())}`, { level: v.level }) });
    }
    if (r) { toast.ok('처리했습니다.'); reload(); }
  });

  await load();
  void prio; void opts;
});
