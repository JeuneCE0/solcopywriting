// CAPI serveur — event « Schedule » (call booké), dédupliqué avec le pixel via event_id.
// Appelé par remerciement.html (page atteinte après réservation du call).
// Pas d'écriture GHL ici : le contact/RDV existe déjà côté GHL — on ne fait que l'event Meta.
// Réutilise META_CAPI_TOKEN (env Vercel).

import crypto from "node:crypto";

const META_PIXEL_ID = "5402493899974994";

const ALLOWED_HOST = /(^|\.)(lecopyquiz\.com|solcopywriting\.com)$/;
const VERCEL_HOST = /\.vercel\.app$/;
const LOCAL_HOST = /^localhost(:\d+)?$/;

function originHost(req) {
  try { return new URL(req.headers.origin).host; }
  catch { return req.headers.host || ""; }
}
function sha256(v) { return crypto.createHash("sha256").update(String(v || "").trim().toLowerCase()).digest("hex"); }
function normPhone(p) {
  let d = String(p || "").replace(/[^0-9]/g, "");
  if (d.length === 10 && d.startsWith("0")) d = "33" + d.slice(1); // FR : 0X… → 33X…
  return d;
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const token = process.env.META_CAPI_TOKEN;
  if (!token) { res.status(503).json({ error: "META_CAPI_TOKEN non configuré." }); return; }

  const host = originHost(req);
  if (host && !(ALLOWED_HOST.test(host) || VERCEL_HOST.test(host) || LOCAL_HOST.test(host))) {
    res.status(403).json({ error: "Origine non autorisée." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  if (!body.event_id) { res.status(400).json({ error: "event_id requis." }); return; }

  const ua = req.headers["user-agent"] || "";
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "";
  const user_data = { client_user_agent: ua };
  if (ip) user_data.client_ip_address = ip;
  if (body.email) user_data.em = [sha256(body.email)];
  const ph = normPhone(body.phone);
  if (ph) user_data.ph = [crypto.createHash("sha256").update(ph).digest("hex")];
  if (body.firstName) user_data.fn = [sha256(body.firstName)];
  if (body.fbp) user_data.fbp = body.fbp;
  if (body.fbc) user_data.fbc = body.fbc;

  const payload = {
    data: [{
      event_name: "Schedule",
      event_time: Math.floor(Date.now() / 1000),
      event_id: body.event_id,
      action_source: "website",
      event_source_url: body.event_source_url || "",
      user_data,
      custom_data: { content_name: "Booking call Sol", currency: "EUR", value: 0 },
    }],
    access_token: token,
  };

  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    res.status(200).json({ ok: true, capiOk: r.ok });
  } catch (e) {
    res.status(502).json({ error: "CAPI indisponible.", detail: String((e && e.message) || e) });
  }
}
