// Proxy serveur SOL.IA → Anthropic Messages API.
// Le front (ia/app.html) POST {system, messages, max_tokens} ici ; la clé API
// reste 100% côté serveur. Fonction serverless Vercel (runtime Node, fetch global).
//
// Variables d'env à définir dans Vercel (Project → Settings → Environment Variables) :
//   ANTHROPIC_API_KEY  (obligatoire)
//   ANTHROPIC_MODEL    (optionnel, défaut claude-sonnet-4-6)

const ALLOWED_HOST = /(^|\.)solcopywriting\.com$/;
const VERCEL_HOST = /\.vercel\.app$/;
const LOCAL_HOST = /^localhost(:\d+)?$/;

function originHost(req) {
  try { return new URL(req.headers.origin).host; }
  catch { return req.headers.host || ""; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "ANTHROPIC_API_KEY non configurée côté serveur." });
    return;
  }

  // Garde anti-abus basique : seulement depuis nos domaines.
  const host = originHost(req);
  if (host && !(ALLOWED_HOST.test(host) || VERCEL_HOST.test(host) || LOCAL_HOST.test(host))) {
    res.status(403).json({ error: "Origine non autorisée." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { system, messages, max_tokens } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "Champ 'messages' requis." });
    return;
  }

  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

  // Prompt caching sur le system prompt (METHODE_SOL, volumineux et constant) → cache hits.
  const systemBlocks = typeof system === "string" && system.length
    ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
    : undefined;

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: Math.min(Number(max_tokens) || 1500, 2000),
        system: systemBlocks,
        messages,
      }),
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data); // le front tolère la réponse Anthropic brute (data.content[])
  } catch (e) {
    res.status(502).json({ error: "Relais IA indisponible.", detail: String((e && e.message) || e) });
  }
}
