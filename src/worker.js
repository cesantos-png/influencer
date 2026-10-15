// API do Hub de influencers no Cloudflare.
// Substitui o banco (db), o usuário (user) e os arquivos (assets) do runtime do claude.ai.
// Login: Cloudflare Access. Banco: D1. Mídia kits: KV.

const MAX_UPLOAD = 20 * 1024 * 1024;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      const email = await verifyAccess(req, env);
      if (!email) return json({ error: "não autenticado" }, 401);
      const me = { email, admin: isAdmin(email, env) };

      if (url.pathname === "/api/me") return json(me);
      if (url.pathname === "/api/sync" && req.method === "POST") return sync(req, env, me);
      if (url.pathname === "/api/doc") return docRoute(req, env, me, url.searchParams.get("path") || "");
      if (url.pathname === "/api/import" && req.method === "POST") return importDocs(req, env, me);
      if (url.pathname === "/api/assets" && req.method === "POST") return upload(req, env, me);
      if (url.pathname.startsWith("/api/assets/") && req.method === "DELETE") {
        if (!me.admin) return json({ error: "sem permissão" }, 403);
        await env.BLOBS.delete(decodeURIComponent(url.pathname.slice(12)));
        return json({ ok: true });
      }
      if (url.pathname.startsWith("/_blob/") && req.method === "GET") {
        const { value, metadata } = await env.BLOBS.getWithMetadata(decodeURIComponent(url.pathname.slice(7)), "stream");
        if (!value) return new Response("Arquivo não encontrado", { status: 404 });
        return new Response(value, { headers: {
          "content-type": metadata?.type || "application/octet-stream",
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(metadata?.name || "arquivo")}`,
          "cache-control": "private, max-age=3600",
        } });
      }
      if (url.pathname.startsWith("/api/")) return json({ error: "rota inexistente" }, 404);
      return env.ASSETS.fetch(req);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

/* ---------- Permissões ---------- */
function isAdmin(email, env) {
  return String(env.ADMINS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean).includes(email);
}
function validPath(p) {
  const s = p.split("/");
  return p.length > 0 && p.length < 400 && s.length >= 2 && s.every(x => x && x !== "." && x !== "..");
}
function canRead(path, me) {
  const s = path.split("/");
  if (s[0] === "data" && s[1] === "users") return s[2] === me.email;
  return true;
}
function canWrite(path, me) {
  const s = path.split("/");
  if (s[0] === "data" && s[1] === "users") return s[2] === me.email;
  if (s[0] === "agenda" || s[0] === "interesses") return true;
  return me.admin;
}

/* ---------- Banco ---------- */
const split = path => { const i = path.lastIndexOf("/"); return [path.slice(0, i), path.slice(i + 1)]; };
const version = async env => (await env.DB.prepare("SELECT v FROM meta WHERE k='version'").first("v")) || 0;
const bump = env => env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='version'");

async function sync(req, env, me) {
  const { cols = [], docs = [], since = -1 } = await req.json();
  const v = await version(env);
  if (v === since) return json({ v, same: true });
  const out = { v, cols: {}, docs: {} };
  for (const c of cols) {
    if (!validPath(c + "/x") || !canRead(c + "/x", me)) { out.cols[c] = null; continue; }
    const { results } = await env.DB.prepare("SELECT id, data FROM docs WHERE col = ? ORDER BY id").bind(c).all();
    out.cols[c] = results.map(r => ({ id: r.id, data: JSON.parse(r.data) }));
  }
  for (const d of docs) {
    if (!validPath(d) || !canRead(d, me)) { out.docs[d] = null; continue; }
    const r = await env.DB.prepare("SELECT data FROM docs WHERE path = ?").bind(d).first("data");
    out.docs[d] = r == null ? { exists: false } : { exists: true, data: JSON.parse(r) };
  }
  return json(out);
}

async function docRoute(req, env, me, path) {
  if (!validPath(path)) return json({ error: "caminho inválido" }, 400);
  if (req.method === "GET") {
    if (!canRead(path, me)) return json({ error: "sem permissão" }, 403);
    const r = await env.DB.prepare("SELECT data FROM docs WHERE path = ?").bind(path).first("data");
    return json(r == null ? { exists: false } : { exists: true, data: JSON.parse(r) });
  }
  if (!canWrite(path, me)) return json({ error: "sem permissão" }, 403);
  if (req.method === "DELETE") {
    await env.DB.batch([env.DB.prepare("DELETE FROM docs WHERE path = ?").bind(path), bump(env)]);
    return json({ ok: true });
  }
  let data = await req.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) return json({ error: "dados inválidos" }, 400);
  if (req.method === "PATCH") {
    const cur = await env.DB.prepare("SELECT data FROM docs WHERE path = ?").bind(path).first("data");
    if (cur == null) return json({ error: "documento não existe" }, 404);
    data = { ...JSON.parse(cur), ...data };
  } else if (req.method !== "PUT") return json({ error: "método inválido" }, 405);
  const body = JSON.stringify(data);
  if (body.length > 900_000) return json({ error: "documento grande demais" }, 413);
  const [col, id] = split(path);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO docs (path, col, id, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
      .bind(path, col, id, body, Date.now()),
    bump(env),
  ]);
  return json({ ok: true });
}

async function importDocs(req, env, me) {
  if (!me.admin) return json({ error: "sem permissão" }, 403);
  const { docs = [] } = await req.json();
  const stmts = [];
  for (const d of docs) {
    if (!d || !validPath(String(d.path)) || typeof d.data !== "object") continue;
    const [col, id] = split(d.path);
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO docs (path, col, id, data, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(d.path, col, id, JSON.stringify(d.data), Date.now()));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await bump(env).run();
  return json({ ok: true, importados: stmts.length });
}

/* ---------- Arquivos ---------- */
async function upload(req, env, me) {
  if (!me.admin) return json({ error: "sem permissão" }, 403);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return json({ error: "arquivo vazio" }, 400);
  if (buf.byteLength > MAX_UPLOAD) return json({ error: "arquivo maior que 20 MB" }, 413);
  const id = crypto.randomUUID().replace(/-/g, "");
  const type = req.headers.get("content-type") || "application/octet-stream";
  const name = decodeURIComponent(req.headers.get("x-file-name") || "arquivo");
  await env.BLOBS.put(id, buf, { metadata: { type, name } });
  return json({ id, sizeBytes: buf.byteLength });
}

/* ---------- Cloudflare Access (verificação do JWT) ---------- */
let certCache = { at: 0, keys: [] };
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));

async function verifyAccess(req, env) {
  const team = String(env.ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!team || !env.ACCESS_AUD) return null;
  const cookie = (req.headers.get("cookie") || "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  const token = req.headers.get("cf-access-jwt-assertion") || (cookie && cookie[1]);
  if (!token) return null;
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const header = JSON.parse(new TextDecoder().decode(b64u(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64u(p)));
  if (Date.now() - certCache.at > 3600_000 || !certCache.keys.some(k => k.kid === header.kid)) {
    const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
    certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = certCache.keys.find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(s), new TextEncoder().encode(h + "." + p));
  if (!ok) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== `https://${team}`) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  return payload.email ? String(payload.email).toLowerCase() : null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
