App.page(async (root) => {
  const { html, icon, api, fmt, can, ME, setHTML, $, on, L, formModal, toast, run, empty, tabs, person, DataTable } = App;
  const criteria = (await api.get('/api/evaluation-criteria')).data;

  setHTML(root, html`
    <div class="page-head"><div><h1>평가 · 평판</h1><p>완료된 업무의 결과와 참여 기록을 바탕으로 구성원을 평가하고 평판을 관리합니다.</p></div>
      <div class="actions">${can('evaluation.write') ? html`<button class="btn primary" data-act="free">${icon('plus')}일반 평가 작성</button>` : ''}</div></div>
    <div id="tabs"></div>`);

  const scoreFields = (values = {}) => [
    ...criteria.map((c) => ({ name: `s_${c.code}`, label: `${c.name} (가중치 ${c.weight})`, type: 'select', required: true, value: values[c.code] || 4, help: c.description,
      options: [5, 4, 3, 2, 1].map((n) => ({ value: n, label: `${n}점 ${['', '매우 미흡', '미흡', '보통', '우수', '탁월'][n]}` })) })),
    { name: 'comment', label: '코멘트', type: 'textarea', full: true },
  ];
  const collect = (v) => ({ scores: Object.fromEntries(criteria.map((c) => [c.code, Number(v[`s_${c.code}`])])), comment: v.comment });

  async function evaluate(memberId, memberName, taskId, taskTitle) {
    const r = await formModal({ title: `${memberName} 평가`, subtitle: taskTitle ? `업무: ${taskTitle}` : '업무와 무관한 일반 평가', size: 'lg', fields: scoreFields(),
      submitLabel: '평가 등록', onSubmit: (v) => api.post('/api/evaluations', { memberId, taskId: taskId || undefined, ...collect(v) }) });
    if (r) { toast.ok(`평가를 등록했습니다. (종합 ${r.data.overall})`); App.refreshInbox(); return true; }
    return false;
  }

  async function pending(p) {
    const r = await api.get('/api/evaluations/pending', { days: 60 });
    setHTML(p, html`<div class="card"><div class="card-h"><h3>평가 대기</h3><span class="sub">최근 60일 내 완료 업무 참여자 중 미평가</span></div><div class="card-b flush">
      ${r.data.length ? html`<ul class="list">${r.data.map((x) => html`<li>${person(x.memberName, L.attendance[x.attendance] || '')}
        <div class="grow"><a class="title" href="/tasks/${x.taskId}" style="color:inherit">${x.title}</a><div class="desc">완료 ${fmt.date(x.completedAt)}${x.contribution !== null ? ` · 기여도 ${x.contribution}` : ''}</div></div>
        <button class="btn sm primary" data-eval="${x.memberId}" data-name="${x.memberName}" data-task="${x.taskId}" data-title="${x.title}">${icon('star')}평가</button></li>`)}</ul>` : empty('평가 대기 중인 구성원이 없습니다', '', 'checkCircle')}</div></div>`);
  }

  async function records(p) {
    setHTML(p, html`<div class="card"><div id="t"></div></div>`);
    const table = new DataTable($('#t', p), {
      url: '/api/evaluations', sort: '-createdAt', params: () => ({}), empty: '평가 기록이 없습니다.',
      columns: [
        { label: '대상', render: (e) => (e.memberId === ME.id ? html`<b>나</b>` : html`<a href="/members/${e.memberId}">${e.memberName || `#${e.memberId}`}</a>`) },
        { label: '업무', render: (e) => (e.taskId ? html`<a href="/tasks/${e.taskId}">#${e.taskId}</a>` : '일반') },
        { label: '항목 점수', render: (e) => Object.entries(e.scores).map(([k, v]) => html`<span class="tag">${(criteria.find((c) => c.code === k) || { name: k }).name} ${v}</span>`) },
        { label: '종합', sort: 'overall', cls: 'num', render: (e) => html`<b>${e.overall}</b>` },
        { label: '평가자', render: (e) => e.evaluator.username || L.role[e.evaluator.role] },
        { label: '일시', sort: 'createdAt', render: (e) => html`${fmt.date(e.createdAt)}${e.revisions && e.revisions.length ? html`<span class="sub">수정 ${e.revisions.length}회</span>` : ''}` },
        { label: '', render: (e) => (e.status === 'VOIDED' ? html`<span class="badge">무효</span>` : html`<div class="row" style="justify-content:flex-end">
          ${e.evaluator.id === ME.id || can('evaluation.void') ? html`<button class="btn sm ghost" data-edit="${e.id}" title="수정">${icon('edit')}</button>` : ''}
          ${can('evaluation.void') ? html`<button class="btn sm ghost" data-void="${e.id}" title="무효화">${icon('ban')}</button>` : ''}</div>`) },
      ],
    });
    p._table = table;
    await table.load(1);
  }

  async function leaderboard(p) {
    const r = await api.get('/api/reputation/leaderboard', { limit: 20 });
    setHTML(p, html`<div class="card"><div class="card-h"><h3>평판 순위</h3><span class="sub">조회 가능한 Crew 기준 · 평가 평균×20 + 가감점</span></div><div class="card-b flush">
      ${r.data.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th style="width:60px">순위</th><th>구성원</th><th>Crew</th><th class="num">평가 평균</th><th class="num">가감점</th><th class="num">출석률</th><th class="num">점수</th></tr></thead><tbody>
      ${r.data.map((x) => html`<tr class="link" data-href="/members/${x.memberId}"><td><b style="font-size:16px;color:${x.rank <= 3 ? 'var(--brand)' : 'var(--muted)'}">${x.rank}</b></td><td>${person(x.name)}</td><td>${x.crewName}</td>
        <td class="num">${x.evaluationAverage === null ? '-' : x.evaluationAverage}</td><td class="num">${x.ledgerPoints}</td><td class="num">${fmt.pct(x.attendanceRate)}</td><td class="num"><b>${x.score}</b></td></tr>`)}
      </tbody></table></div>` : empty('순위 데이터가 없습니다', '', 'star')}</div></div>`);
  }

  async function criteriaTab(p) {
    const r = await api.get('/api/evaluation-criteria', { includeInactive: 'true' });
    setHTML(p, html`<div class="card"><div class="card-h"><h3>평가 항목</h3><button class="btn sm primary" data-crit-new>${icon('plus')}항목 추가</button></div><div class="card-b flush"><div class="table-wrap"><table class="tbl">
      <thead><tr><th>코드</th><th>이름</th><th>설명</th><th class="num">가중치</th><th>상태</th><th></th></tr></thead><tbody>
      ${r.data.map((c) => html`<tr><td class="mono">${c.code}</td><td><b>${c.name}</b></td><td>${c.description || '-'}</td><td class="num">${c.weight}</td><td>${c.active ? html`<span class="badge ok">사용</span>` : html`<span class="badge">중지</span>`}</td>
        <td style="text-align:right"><button class="btn sm ghost" data-crit-edit="${c.code}">${icon('edit')}</button><button class="btn sm ghost" data-crit-del="${c.code}">${icon('trash')}</button></td></tr>`)}
      </tbody></table></div></div></div>`);
    p._crit = r.data;
  }

  const t = tabs($('#tabs', root), [
    { key: 'pending', label: '평가 대기', show: can('evaluation.write'), render: pending },
    { key: 'records', label: can('evaluation.read') ? '평가 기록' : '내 평가', render: records },
    { key: 'leaderboard', label: '평판 순위', render: leaderboard },
    { key: 'criteria', label: '평가 항목 관리', show: can('evaluation.criteria'), render: criteriaTab },
  ]);
  const pane = () => $('.tab-pane', root);

  on(root, 'click', 'tr.link', (e, tr) => { location.href = tr.dataset.href; });
  on(root, 'click', '[data-eval]', async (e, b) => { if (await evaluate(+b.dataset.eval, b.dataset.name, +b.dataset.task, b.dataset.title)) t.reload(); });
  on(root, 'click', '[data-act="free"]', async () => {
    const r = await formModal({ title: '일반 평가 대상 선택', fields: [{ name: 'memberId', label: '구성원', type: 'select', required: true, full: true, numeric: true, options: () => App.options.members() }], submitLabel: '다음', onSubmit: async (v) => v });
    if (r && await evaluate(r.memberId, `구성원 #${r.memberId}`)) t.reload();
  });
  on(root, 'click', '[data-edit]', async (e, b) => {
    const ev = pane()._table.rows.find((x) => x.id === b.dataset.edit);
    const r = await formModal({ title: '평가 수정', subtitle: '수정 전 점수는 수정 이력에 보존됩니다.', size: 'lg', fields: scoreFields(ev.scores), values: { comment: ev.comment },
      onSubmit: (v) => api.patch(`/api/evaluations/${ev.id}`, collect(v)) });
    if (r) { toast.ok('평가를 수정했습니다.'); t.reload(); }
  });
  on(root, 'click', '[data-void]', async (e, b) => {
    const r = await formModal({ title: '평가 무효화', subtitle: '평가는 삭제되지 않고 무효 처리되며 이력에 남습니다.', danger: true, fields: [{ name: 'reason', label: '사유', required: true, full: true }], submitLabel: '무효화', onSubmit: (v) => api.del(`/api/evaluations/${b.dataset.void}`, v) });
    if (r) { toast.ok('무효화했습니다.'); t.reload(); }
  });
  on(root, 'click', '[data-crit-new]', async () => {
    const r = await formModal({ title: '평가 항목 추가', fields: [{ name: 'code', label: '코드 (영문 소문자)', required: true }, { name: 'name', label: '이름', required: true }, { name: 'weight', label: '가중치 (0.1~5)', type: 'number', step: '0.1', value: 1 }, { name: 'description', label: '설명', full: true }],
      onSubmit: (v) => api.post('/api/evaluation-criteria', v) });
    if (r) { toast.ok('추가했습니다.'); t.reload(); }
  });
  on(root, 'click', '[data-crit-edit]', async (e, b) => {
    const c = pane()._crit.find((x) => x.code === b.dataset.critEdit);
    const r = await formModal({ title: `평가 항목: ${c.code}`, values: c,
      fields: [{ name: 'name', label: '이름', required: true }, { name: 'weight', label: '가중치', type: 'number', step: '0.1' }, { name: 'description', label: '설명', full: true }, { name: 'active', label: '사용', type: 'checkbox', full: true }],
      onSubmit: (v) => api.patch(`/api/evaluation-criteria/${c.code}`, v) });
    if (r) { toast.ok('저장했습니다.'); t.reload(); }
  });
  on(root, 'click', '[data-crit-del]', (e, b) => run(() => api.del(`/api/evaluation-criteria/${b.dataset.critDel}`), { confirm: { title: '평가 항목 삭제', message: '평가에 사용된 항목은 삭제할 수 없으며 비활성화해야 합니다.', danger: true }, success: '삭제했습니다.', then: () => t.reload() }));
});
