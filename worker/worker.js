// Cloudflare Worker: holds the Anthropic key and turns a card photo into {name, number, confidence}.
// Secrets (wrangler secret put): ANTHROPIC_API_KEY, optionally APP_TOKEN.  Var: ALLOWED_ORIGIN (e.g. https://you.github.io).
const MODEL = "claude-haiku-4-5";

const SYSTEM = `You identify Pokémon trading cards from a photo.
Reply with ONLY a JSON object: {"name": string|null, "number": string|null, "confidence": "high"|"low"}.
- name: the Pokémon/Trainer/Energy name exactly as printed at the top of the card, keeping suffixes like "ex", "V", "VMAX", "GX".
- number: the collector number printed at the bottom, as printed, e.g. "025/165" or "SWSH020". null if you can't read it.
- confidence "low" if the text is hard to read or you are guessing.
If the image is not a Pokémon card, return {"name": null, "number": null, "confidence": "low"}.`;

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

    let body;
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!body.image || body.image.length > 4_000_000) return json({ error: "missing or oversized image" }, 400);

    const h = body.hints || {};
    const hint = [h.holo && "holographic", h.reverse && "reverse-holo", h.first && "1st edition"].filter(Boolean);
    const text = hint.length
      ? `The owner says this card is ${hint.join(", ")}, so expect glare and reflections. Ignore the shine and read the printed name and number.`
      : "Identify this card.";

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 200, system: SYSTEM,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: body.image } },
          { type: "text", text },
        ] }],
      }),
    });
    if (!r.ok) return json({ error: `anthropic ${r.status}` }, 502);
    const out = await r.json();
    const raw = out.content?.find((b) => b.type === "text")?.text || "";
    const m = raw.match(/\{[\s\S]*\}/);
    try { return json(JSON.parse(m ? m[0] : raw)); } catch { return json({ name: null, number: null, confidence: "low" }); }
  },
};
