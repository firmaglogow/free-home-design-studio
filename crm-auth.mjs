// Warstwa dostępu FREE HOME dla narzędzia zdjecia.freehome.pl.
// Zamyka aplikację dla ludzi z zewnątrz. Dwa wejścia:
//   • BEZPOŚREDNIO: formularz logowania → hasło APP_PASS → cookie (np. Daria).
//   • PRZEZ CRM:    iframe ...?key=SEKRET → cookie (bez formularza; blokada popupów w iframe nie dotyczy).
// Aktywne, gdy w env jest APP_PASS i/lub APP_KEY. Brak obu = otwarte (dev/lokalnie).
// Użycie: installCrmGuard(app) — jedna linia zaraz po `const app = express()`.
import express from "express";
import { createHash, timingSafeEqual } from "node:crypto";

export function installCrmGuard(app) {
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  const APP_KEY = String(process.env.APP_KEY ?? "").trim();
  const APP_PASS = String(process.env.APP_PASS ?? "").trim();
  const URL_SECRET = APP_KEY || APP_PASS; // ?key= sprawdza APP_KEY; gdy brak — APP_PASS
  const AUTH_ON = Boolean(APP_PASS || APP_KEY);
  const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS ?? "'self' https://crm.freehome.pl";
  const AUTH_COOKIE = "foto_auth";
  const AUTH_TOKEN = AUTH_ON
    ? createHash("sha256").update("foto-auth|" + APP_KEY + "|" + APP_PASS).digest("hex")
    : "";

  function safeEqual(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
  function readCookies(header) {
    const out = {};
    for (const part of String(header || "").split(";")) {
      const i = part.indexOf("=");
      if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }
  function setAuthCookie(req, res) {
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const secure = proto === "https";
    res.setHeader(
      "Set-Cookie",
      `${AUTH_COOKIE}=${AUTH_TOKEN}; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
    );
  }
  function loginPage(bladHasla) {
    return `<!doctype html><html lang="pl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>FREE HOME — logowanie</title><style>
 *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;
 font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
 background:linear-gradient(160deg,#071a0e,#0a2113);color:#f5f1e8;padding:20px}
 .card{background:#0d2618;border:1px solid rgba(197,164,78,.25);border-radius:16px;padding:28px;
 width:min(360px,92vw);box-shadow:0 12px 34px rgba(0,0,0,.45);text-align:center}
 h1{font-size:21px;margin:0 0 4px;letter-spacing:.3px}h1 b{color:#d4b86a}
 p{color:#bfc7bd;font-size:13px;margin:0 0 18px}
 input{width:100%;padding:12px;border-radius:10px;border:1px solid #1a4a2e;background:#071a0e;color:#f5f1e8;font-size:15px}
 input:focus{outline:none;border-color:#c5a44e}
 button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:999px;background:#c5a44e;color:#071a0e;font-weight:800;font-size:15px;cursor:pointer}
 button:hover{background:#d4b86a}
 .err{margin:0 0 14px;padding:9px 11px;border-radius:9px;background:rgba(192,57,43,.18);border:1px solid rgba(231,76,60,.5);font-size:13px}
</style></head><body>
 <form class="card" method="post" action="/login" autocomplete="off">
  <h1>FREE <b>HOME</b></h1>
  <p>Obróbka zdjęć AI — strefa wewnętrzna</p>
  ${bladHasla ? '<div class="err">Błędne hasło. Spróbuj ponownie.</div>' : ""}
  <input type="password" name="haslo" placeholder="Hasło" autofocus autocomplete="current-password" required>
  <button type="submit">Wejdź</button>
 </form>
</body></html>`;
  }

  app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "frame-ancestors " + FRAME_ANCESTORS);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!AUTH_ON) return next(); // brak ochrony (lokalnie/dev)

    // 1) ważne cookie
    const cookies = readCookies(req.headers.cookie);
    if (cookies[AUTH_COOKIE] && safeEqual(cookies[AUTH_COOKIE], AUTH_TOKEN)) return next();

    // 2) ?key= — wejście przez CRM (iframe)
    let urlKey = "";
    try { urlKey = new URL(req.url, "http://x").searchParams.get("key") || ""; } catch { /* ignore */ }
    if (URL_SECRET && urlKey && safeEqual(urlKey, URL_SECRET)) {
      setAuthCookie(req, res);
      return next();
    }

    // 3) POST /login — logowanie hasłem (bezpośrednio, np. Daria)
    if (req.method === "POST" && req.path === "/login") {
      const haslo = String((req.body && req.body.haslo) || "");
      if (APP_PASS && safeEqual(haslo, APP_PASS)) {
        setAuthCookie(req, res);
        res.statusCode = 302;
        res.setHeader("Location", "/");
        res.end();
        return;
      }
      res.status(401).type("text/html; charset=utf-8").send(loginPage(true));
      return;
    }

    // 4) niezalogowany: formularz (strony) albo 401 JSON (API)
    if (req.path.startsWith("/api/")) {
      res.status(401).json({ error: "Wymagane logowanie." });
      return;
    }
    res.status(401).type("text/html; charset=utf-8").send(loginPage(false));
  });
}
