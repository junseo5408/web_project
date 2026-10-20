App.page(async (root) => {
  const { html, icon, api, fmt, setHTML, $, L, chart, options, empty } = App;
  const crews = await options.crews().catch(() => []);
  const charts = [];

  setHTML(root, html`
    <div class="page-head"><div><h1>운영 현황</h1><p>시스템에 축적된 구성원·업무·자원·평가·활동 데이터를 기반으로 한 운영 지표입니다.</p></div>
      <div class="actions">
        <select class="input" id="period" style="width:auto"><option value="30">최근 30일</option><option value="90" selected>최근 90일</option><option value="180">최근 180일</option><option value="365">최근 1년</option></select>
        <select class="input" id="crew" style="width:auto"><option value="">전체 Crew</option>${crews.map((c) => html`<option value="${c.value}">${c.label}</option>`)}</select>
        <button class="btn" id="print">${icon('download')}인쇄 / PDF</button>
      </div></div>
    <div id="body"></div>`);

  const card = (title, body, sub = '') => html`<div class="card"><div class="card-h"><h3>${title}${sub ? html`<span class="sub">${sub}</span>` : ''}</h3></div><div class="card-b">${body}</div></div>`;
  const box = (id, h = 260) => html`<div class="chart-box" style="height:${h}px"><canvas id="${id}"></canvas></div>`;

  async function render() {
    charts.splice(0).forEach((c) => c && c.destroy());
    const days = +$('#period', root).value;
    const crewId = $('#crew', root).value || undefined;
    const q = { from: new Date(Date.now() - days * 86400000), to: new Date(), crewId };
    setHTML($('#body', root), App.loading(8));
    const [ov, mem, tasks, trend, crewCmp, util, issues, evals, heat, changes, workload] = await Promise.all([
      api.get('/api/stats/overview', { crewId }), api.get('/api/stats/members', { crewId }), api.get('/api/stats/tasks', q),
      api.get('/api/stats/tasks/trend', { ...q, interval: days > 120 ? 'month' : 'week' }), api.get('/api/stats/crews', { from: q.from, to: q.to }),
      api.get('/api/stats/resources/utilization', { from: q.from, to: q.to }), api.get('/api/stats/resources/issues', { from: q.from, to: q.to }),
      api.get('/api/stats/evaluations', q), api.get('/api/stats/activities/heatmap', q), api.get('/api/stats/status-changes', q), api.get('/api/stats/members/workload', { ...q, limit: 10 }),
    ].map((p) => p.catch((e) => ({ error: e }))));
    const failed = [ov, mem, tasks, trend, crewCmp, util, issues, evals, heat, changes, workload].find((x) => x.error);
    if (failed) { setHTML($('#body', root), empty('통계를 불러오지 못했습니다.', App.errorText(failed.error), 'alert')); return; }
    const o = ov.data;
    const kpi = (label, value, hint, tone = '') => html`<div class="card kpi ${tone}"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`;
    setHTML($('#body', root), html`
      <div class="grid g-4">
        ${kpi('활동중 구성원', o.members.active, `전체 ${o.members.total} · 정지 ${o.members.suspended}`)}
        ${kpi('기간 내 업무', tasks.data.total, `평균 소요 ${tasks.data.avgDurationHours || 0}시간`)}
        ${kpi('기한 경과 업무', o.tasks.overdue, '미완료 상태', o.tasks.overdue ? 'bad' : 'ok')}
        ${kpi('사용 불가 · 점검 자원', o.resources.blocked, `평균 해결 ${issues.data.avgResolveHours === null ? '-' : `${issues.data.avgResolveHours}시간`}`, o.resources.blocked ? 'warn' : 'ok')}
      </div>
      <div class="grid g-2 mt">${card('업무 생성 · 완료 추이', box('c-trend'))}${card('업무 상태 · 결과', box('c-task'))}</div>
      <div class="grid g-3 mt">${card('구성원 상태', box('c-mstatus', 220))}${card('역할 분포', box('c-role', 220))}${card('평가 항목별 평균', box('c-eval', 220), `${evals.data.count}건`)}</div>
      <div class="mt">${card('Crew 비교', html`<div class="table-wrap"><table class="tbl"><thead><tr><th>Crew</th><th class="num">정식 인원</th><th class="num">업무</th><th class="num">완료</th><th class="num">완료율</th><th class="num">성공률</th><th class="num">평균 기여도</th><th class="num">성과 합계</th></tr></thead><tbody>
        ${crewCmp.data.map((c) => html`<tr><td><a href="/crews/${c.crewId}"><b>${c.crewName}</b></a></td><td class="num">${c.members}</td><td class="num">${c.tasksTotal}</td><td class="num">${c.completed}</td>
          <td class="num">${fmt.pct(c.completionRate)}</td><td class="num">${fmt.pct(c.successRate)}</td><td class="num">${c.avgContribution === null ? '-' : c.avgContribution}</td><td class="num">${fmt.num(c.totalValue)}</td></tr>`)}</tbody></table></div>`)}</div>
      <div class="grid g-2 mt">${card('자원 가동률', box('c-util', 300), '기간 대비 배정 시간 %')}${card('업무량 상위 구성원', workload.data.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>구성원</th><th>Crew</th><th class="num">배정</th><th class="num">시간</th><th class="num">진행중</th></tr></thead><tbody>
        ${workload.data.map((w) => html`<tr><td><a href="/members/${w.memberId}">${w.name}</a></td><td>${w.crewName}</td><td class="num">${w.assignments}</td><td class="num">${w.hours}</td><td class="num">${Number(w.openAssignments || 0)}</td></tr>`)}</tbody></table></div>` : empty('데이터가 없습니다'))}</div>
      <div class="grid g-2 mt">${card('활동 히트맵', html`<div id="heat"></div>`, `요일 × 시간 · ${heat.data.total}건`)}${card('구성원 변경 추이', box('c-changes'), '역할·상태·소속·평가 변경')}</div>`);

    const t = trend.data;
    charts.push(chart($('#c-trend', root), 'line', { labels: t.map((x) => x.bucket), datasets: [{ label: '생성', data: t.map((x) => x.created) }, { label: '완료', data: t.map((x) => x.completed) }] }));
    const st = Object.entries(tasks.data.byStatus);
    const oc = Object.entries(tasks.data.byOutcome);
    charts.push(chart($('#c-task', root), 'bar', { labels: [...st.map(([k]) => L.task[k][0]), ...oc.map(([k]) => `결과:${L.outcome[k][0]}`)], datasets: [{ label: '건수', data: [...st.map(([, v]) => v), ...oc.map(([, v]) => v)] }] }, { plugins: { legend: { display: false } } }));
    const ms = Object.entries(mem.data.byStatus);
    charts.push(chart($('#c-mstatus', root), 'doughnut', { labels: ms.map(([k]) => L.member[k][0]), datasets: [{ data: ms.map(([, v]) => v) }] }));
    const rl = Object.entries(mem.data.byRole);
    charts.push(chart($('#c-role', root), 'bar', { labels: rl.map(([k]) => L.role[k]), datasets: [{ label: '인원', data: rl.map(([, v]) => v) }] }, { plugins: { legend: { display: false } } }));
    const ev = Object.entries(evals.data.byCriterion);
    charts.push(chart($('#c-eval', root), 'radar', { labels: ev.map(([k]) => k), datasets: [{ label: '평균', data: ev.map(([, v]) => v), backgroundColor: '#7c1d2e33', borderColor: '#7c1d2e' }] }, { scales: { r: { min: 0, max: 5, ticks: { stepSize: 1 } } } }));
    const u = util.data.slice(0, 10);
    charts.push(chart($('#c-util', root), 'bar', { labels: u.map((x) => x.code), datasets: [{ label: '가동률(%)', data: u.map((x) => x.utilizationRate) }] }, { indexAxis: 'y', plugins: { legend: { display: false } } }));
    const ch = changes.data.weekly;
    charts.push(chart($('#c-changes', root), 'bar', { labels: ch.map((x) => x.week), datasets: [{ label: '변경 건수', data: ch.map((x) => x.count) }] }, { plugins: { legend: { display: false } } }));

    const max = Math.max(1, ...heat.data.cells.map((c) => c.count));
    const cell = (d, h) => (heat.data.cells.find((c) => c.dayOfWeek === d && c.hour === h) || { count: 0 }).count;
    setHTML($('#heat', root), html`<div class="heat"><span></span>${Array.from({ length: 24 }, (_, h) => html`<span style="text-align:center">${h % 3 === 0 ? h : ''}</span>`)}
      ${[1, 2, 3, 4, 5, 6, 7].map((d) => html`<span>${['일', '월', '화', '수', '목', '금', '토'][d - 1]}</span>${Array.from({ length: 24 }, (_, h) => { const n = cell(d, h); return html`<span class="c" title="${n}건" style="opacity:${n ? 0.15 + (0.85 * n) / max : 0.05}"></span>`; })}`)}</div>
      <p style="font-size:12px;color:var(--muted);margin:10px 0 0">시간은 UTC 기준 · 유형: ${Object.entries(heat.data.byType).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>`);
  }

  $('#period', root).addEventListener('change', () => render().catch(App.toast.error));
  $('#crew', root).addEventListener('change', () => render().catch(App.toast.error));
  $('#print', root).addEventListener('click', () => window.print());
  await render();
});
