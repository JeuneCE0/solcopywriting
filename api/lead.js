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

const GHL = "https://services.leadconnectorhq.com";
const LOCATION_ID = "2lB0paK192CFU1cLz5eT";
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
  };
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

    res.status(200).json({ ok: true, contactId, noteOk, opportunityId, stage: stageUsed, opportunityError });
  } catch (e) {
    res.status(502).json({ error: "Relais GHL indisponible.", detail: String((e && e.message) || e) });
  }
}
