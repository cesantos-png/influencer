// API do Hub de influencers no Cloudflare.
// Substitui o banco (db), o usuário (user) e os arquivos (assets) do runtime do claude.ai.
// Login: "Entrar com Google" (só os domínios de ALLOWED_DOMAINS), sessão guardada no D1.
// Banco: D1. Mídia kits: KV.

import indexHtml from "../public/index.html";
import importarHtml from "../public/importar.html";

const MAX_UPLOAD = 20 * 1024 * 1024;
const SESSION_DAYS = 30;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") return page(indexHtml);
      if (url.pathname === "/importar.html") return page(importarHtml);
      if (url.pathname === "/api/config") return json({ googleClientId: env.GOOGLE_CLIENT_ID || "", domains: allowedDomains(env) });
      if (url.pathname === "/api/login" && req.method === "POST") return login(req, env);
      if (url.pathname === "/api/logout" && req.method === "POST") return logout(req, env);

      const email = await sessionEmail(req, env);
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
      return json({ error: "não encontrado" }, 404);
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

/* ---------- Login com Google ---------- */
function allowedDomains(env) {
  return String(env.ALLOWED_DOMAINS || "ahi.com.br").toLowerCase().split(/[\s,;]+/).filter(Boolean);
}
const cookieOf = (req, name) => ((req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)")) || [])[1];

async function sessionEmail(req, env) {
  const id = cookieOf(req, "hub_sess");
  if (!id) return null;
  return env.DB.prepare("SELECT email FROM sessions WHERE id = ? AND expires > ?").bind(id, Date.now()).first("email");
}

async function login(req, env) {
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "GOOGLE_CLIENT_ID não configurado" }, 503);
  const { credential } = await req.json();
  const claims = await verifyGoogleToken(String(credential || ""), env.GOOGLE_CLIENT_ID);
  if (!claims) return json({ error: "Login do Google inválido. Tente de novo." }, 401);
  const email = String(claims.email || "").toLowerCase();
  const domain = email.split("@")[1];
  if (!claims.email_verified || !allowedDomains(env).includes(domain))
    return json({ error: `Use uma conta ${allowedDomains(env).map(d => "@" + d).join(" ou ")}.` }, 403);
  const id = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires < ?").bind(Date.now()),
    env.DB.prepare("INSERT INTO sessions (id, email, expires) VALUES (?, ?, ?)").bind(id, email, Date.now() + SESSION_DAYS * 86400_000),
  ]);
  return json({ email }, 200, { "set-cookie": `hub_sess=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` });
}

async function logout(req, env) {
  const id = cookieOf(req, "hub_sess");
  if (id) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, { "set-cookie": "hub_sess=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
}

let googleKeys = { at: 0, keys: [] };
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));

async function verifyGoogleToken(token, clientId) {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64u(h)));
    claims = JSON.parse(new TextDecoder().decode(b64u(p)));
  } catch { return null; }
  if (Date.now() - googleKeys.at > 3600_000 || !googleKeys.keys.some(k => k.kid === header.kid)) {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    googleKeys = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = googleKeys.keys.find(k => k.kid === header.kid);
  if (!jwk || header.alg !== "RS256") return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(s), new TextEncoder().encode(h + "." + p))) return null;
  if (claims.aud !== clientId) return null;
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") return null;
  if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
  return claims;
}

function page(html) {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
}
