App.page(async (root) => {
  const { html, icon, api, fmt, setHTML, $, on, formModal, toast, run, DATA, options, empty } = App;

  async function load() {
    const [settings, info, integrity] = await Promise.all([api.get('/api/admin/settings'), api.get('/api/admin/system/info'), api.get('/api/admin/integrity-check')]);
    const s = settings.data;
    const i = info.data;
    const ig = integrity.data;
    const rules = Object.entries(ig.checks).filter(([k]) => k.startsWith('BR-'));
    const infos = Object.entries(ig.checks).filter(([k]) => k.startsWith('info'));
    setHTML(root, html`
      <div class="page-head"><div><h1>시스템 설정</h1><p>운영 정책, 데이터 무결성 점검, 공지 발송, 시스템 정보를 관리합니다.</p></div>
        <div class="actions"><button class="btn" data-act="broadcast">${icon('send')}전체 공지 발송</button></div></div>
      <div class="grid g-2">
        <div class="card"><div class="card-h"><h3>운영 정책</h3><button class="btn sm primary" data-act="settings">${icon('edit')}변경</button></div><div class="card-b"><dl class="dl" style="grid-template-columns:220px 1fr">
          <dt>1인 최대 동시 진행 업무</dt><dd><b>${s.maxActiveAssignmentsPerMember}</b>건</dd>
          <dt>로그인 연속 실패 잠금</dt><dd><b>${s.loginLockThreshold}</b>회</dd>
          <dt>평가 작성자 수정 가능 시간</dt><dd><b>${s.evaluationEditWindowHours}</b>시간</dd>
          <dt>자원 사용 요청 자동 만료</dt><dd><b>${s.resourceRequestAutoExpireHours}</b>시간</dd>
          <dt>최근 변경</dt><dd>${s.updatedBy || '-'} · ${s.updatedAt ? fmt.full(s.updatedAt) : '-'}</dd></dl></div></div>
        <div class="card"><div class="card-h"><h3>업무 규칙 무결성 점검</h3><button class="btn sm" data-act="recheck">${icon('refresh')}다시 점검</button></div><div class="card-b">
          <div class="notice ${ig.ok ? 'info' : 'bad'}" style="margin-bottom:12px">${icon(ig.ok ? 'checkCircle' : 'alert')}<div>${ig.ok ? '저장된 모든 데이터가 업무 규칙을 만족합니다.' : '업무 규칙 위반 데이터가 있습니다.'} <span style="opacity:.7">(${fmt.full(ig.checkedAt)})</span></div></div>
          <ul class="list" style="border:1px solid var(--line);border-radius:8px">${rules.map(([k, v]) => html`<li><div class="grow"><div class="title">${k}</div></div><span class="badge ${v.length ? 'bad' : 'ok'}">${v.length ? `${v.length}건 위반` : '이상 없음'}</span></li>`)}
            ${infos.map(([k, v]) => html`<li><div class="grow"><div class="title" style="font-weight:500">${k.replace('info: ', '참고: ')}</div></div><span class="badge ${v.length ? 'warn' : ''}">${v.length}건</span></li>`)}</ul></div></div>
      </div>
      <div class="grid g-2 mt">
        <div class="card"><div class="card-h"><h3>${icon('database')} MySQL <span class="sub">${i.mysql.database} · v${i.mysql.version}</span></h3></div><div class="card-b flush"><div class="table-wrap"><table class="tbl"><thead><tr><th>테이블</th><th class="num">행 수</th></tr></thead><tbody>
          ${Object.entries(i.mysql.tables).map(([k, v]) => html`<tr><td class="mono">${k}</td><td class="num">${fmt.num(v)}</td></tr>`)}</tbody></table></div></div></div>
        <div class="card"><div class="card-h"><h3>${icon('database')} MongoDB <span class="sub">${i.mongo.database} · v${i.mongo.version}</span></h3></div><div class="card-b flush"><div class="table-wrap"><table class="tbl"><thead><tr><th>컬렉션</th><th class="num">문서 수</th></tr></thead><tbody>
          ${Object.entries(i.mongo.collections).map(([k, v]) => html`<tr><td class="mono">${k}</td><td class="num">${fmt.num(v)}</td></tr>`)}</tbody></table></div></div></div>
      </div>
      <div class="card mt"><div class="card-h"><h3>서버</h3></div><div class="card-b"><dl class="dl" style="grid-template-columns:160px 1fr">
        <dt>학번 (DB 이름)</dt><dd>${i.studentId}</dd><dt>Node.js</dt><dd>${i.node}</dd><dt>가동 시간</dt><dd>${Math.floor(i.uptimeSeconds / 3600)}시간 ${Math.floor((i.uptimeSeconds % 3600) / 60)}분</dd><dt>REST API</dt><dd>${i.apiCount}개 · <a href="/api-docs" target="_blank">Swagger</a></dd></dl>
        ${DATA.demoMode ? html`<div class="notice warn mt">${icon('alert')}<div style="flex:1"><b>데모 모드</b> — 데모 데이터 초기화가 허용되어 있습니다. 운영 환경에서는 <code>DEMO_MODE=false</code> 로 실행하세요.</div><button class="btn sm danger" data-act="reset">데모 데이터 초기화</button></div>` : ''}
      </div></div>`);
  }

  on(root, 'click', '[data-act]', async (e, b) => {
    const act = b.dataset.act;
    if (act === 'recheck') return load().catch(toast.error);
    if (act === 'settings') {
      const s = (await api.get('/api/admin/settings')).data;
      const r = await formModal({ title: '운영 정책 변경', values: s,
        fields: [{ name: 'maxActiveAssignmentsPerMember', label: '1인 최대 동시 진행 업무 (1~50)', type: 'number', min: 1, max: 50 }, { name: 'loginLockThreshold', label: '로그인 실패 잠금 횟수 (3~20)', type: 'number', min: 3, max: 20 },
          { name: 'evaluationEditWindowHours', label: '평가 수정 가능 시간 (0~720)', type: 'number', min: 0, max: 720 }, { name: 'resourceRequestAutoExpireHours', label: '자원 요청 자동 만료 (1~720)', type: 'number', min: 1, max: 720 }],
        onSubmit: (v) => api.patch('/api/admin/settings', v) });
      if (r) { toast.ok('정책을 저장했습니다.'); load(); }
    }
    if (act === 'broadcast') {
      const crews = await options.crews().catch(() => []);
      const r = await formModal({ title: '공지 알림 발송', size: 'lg',
        fields: [{ name: 'title', label: '제목', required: true, full: true }, { name: 'message', label: '내용', type: 'textarea', required: true, full: true },
          { name: 'roles', label: '대상 역할 (선택 안 하면 전체)', type: 'multi', full: true, options: options.roles() }, { name: 'crewId', label: '대상 Crew', type: 'select', numeric: true, options: crews, placeholder: '전체 Crew' }],
        submitLabel: '발송', onSubmit: (v) => api.post('/api/admin/broadcast', v) });
      if (r) toast.ok(`${r.data.recipients}명에게 발송했습니다.`);
    }
    if (act === 'reset') {
      run(() => api.post('/api/admin/system/reset-demo', { confirm: 'RESET' }), {
        confirm: { title: '데모 데이터 초기화', message: '모든 데이터가 초기 데모 상태로 되돌아갑니다. 되돌릴 수 없습니다.', danger: true, confirmLabel: '초기화' },
        success: '초기화했습니다. 다시 로그인합니다.', then: () => setTimeout(() => { location.href = '/logout'; }, 800),
      });
    }
  });
  await load();
  void empty;
});
