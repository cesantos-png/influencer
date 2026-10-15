// Recria window.claude.use("db" | "user" | "assets" | "mcp") sobre a API do Worker,
// para que o Hub rode no Cloudflare sem mudar a lógica da página.
(function () {
  const POLL_MS = 8000;

  function err(code, message) { const e = new Error(message || code); e.code = code; return e; }
  async function api(method, url, body, headers) {
    let r;
    try {
      r = await fetch(url, { method, credentials: "same-origin", headers: body instanceof Blob ? headers : { "content-type": "application/json", ...headers }, body: body == null ? undefined : body instanceof Blob ? body : JSON.stringify(body) });
    } catch (e) { throw err("unavailable", "sem conexão"); }
    if (r.status === 401) throw err("revoked", "sessão expirada");
    if (r.status === 403) throw err("invalid_argument", "sem permissão");
    if (r.status >= 500) throw err("unavailable", "erro no servidor");
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw err("failed", data.error || "erro " + r.status);
    return data;
  }

  /* ---------- Assinaturas (polling único para todas) ---------- */
  const listeners = new Set();
  let version = -1, timer = null, running = false, again = false;

  async function poll() {
    if (running) { again = true; return; }
    running = true;
    try {
      const cols = [...new Set([...listeners].filter(l => l.kind === "col").map(l => l.path))];
      const docs = [...new Set([...listeners].filter(l => l.kind === "doc").map(l => l.path))];
      if (!cols.length && !docs.length) return;
      const res = await api("POST", "/api/sync", { cols, docs, since: version });
      if (res.same) return;
      version = res.v;
      for (const l of listeners) {
        const raw = l.kind === "col" ? res.cols[l.path] : res.docs[l.path];
        if (raw === undefined) { version = -1; again = true; continue; }
        if (raw === null) { l.onErr && l.onErr(err("invalid_argument", "sem permissão")); continue; }
        const key = JSON.stringify(raw);
        if (key === l.last) continue;
        l.last = key;
        l.cb(l.kind === "col" ? colSnap(raw) : docSnap(l.path, raw));
      }
    } catch (e) {
      for (const l of listeners) l.onErr && l.onErr(e);
    } finally {
      running = false;
      if (again) { again = false; setTimeout(poll, 0); }
    }
  }
  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => { if (document.visibilityState === "visible") poll(); }, POLL_MS);
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(); });

  function subscribe(kind, path, cb, onErr) {
    const l = { kind, path, cb, onErr, last: null };
    listeners.add(l);
    version = -1;
    poll();
    if (!timer) schedule();
    return () => listeners.delete(l);
  }

  /* ---------- Snapshots e referências ---------- */
  const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
  function docSnap(path, raw) {
    const id = path.slice(path.lastIndexOf("/") + 1);
    return { id, exists: !!raw.exists, data: () => raw.exists ? clone(raw.data) : undefined };
  }
  function colSnap(list) {
    const docs = list.map(d => ({ id: d.id, exists: true, data: () => clone(d.data) }));
    return { docs, size: docs.length, empty: !docs.length };
  }
  const afterWrite = r => { poll(); return r; };
  const q = p => "/api/doc?path=" + encodeURIComponent(p);

  function docRef(path) {
    return {
      id: path.slice(path.lastIndexOf("/") + 1),
      path,
      get: async () => docSnap(path, await api("GET", q(path))),
      set: data => api("PUT", q(path), data).then(afterWrite),
      update: data => api("PATCH", q(path), data).then(afterWrite),
      delete: () => api("DELETE", q(path)).then(afterWrite),
      onSnapshot: (cb, onErr) => subscribe("doc", path, cb, onErr),
    };
  }
  function colRef(path) {
    return {
      path,
      doc: id => docRef(path + "/" + id),
      get: async () => colSnap((await api("POST", "/api/sync", { cols: [path], docs: [], since: -1 })).cols[path] || []),
      onSnapshot: (cb, onErr) => subscribe("col", path, cb, onErr),
    };
  }

  /* ---------- Capacidades ---------- */
  let mePromise = null;
  const me = () => mePromise || (mePromise = api("GET", "/api/me").catch(e => { mePromise = null; throw e; }));

  const caps = {
    db: async () => { await me(); return { doc: docRef, collection: colRef }; },
    user: async () => {
      const m = await me();
      return { id: async () => m.email, email: async () => m.email, canEdit: async () => m.admin, can: async () => true };
    },
    assets: async () => {
      const m = await me();
      if (!m.admin) return null;
      return {
        upload: (file, opts = {}) => api("POST", "/api/assets", file, { "content-type": opts.type || file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name || "arquivo") }),
        delete: id => api("DELETE", "/api/assets/" + encodeURIComponent(id)),
      };
    },
    mcp: async () => null,
  };

  window.claude = {
    use: name => caps[name] ? caps[name]().catch(() => null) : Promise.resolve(null),
  };
})();
