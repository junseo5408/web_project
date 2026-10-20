/* =========================================================================
   The Family — 웹 클라이언트 공통 라이브러리
   모든 화면은 서버의 REST API 를 호출하며, 권한·업무 규칙은 서버에서 검사된다.
   (화면의 버튼 숨김은 편의 기능일 뿐이며 서버가 최종 판단 - NFR-03, BR-09)
   ========================================================================= */
(function () {
  'use strict';

  const DATA = JSON.parse(document.getElementById('app-data').textContent);
  const ME = DATA.user;
  const can = (perm) => [].concat(perm).some((p) => ME.perms.includes(p));

  /* ------------------------------ 템플릿 (자동 이스케이프) ------------------------------ */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => (v === null || v === undefined ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]));
  class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
  const raw = (s) => new Raw(s);
  const out = (v) => (v === null || v === undefined || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(out).join('') : esc(v));
  function html(strings, ...vals) {
    let s = '';
    strings.forEach((str, i) => { s += str; if (i < vals.length) s += out(vals[i]); });
    return raw(s);
  }
  const icon = (name, cls = '') => raw(`<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${window.ICONS[name] || ''}</svg>`);
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const setHTML = (el, h) => { el.innerHTML = out(h); return el; };
  function on(root, event, selector, handler) {
    root.addEventListener(event, (e) => {
      const t = e.target.closest(selector);
      if (t && root.contains(t)) handler(e, t);
    });
  }

  /* ------------------------------ API 클라이언트 ------------------------------ */
  class ApiError extends Error {
    constructor(status, err) { super(err.message || '요청 실패'); this.status = status; this.code = err.code; this.details = err.details; }
  }
  const qs = (params) => {
    const p = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return;
      p.set(k, v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join(',') : v);
    });
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}&error=${encodeURIComponent('세션이 만료되었습니다. 다시 로그인하세요.')}`;
      throw new ApiError(401, { message: '로그인이 필요합니다.' });
    }
    const json = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
    if (!res.ok || (json && json.success === false)) throw new ApiError(res.status, (json && json.error) || { message: `요청 실패 (${res.status})` });
    return json;
  }
  api.get = (url, params) => api('GET', url + qs(params));
  api.post = (url, body) => api('POST', url, body === undefined ? {} : body);
  api.patch = (url, body) => api('PATCH', url, body);
  api.put = (url, body) => api('PUT', url, body);
  api.del = (url, params) => api('DELETE', url + qs(params));

  function errorText(e) {
    if (!(e instanceof ApiError)) return e.message || String(e);
    let msg = e.message;
    if (e.code === 'VALIDATION_ERROR' && Array.isArray(e.details)) msg = e.details.map((d) => d.message).join(' · ');
    return msg;
  }
  const ruleOf = (e) => (e && e.details && !Array.isArray(e.details) && e.details.rule) || null;

  /* ------------------------------ 토스트 ------------------------------ */
  function toast(message, tone = '', rule = null) {
    let box = $('.toasts');
    if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = `toast ${tone}`;
    setHTML(t, html`${icon(tone === 'bad' ? 'alert' : 'checkCircle')}<div>${message}${rule ? html`<span class="rule">${rule}</span>` : ''}</div>`);
    box.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, tone === 'bad' ? 5200 : 3200);
  }
  toast.ok = (m) => toast(m, 'ok');
  toast.error = (e) => toast(errorText(e), 'bad', ruleOf(e));

  /* ------------------------------ 모달 ------------------------------ */
  function modal({ title, subtitle, body, size, actions = [], onMount, dismissable = true }) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    setHTML(back, html`<div class="modal ${size || ''}" role="dialog" aria-modal="true">
      <div class="modal-h"><div><h3>${title}</h3>${subtitle ? html`<p>${subtitle}</p>` : ''}</div>
        <button class="icon-btn x" data-close aria-label="닫기">${icon('x')}</button></div>
      <div class="modal-b">${body}</div>
      ${actions.length ? html`<div class="modal-f">${actions.map((a, i) => html`<button class="btn ${a.kind || ''}" data-i="${i}">${a.label}</button>`)}</div>` : ''}
    </div>`);
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('mousedown', (e) => { if (e.target === back && dismissable) close(); });
    $('[data-close]', back).addEventListener('click', close);
    $$('.modal-f [data-i]', back).forEach((b) => b.addEventListener('click', () => actions[+b.dataset.i].onClick && actions[+b.dataset.i].onClick({ close, el: back, button: b })));
    document.body.appendChild(back);
    const ctx = { close, el: back };
    if (onMount) onMount(ctx);
    const first = $('input, select, textarea', back);
    if (first) setTimeout(() => first.focus(), 30);
    return ctx;
  }

  function confirmDialog({ title, message, confirmLabel = '확인', danger = false }) {
    return new Promise((resolve) => {
      const m = modal({
        title, body: html`<p style="margin:0;color:var(--ink-2)">${message}</p>`,
        actions: [
          { label: '취소', onClick: ({ close }) => { close(); resolve(false); } },
          { label: confirmLabel, kind: danger ? 'danger solid' : 'primary', onClick: ({ close }) => { close(); resolve(true); } },
        ],
      });
      $('[data-close]', m.el).addEventListener('click', () => resolve(false));
    });
  }

  /* ------------------------------ 폼 모달 ------------------------------ */
  const pad = (n) => String(n).padStart(2, '0');
  const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  function fieldHtml(f, value) {
    const id = `f_${f.name}`;
    const req = f.required ? html`<span class="req">*</span>` : '';
    const label = f.label ? html`<label for="${id}">${f.label}${req}</label>` : '';
    const help = f.help ? html`<div class="help">${f.help}</div>` : '';
    const cls = `field ${f.full ? 'full' : ''}`;
    const v = value === undefined || value === null ? '' : value;
    switch (f.type) {
      case 'textarea':
        return html`<div class="${cls}" data-f="${f.name}">${label}<textarea class="input" id="${id}" name="${f.name}" placeholder="${f.placeholder || ''}" rows="${f.rows || 3}">${v}</textarea>${help}<div class="err"></div></div>`;
      case 'select':
        return html`<div class="${cls}" data-f="${f.name}">${label}<select class="input" id="${id}" name="${f.name}">
          ${f.required ? '' : html`<option value="">${f.placeholder || '선택 안 함'}</option>`}
          ${(f.options || []).map((o) => html`<option value="${o.value}" ${String(o.value) === String(v) ? raw('selected') : ''}>${o.label}</option>`)}
          </select>${help}<div class="err"></div></div>`;
      case 'checkbox':
        return html`<div class="${cls}" data-f="${f.name}"><label class="check"><input type="checkbox" name="${f.name}" ${v ? raw('checked') : ''}> ${f.label}</label>${help}<div class="err"></div></div>`;
      case 'multi':
        return html`<div class="${cls}" data-f="${f.name}">${label}<div class="row">${(f.options || []).map((o) => html`<label class="check"><input type="checkbox" name="${f.name}" value="${o.value}" ${[].concat(v || []).includes(o.value) ? raw('checked') : ''}> ${o.label}</label>`)}</div>${help}<div class="err"></div></div>`;
      case 'datetime':
        return html`<div class="${cls}" data-f="${f.name}">${label}<input class="input" type="datetime-local" id="${id}" name="${f.name}" value="${toLocalInput(v)}">${help}<div class="err"></div></div>`;
      case 'html':
        return html`<div class="${cls}">${raw(f.html)}</div>`;
      default:
        return html`<div class="${cls}" data-f="${f.name}">${label}<input class="input" type="${f.type || 'text'}" id="${id}" name="${f.name}" value="${v}" placeholder="${f.placeholder || ''}" ${f.min !== undefined ? raw(`min="${f.min}"`) : ''} ${f.max !== undefined ? raw(`max="${f.max}"`) : ''} ${f.step ? raw(`step="${f.step}"`) : ''} autocomplete="off">${help}<div class="err"></div></div>`;
    }
  }

  function readField(f, root) {
    if (f.type === 'html') return undefined;
    if (f.type === 'checkbox') return $(`[name="${f.name}"]`, root).checked;
    if (f.type === 'multi') return $$(`[name="${f.name}"]:checked`, root).map((i) => i.value);
    const el = $(`[name="${f.name}"]`, root);
    const v = el.value.trim();
    if (v === '') return f.emptyAsNull ? null : undefined;
    if (f.type === 'number' || f.numeric) return Number(v);
    if (f.type === 'datetime') return new Date(v).toISOString();
    return v;
  }

  /** 필드 정의로 폼 모달을 열고, onSubmit 이 성공하면 결과를 resolve. 서버 검증 오류는 필드/배너에 표시 */
  async function formModal({ title, subtitle, fields, values = {}, submitLabel = '저장', danger = false, size, onSubmit, intro }) {
    const resolved = await Promise.all(fields.map(async (f) => (typeof f.options === 'function' ? { ...f, options: await f.options() } : f)));
    return new Promise((resolve) => {
      const body = html`${intro || ''}<div class="notice bad form-error" hidden></div><form class="form-grid" novalidate>${resolved.map((f) => fieldHtml(f, values[f.name] !== undefined ? values[f.name] : f.value))}</form>`;
      const m = modal({
        title, subtitle, body, size,
        actions: [
          { label: '취소', onClick: ({ close }) => { close(); resolve(null); } },
          { label: submitLabel, kind: danger ? 'danger solid' : 'primary', onClick: () => submit() },
        ],
      });
      $('[data-close]', m.el).addEventListener('click', () => resolve(null));
      $('form', m.el).addEventListener('submit', (e) => { e.preventDefault(); submit(); });
      $$('.field:not(.full)', m.el).forEach((el) => { const f = resolved.find((x) => x.name === el.dataset.f); if (f && f.full) el.classList.add('full'); });
      async function submit() {
        const btn = $('.modal-f .btn:last-child', m.el);
        const banner = $('.form-error', m.el);
        $$('.field', m.el).forEach((x) => { x.classList.remove('invalid'); const err = $('.err', x); if (err) err.textContent = ''; });
        banner.hidden = true;
        const data = {};
        for (const f of resolved) {
          const v = readField(f, m.el);
          if (v !== undefined) data[f.name] = v;
          if (f.required && (v === undefined || v === '' || (Array.isArray(v) && !v.length))) {
            const el = $(`[data-f="${f.name}"]`, m.el);
            el.classList.add('invalid'); $('.err', el).textContent = '필수 항목입니다.';
          }
        }
        if ($('.field.invalid', m.el)) return;
        btn.disabled = true;
        const label = btn.innerHTML;
        btn.innerHTML = '<span class="spin"></span>';
        try {
          const result = await onSubmit(data);
          m.close();
          resolve(result === undefined ? true : result);
        } catch (e) {
          btn.disabled = false; btn.innerHTML = label;
          if (e instanceof ApiError && e.code === 'VALIDATION_ERROR' && Array.isArray(e.details)) {
            e.details.forEach((d) => { const el = d.field && $(`[data-f="${d.field}"]`, m.el); if (el) { el.classList.add('invalid'); $('.err', el).textContent = d.message; } });
          }
          setHTML(banner, html`${icon('alert')}<div>${errorText(e)}${ruleOf(e) ? html` <b>(${ruleOf(e)})</b>` : ''}</div>`);
          banner.hidden = false;
        }
      }
    });
  }

  /** 단순 실행 버튼: 확인(선택) → API 호출 → 토스트 → 콜백 */
  async function run(fn, { confirm, success, then } = {}) {
    if (confirm && !(await confirmDialog(confirm))) return false;
    try {
      const r = await fn();
      if (success) toast.ok(success);
      if (then) await then(r);
      return r;
    } catch (e) { toast.error(e); return false; }
  }

  /* ------------------------------ 포맷 / 라벨 ------------------------------ */
  const fmt = {
    date(iso) { if (!iso) return '-'; const d = new Date(iso); return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`; },
    time(iso) { if (!iso) return ''; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; },
    dt(iso) {
      if (!iso) return '-';
      const d = new Date(iso);
      const y = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}.` : '';
      return `${y}${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${fmt.time(iso)}`;
    },
    full(iso) { return iso ? `${fmt.date(iso)} ${fmt.time(iso)}` : '-'; },
    range(a, b) {
      if (!a) return '-';
      const same = new Date(a).toDateString() === new Date(b).toDateString();
      return same ? `${fmt.dt(a)} – ${fmt.time(b)}` : `${fmt.dt(a)} – ${fmt.dt(b)}`;
    },
    rel(iso) {
      if (!iso) return '-';
      const diff = (new Date(iso) - Date.now()) / 1000;
      const a = Math.abs(diff);
      const s = a < 60 ? '방금' : a < 3600 ? `${Math.round(a / 60)}분` : a < 86400 ? `${Math.round(a / 3600)}시간` : a < 86400 * 30 ? `${Math.round(a / 86400)}일` : null;
      if (!s) return fmt.date(iso);
      if (s === '방금') return '방금';
      return diff < 0 ? `${s} 전` : `${s} 후`;
    },
    num: (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('ko-KR')),
    pct: (n) => (n === null || n === undefined ? '-' : `${n}%`),
  };

  const L = {
    role: { ASSOCIATE: 'Associate', SOLDIER: 'Soldier', CAPO: 'Capo', UNDERBOSS: 'Underboss', BOSS: 'Boss', ADMINISTRATOR: 'Administrator' },
    member: { PENDING: ['가입대기', 'warn'], ACTIVE: ['활동중', 'ok'], STANDBY: ['대기', 'info'], SUSPENDED: ['정지', 'bad'], WITHDRAWN: ['탈퇴', ''] },
    task: { PLANNED: ['계획', 'info'], IN_PROGRESS: ['진행중', 'brand'], ON_HOLD: ['보류', 'warn'], COMPLETED: ['완료', 'ok'], CANCELLED: ['취소', ''] },
    priority: { LOW: '낮음', NORMAL: '보통', HIGH: '높음', CRITICAL: '긴급' },
    resource: { AVAILABLE: ['사용 가능', 'ok'], IN_USE: ['사용중', 'info'], NEEDS_INSPECTION: ['점검 필요', 'warn'], MAINTENANCE: ['정비중', 'warn'], UNAVAILABLE: ['사용 불가', 'bad'], RETIRED: ['폐기', ''] },
    alloc: { RESERVED: ['예약', 'info'], IN_USE: ['사용중', 'brand'], RETURNED: ['반납', 'ok'], CANCELLED: ['취소', ''] },
    req: { PENDING: ['대기', 'warn'], APPROVED: ['승인', 'ok'], REJECTED: ['반려', 'bad'], CANCELLED: ['취소', ''] },
    assign: { ASSIGNED: ['응답 대기', 'warn'], ACCEPTED: ['수락', 'ok'], DECLINED: ['거절', 'bad'], REMOVED: ['해제', ''] },
    outcome: { SUCCESS: ['성공', 'ok'], PARTIAL: ['부분 성공', 'warn'], FAILURE: ['실패', 'bad'] },
    crew: { ACTIVE: ['운영중', 'ok'], DISSOLVED: ['해산', ''] },
    meeting: { SCHEDULED: ['예정', 'info'], CANCELLED: ['취소', ''], DONE: ['완료', 'ok'] },
    rsvp: { PENDING: ['미응답', ''], YES: ['참석', 'ok'], NO: ['불참', 'bad'], MAYBE: ['미정', 'warn'] },
    membership: { FORMAL: '정식', AFFILIATE: '준소속' },
    severity: { LOW: ['낮음', ''], MEDIUM: ['보통', 'warn'], HIGH: ['높음', 'bad'] },
    issue: { OPEN: ['미해결', 'bad'], RESOLVED: ['해결', 'ok'] },
    attendance: { PRESENT: '출석', PARTIAL: '부분 참여', ABSENT: '불참' },
    discipline: { WARNING: ['경고', 'warn'], SUSPENSION: ['정지', 'bad'] },
    audit: { SUCCESS: ['성공', 'ok'], DENIED: ['거부', 'bad'] },
    history: { ROLE: '역할', STATUS: '상태', CREW: '소속', EVALUATION: '평가', REPUTATION: '평판', DISCIPLINE: '징계' },
  };
  const opts = (map) => Object.entries(L[map]).map(([value, v]) => ({ value, label: Array.isArray(v) ? v[0] : v }));
  function badge(map, key, extra) {
    const v = L[map] && L[map][key];
    if (!v) return html`<span class="badge">${key || '-'}</span>`;
    const [label, tone] = Array.isArray(v) ? v : [v, ''];
    return html`<span class="badge ${tone}">${label}${extra || ''}</span>`;
  }
  const prio = (p) => html`<span class="prio ${p}">${L.priority[p] || p}</span>`;

  const PALETTE = ['#7c1d2e', '#1d4fd8', '#157f3d', '#a95c06', '#6d28d9', '#0e7490', '#be185d', '#4b5563'];
  function avatar(name, size = '') {
    const s = String(name || '?');
    let h = 0;
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const initials = /[a-zA-Z]/.test(s[0]) ? s.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : s.slice(0, 1);
    return html`<span class="avatar ${size}" style="background:${PALETTE[h % PALETTE.length]}">${initials}</span>`;
  }
  const person = (name, sub, href) => {
    const inner = html`${avatar(name)}<div><b>${name}</b>${sub ? html`<span>${sub}</span>` : ''}</div>`;
    return href ? html`<a class="person" href="${href}" style="color:inherit">${inner}</a>` : html`<div class="person">${inner}</div>`;
  };

  const empty = (title, desc = '', ic = 'inbox') => html`<div class="empty">${icon(ic)}<b>${title}</b>${desc}</div>`;
  const loading = (rows = 4) => html`<div class="loading-block">${Array.from({ length: rows }, (_, i) => html`<div class="skeleton" style="width:${90 - i * 12}%"></div>`)}</div>`;

  /** 알림 등에 저장된 API 경로를 대응하는 화면 경로로 변환 */
  function uiLink(link) {
    if (!link) return null;
    if (!link.startsWith('/api')) return link;
    const rules = [
      [/^\/api\/(?:me\/)?tasks\/(\d+)/, (m) => `/tasks/${m[1]}`], [/^\/api\/crews\/(\d+)/, (m) => `/crews/${m[1]}`],
      [/^\/api\/meetings/, () => '/meetings'], [/^\/api\/allocations/, () => '/allocations'], [/^\/api\/(resource|join|promotion)-requests/, () => '/approvals'],
      [/^\/api\/evaluations/, () => '/evaluations'], [/^\/api\/me/, () => '/me'],
    ];
    for (const [re, fn] of rules) { const m = link.match(re); if (m) return fn(m); }
    return null;
  }

  /* ------------------------------ 페이지 / 상태 ------------------------------ */
  const urlState = {
    get: () => Object.fromEntries(new URLSearchParams(location.search)),
    set(obj) {
      const p = new URLSearchParams();
      Object.entries(obj).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) p.set(k, v); });
      const s = p.toString();
      history.replaceState(null, '', location.pathname + (s ? `?${s}` : '') + location.hash);
    },
  };

  /** 필터 도구모음: defs = [{ name, type: search|select|date, label, options, placeholder }] */
  function filterBar(el, defs, onChange, { sync = true } = {}) {
    const init = sync ? urlState.get() : {};
    setHTML(el, html`${defs.map((d) => {
      const v = init[d.name] !== undefined ? init[d.name] : d.value || '';
      if (d.type === 'select') {
        return html`<select class="input" name="${d.name}" title="${d.label || ''}"><option value="">${d.placeholder || d.label}</option>
          ${d.options.map((o) => html`<option value="${o.value}" ${String(o.value) === String(v) ? raw('selected') : ''}>${o.label}</option>`)}</select>`;
      }
      if (d.type === 'toggle') return html`<label class="check"><input type="checkbox" name="${d.name}" ${v ? raw('checked') : ''}> ${d.label}</label>`;
      if (d.type === 'date') return html`<input class="input" type="date" name="${d.name}" value="${v}" title="${d.label || ''}">`;
      return html`<input class="input grow" type="search" name="${d.name}" value="${v}" placeholder="${d.placeholder || '검색'}">`;
    })}`);
    const values = () => {
      const o = {};
      defs.forEach((d) => {
        const i = $(`[name="${d.name}"]`, el);
        if (d.type === 'toggle') { if (i.checked) o[d.name] = '1'; } else if (i.value) o[d.name] = i.value;
      });
      return o;
    };
    let t;
    const fire = () => { if (sync) urlState.set(values()); onChange(values()); };
    el.addEventListener('input', (e) => { if (e.target.type === 'search') { clearTimeout(t); t = setTimeout(fire, 300); } });
    el.addEventListener('change', (e) => { if (e.target.type !== 'search') fire(); });
    return { values };
  }

  /** 페이지 단위 테이블 (정렬·페이지) */
  class DataTable {
    constructor(el, { url, columns, params = () => ({}), rowHref, onRows, empty: emptyText = '조회된 데이터가 없습니다.', size = 20, sort }) {
      Object.assign(this, { el, url, columns, params, rowHref, onRows, emptyText, size, sort, page: 1 });
      setHTML(el, html`<div class="table-wrap"><table class="tbl"><thead><tr>${columns.map((c, i) => html`<th data-i="${i}" class="${c.sort ? 'sortable' : ''} ${c.cls || ''}" style="${c.width ? `width:${c.width}` : ''}">${c.label}<span class="arrow"></span></th>`)}</tr></thead><tbody></tbody></table></div><div class="pager"></div>`);
      on(el, 'click', 'th.sortable', (e, th) => {
        const key = this.columns[+th.dataset.i].sort;
        this.sort = this.sort === key ? `-${key}` : key;
        this.load(1);
      });
      on(el, 'click', '.pager button[data-p]', (e, b) => this.load(+b.dataset.p));
      if (rowHref) on(el, 'click', 'tbody tr.link', (e, tr) => { if (!e.target.closest('a,button,input,select')) location.href = tr.dataset.href; });
    }
    async load(page = this.page) {
      this.page = page;
      const tbody = $('tbody', this.el);
      setHTML(tbody, html`<tr><td colspan="${this.columns.length}">${loading(3)}</td></tr>`);
      $$('th', this.el).forEach((th) => {
        const k = this.columns[+th.dataset.i].sort;
        $('.arrow', th).textContent = k && this.sort === k ? ' ↑' : k && this.sort === `-${k}` ? ' ↓' : '';
      });
      try {
        const r = await api.get(this.url, { ...this.params(), page, size: this.size, sort: this.sort });
        this.rows = r.data;
        setHTML(tbody, r.data.length
          ? r.data.map((row) => html`<tr class="${this.rowHref ? 'link' : ''}" ${this.rowHref ? raw(`data-href="${esc(this.rowHref(row))}"`) : ''}>${this.columns.map((c) => html`<td class="${c.cls || ''}">${c.render ? c.render(row) : row[c.key]}</td>`)}</tr>`)
          : html`<tr><td colspan="${this.columns.length}">${empty(this.emptyText, '', 'search')}</td></tr>`);
        this.renderPager(r.meta);
        if (this.onRows) this.onRows(r.data, r.meta);
      } catch (e) {
        setHTML(tbody, html`<tr><td colspan="${this.columns.length}">${empty('데이터를 불러오지 못했습니다.', errorText(e), 'alert')}</td></tr>`);
        $('.pager', this.el).innerHTML = '';
      }
    }
    renderPager(meta) {
      if (!meta) { $('.pager', this.el).innerHTML = ''; return; }
      const { page, totalPages, total, size } = meta;
      const from = total ? (page - 1) * size + 1 : 0;
      const to = Math.min(page * size, total);
      const pages = [];
      for (let p = Math.max(1, page - 2); p <= Math.min(totalPages, page + 2); p++) pages.push(p);
      setHTML($('.pager', this.el), html`<span>총 <b>${fmt.num(total)}</b>건 · ${from}–${to}</span>
        <div class="pages"><button data-p="${page - 1}" ${page <= 1 ? raw('disabled') : ''}>‹</button>
        ${pages.map((p) => html`<button data-p="${p}" class="${p === page ? 'on' : ''}">${p}</button>`)}
        <button data-p="${page + 1}" ${page >= totalPages ? raw('disabled') : ''}>›</button></div>`);
    }
  }

  /** 탭 (지연 렌더링, URL hash 유지) */
  function tabs(el, items) {
    const visible = items.filter((t) => t.show !== false);
    const initial = visible.find((t) => `#${t.key}` === location.hash) || visible[0];
    setHTML(el, html`<div class="tabs">${visible.map((t) => html`<button data-k="${t.key}">${t.label}${t.count !== undefined ? html`<span class="n">${t.count}</span>` : ''}</button>`)}</div><div class="tab-pane"></div>`);
    const pane = $('.tab-pane', el);
    const show = async (key) => {
      const t = visible.find((x) => x.key === key);
      $$('.tabs button', el).forEach((b) => b.classList.toggle('on', b.dataset.k === key));
      history.replaceState(null, '', `${location.pathname}${location.search}#${key}`);
      setHTML(pane, loading());
      try { await t.render(pane); } catch (e) {
        setHTML(pane, html`<div class="card">${e.status === 403 ? empty('접근 권한이 없습니다', errorText(e), 'lock') : empty('불러오지 못했습니다.', errorText(e), 'alert')}</div>`);
      }
    };
    on(el, 'click', '.tabs button', (e, b) => show(b.dataset.k));
    show(initial.key);
    return { show, reload: () => show($('.tabs button.on', el).dataset.k) };
  }

  /* ------------------------------ 선택 옵션 로더 ------------------------------ */
  const options = {
    async members(params = {}) {
      const r = await api.get('/api/members', { size: 100, sort: 'name', status: 'ACTIVE,STANDBY', ...params });
      return r.data.map((m) => ({ value: m.id, label: `${m.name} · ${L.role[m.role]}${m.crewName ? ` · ${m.crewName}` : ''}` }));
    },
    async crews(managed = false) {
      const r = managed ? await api.get('/api/crews/managed') : await api.get('/api/crews', { size: 100, status: 'ACTIVE' });
      return r.data.map((c) => ({ value: c.id, label: c.name }));
    },
    async regions() { return (await api.get('/api/regions')).data.map((r) => ({ value: r.id, label: r.name })); },
    async resourceTypes() { return (await api.get('/api/resource-types')).data.map((t) => ({ value: t.code, label: t.name })); },
    roles: (maxLevel = 6) => ['ASSOCIATE', 'SOLDIER', 'CAPO', 'UNDERBOSS', 'BOSS', 'ADMINISTRATOR'].slice(0, maxLevel).map((r) => ({ value: r, label: L.role[r] })),
  };

  /* ------------------------------ 차트 ------------------------------ */
  function chart(canvas, type, data, extra = {}) {
    if (!window.Chart) return null;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = '#6b7280';
    Chart.defaults.borderColor = '#eef0f3';
    data.datasets.forEach((d, i) => {
      const multi = ['doughnut', 'pie', 'polarArea'].includes(type);
      if (!d.backgroundColor) d.backgroundColor = multi ? PALETTE : PALETTE[i % PALETTE.length] + (type === 'line' ? '22' : 'dd');
      if (!d.borderColor && !multi) d.borderColor = PALETTE[i % PALETTE.length];
      if (type === 'line') { d.tension = 0.35; d.fill = d.fill !== undefined ? d.fill : true; d.pointRadius = 3; }
      if (type === 'bar') { d.borderRadius = 5; d.maxBarThickness = 38; }
    });
    return new Chart(canvas, {
      type, data,
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, usePointStyle: true } } },
        ...(['doughnut', 'pie', 'radar'].includes(type) ? {} : { scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { grid: { display: false } } } }),
        ...extra,
      },
    });
  }

  /* ------------------------------ 셸: 상단바 / 검색 / 사이드바 ------------------------------ */
  async function refreshInbox() {
    try {
      const r = await api.get('/api/me/inbox');
      const bell = $('#bell-dot');
      const unread = (r.data.items.find((i) => i.type === 'NOTIFICATION') || {}).count || 0;
      if (bell) { bell.textContent = unread > 99 ? '99+' : unread; bell.hidden = !unread; }
      const nav = $('a[data-nav="approvals"] .count');
      const approvals = r.data.items.filter((i) => ['RESOURCE_REQUEST', 'JOIN_REQUEST', 'PROMOTION_REQUEST'].includes(i.type)).reduce((s, i) => s + i.count, 0);
      if (nav) { nav.textContent = approvals; nav.hidden = !approvals; }
      return r.data;
    } catch (e) { return null; }
  }

  function initSearch() {
    const input = $('#global-search');
    if (!input) return;
    const box = $('#search-results');
    let timer;
    let links = [];
    const routes = { members: (x) => `/members/${x.id}`, crews: (x) => `/crews/${x.id}`, tasks: (x) => `/tasks/${x.id}`, resources: (x) => `/resources/${x.id}` };
    const names = { members: '구성원', crews: 'Crew', tasks: '업무', resources: '자원' };
    const label = { members: (x) => [x.name, L.role[x.role]], crews: (x) => [x.name, x.regionName], tasks: (x) => [x.title, (L.task[x.status] || [])[0]], resources: (x) => [`${x.code} ${x.name}`, (L.resource[x.status] || [])[0]] };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { box.classList.remove('open'); return; }
      timer = setTimeout(async () => {
        try {
          const r = await api.get('/api/search', { q, limit: 5 });
          const groups = Object.entries(r.data.results).filter(([, v]) => v.length);
          setHTML(box, groups.length ? groups.map(([k, list]) => html`<div class="grp">${names[k]}</div>${list.map((x) => { const [a, b] = label[k](x); return html`<a href="${routes[k](x)}"><span>${a}</span><span class="badge plain">${b || ''}</span></a>`; })}`) : html`<div class="empty" style="padding:16px">검색 결과가 없습니다.</div>`);
          links = $$('a', box);
          box.classList.add('open');
        } catch (e) { /* 무시 */ }
      }, 220);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && links[0]) location.href = links[0].href; if (e.key === 'Escape') { box.classList.remove('open'); input.blur(); } });
    document.addEventListener('click', (e) => { if (!e.target.closest('.search')) box.classList.remove('open'); });
    document.addEventListener('keydown', (e) => { if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { e.preventDefault(); input.focus(); } });
  }

  function initShell() {
    const menu = $('#menu-btn');
    if (menu) menu.addEventListener('click', () => $('.sidebar').classList.toggle('open'));
    initSearch();
    refreshInbox();
    setInterval(refreshInbox, 60000);
  }

  /* ------------------------------ 공개 ------------------------------ */
  window.App = {
    ME, DATA, can, html, raw, esc, icon, $, $$, on, setHTML, api, ApiError, errorText, toast, modal, confirmDialog, formModal, run,
    fmt, L, opts, badge, uiLink, prio, avatar, person, empty, loading, urlState, filterBar, DataTable, tabs, options, chart, refreshInbox,
    page(fn) {
      const root = document.getElementById('view');
      Promise.resolve(fn(root, DATA.params || {})).catch((e) => {
        const state = e.status === 403 ? ['접근 권한이 없습니다', 'lock'] : e.status === 404 ? ['대상을 찾을 수 없습니다', 'search'] : ['화면을 불러오지 못했습니다', 'alert'];
        setHTML(root, html`<div class="card" style="margin-top:8vh"><div class="error-page" style="min-height:0;padding:48px 16px"><div>
          ${icon(state[1], 'lg')}<h2 style="margin:10px 0 6px">${state[0]}</h2><p style="color:var(--muted)">${errorText(e)}${ruleOf(e) ? ` (${ruleOf(e)})` : ''}</p>
          <div class="row" style="justify-content:center;margin-top:12px"><button class="btn" data-back>${icon('back')}이전 화면</button><a class="btn primary" href="/dashboard">대시보드</a></div></div></div></div>`);
        const back = $('[data-back]', root);
        if (back) back.addEventListener('click', () => history.back());
      });
    },
  };
  initShell();
})();
