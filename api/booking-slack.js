// Reçoit le webhook GHL « rendez-vous booké » (action Webhook du workflow booking)
// et poste dans le canal Slack #booking-quiz. Protégé par un token en query.
//
// Dans le workflow GHL (trigger « Customer Booked Appointment » sur le calendrier
// du funnel), ajoute une action « Webhook » (POST) vers :
//   https://lecopyquiz.com/api/booking-slack?key=<BOOKING_WEBHOOK_SECRET>
// Payload custom recommandé :
//   { "name":"{{contact.name}}", "email":"{{contact.email}}", "phone":"{{contact.phone}}",
//     "appointment":"{{appointment.start_time}}", "calendar":"{{appointment.calendar_name}}",
//     "tags":"{{contact.tags}}" }  ← tags pour retrouver le profil (profil:pX posé à l'optin)
// (l'endpoint tolère aussi le payload GHL par défaut : contact niché, first_name/last_name…)

async function sendSlack(url, payload) {
  if (!url) return false;
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return r.ok;
  } catch { return false; }
}

function pick(obj, keys) {
  if (!obj) return "";
  for (const k of keys) {
    const v = k.split(".").reduce((o, p) => (o == null ? undefined : o[p]), obj);
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

const MATHIEU = "U0B0X1BU9PA"; // setter — tagué sur chaque notif
const PROFILE_NAMES = { p1: "Le Débutant Ambitieux", p2: "Le Reconverti Motivé", p3: "Le Formé Bloqué", p4: "Le Freelance Instable", p5: "Le Plafond Invisible", p6: "L'Entrepreneur" };
// Le profil vient du tag `profil:pX` posé sur le contact GHL à l'optin (api/lead.js).
function profileFromTags(tags) {
  const s = Array.isArray(tags) ? tags.join(",") : String(tags || "");
  const m = s.match(/profil[:=\s]*?(p[1-6])/i);
  return m ? (PROFILE_NAMES[m[1].toLowerCase()] || m[1]) : "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const secret = process.env.BOOKING_WEBHOOK_SECRET;
  let key = req.query && req.query.key;
  if (!key) { try { key = new URL(req.url, "http://x").searchParams.get("key"); } catch { key = null; } }
  if (secret && key !== secret) { res.status(403).json({ error: "Token invalide." }); return; }

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};
  const c = b.contact || b.customData || b;

  const name = pick(b, ["name", "full_name", "fullName"]) || pick(c, ["name", "full_name", "fullName"]) ||
    [pick(c, ["first_name", "firstName"]), pick(c, ["last_name", "lastName"])].filter(Boolean).join(" ");
  const email = pick(b, ["email"]) || pick(c, ["email"]);
  const phone = pick(b, ["phone"]) || pick(c, ["phone"]);
  const appt = pick(b, ["appointment", "appointment_time", "appointmentTime", "start_time", "startTime", "appointment.start_time", "calendar.startTime", "calendar.start_time"]);
  const calendar = pick(b, ["calendar", "calendar_name", "calendarName", "calendar.calendarName"]);
  const profile = profileFromTags(b.tags || c.tags || pick(b, ["tags"]) || pick(c, ["tags"]));

  const blocks = [
    { type: "header", text: { type: "plain_text", text: "📞 Nouveau call réservé (quiz)", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `👋 <@${MATHIEU}> — call réservé, à confirmer` } },
    { type: "section", fields: [
      { type: "mrkdwn", text: `*👤 Contact*\n${name || "—"}` },
      { type: "mrkdwn", text: `*📅 RDV*\n${appt || "—"}` },
      { type: "mrkdwn", text: `*🏷️ Profil*\n${profile || "—"}` },
      { type: "mrkdwn", text: `*✉️ Email*\n${email || "—"}` },
      { type: "mrkdwn", text: `*📱 WhatsApp*\n${phone || "—"}` },
    ] },
  ];
  if (calendar) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `📆 ${calendar}` }] });

  const ok = await sendSlack(process.env.SLACK_WEBHOOK_BOOKING, { text: `📞 Call réservé — ${name || email || "prospect"} (cc <@${MATHIEU}>)`, blocks });
  res.status(200).json({ ok });
}
