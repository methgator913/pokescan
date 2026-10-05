// Cloudflare Worker: holds the Gemini API key and turns a card photo into {name, number, confidence}.
// Secret (wrangler secret put): GEMINI_API_KEY (free key from aistudio.google.com/apikey), optionally APP_TOKEN.
// Vars: ALLOWED_ORIGIN (e.g. https://you.github.io), optional GEMINI_MODEL to pin a model.
const MODELS = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"]; // first one the key can use wins

const PROMPT = `Identify this Pokémon trading card from the photo.
Return JSON: {"name": string|null, "number": string|null, "confidence": "high"|"low"}.
- name: the card name exactly as printed at the top, keeping suffixes like "ex", "V", "VMAX", "GX" (for evolved Pokémon use the name on the card, not the "Evolves from" text).
- number: the collector number printed at the bottom as printed, e.g. "025/165" or "SWSH020"; null if you cannot read it.
- confidence "low" if the text is hard to read or you are guessing.
If the image is not a Pokémon card, return {"name": null, "number": null, "confidence": "low"}.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    name: { type: "STRING", nullable: true },
    number: { type: "STRING", nullable: true },
    confidence: { type: "STRING", enum: ["high", "low"] },
  },
  required: ["name", "number", "confidence"],
};

export default {
  async fetch(req, env) {
    const origin = req.headers.get("origin") || "";
    const allow = env.ALLOWED_ORIGIN ? (origin === env.ALLOWED_ORIGIN ? origin : "") : "*";
    const cors = { "access-control-allow-origin": allow, "access-control-allow-headers": "content-type,x-app-token", "access-control-allow-methods": "POST,OPTIONS", vary: "origin" };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    if (env.ALLOWED_ORIGIN && !allow) return json({ error: "origin not allowed" }, 403);
    if (env.APP_TOKEN && req.headers.get("x-app-token") !== env.APP_TOKEN) return json({ error: "bad token" }, 401);
    if (!env.GEMINI_API_KEY) return json({ error: "no GEMINI_API_KEY set" }, 503);

    let body;
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!body.image || body.image.length > 4_000_000) return json({ error: "missing or oversized image" }, 400);

    const h = body.hints || {};
    const hint = [h.holo && "holographic", h.reverse && "reverse-holo", h.first && "1st edition"].filter(Boolean);
    const text = hint.length ? `${PROMPT}\nThe owner says this card is ${hint.join(", ")}, so expect glare: ignore the shine and read the printed name and number.` : PROMPT;
    const payload = JSON.stringify({
      contents: [{ parts: [{ text }, { inline_data: { mime_type: "image/jpeg", data: body.image } }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0, maxOutputTokens: 1024 },
    });

    let last = { status: 502, error: "no model worked" };
    for (const model of env.GEMINI_MODEL ? [env.GEMINI_MODEL] : MODELS) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" }, body: payload,
      });
      if (r.ok) {
        const out = await r.json();
        const raw = out.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
        try { return json({ ...JSON.parse(raw), model }); } catch { return json({ name: null, number: null, confidence: "low", model }); }
      }
      last = { status: r.status, error: `gemini ${r.status} on ${model}` };
      if (r.status === 429 || r.status === 401 || r.status === 403) break; // quota or bad key: another model won't help
    }
    return json({ error: last.error }, 502);
  },
};
