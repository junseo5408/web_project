App.page(async (root, params) => {
  const { html, raw, icon, api, fmt, badge, prio, can, ME, setHTML, $, on, L, opts, formModal, toast, run, empty, person, modal } = App;
  const id = params.id;
  const base = `/api/tasks/${id}`;
  const EVENT = {
    CREATED: '업무 등록', UPDATED: '정보 수정', RESCHEDULED: '일정 변경', STATUS_CHANGED: '상태 변경', COMPLETED: '완료 처리', REOPENED: '재개',
    RESULT_AMENDED: '결과 수정', ASSIGNED: '구성원 배정', UNASSIGNED: '배정 해제', REPLACED: '인원 교체', ASSIGNMENT_ACCEPTED: '배정 수락',
    ASSIGNMENT_DECLINED: '배정 거절', PARTICIPATION_RECORDED: '참여 기록', ALLOCATED: '자원 배정', CHECKED_OUT: '자원 사용 시작', RETURNED: '자원 반납', CANCELLED: '예약 취소',
  };
  const STATUS_ACTION = { IN_PROGRESS: ['시작', 'play', 'primary'], ON_HOLD: ['보류', 'pause', ''], CANCELLED: ['취소', 'ban', 'danger'], PLANNED: ['재계획', 'refresh', ''] };
  let managedCrews = [];
  try { managedCrews = (await api.get('/api/crews/managed')).data.map((c) => c.id); } catch (e) { managedCrews = []; }

  async function load() {
    const [t, tr] = await Promise.all([api.get(base), api.get(`${base}/transitions`)]);
    render(t.data, tr.data);
  }

  function render(t, tr) {
    const manage = managedCrews.includes(t.crewId);
    const open = ['PLANNED', 'IN_PROGRESS', 'ON_HOLD'].includes(t.status);
    const mine = t.assignees.find((a) => a.memberId === ME.id);
    const active = t.assignees.filter((a) => ['ASSIGNED', 'ACCEPTED'].includes(a.status));
    const overdue = open && new Date(t.endAt) < new Date();
    const actions = [];
    if (manage && can('task.progress')) {
      tr.allowed.forEach((s) => { const [label, ic, kind] = STATUS_ACTION[s]; actions.push(html`<button class="btn ${kind}" data-act="status" data-s="${s}">${icon(ic)}${label}</button>`); });
      if (tr.canComplete) actions.push(html`<button class="btn primary" data-act="complete">${icon('checkCircle')}완료 처리</button>`);
    }
    if (manage && tr.canReopen && can('task.result.amend')) actions.push(html`<button class="btn" data-act="reopen">${icon('refresh')}재개</button>`);

    setHTML(root, html`
      <a href="/tasks" class="btn ghost sm" style="margin-bottom:12px">${icon('back')}업무 목록</a>
      <div class="card"><div class="card-b">
        <div class="hero">
          <div style="flex:1;min-width:0">
            <div class="row" style="gap:6px">${badge('task', t.status)} ${prio(t.priority)} ${overdue ? html`<span class="badge bad">기한 경과</span>` : ''} ${t.allowConcurrent ? html`<span class="badge plain">동시 수행 가능</span>` : ''}</div>
            <h1 style="margin-top:8px">${t.title}</h1>
            <div class="meta">${icon('clock')}${fmt.range(t.startAt, t.endAt)} <span>·</span> ${icon('crew')}<a href="/crews/${t.crewId}">${t.crewName}</a> ${t.location ? html`<span>·</span> ${icon('pin')}${t.location}` : ''}</div>
          </div>
          <div class="row" style="justify-content:flex-end">${actions}</div>
        </div>
        ${mine && mine.status === 'ASSIGNED' && open ? html`<div class="notice info" style="margin-top:16px">${icon('bell')}<div style="flex:1">이 업무에 <b>${mine.taskRole || '참여자'}</b>(으)로 배정되었습니다. 참여 여부를 응답해 주세요.</div>
          <button class="btn sm primary" data-act="accept" data-a="${mine.assignmentId}">수락</button><button class="btn sm danger" data-act="decline" data-a="${mine.assignmentId}">거절</button></div>` : ''}
      </div></div>

      ${t.status === 'COMPLETED' ? html`<div class="card mt"><div class="card-h"><h3>업무 결과</h3>
          ${manage && can('task.result.amend') ? html`<button class="btn sm" data-act="amend">${icon('edit')}결과 수정</button>` : html`<span class="badge plain" title="BR-06">${icon('lock')}결과 보호됨</span>`}</div>
        <div class="card-b"><dl class="dl"><dt>결과</dt><dd>${badge('outcome', t.resultOutcome)}</dd><dt>요약</dt><dd style="white-space:pre-wrap">${t.resultSummary || '-'}</dd>
        <dt>성과 값</dt><dd>${fmt.num(t.resultValue)}</dd><dt>완료 시각</dt><dd>${fmt.full(t.completedAt)}</dd></dl></div></div>` : ''}

      <div class="grid g-main mt">
        <div class="stack">
          <div class="card">
            <div class="card-h"><h3>참여 구성원 <span class="sub">${active.length}명</span></h3>
              <div class="row">${manage && can('task.assign') && open ? html`<button class="btn sm" data-act="conflicts">${icon('alert')}충돌 점검</button><button class="btn sm primary" data-act="assign">${icon('plus')}배정</button>` : ''}</div></div>
            <div class="card-b flush">${t.assignees.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>구성원</th><th>역할 · 지시사항</th><th>상태</th>${t.status === 'COMPLETED' ? html`<th>출석</th><th class="num">기여도</th>` : ''}<th></th></tr></thead><tbody>
              ${t.assignees.map((a) => html`<tr>
                <td>${person(a.name, a.alias, `/members/${a.memberId}`)}</td>
                <td>${a.taskRole || html`<span style="color:var(--muted-2)">-</span>`}</td>
                <td>${badge('assign', a.status)}</td>
                ${t.status === 'COMPLETED' ? html`<td>${L.attendance[a.attendance] || '-'}</td><td class="num">${a.contribution === null ? '-' : a.contribution}</td>` : ''}
                <td style="text-align:right;white-space:nowrap">
                  ${manage && can('task.assign') && open && ['ASSIGNED', 'ACCEPTED'].includes(a.status) ? html`
                    <button class="btn sm ghost" data-act="edit-assign" data-m="${a.memberId}" title="역할·지시 수정">${icon('edit')}</button>
                    <button class="btn sm ghost" data-act="replace" data-m="${a.memberId}" title="교체">${icon('swap')}</button>
                    <button class="btn sm ghost" data-act="unassign" data-m="${a.memberId}" title="배정 해제">${icon('x')}</button>` : ''}
                  ${manage && can('task.progress') && t.status === 'COMPLETED' && ['ASSIGNED', 'ACCEPTED'].includes(a.status) ? html`<button class="btn sm" data-act="participation" data-m="${a.memberId}">참여 기록</button>` : ''}
                </td></tr>`)}
              </tbody></table></div>` : empty('아직 배정된 구성원이 없습니다', manage ? '배정 버튼으로 일정이 비어 있는 구성원을 추천받을 수 있습니다.' : '', 'users')}</div>
          </div>
          <div class="card"><div class="card-h"><h3>체크리스트</h3><span id="cl-progress"></span></div><div class="card-b flush" id="checklist">${App.loading(2)}</div></div>
          <div class="card"><div class="card-h"><h3>코멘트</h3></div><div class="card-b flush" id="comments">${App.loading(2)}</div></div>
        </div>
        <div class="stack">
          <div class="card"><div class="card-h"><h3>업무 정보</h3>
            ${manage && can('task.update') && open ? html`<div class="row"><button class="btn sm ghost" data-act="schedule" title="일정 변경">${icon('calendar')}</button><button class="btn sm ghost" data-act="edit" title="정보 수정">${icon('edit')}</button></div>` : ''}</div>
            <div class="card-b"><dl class="dl">
              <dt>업무 번호</dt><dd>#${t.id}</dd>
              <dt>설명</dt><dd style="white-space:pre-wrap">${t.description || '-'}</dd>
              <dt>필요 기술</dt><dd>${(t.requiredSkills || []).length ? t.requiredSkills.map((s) => html`<span class="tag">${s}</span>`) : '-'}</dd>
              <dt>등록일</dt><dd>${fmt.full(t.createdAt)}</dd>
              <dt>최근 수정</dt><dd>${fmt.rel(t.updatedAt)}</dd>
            </dl>
            ${can('task.create') ? html`<div class="row mt"><button class="btn sm" data-act="duplicate">${icon('copy')}복제</button>${manage && ['PLANNED', 'CANCELLED'].includes(t.status) ? html`<button class="btn sm danger" data-act="delete">${icon('trash')}삭제</button>` : ''}</div>` : ''}
            </div></div>
          <div class="card"><div class="card-h"><h3>배정 자원</h3>${manage && can('resource.allocate') && open ? html`<button class="btn sm" data-act="allocate">${icon('plus')}자원 배정</button>` : ''}</div>
            <div class="card-b flush">${t.resources.length ? html`<ul class="list">${t.resources.map((r) => html`<li>
              <div class="grow"><a class="title" href="/resources/${r.resourceId}" style="color:inherit">${r.code} ${r.name}</a><div class="desc">${fmt.range(r.startAt, r.endAt)}</div></div>${badge('alloc', r.status)}
              ${r.status === 'RESERVED' && (mine || manage) ? html`<button class="btn sm" data-act="checkout" data-al="${r.allocationId}">사용 시작</button>` : ''}
              ${r.status === 'IN_USE' && (mine || manage) ? html`<button class="btn sm" data-act="return" data-al="${r.allocationId}">반납</button>` : ''}
              ${r.status === 'RESERVED' && manage ? html`<button class="btn sm ghost" data-act="cancel-alloc" data-al="${r.allocationId}" title="예약 취소">${icon('x')}</button>` : ''}
              </li>`)}</ul>` : empty('배정된 자원이 없습니다', '', 'box')}</div></div>
          <div class="card"><div class="card-h"><h3>변경 이력</h3></div><div class="card-b" id="timeline">${App.loading()}</div></div>
        </div>
      </div>`);
    loadChecklist(t, manage, !!mine);
    loadComments(t);
    loadTimeline();
    root._task = t;
  }

  async function loadChecklist(t, manage, mine) {
    const r = await api.get(`${base}/checklist`);
    const { items, progress } = r.data;
    const editable = t.status !== 'COMPLETED';
    const canToggle = editable && (mine || (manage && can('task.update')));
    setHTML($('#cl-progress', root), progress.total ? html`<div class="row" style="gap:8px;min-width:150px"><div class="progress" style="flex:1"><i style="width:${Math.round((progress.done / progress.total) * 100)}%"></i></div><span style="font-size:12px;color:var(--muted)">${progress.done}/${progress.total}</span></div>` : '');
    setHTML($('#checklist', root), html`
      ${items.length ? html`<ul class="list checklist">${items.map((i) => html`<li class="${i.done ? 'done' : ''}">
        <label class="check grow"><input type="checkbox" data-act="toggle" data-item="${i.id}" ${i.done ? raw('checked') : ''} ${canToggle ? '' : raw('disabled')}><span class="title">${i.text}</span></label>
        ${i.doneBy ? html`<span class="desc">${i.doneBy}</span>` : ''}
        ${editable && manage && can('task.update') ? html`<button class="btn sm ghost" data-act="del-item" data-item="${i.id}" title="삭제">${icon('trash')}</button>` : ''}</li>`)}</ul>` : empty('체크리스트가 없습니다', '', 'checkCircle')}
      ${editable && manage && can('task.update') ? html`<form class="row" data-form="add-item" style="padding:12px 18px;border-top:1px solid var(--line-2)"><input class="input" name="text" placeholder="새 항목 추가" maxlength="200" style="flex:1"><button class="btn sm">${icon('plus')}추가</button></form>` : ''}`);
  }

  async function loadComments(t) {
    const r = await api.get(`${base}/comments`, { size: 100 });
    setHTML($('#comments', root), html`
      ${r.data.length ? r.data.map((c) => html`<div class="comment">${App.avatar(c.author.username)}<div class="body">
          <div class="who">${c.author.username}<span>${L.role[c.author.role] || ''} · ${fmt.rel(c.createdAt)}${c.edited ? ' · 수정됨' : ''}</span>
          ${c.author.id === ME.id ? html`<button class="btn sm ghost" style="float:right" data-act="del-comment" data-c="${c.id}" title="삭제">${icon('trash')}</button>` : ''}</div>
          <p>${c.body}</p></div></div>`) : empty('아직 코멘트가 없습니다', '', 'meeting')}
      <form class="row" data-form="comment" style="padding:12px 18px;border-top:1px solid var(--line-2)"><input class="input" name="body" placeholder="코멘트 입력 (Enter)" maxlength="2000" style="flex:1"><button class="btn sm primary">${icon('send')}등록</button></form>`);
    void t;
  }

  async function loadTimeline() {
    const r = await api.get(`${base}/timeline`);
    const tone = (x) => (x.kind === 'COMMENT' ? 'info' : x.event === 'COMPLETED' ? 'ok' : ['UNASSIGNED', 'ASSIGNMENT_DECLINED', 'CANCELLED'].includes(x.event) ? 'bad' : 'brand');
    const label = (x) => {
      if (x.kind === 'COMMENT') return `코멘트: ${x.body.slice(0, 40)}`;
      const name = EVENT[x.event] || x.event;
      if (x.event === 'STATUS_CHANGED' || x.event === 'COMPLETED' || x.event === 'REOPENED') return `${name}: ${(L.task[x.from] || [x.from])[0]} → ${(L.task[x.to] || [x.to])[0]}`;
      return x.kind === 'RESOURCE' ? `${name} (자원 #${x.resourceId})` : name;
    };
    setHTML($('#timeline', root), r.data.length ? html`<ul class="timeline">${r.data.slice().reverse().slice(0, 30).map((x) => html`<li><span class="dot ${tone(x)}"></span><div class="t">${label(x)}</div><div class="s">${x.by} · ${fmt.full(x.at)}${x.note ? ` · ${x.note}` : ''}</div></li>`)}</ul>` : empty('이력이 없습니다'));
  }

  const reload = () => load().catch((e) => toast.error(e));

  async function candidateOptions() {
    const r = await api.get(`${base}/candidates`, { includeOtherCrews: ME.level >= 4 ? 'true' : undefined });
    return r.data.map((c) => ({ value: c.memberId, label: `${c.name} · ${L.role[c.role]} · 기술 적합 ${Math.round(c.skillMatch * 100)}% · 진행 업무 ${c.openAssignments}건` }));
  }

  on(root, 'submit', 'form[data-form]', async (e, f) => {
    e.preventDefault();
    const input = f.querySelector('input');
    const v = input.value.trim();
    if (!v) return;
    if (f.dataset.form === 'comment') await run(() => api.post(`${base}/comments`, { body: v }), { then: () => loadComments(root._task) });
    if (f.dataset.form === 'add-item') await run(() => api.post(`${base}/checklist`, { text: v }), { then: reload });
  });

  on(root, 'change', '[data-act="toggle"]', (e, el) => run(() => api.patch(`${base}/checklist/${el.dataset.item}`, { done: el.checked }), { then: reload }));

  on(root, 'click', 'button[data-act]', async (e, b) => {
    const t = root._task;
    const act = b.dataset.act;
    const m = b.dataset.m;
    const al = b.dataset.al;
    const assignee = m && t.assignees.find((a) => String(a.memberId) === m);
    switch (act) {
      case 'status': {
        const s = b.dataset.s;
        const r = await formModal({ title: `업무 상태 변경: ${(L.task[s] || [s])[0]}`, subtitle: `${(L.task[t.status])[0]} → ${(L.task[s])[0]}`, danger: s === 'CANCELLED',
          fields: [{ name: 'reason', label: '사유', type: 'textarea', full: true, placeholder: s === 'CANCELLED' ? '취소 사유 (예약된 자원도 함께 취소됩니다)' : '선택 입력' }],
          submitLabel: '변경', onSubmit: (v) => api.patch(`${base}/status`, { status: s, ...v }) });
        if (r) { toast.ok('상태를 변경했습니다.'); reload(); }
        break;
      }
      case 'complete': {
        const active = t.assignees.filter((a) => ['ASSIGNED', 'ACCEPTED'].includes(a.status));
        const fields = [
          { name: 'outcome', label: '결과', type: 'select', required: true, options: App.opts('outcome') },
          { name: 'value', label: '성과 값 (선택)', type: 'number', min: 0 },
          { name: 'summary', label: '결과 요약', type: 'textarea', required: true, full: true },
          ...(active.length ? [{ type: 'html', name: '_h', full: true, html: '<div style="font-weight:600;font-size:13px;margin:4px 0 8px">참여 기록 (출석 · 기여도 0~100)</div>' }] : []),
          ...active.flatMap((a) => [
            { name: `att_${a.memberId}`, label: `${a.name} 출석`, type: 'select', required: true, value: 'PRESENT', options: App.opts('attendance') },
            { name: `con_${a.memberId}`, label: `${a.name} 기여도`, type: 'number', min: 0, max: 100, value: 80 },
          ]),
        ];
        const r = await formModal({ title: '업무 완료 처리', subtitle: '완료 후 핵심 결과는 Underboss 이상만 수정할 수 있습니다 (BR-06).', size: 'lg', fields, submitLabel: '완료 처리',
          onSubmit: (v) => api.post(`${base}/complete`, {
            outcome: v.outcome, summary: v.summary, value: v.value,
            participation: active.map((a) => ({ memberId: a.memberId, attendance: v[`att_${a.memberId}`], contribution: v[`con_${a.memberId}`] })),
          }) });
        if (r) { toast.ok('업무를 완료 처리했습니다.'); reload(); }
        break;
      }
      case 'reopen': {
        const r = await formModal({ title: '완료 업무 재개', subtitle: '업무를 다시 진행중 상태로 되돌립니다. 이력에 기록됩니다.', fields: [{ name: 'reason', label: '사유', type: 'textarea', required: true, full: true }], submitLabel: '재개', onSubmit: (v) => api.post(`${base}/reopen`, v) });
        if (r) { toast.ok('업무를 재개했습니다.'); reload(); }
        break;
      }
      case 'amend': {
        const r = await formModal({ title: '업무 결과 수정', subtitle: '수정 전 값과 사유가 이력에 보존됩니다.', values: { outcome: t.resultOutcome, summary: t.resultSummary, value: t.resultValue },
          fields: [{ name: 'outcome', label: '결과', type: 'select', required: true, options: App.opts('outcome') }, { name: 'value', label: '성과 값', type: 'number', min: 0 },
            { name: 'summary', label: '결과 요약', type: 'textarea', full: true }, { name: 'reason', label: '수정 사유', required: true, full: true }],
          submitLabel: '수정', onSubmit: (v) => api.patch(`${base}/result`, v) });
        if (r) { toast.ok('결과를 수정했습니다.'); reload(); }
        break;
      }
      case 'edit': {
        const r = await formModal({ title: '업무 정보 수정', size: 'lg', values: { ...t, requiredSkills: (t.requiredSkills || []).join(', ') },
          fields: [{ name: 'title', label: '업무명', required: true, full: true }, { name: 'priority', label: '중요도', type: 'select', required: true, options: opts('priority') },
            { name: 'location', label: '장소', emptyAsNull: true }, { name: 'requiredSkills', label: '필요 기술 (쉼표 구분)', full: true }, { name: 'description', label: '설명', type: 'textarea', full: true, emptyAsNull: true }],
          onSubmit: (v) => api.patch(base, { ...v, requiredSkills: (v.requiredSkills || '').split(',').map((s) => s.trim()).filter(Boolean) }) });
        if (r) { toast.ok('저장했습니다.'); reload(); }
        break;
      }
      case 'schedule': {
        const r = await formModal({ title: '일정 변경', subtitle: '참여자의 다른 업무(BR-03)와 예약 자원(BR-07)의 시간 중복을 다시 검사합니다.', values: t,
          fields: [{ name: 'startAt', label: '시작', type: 'datetime', required: true }, { name: 'endAt', label: '종료', type: 'datetime', required: true },
            { name: 'allowConcurrent', label: '다른 업무와 동시 수행 가능', type: 'checkbox', full: true }],
          onSubmit: (v) => api.patch(`${base}/schedule`, v) });
        if (r) { toast.ok(`일정을 변경했습니다. (이동한 자원 예약 ${r.data.movedReservations}건)`); reload(); }
        break;
      }
      case 'duplicate': {
        const r = await formModal({ title: '업무 복제', subtitle: '정보와 체크리스트를 복사해 새 업무를 만듭니다.', values: { title: `${t.title} (복제)`, startAt: new Date(new Date(t.startAt).getTime() + 7 * 86400000).toISOString(), endAt: new Date(new Date(t.endAt).getTime() + 7 * 86400000).toISOString() },
          fields: [{ name: 'title', label: '업무명', full: true }, { name: 'startAt', label: '시작', type: 'datetime', required: true }, { name: 'endAt', label: '종료', type: 'datetime', required: true }],
          submitLabel: '복제', onSubmit: (v) => api.post(`${base}/duplicate`, v) });
        if (r) { toast.ok('업무를 복제했습니다.'); location.href = `/tasks/${r.data.id}`; }
        break;
      }
      case 'delete':
        run(() => api.del(base), { confirm: { title: '업무 삭제', message: '배정·자원 이력이 없는 업무만 삭제할 수 있습니다. 삭제하시겠습니까?', danger: true, confirmLabel: '삭제' }, success: '삭제했습니다.', then: () => { location.href = '/tasks'; } });
        break;
      case 'assign': {
        const candidates = await candidateOptions();
        if (!candidates.length) return toast('일정이 비어 있는 배정 가능 구성원이 없습니다. (정지·탈퇴·시간 중복 제외)', 'bad');
        const r = await formModal({ title: '구성원 배정', subtitle: '상태(BR-02)와 시간 중복(BR-03)을 통과한 후보만 추천됩니다. 기술 적합도·업무량 순.', size: 'lg',
          fields: [{ name: 'memberId', label: '구성원', type: 'select', required: true, full: true, options: candidates, numeric: true },
            { name: 'taskRole', label: '업무 내 역할', placeholder: '예) 경비, 운전' }, { name: 'instructions', label: '지시사항', type: 'textarea', full: true }],
          submitLabel: '배정', onSubmit: (v) => api.post(`${base}/assignments`, v) });
        if (r) { toast.ok('배정했습니다. 대상자에게 알림이 전송되었습니다.'); reload(); }
        break;
      }
      case 'edit-assign': {
        const r = await formModal({ title: `${assignee.name} 배정 정보`, values: assignee,
          fields: [{ name: 'taskRole', label: '업무 내 역할', full: true, emptyAsNull: true }, { name: 'instructions', label: '지시사항', type: 'textarea', full: true, emptyAsNull: true }],
          onSubmit: (v) => api.patch(`${base}/assignments/${m}`, v) });
        if (r) { toast.ok('저장했습니다.'); reload(); }
        break;
      }
      case 'replace': {
        const candidates = await candidateOptions();
        if (!candidates.length) return toast('교체 가능한 구성원이 없습니다.', 'bad');
        const r = await formModal({ title: `${assignee.name} 교체`, subtitle: '기존 배정 해제와 신규 배정이 하나의 트랜잭션으로 처리됩니다.',
          fields: [{ name: 'newMemberId', label: '새 구성원', type: 'select', required: true, full: true, options: candidates, numeric: true }, { name: 'reason', label: '사유', full: true }],
          submitLabel: '교체', onSubmit: (v) => api.post(`${base}/assignments/${m}/replace`, v) });
        if (r) { toast.ok('교체했습니다.'); reload(); }
        break;
      }
      case 'unassign': {
        const r = await formModal({ title: `${assignee.name} 배정 해제`, danger: true, fields: [{ name: 'reason', label: '사유', full: true }], submitLabel: '해제',
          onSubmit: (v) => api.del(`${base}/assignments/${m}`, v) });
        if (r) { toast.ok('배정을 해제했습니다.'); reload(); }
        break;
      }
      case 'participation': {
        const r = await formModal({ title: `${assignee.name} 참여 기록`, subtitle: '이미 기록된 값의 수정은 Underboss 이상만 가능합니다 (BR-06).', values: { attendance: assignee.attendance || 'PRESENT', contribution: assignee.contribution === null ? 80 : assignee.contribution },
          fields: [{ name: 'attendance', label: '출석', type: 'select', required: true, options: App.opts('attendance') }, { name: 'contribution', label: '기여도 (0~100)', type: 'number', required: true, min: 0, max: 100 }, { name: 'note', label: '메모', full: true }],
          onSubmit: (v) => api.put(`${base}/assignments/${m}/participation`, v) });
        if (r) { toast.ok('참여 기록을 저장했습니다.'); reload(); }
        break;
      }
      case 'conflicts': {
        const r = await api.get(`${base}/conflicts`);
        const d = r.data;
        modal({ title: '충돌 점검', subtitle: '참여자 일정 중복(BR-03)과 자원 중복(BR-07)을 점검합니다.',
          body: d.ok ? html`<div class="notice info">${icon('checkCircle')}<div>충돌이 없습니다.</div></div>` : html`<div class="notice bad">${icon('alert')}<div>구성원 충돌 ${d.memberConflicts.length}건, 자원 충돌 ${d.resourceConflicts.length}건</div></div>
            <pre class="mono" style="white-space:pre-wrap;font-size:12px">${JSON.stringify(d, null, 2)}</pre>`,
          actions: [{ label: '닫기', onClick: ({ close }) => close() }] });
        break;
      }
      case 'allocate': {
        const av = await api.get('/api/resources/available', { startAt: t.startAt, endAt: t.endAt });
        if (!av.data.length) return toast('이 업무 시간에 사용 가능한 자원이 없습니다.', 'bad');
        const r = await formModal({ title: '자원 배정', subtitle: `${fmt.range(t.startAt, t.endAt)} 에 사용 가능한 자원 (사용 불가·중복 제외)`,
          fields: [{ name: 'resourceId', label: '자원', type: 'select', required: true, full: true, numeric: true, options: av.data.map((x) => ({ value: x.id, label: `${x.code} ${x.name} · ${x.typeName}${x.crewName ? ` · ${x.crewName}` : ''}` })) },
            { name: 'purpose', label: '사용 목적', full: true }],
          submitLabel: '배정', onSubmit: (v) => api.post('/api/allocations', { ...v, taskId: t.id }) });
        if (r) { toast.ok('자원을 배정했습니다.'); reload(); }
        break;
      }
      case 'checkout': run(() => api.post(`/api/allocations/${al}/checkout`), { success: '자원 사용을 시작했습니다.', then: reload }); break;
      case 'return': {
        const r = await formModal({ title: '자원 반납', fields: [{ name: 'condition', label: '반납 상태', type: 'select', required: true, value: 'GOOD', options: [{ value: 'GOOD', label: '정상' }, { value: 'DAMAGED', label: '파손 (점검 필요로 전환)' }, { value: 'LOST', label: '분실 (사용 불가로 전환)' }] }, { name: 'note', label: '메모', full: true }],
          submitLabel: '반납', onSubmit: (v) => api.post(`/api/allocations/${al}/return`, v) });
        if (r) { toast.ok('반납했습니다.'); reload(); }
        break;
      }
      case 'cancel-alloc': run(() => api.del(`/api/allocations/${al}`), { confirm: { title: '예약 취소', message: '자원 예약을 취소하시겠습니까?', danger: true }, success: '예약을 취소했습니다.', then: reload }); break;
      case 'accept': run(() => api.post(`/api/me/assignments/${b.dataset.a}/accept`), { success: '배정을 수락했습니다.', then: () => { App.refreshInbox(); reload(); } }); break;
      case 'decline': {
        const r = await formModal({ title: '배정 거절', subtitle: 'Crew 책임자에게 알림이 전송됩니다.', danger: true, fields: [{ name: 'reason', label: '거절 사유', type: 'textarea', required: true, full: true }], submitLabel: '거절', onSubmit: (v) => api.post(`/api/me/assignments/${b.dataset.a}/decline`, v) });
        if (r) { toast.ok('배정을 거절했습니다.'); App.refreshInbox(); reload(); }
        break;
      }
      case 'del-item': run(() => api.del(`${base}/checklist/${b.dataset.item}`), { then: reload }); break;
      case 'del-comment': run(() => api.del(`${base}/comments/${b.dataset.c}`), { confirm: { title: '코멘트 삭제', message: '삭제하시겠습니까?', danger: true }, then: () => loadComments(t) }); break;
      default:
    }
  });

  await load();
});
