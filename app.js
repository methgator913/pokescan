"use strict";
const $ = (s) => document.querySelector(s);
const DEX = "https://api.tcgdex.net/v2/en";

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode etc. */ } },
};
let collection = store.get("collection", []);
const DEFAULT_SCAN_URL = "https://pokescan-id.lukablum123.workers.dev"; // Gemini scanner; the app falls back to on-phone OCR if it isn't reachable
let settings = store.get("settings", { url: "", token: "" });
if (!settings.url) settings.url = DEFAULT_SCAN_URL;
let finish = store.get("finish", { holo: false, reverse: false, first: false });

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v, cur = "USD") => v == null ? "n/a" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(v);
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 1800); }
const status = (msg) => { $("#status").textContent = msg || ""; };

/* ---------- finish + pricing ---------- */
const FINISH_LABEL = { normal: "Normal", holofoil: "Holofoil", reverseHolofoil: "Reverse holo", "1stEditionHolofoil": "1st ed. holo", "1stEditionNormal": "1st ed.", unlimitedHolofoil: "Unlimited holo", unlimited: "Unlimited" };

function wantedFinish() {
  if (finish.first) return finish.holo ? "1stEditionHolofoil" : "1stEditionNormal";
  if (finish.reverse) return "reverseHolofoil";
  if (finish.holo) return "holofoil";
  return "normal";
}

/** Price for a card at the finish the user ticked; falls back to whatever TCGplayer lists. */
function priceOf(card, want = wantedFinish()) {
  const p = card.tcgplayer?.prices;
  if (p && Object.keys(p).length) {
    const order = [want, "normal", "holofoil", "reverseHolofoil", "1stEditionHolofoil", "1stEditionNormal", ...Object.keys(p)];
    const key = order.find((k) => p[k]);
    const v = p[key].market ?? p[key].mid ?? p[key].low ?? null;
    return { value: v, cur: "USD", key, exact: key === want };
  }
  const cm = card.cardmarket?.prices;
  if (cm) return { value: cm.trendPrice ?? cm.averageSellPrice ?? null, cur: "EUR", key: "cardmarket", exact: false };
  return { value: null, cur: "USD", key: want, exact: false };
}

/* ---------- card lookup (TCGdex: free, same TCGplayer prices) ---------- */
async function getJSON(url) {
  let err;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.status === 404) return null;
      if (res.ok) return await res.json();
      err = new Error(`Card API ${res.status}`);
      if (res.status < 500) break;
    } catch (e) { err = e; }
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  throw err;
}

/** TCGdex card -> the shape the rest of the app uses. */
function normalize(d) {
  const camel = (k) => k.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  const prices = {};
  for (const [k, v] of Object.entries(d.pricing?.tcgplayer || {})) {
    if (v && typeof v === "object" && (v.marketPrice != null || v.midPrice != null || v.lowPrice != null))
      prices[camel(k)] = { market: v.marketPrice, mid: v.midPrice, low: v.lowPrice };
  }
  const cm = d.pricing?.cardmarket;
  return {
    id: d.id, name: d.name, number: d.localId,
    set: { name: d.set?.name, printedTotal: d.set?.cardCount?.official ?? d.set?.cardCount?.total },
    images: { small: d.image ? `${d.image}/low.webp` : "" },
    tcgplayer: Object.keys(prices).length ? { prices } : null,
    cardmarket: cm ? { prices: { trendPrice: cm.trend, averageSellPrice: cm.avg } } : null,
  };
}

const getCard = async (id) => { const d = await getJSON(`${DEX}/cards/${encodeURIComponent(id)}`); return d ? normalize(d) : null; };
const getCards = async (briefs) => (await Promise.all(briefs.map((b) => getCard(b.id).catch(() => null)))).filter(Boolean);
const list = async (params) => (await getJSON(`${DEX}/cards?${new URLSearchParams({ "pagination:itemsPerPage": 100, ...params })}`)) || [];

/** How well a card name matches the OCR'd / typed guesses (a guess that contains the whole card name is a perfect hit). */
function nameScore(cardName, guesses) {
  const cn = cardName.toLowerCase();
  return Math.max(0, ...guesses.map((g) => (g && g.toLowerCase().includes(cn) ? 1 : similarity(cn, g || ""))));
}
const byScore = (cards, guesses) => cards.map((c) => [nameScore(c.name, guesses), c]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
/** Prefer cards from a set of the printed size; OCR sometimes drops a trailing digit ("14" for 146), so accept a prefix match too. */
const sameTotal = (cards, total) => {
  if (!total) return cards;
  const t = String(+total), tot = (c) => String(c.set.printedTotal);
  const exact = cards.filter((c) => tot(c) === t);
  if (exact.length) return exact;
  const prefix = t.length >= 2 ? cards.filter((c) => tot(c).startsWith(t)) : [];
  return prefix.length ? prefix : cards;
};
const normNum = (n) => String(n).replace(/^([A-Za-z]*)0+(?=\d)/, "$1").toLowerCase();
/** TCGdex's localId filter is a substring match ("4" also finds 24, 14, 104), so re-check the number exactly. */
const exactNum = (cards, num) => (num ? cards.filter((c) => normNum(c.number) === normNum(num)) : cards);
const briefRank = (briefs, guesses, limit = 12) => briefs.map((b) => [nameScore(b.name, guesses), b]).sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1]);

/** name + optional collector number ("025/165", "4", "SWSH020") -> candidate cards, loosening the query until something matches. */
async function lookup(name, numberRaw, strict = false) {
  const m = String(numberRaw || "").trim().match(/^([A-Za-z]*\d+[A-Za-z]*)?(?:\s*\/\s*(\d+))?$/);
  const num = m?.[1], total = m?.[2]; // number may be missing ("/149": name + set size only)
  // strict (used for photo scans): never drop the number, or a stray word could match the wrong card
  const tries = num ? [{ name, localId: num }, { name, localId: num.replace(/^0+(?=\d)/, "") }, ...(strict ? [] : [{ name }])] : [{ name }];
  let err;
  for (const t of tries) {
    try {
      const briefs = await list(t);
      if (!briefs.length) continue;
      let cards = await getCards(briefRank(briefs, [name], num ? 12 : 30));
      if (num) { const e = exactNum(cards, num); if (e.length || strict) cards = e; }
      cards = sameTotal(cards, total);
      if (cards.length) return byScore(cards, [name]).slice(0, 6);
    } catch (e) { err = e; }
  }
  if (err) throw err;
  return [];
}

function parseTyped(text) {
  const t = text.trim();
  const m = t.match(/^(.*?)\s+((?:[A-Za-z]*\d+[A-Za-z]*)(?:\s*\/\s*\d+)?)$/);
  return m ? { name: m[1], number: m[2] } : { name: t, number: "" };
}

/* ---------- photo -> Claude id ---------- */
async function downscale(file, max = 1000) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85).split(",")[1];
}

async function identify(file) {
  if (!settings.url) throw new Error("no-server");
  const image = await downscale(file);
  const res = await fetch(settings.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(settings.token ? { "x-app-token": settings.token } : {}) },
    body: JSON.stringify({ image, hints: finish }),
  });
  if (!res.ok) throw new Error(`Scan server ${res.status}`);
  return res.json(); // { name, number, confidence }
}

/* ---------- photo -> free on-phone OCR (Tesseract.js) ---------- */
let ocrWorker;
async function getOcr() {
  if (ocrWorker) return ocrWorker;
  if (!window.Tesseract) {
    await new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
      s.onload = ok; s.onerror = () => fail(new Error("couldn't load the text reader (offline?)"));
      document.head.appendChild(s);
    });
  }
  ocrWorker = await Tesseract.createWorker("eng");
  return ocrWorker;
}

/** Crop a band of the card, grayscale + stretch contrast, upscale: small printed text reads far better. */
function prep(src, fx, fy, fw, fh, minH) {
  const sx = Math.round(src.width * fx), sy = Math.round(src.height * fy), sw = Math.round(src.width * fw), sh = Math.round(src.height * fh);
  const k = Math.max(1, minH / sh);
  const c = document.createElement("canvas");
  c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const im = g.getImageData(0, 0, c.width, c.height), d = im.data;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) { const v = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) | 0; d[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) { const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / span)); d[i] = d[i + 1] = d[i + 2] = v; }
  g.putImageData(im, 0, 0);
  return c;
}

const cleanName = (line) => line
  .replace(/[^A-Za-zÀ-ÿ'’.\- ]/g, " ").replace(/\s+/g, " ").trim()
  .replace(/^(basic|stage\s*[12i]|restored|pokémon|pokemon)\s+/i, "")
  .replace(/\s+(hp|h p)$/i, "").trim();

function parseNumber(text) {
  for (const t of [text, text.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1")]) {
    let m = t.match(/\b(\d{1,3}[A-Za-z]?)\s*[\/7]\s*(\d{2,3})\b/); // 025/165
    if (m) return { number: m[1].toUpperCase(), total: m[2] };
    m = t.match(/\b([A-Za-z]{1,4}\d{1,3})\s*\/\s*([A-Za-z]{1,4}\d{1,3})\b/); // TG05/TG30, GG01/GG70
    if (m) return { number: m[1].toUpperCase(), total: m[2].replace(/\D/g, "") };
    m = t.match(/\b((?:SWSH|SVP|SM|XY|BW|DP|HGSS|SV|PR)\d{2,3})\b/i); // promos print no total
    if (m) return { number: m[1].toUpperCase(), total: "" };
  }
  return { number: "", total: "" };
}

async function loadPage(file, max = 1800) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const page = document.createElement("canvas");
  page.width = Math.round(bmp.width * k); page.height = Math.round(bmp.height * k);
  page.getContext("2d").drawImage(bmp, 0, 0, page.width, page.height);
  return page;
}

function rotate(src, deg) {
  const c = document.createElement("canvas");
  const swap = deg === 90 || deg === 270;
  c.width = swap ? src.height : src.width; c.height = swap ? src.width : src.height;
  const g = c.getContext("2d");
  g.translate(c.width / 2, c.height / 2); g.rotate((deg * Math.PI) / 180);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

function rotateAny(src, rad, fill) {
  const sn = Math.abs(Math.sin(rad)), cs = Math.abs(Math.cos(rad));
  const c = document.createElement("canvas");
  c.width = Math.ceil(src.width * cs + src.height * sn); c.height = Math.ceil(src.width * sn + src.height * cs);
  const g = c.getContext("2d"); g.fillStyle = fill; g.fillRect(0, 0, c.width, c.height);
  g.translate(c.width / 2, c.height / 2); g.rotate(rad); g.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/** Find the card in a photo: everything that differs from the background colour (sampled round the frame edge),
 *  then take the bounding box of the big blob. Returns a crop of the page, or null if nothing card-shaped stands out. */
function detectCard(page, depth = 0) {
  const S = 360, k = S / Math.max(page.width, page.height);
  const w = Math.max(8, Math.round(page.width * k)), h = Math.max(8, Math.round(page.height * k));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(page, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const bx = Math.max(2, Math.round(w * 0.05)), by = Math.max(2, Math.round(h * 0.05));
  const ring = [[], [], []];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= bx && x < w - bx && y >= by && y < h - by) continue;
    const i = (y * w + x) * 4; for (let ch = 0; ch < 3; ch++) ring[ch].push(d[i + ch]);
  }
  const med = ring.map((a) => a.sort((p, q) => p - q)[a.length >> 1]);
  const dist = new Uint16Array(w * h), hist = new Uint32Array(766);
  for (let i = 0; i < w * h; i++) {
    const v = Math.abs(d[i * 4] - med[0]) + Math.abs(d[i * 4 + 1] - med[1]) + Math.abs(d[i * 4 + 2] - med[2]);
    dist[i] = v; hist[v]++;
  }
  // Otsu threshold on the distance histogram
  let total = w * h, sum = 0; for (let t = 0; t < 766; t++) sum += t * hist[t];
  let wB = 0, sB = 0, best = 0, thr = 40;
  for (let t = 0; t < 766; t++) {
    wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break;
    sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; thr = t; }
  }
  thr = Math.max(thr, 35);
  const row = new Uint16Array(h), col = new Uint16Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (dist[y * w + x] > thr) { row[y]++; col[x]++; }
  const mr = Math.max(...row), mc = Math.max(...col);
  if (mr < 8 || mc < 8) return null;
  const span = (arr, m) => { let lo = 0, hi = arr.length - 1; while (lo < hi && arr[lo] < 0.4 * m) lo++; while (hi > lo && arr[hi] < 0.4 * m) hi--; return [lo, hi]; };
  const [y0, y1] = span(row, mr), [x0, x1] = span(col, mc);
  if (depth === 0) { // a tilted card: measure its angle from the mask's principal axis and straighten the photo first
    let n = 0, sx = 0, sy = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (dist[y * w + x] > thr) { n++; sx += x; sy += y; }
    if (n > 50) {
      const mx = sx / n, my = sy / n; let cxx = 0, cyy = 0, cxy = 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (dist[y * w + x] > thr) { cxx += (x - mx) ** 2; cyy += (y - my) ** 2; cxy += (x - mx) * (y - my); }
      const phi = 0.5 * Math.atan2(2 * cxy, cxx - cyy), tilt = phi > 0 ? phi - Math.PI / 2 : phi + Math.PI / 2, deg = Math.abs(tilt * 180 / Math.PI);
      if (deg > 1.5 && deg < 30) return detectCard(rotateAny(page, -tilt, `rgb(${med[0]},${med[1]},${med[2]})`), 1);
    }
  }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, area = (bw * bh) / (w * h), asp = Math.min(bw, bh) / Math.max(bw, bh);
  if (area < 0.1 || area > 0.97 || asp < 0.55 || asp > 0.88) return null;
  const mx = Math.round(bw * 0.015), my = Math.round(bh * 0.015);
  const sx = Math.max(0, x0 - mx) / k, sy = Math.max(0, y0 - my) / k;
  const sw = Math.min(w, x1 + mx + 1) / k - sx, sh = Math.min(h, y1 + my + 1) / k - sy;
  const out = document.createElement("canvas"); out.width = Math.round(sw); out.height = Math.round(sh);
  out.getContext("2d").drawImage(page, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

/** Read name (top band) and collector number (bottom bands) off an upright card image. */
async function readCard(card) {
  const w = await getOcr();
  await w.setParameters({ tessedit_pageseg_mode: "6", tessedit_char_whitelist: "" });
  const topRes = (await w.recognize(prep(card, 0.04, 0.02, 0.92, 0.13, 140))).data;
  const top = topRes.text;
  const lines = top.split("\n");
  const names = lines.map(cleanName).filter((l) => (l.match(/[A-Za-z]/g) || []).length >= 3);
  // Evolved cards print "Put <Name> on the Stage N card" in the flavor line: that is the real name.
  const put = top.match(/Put\s+([A-Z][A-Za-zÀ-ÿ'’.\-]+(?:\s+(?:ex|EX|GX|V|VMAX))?)\s+on\s+the/);
  if (put) names.unshift(put[1]);
  // wrong way up / not a card: the top band is garbage, so don't waste time on the rest
  if (!put && topRes.confidence < 40 && !names.some((n) => n.replace(/[^A-Za-z]/g, "").length >= 5)) return { names: [], number: "", total: "", conf: topRes.confidence, raw: { top, bottom: "" } };

  await w.setParameters({ tessedit_pageseg_mode: "6", tessedit_char_whitelist: "0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ " });
  // The collector number is small and its spot varies by era: try the whole bottom band, then tighter bands per side.
  let bottom = "", num = { number: "", total: "" };
  for (const [x, y, bw, bh] of [[0, 0.88, 1, 0.12], [0, 0.915, 0.5, 0.08], [0.5, 0.915, 0.5, 0.08], [0, 0.93, 1, 0.065]]) {
    const t = (await w.recognize(prep(card, x, y, bw, bh, 120))).data.text;
    bottom += t + "\n";
    num = parseNumber(t);
    if (num.number && num.total) break;
  }
  return { names, ...num, conf: topRes.confidence, raw: { top, bottom } };
}

/** words printed on cards that are never the card's name */
const GENERIC = /^(stage\s*\d?|basic|evolves|from|put|card|pok[eé]mon|restored|trainer|energy|supporters?|items?|tools?|stadium|special|the|and|your|you)\W*$/i;
const plausible = (r) => !!(r.number && r.total) || (r.conf >= 45 && r.names.some((n) => !GENERIC.test(n) && n.replace(/[^A-Za-z]/g, "").length >= 3));

/** Yields plausible reads, trying the detected card crop then the whole photo, upright then rotated. */
async function* ocrReads(file) {
  const page = await loadPage(file);
  const card = detectCard(page);
  const dbg = (window.scanDebug = { found: !!card, tries: [], img: (card || page) });
  let n = 0;
  for (const base of card ? [card, page] : [page]) {
    const rots = base.width > base.height ? [90, 270, 0] : [0, 90, 270];
    for (const rot of rots) {
      status(`Reading card… (try ${++n})`);
      const r = await readCard(rot ? rotate(base, rot) : base);
      r.rot = rot; r.crop = base === card ? "card" : "photo";
      dbg.tries.push(`#${n} ${r.crop} rot${rot} conf${Math.round(r.conf)} names=[${r.names.slice(0, 2).join(" // ")}] num=${r.number}/${r.total}`);
      if (plausible(r)) { window.lastOcr = r; yield r; }
    }
  }
}

/** name / number guesses from one OCR read -> candidate cards. */
async function resolveRead(r) {
  // Try whole lines first, then single words (OCR often glues "Stage 2 ... Charizard HP" together), accepting a hit
  // only if its set size matches the printed total; fall back to a number+total search ranked by name similarity.
  // 3+ letters so short Trainer names like "Hop" or "Lisia" survive
  const words = [...new Set(r.names.flatMap((l) => l.split(" ")).map((w) => w.replace(/[^A-Za-zÀ-ÿ'’.-]/g, "")).filter((w) => w.length >= 3 && !GENERIC.test(w)))];
  const guesses = [...r.names.slice(0, 2), ...words].slice(0, 7);
  const numArg = r.total ? `${r.number}/${r.total}` : r.number;
  let cards = [], weak = [];
  for (const n of guesses) {
    const got = await lookup(n, numArg, true).catch(() => []);
    if (!got.length) continue;
    if (!r.total || got.some((c) => String(c.set.printedTotal).startsWith(String(+r.total)))) { cards = got; break; }
    if (!weak.length) weak = got;
  }
  if (!cards.length && r.number && r.total) cards = await lookupByNumber(r.number, r.total, r.names).catch(() => []);
  if (!cards.length && r.total) { // number unreadable: name + set size
    for (const n of guesses.slice(0, 3)) { const got = sameTotal(await lookup(n, `/${r.total}`).catch(() => []), r.total); if (got.length) { cards = got; break; } }
  }
  let out = cards.length ? cards : weak;
  // Cross-check: a number-led match whose name disagrees with the name we read is probably a misread number. Trust the name.
  const clean = r.names.filter((n) => !GENERIC.test(n)).concat(words);
  const score = (cs) => (cs.length ? nameScore(cs[0].name, clean) : 0);
  if (clean.length && score(out) < 0.6) {
    for (const n of words.slice(0, 4)) {
      const alt = byScore(await lookup(n, "").catch(() => []), clean);
      if (alt.length && score(alt) >= 0.8) { out = sameTotal(alt, r.total); break; }
    }
  }
  return { cards: out, sure: !clean.length || score(out) >= 0.6 };
}

function showDebug() {
  const d = window.scanDebug; if (!d) return;
  const box = $("#dbg"); box.hidden = false;
  const img = $("#dbg-img"); img.innerHTML = ""; d.img.style.cssText = "max-width:140px;border-radius:6px;display:block;margin:8px 0"; img.appendChild(d.img);
  $("#dbg-txt").textContent = `card found in photo: ${d.found}\n` + d.tries.join("\n");
}

function similarity(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (!a || !b) return 0;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
}

let setTotals;
/** set id -> printed totals ("official" and "total"), fetched once. Lets a number search drop every card from a set of the wrong size
 *  before spending a request per candidate. */
async function getSetTotals() {
  if (!setTotals) {
    const sets = (await getJSON(`${DEX}/sets`).catch(() => null)) || [];
    setTotals = new Map(sets.map((x) => [x.id, [x.cardCount?.official, x.cardCount?.total].filter(Boolean).map(String)]));
  }
  return setTotals;
}

/** Number + set size pins down a handful of cards; rank them by how close their name is to the (possibly garbled) OCR names. */
async function lookupByNumber(number, total, guesses) {
  let briefs = (await list({ localId: number, "pagination:itemsPerPage": 1000 })).filter((b) => normNum(b.localId) === normNum(number));
  const st = await getSetTotals(), t = String(+total);
  const setOf = (b) => b.id.slice(0, b.id.length - String(b.localId).length - 1);
  const exact = briefs.filter((b) => (st.get(setOf(b)) || []).includes(t));
  const prefix = t.length >= 2 ? briefs.filter((b) => (st.get(setOf(b)) || []).some((x) => x.startsWith(t))) : [];
  const pool = exact.length ? exact : prefix.length ? prefix : briefs;
  const cards = sameTotal(await getCards(briefRank(pool, guesses)), total);
  return byScore(cards, guesses).slice(0, 6);
}

/* ---------- scan screen ---------- */
let shown = [];
function renderResults() {
  const want = wantedFinish();
  $("#results").innerHTML = shown.map((c, i) => {
    const p = priceOf(c, want);
    const note = p.key === "cardmarket" ? "Cardmarket trend" : (p.exact ? FINISH_LABEL[p.key] : `${FINISH_LABEL[p.key] || p.key} price`);
    return `<li class="row"><img src="${esc(c.images?.small)}" alt="" loading="lazy">
      <div><div class="name">${esc(c.name)}</div><div class="sub">${esc(c.set?.name)} · ${esc(c.number)}/${esc(c.set?.printedTotal)}</div></div>
      <div><div class="price">${money(p.value, p.cur)}<small>${esc(note)}${p.exact || p.key === "cardmarket" ? "" : " ⚠"}</small></div>
      <button class="add" data-i="${i}">Add</button></div></li>`;
  }).join("");
}

function showCards(cards, label) {
  shown = cards;
  status(cards.length ? label : "No match found. Try the search box with the name and number.");
  renderResults();
}

async function search(text) {
  const { name, number } = parseTyped(text);
  if (!name) return;
  status("Searching…");
  try { showCards(await lookup(name, number), "Tap Add on the right one."); }
  catch (e) { status(`Couldn't reach the card database (${e.message}).`); }
}

let scanning = false;
async function onPhoto(file) {
  if (!file || scanning) return; // one scan at a time: the OCR worker is shared
  scanning = true;
  $("#results").innerHTML = "";
  try {
    if (settings.url) { // Gemini via our Worker; if it fails (no key yet, quota, offline) fall through to the on-phone reader
      status("Reading card…");
      try {
        const g = await identify(file);
        if (g.name) {
          const n = parseNumber(g.number || "");
          const label = `${g.name} ${g.number || ""}`.trim();
          status(`Read: ${label}. Looking up…`);
          const { cards, sure } = await resolveRead({ names: [g.name], number: n.number, total: n.total, conf: 90 });
          if (cards.length) {
            showCards(cards, sure && g.confidence !== "low" ? `Read “${label}”. Check it's the right card, then tap Add.` : `Not sure: I read “${label}” but the best match may be wrong. Compare the picture with your card, or use search.`);
            return;
          }
        }
      } catch (e) { /* fall back to OCR */ }
      status("Trying the on-phone reader…");
    }
    status(ocrWorker ? "Reading card…" : "Reading card… (the first scan downloads the text reader, about 10 MB)");
    let cards = [], sure = true, read = "";
    for await (const r of ocrReads(file)) {
      const nm = r.names.find((n) => !GENERIC.test(n)) || "?";
      read = `${nm} ${r.number ? r.number + (r.total ? "/" + r.total : "") : ""}`.trim();
      status(`Read: ${read}. Looking up…`);
      ({ cards, sure } = await resolveRead(r));
      if (cards.length) break;
    }
    showDebug();
    if (!cards.length) { status("Couldn't read that card. Fill the frame, use even light, avoid glare, or use search. (See “What I read” below.)"); return; }
    showCards(cards, sure ? `Read “${read}”. Check it's the right card, then tap Add.` : `Not sure: I read “${read}” but the best match may be wrong. Compare the picture with your card, or use search.`);
  } catch (e) {
    status(e.message === "no-server" ? "Scanning isn't set up yet. Use search for now." : `Scan failed: ${e.message}`);
  } finally { scanning = false; }
}

/* ---------- collection ---------- */
const save = () => { store.set("collection", collection); };

function addCard(c) {
  const p = priceOf(c);
  const key = `${c.id}|${p.key}`;
  const hit = collection.find((x) => x.key === key);
  if (hit) { hit.qty++; hit.price = p.value; }
  else collection.unshift({ key, id: c.id, name: c.name, set: c.set?.name, number: `${c.number}/${c.set?.printedTotal}`, image: c.images?.small, finish: p.key, price: p.value, cur: p.cur, qty: 1, added: new Date().toISOString() });
  save(); renderCollection(); toast(`Added ${c.name}`);
}

function renderCollection() {
  const usd = collection.filter((c) => c.cur !== "EUR").reduce((s, c) => s + (c.price || 0) * c.qty, 0);
  const eur = collection.filter((c) => c.cur === "EUR").reduce((s, c) => s + (c.price || 0) * c.qty, 0);
  const n = collection.reduce((s, c) => s + c.qty, 0);
  $("#total").textContent = money(usd) + (eur ? ` + ${money(eur, "EUR")}` : "");
  $("#count").textContent = `${n} card${n === 1 ? "" : "s"} · ${collection.length} unique`;
  $("#badge").textContent = n || ""; $("#badge").hidden = !n;
  $("#cards").innerHTML = collection.length ? collection.map((c, i) => `<li class="row"><img src="${esc(c.image)}" alt="" loading="lazy">
    <div><div class="name">${esc(c.name)}</div><div class="sub">${esc(c.set)} · ${esc(c.number)}</div><div class="sub">${esc(FINISH_LABEL[c.finish] || c.finish)}</div></div>
    <div><div class="price">${money(c.price, c.cur)}${c.qty > 1 ? `<small>${money((c.price || 0) * c.qty, c.cur)} total</small>` : ""}</div>
    <div class="qty"><button data-d="-1" data-i="${i}">−</button>${c.qty}<button data-d="1" data-i="${i}">+</button></div></div></li>`).join("")
    : `<li class="empty">No cards yet. Scan one and tap Add.</li>`;
}

async function refreshPrices() {
  if (!collection.length) return;
  toast("Refreshing…");
  try {
    let bad = 0;
    for (const id of [...new Set(collection.map((c) => c.id))]) {
      const card = await getCard(id).catch(() => null);
      if (!card) { bad++; continue; }
      for (const c of collection.filter((x) => x.id === id)) {
        const p = priceOf(card, c.finish); if (p.value != null) { c.price = p.value; c.cur = p.cur; }
      }
    }
    save(); renderCollection(); toast(bad ? `Updated (${bad} failed)` : "Prices updated");
  } catch (e) { toast("Refresh failed"); }
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/* ---------- wiring ---------- */
for (const [k, id] of [["holo", "#f-holo"], ["reverse", "#f-reverse"], ["first", "#f-first"]]) {
  $(id).checked = finish[k];
  $(id).addEventListener("change", (e) => { finish[k] = e.target.checked; store.set("finish", finish); renderResults(); });
}
$("#photo").addEventListener("change", (e) => { onPhoto(e.target.files[0]); e.target.value = ""; });
$("#search").addEventListener("submit", (e) => { e.preventDefault(); search($("#q").value); });
$("#results").addEventListener("click", (e) => { const b = e.target.closest(".add"); if (b) addCard(shown[+b.dataset.i]); });
$("#cards").addEventListener("click", (e) => {
  const b = e.target.closest("[data-d]"); if (!b) return;
  const c = collection[+b.dataset.i]; c.qty += +b.dataset.d;
  if (c.qty <= 0) collection.splice(+b.dataset.i, 1);
  save(); renderCollection();
});
$("#refresh").addEventListener("click", refreshPrices);
$("#csv").addEventListener("click", () => download("pokemon-collection.csv",
  ["name,set,number,finish,qty,price,currency", ...collection.map((c) => [c.name, c.set, c.number, c.finish, c.qty, c.price, c.cur].map(csvCell).join(","))].join("\n"), "text/csv"));
$("#json").addEventListener("click", () => download("pokemon-collection.json", JSON.stringify(collection, null, 2), "application/json"));
$("#restore").addEventListener("change", async (e) => {
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (!Array.isArray(data)) throw new Error("bad file");
    collection = data; save(); renderCollection(); toast(`Restored ${data.length} entries`);
  } catch { toast("That file isn't a backup"); }
  e.target.value = "";
});
$("#s-url").value = settings.url; $("#s-token").value = settings.token;
for (const [id, k] of [["#s-url", "url"], ["#s-token", "token"]])
  $(id).addEventListener("change", (e) => { settings[k] = e.target.value.trim(); store.set("settings", settings); });

document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("on", x === b));
  $("#scan").hidden = b.dataset.tab !== "scan"; $("#collection").hidden = b.dataset.tab !== "collection";
}));

renderCollection();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
