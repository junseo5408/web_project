App.page(async (root) => {
  const { html, icon, api, setHTML, $, on, options, ME, fmt, urlState } = App;
  const state = urlState.get();
  let cursor = state.month ? new Date(`${state.month}-01T00:00:00`) : new Date();
  cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  let mine = state.mine === '1';
  let crewId = state.crewId || '';
  const crews = await options.crews().catch(() => []);

  setHTML(root, html`
    <div class="page-head">
      <div><h1>업무 캘린더</h1><p>권한 범위 내 업무 일정을 월 단위로 확인합니다.</p></div>
      <div class="actions">
        <select class="input" id="crew" style="width:auto"><option value="">모든 Crew</option>${crews.map((c) => html`<option value="${c.value}">${c.label}</option>`)}</select>
        <div class="seg" id="scope"><button data-v="">전체</button><button data-v="1">내 업무</button></div>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><div class="row"><button class="btn sm" data-nav="-1">${icon('left')}</button><button class="btn sm" data-nav="0">오늘</button><button class="btn sm" data-nav="1">${icon('right')}</button></div>
        <h3 id="title" style="font-size:16px"></h3><span id="count" style="color:var(--muted);font-size:13px"></span></div>
      <div id="cal"></div>
    </div>`);
  $('#crew', root).value = crewId;

  const key = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  async function render() {
    [...$('#scope', root).children].forEach((b) => b.classList.toggle('on', (b.dataset.v === '1') === mine));
    urlState.set({ month: `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`, mine: mine ? '1' : '', crewId });
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first); start.setDate(1 - first.getDay());
    const end = new Date(start); end.setDate(start.getDate() + 42);
    $('#title', root).textContent = `${cursor.getFullYear()}년 ${cursor.getMonth() + 1}월`;
    setHTML($('#cal', root), App.loading(5));
    const r = await api.get('/api/tasks/calendar', { from: start, to: new Date(end.getTime() - 1), crewId, memberId: mine ? ME.id : undefined });
    const byDay = new Map();
    let total = 0;
    r.data.forEach((d) => d.tasks.forEach((t) => {
      const k = key(new Date(t.startAt));
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(t);
      total += 1;
    }));
    $('#count', root).textContent = `업무 ${total}건`;
    const today = key(new Date());
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const list = byDay.get(key(d)) || [];
      cells.push(html`<div class="day ${d.getMonth() !== cursor.getMonth() ? 'out' : ''} ${key(d) === today ? 'today' : ''}">
        <span class="d">${d.getDate()}</span>
        ${list.slice(0, 4).map((t) => html`<a class="ev ${t.status}" href="/tasks/${t.id}" title="${t.title} · ${fmt.range(t.startAt, t.endAt)} · ${t.crewName}">${fmt.time(t.startAt)} ${t.title}</a>`)}
        ${list.length > 4 ? html`<span style="font-size:11px;color:var(--muted)">+${list.length - 4}건</span>` : ''}</div>`);
    }
    setHTML($('#cal', root), html`<div class="cal">${['일', '월', '화', '수', '목', '금', '토'].map((d) => html`<div class="dow">${d}</div>`)}${cells}</div>`);
  }

  on(root, 'click', '[data-nav]', (e, b) => {
    const n = +b.dataset.nav;
    cursor = n === 0 ? new Date(new Date().getFullYear(), new Date().getMonth(), 1) : new Date(cursor.getFullYear(), cursor.getMonth() + n, 1);
    render().catch(App.toast.error);
  });
  on(root, 'click', '#scope button', (e, b) => { mine = b.dataset.v === '1'; render().catch(App.toast.error); });
  $('#crew', root).addEventListener('change', (e) => { crewId = e.target.value; render().catch(App.toast.error); });
  await render();
});
