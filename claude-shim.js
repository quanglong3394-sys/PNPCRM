/* Bridges the CRM page to this server.
   The page was built on claude.ai, where it asks `window.claude.use(name)` for
   db / user / assets / downloads. This file provides the same calls on top of
   the Flask API, so index.html runs unchanged on your own server. */
(() => {
  'use strict';
  const POLL_MS = 3000;
  const err = (code, message) => Object.assign(new Error(message || code), { code });
  async function api(method, url, body, headers) {
    const opt = { method, credentials: 'same-origin', headers: Object.assign({}, headers) };
    if (body !== undefined) {
      if (body instanceof FormData) opt.body = body;
      else { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    }
    let r;
    try { r = await fetch(url, opt); } catch (e) { throw err('unavailable', 'network error'); }
    if (r.status === 401) { if (url !== '/api/me') showLogin(); throw err('unauthenticated'); }   // session expired: ask again
    if (r.status === 403) throw err('invalid_argument', 'read only');   // the page treats this as "view only"
    if (r.status === 404) throw err('not_found');
    if (r.status === 409) throw err('conflict');
    if (r.status === 413) throw err('too_large');
    if (r.status === 415) throw err('unsupported_type');
    if (!r.ok) throw err('internal', 'HTTP ' + r.status);
    return r.json();
  }
  const enc = encodeURIComponent;
  const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 20);

  /* ---------- live refresh: one poller, many listeners ---------- */
  const listeners = new Set();
  let seq = 0, timer = null;
  async function poll() {
    try {
      const r = await api('GET', '/api/changes?since=' + seq);
      if (r.seq !== seq) {
        const cols = new Set(r.collections); seq = r.seq;
        listeners.forEach(l => { if (cols.has(l.collection)) l.refresh(); });
      }
    } catch (_) { /* keep polling */ }
    timer = setTimeout(poll, POLL_MS);
  }
  // after this browser writes, refresh that collection at once (no waiting for the poll)
  async function notify(collection) {
    await Promise.all([...listeners].filter(l => l.collection === collection).map(l => l.refresh()));
  }
  function listen(l) { listeners.add(l); if (!timer) timer = setTimeout(poll, POLL_MS); l.refresh(); return () => listeners.delete(l); }

  /* ---------- db ---------- */
  function docRef(collection, id) {
    const url = '/api/docs/' + enc(collection) + '/' + enc(id);
    return {
      id, path: collection + '/' + id,
      async get() { try { const d = await api('GET', url); return snapDoc(d, true); } catch (e) { if (e.code === 'not_found') return snapDoc({ id, data: null }, false); throw e; } },
      set: async data => { await api('PUT', url, data); await notify(collection); },
      update: async data => { await api('PATCH', url, data); await notify(collection); },
      delete: async () => { await api('DELETE', url); await notify(collection); },
      onSnapshot(next, onErr) {
        const ref = this;
        return listen({ collection, refresh: async () => {
          try { next(await ref.get()); } catch (e) { onErr && onErr(e); }
        } });
      }
    };
  }
  const snapDoc = (d, exists) => ({ id: d.id, exists, data: () => (d.data ? JSON.parse(JSON.stringify(d.data)) : undefined), version: d.version });
  function query(collection, opts) {
    const q = Object.assign({ limit: 1000 }, opts);
    const url = () => '/api/collections/' + enc(collection) + '?limit=' + q.limit + (q.orderBy ? '&order_by=' + enc(q.orderBy) + '&direction=' + (q.dir || 'asc') : '');
    return {
      doc: id => docRef(collection, id || newId()),
      limit: n => query(collection, Object.assign({}, q, { limit: n })),
      orderBy: (field, dir) => query(collection, Object.assign({}, q, { orderBy: field, dir: dir || 'asc' })),
      async get() { const r = await api('GET', url()); if (!seq) seq = r.seq; return { docs: r.docs.map(d => snapDoc(d, true)), size: r.docs.length, empty: !r.docs.length }; },
      onSnapshot(next, onErr) {
        const self = this;
        return listen({ collection, refresh: async () => {
          try { next(await self.get()); } catch (e) { onErr && onErr(e); }
        } });
      }
    };
  }
  const db = {
    collection: name => query(name, {}),
    doc: path => { const p = String(path).split('/'); return docRef(p.slice(0, -1).join('/'), p[p.length - 1]); }
  };

  /* ---------- user ---------- */
  let mePromise = null;
  const me = () => (mePromise = mePromise || api('GET', '/api/me'));
  const user = {
    async can(name) { const m = await me(); return name === 'data.write' ? m.canWrite : null; },
    async canEdit() { return (await me()).canEdit; },
    async isOwner() { return (await me()).role === 'admin'; },
    async id() { return 'u_' + (await me()).username; },
    async me() { const m = await me(); return { id: 'u_' + m.username, name: m.username }; },
    async profiles(ids) { const out = {}; (ids || []).forEach(i => out[i] = { id: i, name: String(i).replace(/^u_/, '') }); return out; }
  };

  /* ---------- assets ---------- */
  const assets = {
    async upload(blob, opts) {
      const fd = new FormData();
      fd.append('file', blob, blob.name || 'file');
      if (opts && opts.type) fd.append('type', opts.type);
      return api('POST', '/api/assets', fd);
    },
    delete: id => api('DELETE', '/api/assets/' + enc(id)).then(() => undefined),
    async list() { return { assets: [], usage: null }; }
  };

  /* ---------- downloads ---------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename || 'download';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      return { status: 'saved' };
    }
  };

  /* ---------- login / first-run setup / accounts (plain DOM, bilingual) ---------- */
  const CSS_BOX = 'position:fixed;inset:0;z-index:999;display:grid;place-items:center;background:rgba(16,20,22,.72);padding:12px;overflow:auto';
  const CSS_CARD = 'background:#fff;color:#1a1f23;border-radius:12px;padding:24px;width:100%;max-width:380px;display:flex;flex-direction:column;gap:12px;font:14px system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.3)';
  const CSS_IN = 'padding:10px 12px;min-height:44px;border:1px solid #c5cbcf;border-radius:8px;font:16px system-ui,sans-serif;background:#fff;color:#1a1f23';
  const CSS_BTN = 'min-height:44px;padding:10px 14px;border:0;border-radius:8px;background:#2f3d46;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer';
  const CSS_BTN2 = 'min-height:40px;padding:8px 12px;border:1px solid #c5cbcf;border-radius:8px;background:#fff;color:#1a1f23;font:500 13px system-ui,sans-serif;cursor:pointer';
  const ROLE_LABEL = { admin: 'Quản trị / Admin', editor: 'Người dùng (nhập liệu) / User', viewer: 'Chỉ xem / Viewer' };
  const escH = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const field = (label, name, type, extra) => `<label style="display:flex;flex-direction:column;gap:4px">${label}<input name="${name}" type="${type || 'text'}" ${extra || ''} style="${CSS_IN}"></label>`;
  function overlay(inner, wide) {
    const box = document.createElement('div');
    box.setAttribute('data-noi18n', ''); box.style.cssText = CSS_BOX;
    box.innerHTML = `<div style="${CSS_CARD};${wide ? 'max-width:720px' : ''}">${inner}</div>`;
    document.body.appendChild(box);
    return box;
  }
  async function post(url, body, method) {
    const r = await fetch(url, { method: method || 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.message || ('Lỗi ' + r.status)), { status: r.status });
    return j;
  }

  let loginShown = false;
  function showLogin() {
    if (loginShown) return new Promise(() => {});
    loginShown = true;
    fetch('/api/setup').then(r => r.json()).then(st => st.hasUsers ? loginForm() : setupForm(st.needsToken)).catch(() => loginForm());
    return new Promise(() => {});   // the page waits until the reload after login
  }
  function loginForm(mode) {
    const reg = mode === 'register';
    const tab = (on, label, m) => `<button type="button" data-mode="${m}" style="flex:1;padding:8px;border:0;border-bottom:2px solid ${on ? '#2f3d46' : 'transparent'};background:none;font:600 14px system-ui,sans-serif;color:${on ? '#1a1f23' : '#7b858c'};cursor:pointer">${label}</button>`;
    const box = overlay(`<form style="display:flex;flex-direction:column;gap:12px">
      <b style="font-size:1.2rem">CRM Panel Plus</b>
      <div style="display:flex;border-bottom:1px solid #e5e8ea">${tab(!reg, 'Đăng nhập / Sign in', 'login')}${tab(reg, 'Đăng ký / Sign up', 'register')}</div>
      ${reg ? field('Họ tên / Full name', 'n', 'text', 'autocomplete="name" required maxlength="120"') : ''}
      ${field('Tên đăng nhập / Username', 'u', 'text', 'autocomplete="username" required' + (reg ? ' pattern="[A-Za-z0-9_.\\-]+" title="chữ không dấu, số, . _ -"' : ''))}
      ${field('Mật khẩu / Password' + (reg ? ' (≥ 8)' : ''), 'p', 'password', (reg ? 'autocomplete="new-password" minlength="8"' : 'autocomplete="current-password"') + ' required')}
      ${reg ? field('Nhập lại mật khẩu / Repeat password', 'p2', 'password', 'autocomplete="new-password" required minlength="8"') : ''}
      ${reg ? '<div style="color:#5d666d;font-size:12px">Sau khi đăng ký, admin sẽ duyệt và phân quyền cho tài khoản. / An admin approves new accounts and sets their role.</div>' : ''}
      <div data-msg style="color:#9c4a1f;min-height:1.2em"></div>
      <button style="${CSS_BTN}">${reg ? 'Gửi đăng ký / Sign up' : 'Đăng nhập / Sign in'}</button></form>`);
    const f = box.querySelector('form'), msg = box.querySelector('[data-msg]');
    box.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { box.remove(); loginForm(b.dataset.mode); });
    (f.n || f.u).focus();
    f.onsubmit = async ev => { ev.preventDefault(); msg.textContent = ''; msg.style.color = '#9c4a1f';
      try {
        if (!reg) { await post('/api/login', { username: f.u.value, password: f.p.value }); location.reload(); return; }
        if (f.p.value !== f.p2.value) { msg.textContent = 'Hai mật khẩu không khớp / Passwords differ'; return; }
        const r = await post('/api/register', { username: f.u.value.trim(), password: f.p.value, fullName: f.n.value.trim() });
        if (r.status === 'active') { location.reload(); return; }
        box.remove(); loginForm('login');
        const m2 = document.querySelector('[data-msg]'); if (m2) { m2.style.color = '#4b6630'; m2.textContent = r.message || 'Đã gửi đăng ký, chờ admin duyệt.'; }
      } catch (e) { msg.textContent = e.message; } };
  }
  function setupForm(needsToken) {
    const box = overlay(`<form style="display:flex;flex-direction:column;gap:12px">
      <b style="font-size:1.2rem">CRM Panel Plus · Cài đặt lần đầu</b>
      <span style="color:#5d666d">Chưa có tài khoản nào. Tạo tài khoản <b>quản trị (admin)</b> đầu tiên. Sau đó vào mục “Tài khoản” để tạo thêm người dùng.<br><i>First run: create the admin account.</i></span>
      ${needsToken ? field('Mã cài đặt / Setup token (SETUP_TOKEN)', 't', 'password', 'required') : ''}
      ${field('Tên đăng nhập admin / Admin username', 'u', 'text', 'autocomplete="username" required pattern="[A-Za-z0-9_.\\-]+" title="chữ không dấu, số, . _ -"')}
      ${field('Mật khẩu (tối thiểu 8 ký tự) / Password', 'p', 'password', 'autocomplete="new-password" required minlength="8"')}
      ${field('Nhập lại mật khẩu / Repeat password', 'p2', 'password', 'autocomplete="new-password" required minlength="8"')}
      <div data-msg style="color:#9c4a1f;min-height:1.2em"></div>
      <button style="${CSS_BTN}">Tạo admin & đăng nhập / Create admin</button></form>`);
    const f = box.querySelector('form'), msg = box.querySelector('[data-msg]');
    f.u.focus();
    f.onsubmit = async ev => { ev.preventDefault(); msg.textContent = '';
      if (f.p.value !== f.p2.value) { msg.textContent = 'Hai mật khẩu không khớp / Passwords differ'; return; }
      try { await post('/api/setup', { username: f.u.value.trim(), password: f.p.value, token: f.t ? f.t.value : undefined }); location.reload(); }
      catch (e) { msg.textContent = e.message; if (e.status === 409) setTimeout(() => location.reload(), 1200); } };
    const sw = document.createElement('div');
    sw.innerHTML = '<a href="#" style="color:#5d666d;font-size:12px">Đã có tài khoản? Đăng nhập / Sign in</a>';
    sw.querySelector('a').onclick = e => { e.preventDefault(); box.remove(); loginForm('login'); };
    f.appendChild(sw);
  }
  function passwordForm() {
    const box = overlay(`<form style="display:flex;flex-direction:column;gap:12px">
      <b style="font-size:1.1rem">Đổi mật khẩu / Change password</b>
      ${field('Mật khẩu hiện tại / Current', 'c', 'password', 'autocomplete="current-password" required')}
      ${field('Mật khẩu mới (≥ 8 ký tự) / New', 'p', 'password', 'autocomplete="new-password" required minlength="8"')}
      <div data-msg style="color:#9c4a1f;min-height:1.2em"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" data-x style="${CSS_BTN2}">Hủy / Cancel</button><button style="${CSS_BTN}">Lưu / Save</button></div></form>`);
    const f = box.querySelector('form'), msg = box.querySelector('[data-msg]');
    box.querySelector('[data-x]').onclick = () => box.remove();
    f.onsubmit = async ev => { ev.preventDefault(); msg.textContent = '';
      try { await post('/api/me/password', { current: f.c.value, password: f.p.value }); box.remove(); alertBox('Đã đổi mật khẩu / Password changed'); }
      catch (e) { msg.textContent = e.message; } };
  }
  function alertBox(text) { const b = overlay(`<div>${escH(text)}</div><div style="text-align:right"><button style="${CSS_BTN}">OK</button></div>`); b.querySelector('button').onclick = () => b.remove(); }
  async function accountsForm(meName) {
    const box = overlay(`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b style="font-size:1.1rem">Tài khoản / Accounts</b><button data-x style="${CSS_BTN2}">Đóng / Close</button></div>
      <div style="color:#5d666d;font-size:13px"><b>Quản trị</b>: toàn quyền, gồm duyệt tài khoản, phân quyền, chuyển CTKM, sao lưu. <b>Người dùng</b>: nhập và sửa dữ liệu. <b>Chỉ xem</b>: xem, không sửa. Tài khoản tự đăng ký nằm ở trạng thái <b>Chờ duyệt</b> cho tới khi bạn bấm Duyệt.</div>
      <div data-list style="overflow:auto"></div>
      <form style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;align-items:end;border-top:1px solid #e5e8ea;padding-top:12px">
        ${field('Tên đăng nhập / Username', 'u', 'text', 'required pattern="[A-Za-z0-9_.\\-]+" title="chữ không dấu, số, . _ -"')}
        ${field('Họ tên / Full name', 'n', 'text', 'maxlength="120"')}
        ${field('Mật khẩu (≥ 8) / Password', 'p', 'password', 'autocomplete="new-password" minlength="8"')}
        <label style="display:flex;flex-direction:column;gap:4px">Vai trò / Role<select name="r" style="${CSS_IN}">${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${k === 'editor' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <button style="${CSS_BTN}">Tạo / Lưu · Save</button></form>
      <div data-msg style="color:#9c4a1f;min-height:1.2em;font-size:13px"></div>
      <div style="color:#5d666d;font-size:12px">Nhập tên đã có để đổi vai trò; điền mật khẩu để đặt lại mật khẩu cho người đó. / Enter an existing name to change role or reset password.</div>`, true);
    const list = box.querySelector('[data-list]'), msg = box.querySelector('[data-msg]'), f = box.querySelector('form');
    box.querySelector('[data-x]').onclick = () => box.remove();
    async function draw() {
      try {
        const { users } = await post('/api/users', undefined, 'GET');
        const ST = { pending: 'Chờ duyệt / Pending', active: 'Hoạt động / Active', disabled: 'Khóa / Disabled' };
        const ST_COLOR = { pending: '#a8711c', active: '#4b6630', disabled: '#9c4a1f' };
        list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:left;color:#5d666d"><th style="padding:6px">Tài khoản / Account</th><th style="padding:6px">Vai trò / Role</th><th style="padding:6px">Trạng thái / Status</th><th></th></tr></thead><tbody>${users.map(u => `<tr style="border-top:1px solid #eceeef;${u.status === 'pending' ? 'background:#fbf5ea' : ''}">
          <td style="padding:6px"><b>${escH(u.username)}</b>${u.username === meName ? ' <span style="color:#5d666d">(bạn / you)</span>' : ''}<div style="color:#5d666d">${escH(u.full_name || '')}${u.full_name ? ' · ' : ''}${escH(String(u.created_at || '').slice(0, 10))}</div></td>
          <td style="padding:6px"><select data-role="${escH(u.username)}" ${u.username === meName ? 'disabled' : ''} style="${CSS_IN};padding:4px 6px">${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${k === (u.status === 'pending' ? 'editor' : u.role) ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
          <td style="padding:6px"><select data-status="${escH(u.username)}" ${u.username === meName ? 'disabled' : ''} style="${CSS_IN};padding:4px 6px;color:${ST_COLOR[u.status] || '#1a1f23'}">${Object.entries(ST).map(([k, v]) => `<option value="${k}" ${k === u.status ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
          <td style="padding:6px;text-align:right;white-space:nowrap">${u.status === 'pending' ? `<button data-ok="${escH(u.username)}" style="${CSS_BTN};padding:6px 10px;font-size:13px">Duyệt / Approve</button> ` : ''}${u.username === meName ? '' : `<button data-del="${escH(u.username)}" style="${CSS_BTN2};color:#9c4a1f">Xóa</button>`}</td></tr>`).join('')}</tbody></table>`;
        const pending = users.filter(u => u.status === 'pending').length;
        const badge = document.querySelector('#crm-who [data-a="acc"]'); if (badge) badge.textContent = 'Tài khoản / Accounts' + (pending ? ' (' + pending + ' chờ duyệt)' : '');
        const dot = document.querySelector('#crm-who .who-btn b'); if (dot) { if (pending) dot.textContent = pending; else dot.remove(); }
        const save = async (name, patch, okText) => { msg.textContent = '';
          try { await post('/api/users/' + encodeURIComponent(name), patch, 'PUT'); msg.style.color = '#4b6630'; msg.textContent = okText; }
          catch (e) { msg.style.color = '#9c4a1f'; msg.textContent = e.message; } draw(); };
        list.querySelectorAll('[data-status]').forEach(s => s.onchange = () => save(s.dataset.status, { status: s.value }, 'Đã đổi trạng thái ' + s.dataset.status));
        list.querySelectorAll('[data-ok]').forEach(b => b.onclick = () => { const r = list.querySelector(`[data-role="${b.dataset.ok}"]`);
          save(b.dataset.ok, { status: 'active', role: r ? r.value : 'editor' }, 'Đã duyệt ' + b.dataset.ok + ' với quyền ' + (ROLE_LABEL[r ? r.value : 'editor'] || '')); });
        list.querySelectorAll('[data-role]').forEach(s => s.onchange = () => {
          const u = users.find(x => x.username === s.dataset.role);
          if (u && u.status === 'pending') return;   // pending: the role is applied when you click Approve
          save(s.dataset.role, { role: s.value }, 'Đã đổi vai trò ' + s.dataset.role); });
        list.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { msg.textContent = '';
          if (!confirm('Xóa tài khoản ' + b.dataset.del + '? / Delete this account?')) return;
          try { await post('/api/users/' + encodeURIComponent(b.dataset.del), undefined, 'DELETE'); draw(); } catch (e) { msg.textContent = e.message; } });
      } catch (e) { list.textContent = e.message; }
    }
    f.onsubmit = async ev => { ev.preventDefault(); msg.textContent = '';
      try { await post('/api/users/' + encodeURIComponent(f.u.value.trim()), Object.assign({ role: f.r.value, status: 'active', password: f.p.value || undefined }, f.n.value.trim() ? { fullName: f.n.value.trim() } : {}), 'PUT');
        msg.textContent = 'Đã lưu tài khoản ' + f.u.value.trim() + ' / Saved'; f.reset(); f.r.value = 'editor'; draw(); }
      catch (e) { msg.textContent = e.message; } };
    draw();
  }
  function showWho(m) {
    const anchor = document.querySelector('.lang-sw') || document.querySelector('.brand');
    if (!anchor || document.getElementById('crm-who')) return;
    if (!document.getElementById('crm-who-css')) {
      const st = document.createElement('style'); st.id = 'crm-who-css';
      st.textContent = `#crm-who{font-size:.76rem;color:var(--side-fg,#aab);padding:0 8px}
        #crm-who .who-btn{display:none}
        #crm-who .who-menu{display:flex;gap:4px 10px;flex-wrap:wrap;align-items:center}
        #crm-who .who-menu a{color:inherit}
        #crm-who .who-name{width:100%;color:var(--side-hi,#fff)}
        @media (max-width:860px){
          #crm-who{position:relative;padding:0;flex:none}
          #crm-who .who-btn{display:grid;place-items:center;width:40px;height:40px;border-radius:50%;border:1px solid var(--side-act,#333);
            background:var(--side-act,#2a3339);color:var(--side-hi,#fff);font:700 15px system-ui,sans-serif;cursor:pointer;position:relative}
          #crm-who .who-btn b{position:absolute;top:-3px;right:-3px;min-width:18px;height:18px;border-radius:9px;background:#c99a55;color:#1a1408;font-size:11px;display:grid;place-items:center;padding:0 4px}
          #crm-who .who-menu{display:none;position:absolute;right:0;top:48px;z-index:60;flex-direction:column;align-items:stretch;gap:2px;
            min-width:240px;padding:8px;border-radius:14px;background:var(--surface,#fff);color:var(--ink,#111);border:1px solid var(--line,#ddd);box-shadow:0 12px 32px rgba(0,0,0,.28)}
          #crm-who.open .who-menu{display:flex}
          #crm-who .who-name{padding:10px 12px;border-bottom:1px solid var(--line,#ddd);color:var(--muted,#666);font-size:.85rem}
          #crm-who .who-menu a{display:block;padding:13px 12px;border-radius:10px;text-decoration:none;font-size:.95rem;font-weight:600;color:var(--ink,#111)}
          #crm-who .who-menu a:active{background:var(--surface-2,#f3f3f3)}
        }`;
      document.head.appendChild(st);
    }
    const el = document.createElement('div');
    el.id = 'crm-who'; el.setAttribute('data-noi18n', '');
    const label = (ROLE_LABEL[m.role] || m.role).split(' / ')[0];
    el.innerHTML = `<button type="button" class="who-btn" aria-label="Tài khoản / Account"></button>
      <div class="who-menu"><span class="who-name"></span>${m.role === 'admin' ? `<a href="#" data-a="acc">Tài khoản / Accounts${m.pendingUsers ? ' (' + m.pendingUsers + ' chờ duyệt)' : ''}</a>` : ''}<a href="#" data-a="pw">Đổi mật khẩu / Password</a><a href="#" data-a="out">Đăng xuất / Log out</a></div>`;
    el.querySelector('.who-name').textContent = m.username + ' · ' + label;
    const btn = el.querySelector('.who-btn');
    btn.textContent = (m.username || '?').slice(0, 1).toUpperCase();
    if (m.pendingUsers) { const b = document.createElement('b'); b.textContent = m.pendingUsers; btn.appendChild(b); }
    btn.onclick = e => { e.stopPropagation(); el.classList.toggle('open'); };
    document.addEventListener('click', e => { if (!el.contains(e.target)) el.classList.remove('open'); });
    el.querySelectorAll('[data-a]').forEach(a => a.onclick = async e => { e.preventDefault(); el.classList.remove('open');
      if (a.dataset.a === 'acc') accountsForm(m.username);
      else if (a.dataset.a === 'pw') passwordForm();
      else { try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) {} location.reload(); } });
    anchor.insertAdjacentElement('afterend', el);
  }

  const caps = { db, user, assets, downloads };
  window.claude = Object.freeze({
    use: async name => {
      if (!(name in caps)) return null;
      try { const m = await me(); showWho(m); }
      catch (e) { mePromise = null; if (e.code === 'unauthenticated') return showLogin(); return null; }
      if (name === 'assets') { try { if (!(await me()).canWrite) return null; } catch (_) { return null; } }
      return caps[name];
    }
  });
})();
