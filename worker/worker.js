// Cloudflare Worker: turns a card photo into {name, number, confidence}.
// Uses Cloudflare Workers AI vision models through the AI binding (free daily allowance, no key; over the limit it
// errors instead of charging). Gemini is optional: set secret GEMINI_API_KEY and var USE_GEMINI = "1" (paid on this account).
// Vars: ALLOWED_ORIGIN (comma-separated origins), optional CF_MODEL / GEMINI_MODEL to pin a model.
const CF_MODELS = ["@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/google/gemma-3-12b-it"];
const GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];

const PROMPT = `Identify this Pokémon trading card from the photo.
Return ONLY a JSON object, no other text: {"name": string|null, "number": string|null, "confidence": "high"|"low"}.
- name: the card name exactly as printed at the top, keeping suffixes like "ex", "V", "VMAX", "GX" (for evolved Pokémon use the name on the card, not the "Evolves from" text; for Trainer cards use the trainer's name).
- number: the collector number printed small at the bottom, as printed, e.g. "025/165", "199/165" or "SWSH020"; null if you cannot read it.
- confidence "low" if the text is hard to read or you are guessing.
If the image is not a Pokémon card, return {"name": null, "number": null, "confidence": "low"}.`;

/** Pull the first {...} out of a model reply (they sometimes wrap JSON in prose or code fences). */
function parseReply(raw) {
  if (raw && typeof raw === "object") return raw;
  const m = String(raw || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function viaWorkersAI(env, image, text, tried, alt) {
  // alt = a second opinion from a different model when the app couldn't match the first answer to a card
  for (const model of env.CF_MODEL ? [env.CF_MODEL] : alt ? CF_MODELS.slice(1) : CF_MODELS) {
    try {
      const out = await env.AI.run(model, {
        messages: [{ role: "user", content: [
          { type: "text", text },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } },
        ] }],
        max_tokens: 200,
        temperature: 0,
      });
      const r = parseReply(out?.response ?? out?.choices?.[0]?.message?.content);
      if (r && "name" in r) return { ...r, model };
      tried.push(`${model}: unparseable reply ${JSON.stringify(out?.response ?? out).slice(0, 120)}`);
    } catch (e) {
      tried.push(`${model}: ${String(e.message || e).slice(0, 160)}`);
    }
  }
  return null;
}

async function viaGemini(env, image, text, tried) {
  const payload = JSON.stringify({
    contents: [{ parts: [{ text }, { inline_data: { mime_type: "image/jpeg", data: image } }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 1024 },
  });
  for (const model of env.GEMINI_MODEL ? [env.GEMINI_MODEL] : GEMINI_MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" }, body: payload,
    });
    if (r.ok) {
      const out = await r.json();
      const p = parseReply(out.candidates?.[0]?.content?.parts?.map((x) => x.text || "").join(""));
      if (p) return { ...p, model };
    }
    let why = ""; try { why = (await r.json()).error?.message || ""; } catch { /* not json */ }
    tried.push(`${model}: ${r.status} ${why.slice(0, 160)}`);
    if ([401, 402, 403, 429].includes(r.status)) break; // key, billing or quota: another model won't help
  }
  return null;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((x) => x.trim()).filter(Boolean);
    const allow = allowed.length ? (allowed.includes(origin) ? origin : "") : "*";
    const cors = { "access-control-allow-origin": allow, "access-control-allow-headers": "content-type,x-app-token", "access-control-allow-methods": "POST,OPTIONS", vary: "origin" };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    if (allowed.length && !allow) return json({ error: "origin not allowed" }, 403);
    if (env.APP_TOKEN && req.headers.get("x-app-token") !== env.APP_TOKEN) return json({ error: "bad token" }, 401);

    let body;
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!body.image || body.image.length > 4_000_000) return json({ error: "missing or oversized image" }, 400);

    const h = body.hints || {};
    const hint = [h.holo && "holographic", h.reverse && "reverse-holo", h.first && "1st edition"].filter(Boolean);
    const text = hint.length ? `${PROMPT}\nThe owner says this card is ${hint.join(", ")}, so expect glare: ignore the shine and read the printed name and number.` : PROMPT;

    const tried = [];
    const result =
      (env.USE_GEMINI === "1" && env.GEMINI_API_KEY ? await viaGemini(env, body.image, text, tried) : null) ||
      (env.AI ? await viaWorkersAI(env, body.image, text, tried, !!body.alt) : null);
    return result ? json(result) : json({ error: "no model could read it", tried }, 502);
  },
};
