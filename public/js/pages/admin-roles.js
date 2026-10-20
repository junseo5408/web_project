App.page(async (root) => {
  const { html, raw, icon, api, setHTML, $, $$, on, L, toast, run } = App;
  const ROLES = ['ASSOCIATE', 'SOLDIER', 'CAPO', 'UNDERBOSS', 'BOSS', 'ADMINISTRATOR'];
  const CAT = { MEMBER: '구성원', CREW: 'Crew', TASK: '업무', RESOURCE: '자원', EVALUATION: '평가', ADMIN: '관리' };
  let original = {};

  async function load() {
    const [roles, perms] = await Promise.all([api.get('/api/roles'), api.get('/api/permissions')]);
    original = Object.fromEntries(ROLES.map((r) => [r, perms.data.filter((p) => p.roles.includes(r)).map((p) => p.code)]));
    const cats = [...new Set(perms.data.map((p) => p.category))];
    setHTML(root, html`
      <div class="page-head"><div><h1>권한 관리</h1><p>역할별 권한 코드를 지정합니다. 변경 사항은 저장 즉시 모든 API 의 서버 측 권한 검사에 반영됩니다.</p></div>
        <div class="actions"><button class="btn" data-act="revert">${icon('refresh')}되돌리기</button><button class="btn primary" data-act="save" disabled>${icon('check')}변경 사항 저장</button></div></div>
      <div class="grid g-4" style="margin-bottom:16px">${roles.data.map((r) => html`<div class="card kpi"><div class="label">Lv.${r.level} · ${L.role[r.code]}</div><div class="value">${r.permissionCount}</div><div class="hint">권한 코드 · 구성원 ${r.memberCount}명</div></div>`)}</div>
      <div class="notice info" style="margin-bottom:16px">${icon('shield')}<div>권한 코드는 "무엇을 할 수 있는가"를, 관리 범위(담당·감독 Crew)는 "어디까지 할 수 있는가"를 결정합니다. Administrator 의 관리 필수 권한은 해제할 수 없습니다.</div></div>
      <div class="card"><div class="table-wrap"><table class="tbl matrix"><thead><tr><th>권한 코드</th><th>설명</th>${ROLES.map((r) => html`<th>${L.role[r]}</th>`)}</tr></thead><tbody>
        ${cats.map((c) => html`<tr><td colspan="8" style="background:#fafbfc;font-weight:700;font-size:12px;color:var(--muted)">${CAT[c] || c}</td></tr>
          ${perms.data.filter((p) => p.category === c).map((p) => html`<tr><td class="mono">${p.code}</td><td>${p.description}</td>
            ${ROLES.map((r) => html`<td><input type="checkbox" class="pc" data-role="${r}" data-perm="${p.code}" ${p.roles.includes(r) ? raw('checked') : ''} style="width:16px;height:16px;accent-color:var(--brand)"></td>`)}</tr>`)}`)}
      </tbody></table></div></div>`);
  }

  const current = () => Object.fromEntries(ROLES.map((r) => [r, $$(`.pc[data-role="${r}"]:checked`, root).map((i) => i.dataset.perm)]));
  const changed = () => ROLES.filter((r) => current()[r].slice().sort().join() !== original[r].slice().sort().join());

  on(root, 'change', '.pc', () => { $('[data-act="save"]', root).disabled = !changed().length; });
  on(root, 'click', '[data-act="revert"]', () => load());
  on(root, 'click', '[data-act="save"]', async () => {
    const roles = changed();
    const cur = current();
    await run(async () => { for (const r of roles) await api.put(`/api/roles/${r}/permissions`, { permissions: cur[r] }); }, {
      confirm: { title: '권한 변경 저장', message: `${roles.map((r) => L.role[r]).join(', ')} 역할의 권한이 변경됩니다. 해당 역할 사용자에게 즉시 적용됩니다.` },
      success: '권한을 저장했습니다. (감사 로그에 기록됨)',
      then: load,
    });
  });
  await load();
  void toast;
});
