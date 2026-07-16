// Relais serveur Le Copy Quiz → API GoHighLevel.
// Reçoit l'optin du quiz et, via l'API GHL v2 :
//   1) crée / met à jour le contact (+ tags)
//   2) ajoute une remarque avec le récap des réponses (quiz_recap)
//   3) crée une opportunité dans le bon stage selon la source (ads → Quiz Ads, orga → Quiz Orga)
//
// Le token reste 100% côté serveur. Fonction serverless Vercel (fetch global, zéro dépendance).
//
// Variable d'env Vercel (Project → Settings → Environment Variables) :
//   GHL_TOKEN  (obligatoire) — Private Integration GHL, scopes Contacts + Opportunités (lecture/écriture)

import crypto from "node:crypto";

const GHL = "https://services.leadconnectorhq.com";
const LOCATION_ID = "2lB0paK192CFU1cLz5eT";
const META_PIXEL_ID = "5402493899974994";
const PIPELINE_NAME = "Formations / Coaching";
const STAGE_BY_SOURCE = { ads: "Quiz Ads", orga: "Quiz Orga" };

const ALLOWED_HOST = /(^|\.)(lecopyquiz\.com|solcopywriting\.com)$/;
const VERCEL_HOST = /\.vercel\.app$/;
const LOCAL_HOST = /^localhost(:\d+)?$/;

function originHost(req) {
  try { return new URL(req.headers.origin).host; }
  catch { return req.headers.host || ""; }
}

function ghlHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Version": "2021-07-28",
    "Content-Type": "application/json",
    "Accept": "application/json",
    // Sans User-Agent "navigateur", Cloudflare bloque le fetch serveur (erreur 1010 browser_signature_banned).
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };
}

// Meta Conversions API — event Lead côté serveur, dédupliqué avec le pixel via event_id.
// Token en env (META_CAPI_TOKEN). Données perso hashées SHA-256 (exigence Meta).
function sha256(v) { return crypto.createHash("sha256").update(String(v || "").trim().toLowerCase()).digest("hex"); }
function normPhone(p) {
  let d = String(p || "").replace(/[^0-9]/g, "");
  if (d.length === 10 && d.startsWith("0")) d = "33" + d.slice(1); // FR : 0X… → 33X…
  return d;
}
async function sendMetaCAPI(body, req) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token || !body.event_id) return false;
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
      event_name: "Lead",
      event_time: Math.floor(Date.now() / 1000),
      event_id: body.event_id,
      action_source: "website",
      event_source_url: body.event_source_url || "",
      user_data,
      custom_data: { content_name: "Le Copy Quiz", currency: "EUR", value: 0 },
    }],
    access_token: token,
  };
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    return r.ok;
  } catch { return false; }
}

// Slack — notif dans le canal #prospects-quiz à chaque optin. Webhook en env.
async function sendSlack(url, payload) {
  if (!url) return false;
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return r.ok;
  } catch { return false; }
}
const MATHIEU = "U0B0X1BU9PA"; // setter — tagué sur chaque notif
function slackProspectPayload({ firstName, email, phone, source, profileName, recap }) {
  const blocks = [
    { type: "header", text: { type: "plain_text", text: "🆕 Nouveau prospect (quiz)", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `👋 <@${MATHIEU}> — nouveau prospect à contacter` } },
    { type: "section", fields: [
      { type: "mrkdwn", text: `*👤 Prénom*\n${firstName || "—"}` },
      { type: "mrkdwn", text: `*🏷️ Profil*\n${profileName || "—"}` },
      { type: "mrkdwn", text: `*✉️ Email*\n${email || "—"}` },
      { type: "mrkdwn", text: `*📱 WhatsApp*\n${phone || "—"}` },
      { type: "mrkdwn", text: `*🎯 Source*\n${source || "direct"}` },
    ] },
  ];
  if (recap) {
    const quoted = String(recap).split("\n").map((l) => "> " + l).join("\n").slice(0, 2900);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "*📝 Récap des réponses*\n" + quoted } });
  }
  return { text: `🆕 Nouveau prospect ${firstName || ""} — ${profileName || ""} (cc <@${MATHIEU}>)`.trim(), blocks };
}

// Résolution pipeline + stages par NOM (pas besoin d'IDs en dur). Mise en cache entre invocations chaudes.
let pipelineCache = null;
async function resolvePipeline(token) {
  if (pipelineCache) return pipelineCache;
  const r = await fetch(`${GHL}/opportunities/pipelines?locationId=${LOCATION_ID}`, { headers: ghlHeaders(token) });
  const data = await r.json();
  const pipelines = data.pipelines || [];
  const pl = pipelines.find(p => (p.name || "").trim().toLowerCase() === PIPELINE_NAME.toLowerCase()) || pipelines[0];
  if (!pl) throw new Error("Pipeline introuvable");
  const stages = {};
  (pl.stages || []).forEach(s => { stages[(s.name || "").trim().toLowerCase()] = s.id; });
  pipelineCache = { pipelineId: pl.id, stages };
  return pipelineCache;
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const token = process.env.GHL_TOKEN;
  if (!token) { res.status(503).json({ error: "GHL_TOKEN non configuré côté serveur." }); return; }

  const host = originHost(req);
  if (host && !(ALLOWED_HOST.test(host) || VERCEL_HOST.test(host) || LOCAL_HOST.test(host))) {
    res.status(403).json({ error: "Origine non autorisée." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const firstName = String(body.firstName || "").trim();
  const email = String(body.email || "").trim();
  const phone = String(body.phone || "").trim();
  if (!email && !phone) { res.status(400).json({ error: "email ou phone requis." }); return; }

  const source = String(body.quiz_source || "direct").toLowerCase();
  const stageName = STAGE_BY_SOURCE[source] || STAGE_BY_SOURCE.orga; // défaut : Quiz Orga
  const profileName = body.quiz_profile_name || "";
  const recap = body.quiz_recap || "";

  try {
    // 1) Upsert contact
    const tags = ["Le Copy Quiz", "quiz:" + source];
    if (body.quiz_profile_code) tags.push("profil:" + body.quiz_profile_code);
    const cRes = await fetch(`${GHL}/contacts/upsert`, {
      method: "POST",
      headers: ghlHeaders(token),
      body: JSON.stringify({ locationId: LOCATION_ID, firstName, name: firstName, email, phone, source: "Le Copy Quiz", tags }),
    });
    const cData = await cRes.json();
    const contactId = (cData.contact && cData.contact.id) || cData.id;
    if (!contactId) { res.status(502).json({ error: "Upsert contact échoué", detail: cData }); return; }

    // 2) Remarque avec le récap des réponses (→ onglet Remarques du contact)
    let noteOk = false;
    if (recap) {
      try {
        const nRes = await fetch(`${GHL}/contacts/${contactId}/notes`, {
          method: "POST", headers: ghlHeaders(token), body: JSON.stringify({ body: recap }),
        });
        noteOk = nRes.ok;
      } catch { /* non bloquant */ }
    }

    // 3) Opportunité dans le bon stage
    let opportunityId = null, stageUsed = null, opportunityError = null;
    try {
      const pl = await resolvePipeline(token);
      const stageId = pl.stages[stageName.toLowerCase()];
      if (!stageId) {
        opportunityError = `Stage "${stageName}" introuvable dans "${PIPELINE_NAME}"`;
      } else {
        const oRes = await fetch(`${GHL}/opportunities/`, {
          method: "POST",
          headers: ghlHeaders(token),
          body: JSON.stringify({
            pipelineId: pl.pipelineId,
            locationId: LOCATION_ID,
            pipelineStageId: stageId,
            name: `${firstName || email || "Lead"} — Le Copy Quiz${profileName ? ` (${profileName})` : ""}`,
            status: "open",
            contactId,
          }),
        });
        const oData = await oRes.json();
        opportunityId = (oData.opportunity && oData.opportunity.id) || oData.id || null;
        stageUsed = stageName;
        if (!opportunityId) opportunityError = oData;
      }
    } catch (e) { opportunityError = String((e && e.message) || e); }

    const capiOk = await sendMetaCAPI(body, req);
    const slackOk = await sendSlack(process.env.SLACK_WEBHOOK_PROSPECTS, slackProspectPayload({ firstName, email, phone, source, profileName, recap }));

    res.status(200).json({ ok: true, contactId, noteOk, capiOk, slackOk, opportunityId, stage: stageUsed, opportunityError });
  } catch (e) {
    res.status(502).json({ error: "Relais GHL indisponible.", detail: String((e && e.message) || e) });
  }
}
