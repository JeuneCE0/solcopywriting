// Relais serveur Onboarding « Big Brother » → API GoHighLevel.
// Reçoit les réponses du questionnaire d'onboarding et, via l'API GHL v2 :
//   1) upsert le contact (identifié par email) + tags
//   2) ajoute une remarque (Note) avec le récap complet formaté côté serveur
//
// On passe par l'API (comme api/lead.js) plutôt que par le no-code GHL :
// les balises de note du workflow GHL rejettaient les variables du webhook.
// Ici on construit la note nous-mêmes → contrôle total, zéro balise.
//
// Token 100% serveur. Réutilise GHL_TOKEN (même Private Integration que le quiz).

const GHL = "https://services.leadconnectorhq.com";
const LOCATION_ID = "2lB0paK192CFU1cLz5eT";

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
    // Sans User-Agent "navigateur", Cloudflare bloque le fetch serveur (erreur 1010).
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };
}

// Récap lisible : sections + libellés. Tout champ non listé est ajouté en fin (rien n'est perdu).
const SECTIONS = [
  ["PROFIL", [
    ["age", "Âge"], ["pays", "Pays"], ["ville", "Ville"],
    ["situation_familiale", "Situation familiale"], ["situation_pro", "Situation pro"],
    ["activite", "Activité"], ["activite_autre", "Activité (autre)"],
  ]],
  ["NIVEAU & PARCOURS COPY", [
    ["niveau", "Niveau"], ["copy_depuis", "Fait du copy depuis"], ["formation_anterieure", "Formation antérieure"],
    ["deja_missions", "Déjà des missions"], ["deja_clients", "Déjà des clients"],
    ["deja_abandonne", "Déjà abandonné"], ["abandon_pourquoi", "Pourquoi abandonné"],
    ["ce_qui_a_empeche", "Ce qui l'a empêché"], ["suivi_depuis", "Nous suit depuis"],
  ]],
  ["OBJECTIFS & MOTIVATION", [
    ["objectif_principal", "Objectif principal"], ["objectifs", "Objectifs"], ["objectifs_autre", "Objectifs (autre)"],
    ["pourquoi_maintenant", "Pourquoi maintenant"], ["message_futur", "Message au futur soi"], ["reaction_2mois", "Si rien dans 2 mois"],
  ]],
  ["FREINS & DÉFIS", [
    ["freins", "Freins"], ["freins_autre", "Freins (autre)"],
    ["plus_grand_defi", "Plus grand défi"], ["defi_autre", "Défi (autre)"],
    ["zone_confort", "Zone de confort"], ["face_difficulte", "Face à la difficulté"], ["face_feedback", "Face au feedback"],
  ]],
  ["DISPO & ENGAGEMENT", [
    ["disponibilite", "Disponibilité"], ["autonomie", "Autonomie"], ["engagement", "Engagement /10"], ["accompagnement_pref", "Accompagnement préféré"],
  ]],
  ["POURQUOI NOUS / ACQUISITION", [
    ["pourquoi_bb", "Pourquoi Big Brother"], ["pourquoi_nous", "Pourquoi nous"],
    ["convaincu_par", "Convaincu par"], ["convaincu_par_autre", "Convaincu par (autre)"],
    ["acquisition_canal", "Canal d'acquisition"], ["acquisition_canal_autre", "Canal (autre)"], ["contenu_declencheur", "Contenu déclencheur"],
  ]],
  ["LIENS", [
    ["linkedin", "LinkedIn"], ["site", "Site"], ["reseaux", "Réseaux"],
  ]],
];

function val(v) {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "Oui" : "Non";
  return (v === undefined || v === null) ? "" : String(v);
}

function buildRecap(data) {
  const used = new Set(["_meta", "email", "recap", "prenom", "nom"]);
  const lines = [];
  lines.push(`🎯 ONBOARDING BIG BROTHER — ${val(data.prenom)} ${val(data.nom)}`.trim());
  if (data.email) lines.push(`📧 ${val(data.email)}`);
  for (const [title, fields] of SECTIONS) {
    const seg = [];
    for (const [key, label] of fields) {
      used.add(key);
      const v = val(data[key]).trim();
      if (v) seg.push(`${label} : ${v}`);
    }
    if (seg.length) { lines.push("", `— ${title} —`, ...seg); }
  }
  const confs = [];
  for (let i = 1; i <= 7; i++) { const k = `confirm_${i}`; used.add(k); if (k in data) confs.push(`${i}:${val(data[k])}`); }
  if (confs.length) { lines.push("", "— CONFIRMATIONS —", confs.join(" · ")); }
  // filet de sécurité : tout champ non listé (rien de perdu)
  const extra = [];
  for (const k of Object.keys(data)) {
    if (used.has(k)) continue;
    const v = val(data[k]).trim();
    if (v) extra.push(`${k} : ${v}`);
  }
  if (extra.length) { lines.push("", "— AUTRES —", ...extra); }
  return lines.join("\n");
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

  let data = req.body;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { data = {}; } }
  data = data || {};

  const email = String(data.email || "").trim();
  const firstName = String(data.prenom || "").trim();
  const lastName = String(data.nom || "").trim();
  if (!email) { res.status(400).json({ error: "email requis (ajoute ?email=... au lien d'onboarding)." }); return; }

  const recap = buildRecap(data);

  try {
    // 1) Upsert contact par email
    const cRes = await fetch(`${GHL}/contacts/upsert`, {
      method: "POST",
      headers: ghlHeaders(token),
      body: JSON.stringify({
        locationId: LOCATION_ID,
        email,
        firstName,
        name: [firstName, lastName].filter(Boolean).join(" ") || firstName,
        source: "Onboarding Big Brother",
        tags: ["Onboarding Big Brother", "onboarding-complete"],
      }),
    });
    const cData = await cRes.json();
    const contactId = (cData.contact && cData.contact.id) || cData.id;
    if (!contactId) { res.status(502).json({ error: "Upsert contact échoué", detail: cData }); return; }

    // 2) Remarque avec le récap complet (→ onglet Remarques du contact)
    let noteOk = false;
    try {
      const nRes = await fetch(`${GHL}/contacts/${contactId}/notes`, {
        method: "POST", headers: ghlHeaders(token), body: JSON.stringify({ body: recap }),
      });
      noteOk = nRes.ok;
    } catch { /* non bloquant */ }

    res.status(200).json({ ok: true, contactId, noteOk });
  } catch (e) {
    res.status(502).json({ error: "Relais GHL indisponible.", detail: String((e && e.message) || e) });
  }
}
