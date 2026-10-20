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

  /* ---------- login form (shown when there is no session) ---------- */
  let loginShown = false;
  function showLogin() {
    if (loginShown) return new Promise(() => {});
    loginShown = true;
    const box = document.createElement('div');
    box.setAttribute('data-noi18n', '');
    box.style.cssText = 'position:fixed;inset:0;z-index:999;display:grid;place-items:center;background:rgba(16,20,22,.72);padding:16px';
    box.innerHTML = `<form style="background:#fff;color:#1a1f23;border-radius:12px;padding:24px;width:100%;max-width:360px;display:flex;flex-direction:column;gap:12px;font:14px system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.3)">
      <b style="font-size:1.2rem">CRM Panel Plus</b>
      <span style="color:#5d666d">Đăng nhập / Sign in</span>
      <label style="display:flex;flex-direction:column;gap:4px">Tên đăng nhập / Username<input name="u" autocomplete="username" required style="padding:8px 10px;border:1px solid #c5cbcf;border-radius:8px;font:inherit"></label>
      <label style="display:flex;flex-direction:column;gap:4px">Mật khẩu / Password<input name="p" type="password" autocomplete="current-password" required style="padding:8px 10px;border:1px solid #c5cbcf;border-radius:8px;font:inherit"></label>
      <div data-msg style="color:#9c4a1f;min-height:1.2em"></div>
      <button style="padding:9px;border:0;border-radius:8px;background:#2f3d46;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer">Đăng nhập / Sign in</button></form>`;
    document.body.appendChild(box);
    const f = box.querySelector('form'), msg = box.querySelector('[data-msg]');
    fetch('/api/setup').then(r => r.json()).then(r => { if (!r.hasUsers) msg.textContent = 'Chưa có tài khoản. Tạo admin bằng biến ADMIN_USER / ADMIN_PASSWORD hoặc lệnh create-user.'; }).catch(() => {});
    f.querySelector('input').focus();
    f.onsubmit = async ev => {
      ev.preventDefault(); msg.textContent = '';
      try {
        const r = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: f.u.value, password: f.p.value }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { msg.textContent = j.message || ('Lỗi ' + r.status); return; }
        location.reload();
      } catch (_) { msg.textContent = 'Không kết nối được máy chủ / Server unreachable'; }
    };
    return new Promise(() => {});   // the page waits until the reload after login
  }
  function showWho(m) {
    const anchor = document.querySelector('.lang-sw') || document.querySelector('.brand');
    if (!anchor || document.getElementById('crm-who')) return;
    const el = document.createElement('div');
    el.id = 'crm-who'; el.setAttribute('data-noi18n', '');
    el.style.cssText = 'font-size:.74rem;color:var(--side-fg,#aab);padding:0 8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center';
    el.innerHTML = '<span></span><a href="#" style="color:inherit">Đăng xuất / Log out</a>';
    el.querySelector('span').textContent = m.username + ' (' + m.role + ')';
    el.querySelector('a').onclick = async e => { e.preventDefault(); try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) {} location.reload(); };
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
