'use strict';
/*
  ExamInfo Pay: pay with Monnify, get your WAEC/NECO/NABTEB token instantly.
  No npm packages needed. Needs Node.js 18 or newer.
  All secrets live in the .env file. Never put keys in this file.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cardSvg } = require('./lib/card');

// ---------- .env ----------
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* no .env yet */ }
const E = process.env;
const PORT = Number(E.PORT) || 3000;
const MOCK = (E.MOCK_MODE || 'true').toLowerCase() !== 'false';      // true = fake payments + fake tokens
const SITE_URL = (E.SITE_URL || 'http://localhost:' + PORT).replace(/\/$/, '');
const MONNIFY_BASE = E.MONNIFY_BASE_URL || (E.MONNIFY_ENV === 'live' ? 'https://api.monnify.com' : 'https://sandbox.monnify.com');
const VTU_BASE = E.VTU_BASE_URL || (E.VTU_ENV === 'sandbox' ? 'https://vtuafrica.com.ng/portal/api-test' : 'https://vtuafrica.com.ng/portal/api');
const DEFAULT_PASSWORD = E.ADMIN_PASSWORD || '200517';   // first-run password. Change it in /admin
const SESSION_SECRET = E.SESSION_SECRET || crypto.randomBytes(24).toString('hex');
const SECURE_COOKIE = SITE_URL.startsWith('https://');
// JAMB practice questions access (CBT): one payment unlocks the practice test for CBT_ACCESS_HOURS on that phone.
const CBT_PRICE = Math.max(100, Math.floor(Number(E.CBT_PRICE || 30000)));
const CBT_HOURS = Math.max(1, Math.floor(Number(E.CBT_ACCESS_HOURS || 24)));
const BLOGGER_URL = (E.BLOGGER_URL || 'https://www.examinfo.com.ng').replace(/\/$/, '');

// ---------- tiny JSON store ----------
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (e) { return d; } }
function writeJson(f, v) { const p = path.join(DATA, f), t = p + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, p); }

const DEFAULTS = {
  markup: 1500,            // your profit added to the provider price (the buyer pays the charges)
  maxQty: 5,
  whatsapp: '2349045195158',
  products: {              // cost = what the provider charges YOU. markup null = use the main markup
    WAEC:   { service: 'waec',   code: '1', cost: 0, markup: null, on: true },
    NECO:   { service: 'neco',   code: '1', cost: 0, markup: null, on: true },
    NABTEB: { service: 'nabteb', code: '1', cost: 0, markup: null, on: true }
  },
  about: { line: 'We deliver like Hebrew women.', since: 2016, trustedBy: '' },
  // OTP codes for a forgotten password go ONLY to these. Edit data/settings.json to change them.
  recovery: { emails: ['Rkenechukwu49@gmail.com'], phones: ['09045195158', '09055460134', '09038433411'] }
};
let settings = readJson('settings.json', null) || DEFAULTS;
for (const k of Object.keys(DEFAULTS.products)) settings.products[k] = Object.assign({}, DEFAULTS.products[k], settings.products[k] || {});
settings.about = Object.assign({}, DEFAULTS.about, settings.about || {});
settings.recovery = Object.assign({}, DEFAULTS.recovery, settings.recovery || {});
let orders = readJson('orders.json', {});
const save = () => { writeJson('orders.json', orders); writeJson('settings.json', settings); };
let cbtOrders = readJson('cbt-orders.json', {});
const saveCbt = () => writeJson('cbt-orders.json', cbtOrders);

// ---------- helpers ----------
const rid = (n) => crypto.randomBytes(n).toString('hex');
const markupOf = (p) => (p && p.markup !== null && p.markup !== undefined && p.markup !== '') ? Number(p.markup) : settings.markup;
const unitPrice = (p) => (p && p.on && p.cost > 0) ? Math.round(p.cost + markupOf(p)) : 0;
const naira = (n) => 'N' + Number(n).toLocaleString('en-NG');
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const hits = new Map();
function limited(ip, key, max, ms) {
  const k = key + ip, now = Date.now(), arr = (hits.get(k) || []).filter((t) => now - t < ms);
  arr.push(now); hits.set(k, arr); return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 600000)) hits.delete(k); }, 600000).unref();

function newRef() { return String(Date.now()) + String(Math.floor(Math.random() * 900 + 100)); }

// ---------- Monnify ----------
let mTok = { v: '', exp: 0 };
async function monnifyToken() {
  if (mTok.v && Date.now() < mTok.exp) return mTok.v;
  const basic = Buffer.from(E.MONNIFY_API_KEY + ':' + E.MONNIFY_SECRET_KEY).toString('base64');
  const r = await fetch(MONNIFY_BASE + '/api/v1/auth/login', { method: 'POST', headers: { Authorization: 'Basic ' + basic } });
  const j = await r.json();
  if (!j.requestSuccessful) throw new Error('Monnify login failed: ' + (j.responseMessage || r.status));
  mTok = { v: j.responseBody.accessToken, exp: Date.now() + (Number(j.responseBody.expiresIn || 300) - 30) * 1000 };
  return mTok.v;
}
async function startPayment(o) {
  if (MOCK) return SITE_URL + '/mock-pay?ref=' + o.ref + '&key=' + o.key;
  const t = await monnifyToken();
  const r = await fetch(MONNIFY_BASE + '/api/v1/merchant/transactions/init-transaction', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: o.amount, customerName: o.name, customerEmail: o.email, paymentReference: o.ref,
      paymentDescription: o.kind === 'cbt' ? 'ExamInfo JAMB practice questions (practice only, not the real exam)' : o.qty + ' ' + o.exam + ' result checker token(s)', currencyCode: 'NGN',
      contractCode: E.MONNIFY_CONTRACT_CODE, redirectUrl: o.kind === 'cbt' ? BLOGGER_URL + '/?cbt=' + o.ref + '&key=' + o.key : SITE_URL + '/?ref=' + o.ref + '&key=' + o.key,
      paymentMethods: ['CARD', 'ACCOUNT_TRANSFER']
    })
  });
  const j = await r.json();
  if (!j.requestSuccessful) throw new Error('Monnify init failed: ' + (j.responseMessage || r.status));
  return j.responseBody.checkoutUrl;
}
// Always ask Monnify directly. Never trust a browser or webhook claim by itself.
async function isPaid(o) {
  if (MOCK) return !!o.mockPaid;
  const t = await monnifyToken();
  const r = await fetch(MONNIFY_BASE + '/api/v2/merchant/transactions/query?paymentReference=' + encodeURIComponent(o.ref), { headers: { Authorization: 'Bearer ' + t } });
  const j = await r.json();
  if (!j.requestSuccessful || !j.responseBody) return false;
  const b = j.responseBody, st = String(b.paymentStatus || b.status || '').toUpperCase();
  // Only the money Monnify says was really paid counts: it must be PAID and at least the full price (less never unlocks).
  const paid = Number(b.amountPaid);
  return st === 'PAID' && Number.isFinite(paid) && paid >= o.amount && String(b.currency || b.currencyCode || 'NGN').toUpperCase() === 'NGN';
}

// ---------- JAMB practice questions access ----------
const corsFor = (req) => { const o = String(req.headers.origin || ''); return FRAME_ALLOW.indexOf(o) > -1 ? { 'Access-Control-Allow-Origin': o, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } : {}; };
async function cbtCheck(o) {
  if (o.status === 'paid') return true;
  if (await isPaid(o)) { o.status = 'paid'; o.paidAt = Date.now(); saveCbt(); return true; }
  return false;
}
const cbtView = (o) => { const exp = o.paidAt ? o.paidAt + CBT_HOURS * 3600000 : 0; return { paid: o.status === 'paid', active: o.status === 'paid' && Date.now() < exp, expiresAt: exp, name: o.name, reg: o.reg }; };

// ---------- token supplier (VTUAfrica) ----------
// VTUAfrica sends: "pins":"SERIAL<=>PIN" (several are separated by , ; | or new lines). One value = a NECO token.
function parsePins(str, exam) {
  const out = [];
  String(str || '').split(/[,;|\n]+/).map((x) => x.trim()).filter(Boolean).forEach((part) => {
    if (part.indexOf('<=>') > -1) { const [a, b] = part.split('<=>').map((x) => x.trim()); if (a) out.push({ k: 'Serial', v: a }); if (b) out.push({ k: 'PIN', v: b }); }
    else out.push({ k: exam === 'NECO' ? 'Token' : 'PIN', v: part });
  });
  return out;
}
async function buyTokens(o) {
  if (MOCK) {
    const pins = [];
    for (let i = 0; i < o.qty; i++) {
      if (o.exam === 'NECO') pins.push({ k: 'Token', v: String(Math.floor(1e11 + Math.random() * 9e11)) });
      else { pins.push({ k: 'Serial', v: String(Math.floor(1e9 + Math.random() * 9e9)) }); pins.push({ k: 'PIN', v: String(Math.floor(1e11 + Math.random() * 9e11)) }); }
    }
    return { ok: true, pins, raw: 'mock', charged: o.cost * o.qty };
  }
  const p = settings.products[o.exam];
  const url = VTU_BASE + '/exam-pin/?apikey=' + encodeURIComponent(E.VTU_API_KEY) + '&service=' + p.service + '&product_code=' + p.code + '&quantity=' + o.qty + '&ref=' + o.ref;
  const r = await fetch(url);
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (e) { /* not json */ }
  const d = (j && j.description) || {};
  const done = !!j && String(j.code) === '101' && /completed/i.test(String(d.Status || ''));
  const pins = done ? parsePins(d.pins, o.exam) : [];
  return { ok: done && pins.length > 0, pins, raw: text.slice(0, 3000), charged: Number(d.Amount_Charged) || 0 };
}

// ---------- order pipeline ----------
async function settle(o) {
  if (o.status === 'delivered' || o.busy) return o;
  o.busy = true;
  try {
    if (!o.paidAt) {
      if (!(await isPaid(o))) return o;
      o.paidAt = new Date().toISOString(); o.status = 'paid'; save();
    }
    if (o.tries >= 3) return o;                          // stop auto retrying, admin can retry
    o.tries = (o.tries || 0) + 1;
    const res = await buyTokens(o);
    o.providerRaw = res.raw;
    if (res.ok) { o.tokens = res.pins; o.status = 'delivered'; o.deliveredAt = new Date().toISOString(); ensureCode(o); if (res.charged > 0) o.supplierCharged = res.charged; save(); emailReceipt(o).catch(() => {}); }
    else { o.status = 'paid_not_delivered'; }
    save();
  } catch (e) {
    o.status = o.paidAt ? 'paid_not_delivered' : o.status; o.err = String(e.message || e).slice(0, 200); save();
  } finally { o.busy = false; }
  return o;
}
// Group raw token lines into cards: WAEC/NABTEB = Serial + PIN, NECO = one token.
function cardsOf(o) {
  const cards = []; let cur = null;
  for (const t of (o.tokens || [])) {
    const isSerial = /serial/i.test(t.k);
    if (!cur || (isSerial && cur.serial) || (!isSerial && cur.pin)) { cur = {}; cards.push(cur); }
    if (isSerial) cur.serial = t.v; else cur.pin = t.v;
  }
  return cards.filter((c) => c.pin || c.serial).map((c, i) => ({ n: i + 1, serial: c.serial || '', pin: c.pin || c.serial }));
}
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() { let c = ''; const b = crypto.randomBytes(8); for (let i = 0; i < 8; i++) c += CODE_CHARS[b[i] % CODE_CHARS.length]; return 'EI-' + c; }
function ensureCode(o) { if (!o.code) { do { o.code = newCode(); } while (Object.values(orders).some((x) => x !== o && x.code === o.code)); save(); } return o.code; }
const maskName = (n) => { const p = String(n).trim().split(/\s+/); return p.length > 1 ? p[0] + ' ' + p[p.length - 1][0].toUpperCase() + '.' : p[0]; };
const dateText = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
function findByCode(full) {
  const m = /^(EI-[A-Z0-9]{8})-(\d{1,2})$/.exec(String(full || '').trim().toUpperCase()); if (!m) return null;
  const o = Object.values(orders).find((x) => x.code === m[1] && x.status === 'delivered'); if (!o) return null;
  const cards = cardsOf(o), card = cards[Number(m[2]) - 1]; return card ? { o, card, cards } : null;
}
const publicView = (o) => {
  const done = o.status === 'delivered';
  return {
    ref: o.ref, exam: o.exam, qty: o.qty, amount: o.amount, status: o.status, whatsapp: settings.whatsapp,
    tokens: done ? o.tokens : [], name: o.name,
    cards: done ? cardsOf(o).map((c) => Object.assign({}, c, { used: !!(o.used && o.used[c.n]) })) : []
  };
};

// ---------- questions library: free PIN codes you give to your students ----------
// Content is posted after each exam has been written. A PIN is an access code (not for sale).
const EXAM_LIST = ['WAEC', 'NECO', 'NABTEB', 'JAMB', 'IJMB', 'JUPEB'];
const LIB_DIR = path.join(DATA, 'library-img'); fs.mkdirSync(LIB_DIR, { recursive: true });
let lib = readJson('library.json', { entries: {}, pins: {} });
const saveLib = () => writeJson('library.json', lib);
let saveTimer = null; const saveLibSoon = () => { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; saveLib(); }, 5000); };   // busy PINs: write the file at most every 5 seconds
let pinSecret; try { pinSecret = fs.readFileSync(path.join(DATA, 'pin.secret'), 'utf8'); } catch (e) { pinSecret = rid(32); fs.writeFileSync(path.join(DATA, 'pin.secret'), pinSecret, { mode: 0o600 }); }
const normPin = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const pinHash = (p) => crypto.createHmac('sha256', pinSecret).update(normPin(p)).digest('hex');
function newPin() { if (PIN_DIGITS) return String(crypto.randomInt(0, 10 ** PIN_DIGITS)).padStart(PIN_DIGITS, '0'); let c = ''; const b = crypto.randomBytes(8); for (let i = 0; i < 8; i++) c += CODE_CHARS[b[i] % CODE_CHARS.length]; return c.slice(0, 4) + '-' + c.slice(4); }
const IMG_ID = /^[a-f0-9]{24}$/;
const imgFile = (id) => { for (const ext of ['jpg', 'png', 'webp']) { const f = path.join(LIB_DIR, id + '.' + ext); if (IMG_ID.test(id) && fs.existsSync(f)) return { f, type: ext === 'jpg' ? 'image/jpeg' : 'image/' + ext }; } return null; };
const SESSION_MS = 30 * 24 * 3600 * 1000;
function libSig(sid) { return crypto.createHmac('sha256', pinSecret).update('lib.' + sid).digest('hex'); }
// Each PIN opens only the pages linked to it (p.entries). Old PINs made before this update have no list and open everything.
function pinCan(p, entryId) { return p.all === true || !Array.isArray(p.entries) || p.entries.includes(entryId); }
function pinActive(p) { return p && !p.revoked && (!p.exp || Date.now() < p.exp); }
function libAuth(req) {
  const m = /(?:^|;\s*)ei_lib=([a-z0-9-]{4,60})\.([a-f0-9]{64})/.exec(req.headers.cookie || ''); if (!m || !safeEq(m[2], libSig(m[1]))) return null;
  const u = /^u-([a-f0-9]{12})-(\d+)$/.exec(m[1]);   // unlimited PIN: nothing is stored per student, so any number of people can use it
  if (u) { const p = lib.pins[u[1]]; return p && p.max === 0 && (p.ep || 0) === Number(u[2]) && pinActive(p) ? { id: u[1], pin: p, sid: m[1] } : null; }
  for (const id of Object.keys(lib.pins)) {
    const p = lib.pins[id], ses = (p.sessions || []).find((x) => x.s === m[1]);
    if (ses && Date.now() - ses.at < SESSION_MS && pinActive(p)) return { id, pin: p, sid: m[1] };
  }
  return null;
}
const libCookie = (sid) => 'ei_lib=' + sid + '.' + libSig(sid) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + (SESSION_MS / 1000) + (SECURE_COOKIE ? '; Secure' : '');
// returns { ok, cookie } or { error, code }
function enterPin(req, text, ip) {
  if (limited(ip, 'pin', 8, 600000)) return { error: 'Too many tries. Wait 10 minutes.', code: 429 };
  const h = pinHash(text); const id = Object.keys(lib.pins).find((k) => safeEq(lib.pins[k].h, h));
  const p = id && lib.pins[id];
  if (!pinActive(p)) return { error: 'That PIN is not correct or has expired.', code: 401 };
  const cur = libAuth(req); if (cur && cur.id === id) return { ok: true, label: p.label };
  if (p.max === 0) { p.uses = (p.uses || 0) + 1; p.lastUsed = new Date().toISOString(); saveLibSoon(); return { ok: true, cookie: libCookie('u-' + id + '-' + (p.ep || 0)), label: p.label }; }
  p.sessions = (p.sessions || []).filter((x) => Date.now() - x.at < SESSION_MS);
  if (p.sessions.length >= (p.max || 3)) return { error: 'This PIN is already in use on the most devices allowed. Ask ExamInfo for help.', code: 403 };
  const sid = rid(16); p.sessions.push({ s: sid, at: Date.now() }); p.uses = (p.uses || 0) + 1; p.lastUsed = new Date().toISOString(); saveLib();
  return { ok: true, cookie: libCookie(sid), label: p.label };
}
const entryPublic = (e, full) => Object.assign({ id: e.id, exam: e.exam, year: e.year, subject: e.subject, title: e.title, created: e.created, images: (e.images || []).length }, full ? { text: e.text, imageIds: e.images || [] } : {});
function readEntry(d, old) {
  const exam = String(d.exam || '').toUpperCase(), year = Math.floor(Number(d.year)), title = String(d.title || '').trim(), subject = String(d.subject || '').trim(), text = String(d.text || '');
  if (!EXAM_LIST.includes(exam)) return { error: 'Choose the exam.' };
  if (!(year >= 2000 && year <= 2100)) return { error: 'Enter the exam year.' };
  if (title.length < 3 || title.length > 120) return { error: 'Title must be 3 to 120 characters.' };
  if (subject.length > 60 || text.length > 30000) return { error: 'Subject or text is too long.' };
  const images = (Array.isArray(d.images) ? d.images : []).filter((x) => IMG_ID.test(x) && imgFile(x)).slice(0, 25);
  if (!(d.written === true || (old && old.written))) return { error: 'Tick the box: this exam has already been written.' };
  if (!text.trim() && !images.length) return { error: 'Add some text or at least one image.' };
  if (d.aiAnswers === true && d.aiChecked !== true) return { error: 'The AI wrote some answers. Tick the box to confirm you have checked them.' };
  return { value: Object.assign(old || { id: rid(8), created: new Date().toISOString() }, { exam, year, title, subject, text, images, written: true, published: !!d.published, practice: d.practice !== false, aiChecked: d.aiAnswers === true ? true : !!(old && old.aiChecked) }) };
}
function imgType(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}
function sendImage(res, id) {
  const f = imgFile(id); if (!f) return send(res, 404, 'Not found', 'text/plain');
  send(res, 200, fs.readFileSync(f.f), f.type, { 'Cache-Control': 'private, no-store' });
}

// ---------- AI arranger: turns raw answers + question paper photos into the ExamInfo layout ----------
// Needs ANTHROPIC_API_KEY in .env. The text and pictures you press "Arrange with AI" on are sent to Anthropic. Nothing is sent otherwise.
const AI_KEY = E.ANTHROPIC_API_KEY || '';
const AI_MODEL = E.AI_MODEL || 'claude-sonnet-5-5';
const AI_BASE = (E.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const AI_SYSTEM = `You are the content formatter for ExamInfo, a Nigerian student-help website. The owner gives you raw material (typed text and photos) for ONE page of questions and answers for an exam that has ALREADY been written. Put everything into ExamInfo's exact layout. Never invent a question, a mark or an answer. Never copy from other websites. Keep the owner's wording (you may fix spelling and spacing only).

The raw material can be in ANY order and can mix: answers, typed questions, notes, and photos. Work like this:
1. Photos: read each one. Decide what it is: a question paper page (cover page, instructions page, or a page of questions), a diagram or map, an answer sheet, or something unrelated or a duplicate. Use the page numbers and question numbers printed on the photos to put question paper pages in their correct order (cover/instructions first, then page 2, 3 and so on, then Paper 1 or Paper 2 order as printed). If two photos show the same page, keep the clearer one and list the other in skip_pictures. If a photo is too blurry to read, say so in check.
2. Text: find every question number and part ((a), (b), (c)). Sort everything by question number and part, even if the owner pasted it as 3, 1, 2. Put each answer under its own question. If the owner typed a question, show it with a line that starts with "Q: " right after the part label. If a part has no answer, write the line: (answer not supplied)
3. Do not silently fix a wrong looking answer or a mismatch between a question and its answer. List it in check.
4. If a photo shows a question that has no typed text, you may read it and show it as a "Q: " line only when the photo is clear. Otherwise leave it to the picture.
5. If a question (typed, or clearly readable in a photo) has NO answer in the raw material, write the answer yourself in the same layout using your own subject knowledge: objective answers go in the letter lines, theory answers as parts and points. Do not leave a gap. If you are not sure, still give your best answer and describe the doubt in check. List every question you answered this way in ai_filled (for example "Objective 12", "1b") and set ai_answers to true. Leave out the COMPLETED line when you wrote any answers yourself. Never claim these answers are official, and never invent a question you cannot read.

EXACT TEXT LAYOUT for the "text" field (plain text, no markdown, no emojis, no tables, no bullet dots):
- First line: the subject in CAPITAL letters, for example ENGLISH LANGUAGE
- Objective answers, 10 letters per line and nothing else on that line, for example: 01-10: BBADBBDDCC  then  11-20: CCDABBDCBC
- Then a line with only: COMPLETED (only when every answer was supplied)
- Each question starts with two heading lines, each wrapped in stars, for example: *WAEC ENGLISH LANGUAGE* then *NUMBER ONE* (use the real exam, subject and question number)
- Each part on its own line in brackets with nothing else on that line: (1a) (1b) (2a)
- A typed question: Q: followed by the question text, on one line, directly under the part label\n- A typed objective question with options: the Q: line, then each option on its own line (A. text then B. text then C. text then D. text), then a line Answer: B
- An instruction line in capitals inside brackets: (PICK ANY FIVE) or (CHOOSE ANY FOUR)
- Points: one per line, starting with a roman number in brackets: (i) First point. (ii) Second point. A point with a title is written (iii) Title of point: the explanation.
- One blank line between parts. If a question needs a drawn diagram or map, write one line: Draw the diagram below

Reply with ONE JSON object and nothing else (no words before or after, no code fences) with exactly these keys:
{"exam": "WAEC or NECO or NABTEB or JAMB or IJMB or JUPEB, or empty text if unknown",
 "year": 2026 (a number, or 0 if unknown),
 "subject": "English Language",
 "title": "WAEC 2026 English Language Answers",
 "text": "the full formatted text using \\n for new lines",
 "pictures": [{"n": 1, "what": "short description of picture 1"}],
 "picture_order": [2, 1, 4],
 "skip_pictures": [3],
 "check": ["short note about anything unclear, missing, blurry or possibly wrong"],
 "pin_label": "short name for the PIN of this page, for example SS3 English 2026",
 "ai_answers": false (true only if you wrote any answers yourself),
 "ai_filled": ["Objective 12", "1b"] (empty list if you wrote none)}
"pictures" lists every photo in the order given. "picture_order" lists the picture numbers to SHOW, in the order to show them. A picture number must not appear in both picture_order and skip_pictures. If no photos were given use empty lists.`;
function aiParse(text, nImages) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a < 0 || b <= a) throw new Error('The AI reply was not understood. Try again.');
  let j; try { j = JSON.parse(text.slice(a, b + 1)); } catch (e) { throw new Error('The AI reply was not understood. Try again.'); }
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const ex = str(j.exam, 10).toUpperCase(); const yr = Math.floor(Number(j.year));
  const seen = new Set(), order = [];
  (Array.isArray(j.picture_order) ? j.picture_order : []).forEach((x) => { x = Math.floor(Number(x)); if (x >= 1 && x <= nImages && !seen.has(x)) { seen.add(x); order.push(x); } });
  const skip = [];
  (Array.isArray(j.skip_pictures) ? j.skip_pictures : []).forEach((x) => { x = Math.floor(Number(x)); if (x >= 1 && x <= nImages && !seen.has(x) && !skip.includes(x)) skip.push(x); });
  for (let n = 1; n <= nImages; n++) if (!seen.has(n) && !skip.includes(n)) order.push(n);   // never lose a picture the AI forgot
  return {
    exam: EXAM_LIST.includes(ex) ? ex : '', year: yr >= 2000 && yr <= 2100 ? yr : 0, subject: str(j.subject, 60).trim(), title: str(j.title, 120).trim(),
    text: str(j.text, 30000).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim(),
    pictures: (Array.isArray(j.pictures) ? j.pictures : []).slice(0, 25).map((p) => ({ n: Math.floor(Number(p && p.n)) || 0, what: str(p && p.what, 120) })),
    picture_order: order, skip_pictures: skip, check: (Array.isArray(j.check) ? j.check : []).slice(0, 25).map((c) => str(c, 300)).filter(Boolean), pin_label: str(j.pin_label, 40).trim(),
    ai_filled: (Array.isArray(j.ai_filled) ? j.ai_filled : []).slice(0, 100).map((c) => str(c, 40)).filter(Boolean), ai_answers: j.ai_answers === true || (Array.isArray(j.ai_filled) && j.ai_filled.length > 0)
  };
}
async function aiArrange(raw, ids, hint) {
  const content = [{ type: 'text', text: 'Hints from the owner (may be empty): exam=' + (hint.exam || '') + ', year=' + (hint.year || '') + ', subject=' + (hint.subject || '') + '.\n\nRAW TEXT (any order):\n' + (raw || '(none)') }];
  ids.forEach((id, i) => {
    const f = imgFile(id); content.push({ type: 'text', text: 'Picture ' + (i + 1) + ':' });
    content.push({ type: 'image', source: { type: 'base64', media_type: f.type, data: fs.readFileSync(f.f).toString('base64') } });
  });
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 170000);
  let r;
  try {
    r = await fetch(AI_BASE + '/v1/messages', { method: 'POST', signal: ctl.signal, headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 12000, temperature: 0, system: AI_SYSTEM, messages: [{ role: 'user', content }] }) });
  } catch (e) { throw new Error('Could not reach the AI service. Try again.'); } finally { clearTimeout(timer); }
  if (r.status === 401 || r.status === 403) throw new Error('The AI key was not accepted. Check ANTHROPIC_API_KEY in .env.');
  if (r.status === 429) throw new Error('The AI service is busy. Wait a minute and try again.');
  if (!r.ok) throw new Error('The AI service had a problem (' + r.status + '). Try again.');
  const j = await r.json(); const t = (j.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
  return aiParse(t, ids.length);
}

// ---------- Blogger post maker: news text or link in, ready-to-publish post out (never auto-publishes) ----------
const BLOGGER_ON = () => !!(E.BLOGGER_BLOG_ID && E.GOOGLE_CLIENT_ID && E.GOOGLE_CLIENT_SECRET && E.GOOGLE_REFRESH_TOKEN);
const escH = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function safeUrl(u) {
  try { const x = new URL(String(u)); if (!/^https?:$/.test(x.protocol)) return null; const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.includes(':') || /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return null; return x.href; } catch (e) { return null; }
}
async function readPage(url) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
  try { const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'ExamInfoPostMaker/1.0' } }); if (!r.ok) throw new Error('x');
    const h = (await r.text()).slice(0, 400000);
    return h.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 12000);
  } catch (e) { throw new Error('Could not read that link. Paste the article text instead.'); } finally { clearTimeout(t); }
}
const POST_SYSTEM = `You write short education news posts for ExamInfo, a Nigerian student-help website. Use ONLY the facts in the text you are given. Write in your own new words and never copy sentences. Reply with ONE JSON object and nothing else: {"title": "a clear headline under 90 characters", "labels": ["one to three of: JAMB, WAEC, NECO, NABTEB, NELFUND, Scholarships, Admissions, School news, Tips"], "description": "one sentence under 150 characters", "image_query": "two to four words naming the main place or institution in the story, for a picture search (not a person)", "paragraphs": ["paragraph 1", "paragraph 2", "paragraph 3"]}. Paragraph 1: what happened. Paragraph 2: the details (dates, amounts, names) only if they are in the text. Paragraph 3: what students should do, practical, with no invented facts. Plain text only, no markdown. If the text has too few facts, keep it short and say so in paragraph 3.`;
async function aiPost(text) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 120000); let r;
  try { r = await fetch(AI_BASE + '/v1/messages', { method: 'POST', signal: ctl.signal, headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: 2000, temperature: 0.3, system: POST_SYSTEM, messages: [{ role: 'user', content: 'TEXT:\n' + text }] }) }); }
  catch (e) { throw new Error('Could not reach the AI service. Try again.'); } finally { clearTimeout(t); }
  if (r.status === 401 || r.status === 403) throw new Error('The AI key was not accepted. Check ANTHROPIC_API_KEY in .env.');
  if (r.status === 429) throw new Error('The AI service is busy. Wait a minute and try again.');
  if (!r.ok) throw new Error('The AI service had a problem (' + r.status + '). Try again.');
  const j = await r.json(); const out = (j.content || []).filter((x) => x.type === 'text').map((x) => x.text).join(''); const a = out.indexOf('{'), b = out.lastIndexOf('}');
  let o; try { o = JSON.parse(out.slice(a, b + 1)); } catch (e) { throw new Error('The AI reply was not understood. Try again.'); }
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  return { title: str(o.title, 120), description: str(o.description, 160), imageQuery: str(o.image_query, 60), labels: (Array.isArray(o.labels) ? o.labels : []).slice(0, 3).map((x) => str(x, 30)).filter(Boolean), paragraphs: (Array.isArray(o.paragraphs) ? o.paragraphs : []).slice(0, 4).map((x) => str(x, 1500)).filter(Boolean) };
}
function postHtml(p, srcName, srcUrl) {
  const src = srcUrl ? '<p style="font-size:.9em"><b>Source:</b> ' + escH(srcName || 'Original report') + ' (<a href="' + escH(srcUrl) + '" rel="nofollow noopener" target="_blank">read the full story</a>)</p>' : '';
  return '<div class="ei-post">\n' + p.paragraphs.map((x) => '<p>' + escH(x) + '</p>').join('\n') + '\n' + src
    + '\n<p style="background:#eaf3ed;border-radius:8px;padding:10px"><b>Need help?</b> Chat ExamInfo on WhatsApp: <a href="https://wa.me/2349045195158" target="_blank">09045195158</a>. Share this post with your classmates.</p>\n</div>';
}
async function bloggerDraft(title, html, labels) {
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: E.GOOGLE_CLIENT_ID, client_secret: E.GOOGLE_CLIENT_SECRET, refresh_token: E.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
  const tj = await tr.json().catch(() => ({})); if (!tr.ok || !tj.access_token) throw new Error('Google did not accept the saved login. Check the GOOGLE_ values in .env.');
  const r = await fetch('https://www.googleapis.com/blogger/v3/blogs/' + encodeURIComponent(E.BLOGGER_BLOG_ID) + '/posts?isDraft=true', { method: 'POST',
    headers: { authorization: 'Bearer ' + tj.access_token, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'blogger#post', title, content: html, labels }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('Blogger refused the draft (' + r.status + ').');
  return { id: j.id, url: j.url || '' };
}

// ---------- http plumbing ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function send(res, code, body, type, extra) {
  const h = Object.assign({
    'Content-Type': type || 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store'
  }, extra || {});
  res.writeHead(code, h); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function body(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > (max || 20000)) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const NOFRAME = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" };
// The questions page may be shown INSIDE your Blogger site (so visitors never leave it).
// Put your Blogger address(es) in FRAME_ALLOW, for example: https://www.examinfo.com.ng https://examinfo.blogspot.com
const FRAME_ALLOW = String(E.FRAME_ALLOW || '').split(/[ ,]+/).filter((o) => /^https?:\/\/[A-Za-z0-9.\-:]+$/.test(o));
const ADMIN_SAMESITE = (E.ADMIN_COOKIE_SAMESITE === 'None' && SECURE_COOKIE) ? 'None' : (E.ADMIN_COOKIE_SAMESITE === 'Lax' ? 'Lax' : 'Strict');   // Lax when the admin is shown inside www.examinfo.com.ng (same site as pay.examinfo.com.ng)
const LIBFRAME = FRAME_ALLOW.length ? { 'Content-Security-Policy': "frame-ancestors 'self' " + FRAME_ALLOW.join(' ') } : NOFRAME;
// PIN_DIGITS=3 makes new PINs 3 numbers (for example 417). Leave empty for the longer ABCD-EFGH style.
const PIN_DIGITS = Math.min(8, Math.max(0, parseInt(E.PIN_DIGITS, 10) || 0));
function serveFile(res, name, extra) {
  const f = path.join(__dirname, 'public', name);
  if (!f.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(f)) return send(res, 404, 'Not found', 'text/plain');
  send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream', extra);
}

// ---------- admin password, login, forgot-password OTP ----------
const scrypt = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
let auth = readJson('auth.json', null);
if (!auth) {
  const salt = rid(16);
  auth = { salt, hash: scrypt(DEFAULT_PASSWORD, salt), epoch: 1, defaultPw: true, otp: null, sent: [] };
  writeJson('auth.json', auth);
}
const saveAuth = () => writeJson('auth.json', auth);
const pwOk = (pw) => safeEq(scrypt(pw, auth.salt), auth.hash);
function sign(exp) { return crypto.createHmac('sha256', SESSION_SECRET).update(exp + '.' + auth.epoch).digest('hex'); }
function makeSession() { const exp = String(Date.now() + 8 * 3600 * 1000); return exp + '.' + sign(exp); }
function isAdmin(req) {
  const m = /(?:^|;\s*)ei_admin=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return false;
  const [exp, sig] = m[1].split('.'); if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEq(sig, sign(exp));
}
let failed = []; // global wrong-password times
function locked() { const now = Date.now(); failed = failed.filter((t) => now - t < 900000); return failed.length >= 20; }

const mailOn = () => !!(E.RESEND_API_KEY && E.MAIL_FROM);
const smsOn = () => !!E.TERMII_API_KEY;
const normPhone = (p) => '234' + String(p).replace(/\D/g, '').replace(/^234/, '').replace(/^0/, '');
const maskEmail = (e) => e.replace(/^(.{2}).*(@.*)$/, '$1***$2');
const maskPhone = (p) => String(p).replace(/^(\d{4}).*(\d{3})$/, '$1***$2');
function recoveryList() {
  return settings.recovery.emails.map((e, i) => ({ id: 'e' + i, label: maskEmail(e) }))
    .concat(settings.recovery.phones.map((p, i) => ({ id: 'p' + i, label: maskPhone(p) })));
}
async function sendMail(to, subject, text, html) {
  const r = await fetch(E.MAIL_API_URL || 'https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + E.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: E.MAIL_FROM, to: [to], subject, text, html }) });
  if (!r.ok) throw new Error('mail ' + r.status);
}
async function sendSms(to, text) {
  const r = await fetch(E.SMS_API_URL || 'https://api.ng.termii.com/api/sms/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: normPhone(to), from: E.TERMII_SENDER_ID || 'N-Alert', sms: text, type: 'plain', channel: E.TERMII_CHANNEL || 'generic', api_key: E.TERMII_API_KEY }) });
  if (!r.ok) throw new Error('sms ' + r.status);
}
// Returns true if a code was sent (or printed in test mode)
async function sendOtp(id, code) {
  const text = 'Your ExamInfo password reset code is ' + code + '. It expires in 10 minutes. If you did not ask for it, ignore this message.';
  const kind = id[0], idx = Number(id.slice(1));
  const dest = kind === 'e' ? settings.recovery.emails[idx] : kind === 'p' ? settings.recovery.phones[idx] : null;
  if (!dest) return false;
  if (kind === 'e' && mailOn()) { await sendMail(dest, 'ExamInfo password reset code', text); return true; }
  if (kind === 'p' && smsOn()) { await sendSms(dest, text); return true; }
  if (MOCK || E.OTP_CONSOLE === 'true') { console.log('[TEST] reset code for ' + dest + ': ' + code); return true; }
  return false;
}
async function emailReceipt(o) {
  if (!mailOn() || !o.email || o.emailed) return;
  const cards = cardsOf(o), link = SITE_URL + '/?ref=' + o.ref + '&key=' + o.key;
  const lines = cards.map((c) => 'Card ' + c.n + ': ' + (c.serial ? 'Serial ' + c.serial + ', PIN ' + c.pin : 'Token ' + c.pin)).join('\n');
  const text = 'Welcome to ExamInfo, ' + o.name + '!\n\nThank you for choosing us. Please refer ExamInfo to your classmates and your school. Your ' + o.exam + ' result checker ' + (o.qty > 1 ? 'tokens' : 'token') + ':\n\n' + lines + '\n\nYour token card: ' + link + '\nOrder ' + o.ref + ' · ' + naira(o.amount) + '\n\nKeep this email private. ExamInfo is independent and is not an exam body.';
  const COL = { WAEC: '#1f7a4d', NECO: '#1d4ed8', NABTEB: '#d97706' }[o.exam] || '#16306b';
  const esc = (t) => String(t == null ? '' : t).replace(/[<>&"]/g, '');
  const exam = esc(o.exam), plural = o.qty > 1;
  const cardsHtml = cards.map((c) => '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #cfe0d4;border-radius:14px;margin:14px 0;overflow:hidden;font-family:Arial,sans-serif;background:#fff"><tr><td style="background:' + COL + ';color:#fff;padding:14px 16px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td><img src="' + SITE_URL + '/emblems/' + String(o.exam).toLowerCase() + '.jpg" width="46" height="46" alt="' + exam + '" style="border-radius:23px;background:#fff;display:block"></td><td style="padding-left:12px;color:#fff"><div style="font-size:16px;font-weight:bold">' + exam + ' ' + (o.exam === 'NECO' ? 'RESULT CHECKING TOKEN' : 'RESULT CHECKER PIN') + '</div><div style="font-size:12px;color:#ffd566;font-weight:bold">Purchased on ExamInfo</div></td></tr></table></td></tr><tr><td style="padding:16px;font-size:14px;color:#1b2430"><div style="font-size:11px;letter-spacing:1px;color:#5d6b7a">ISSUED TO</div><div style="font-size:18px;font-weight:bold">' + esc(o.name) + '</div>' + (c.serial ? '<div style="font-size:11px;letter-spacing:1px;color:#5d6b7a;margin-top:12px">SERIAL NUMBER</div><div style="font-family:Consolas,monospace;font-size:20px;font-weight:bold;color:#16306b">' + esc(c.serial) + '</div>' : '') + '<div style="font-size:11px;letter-spacing:1px;color:#5d6b7a;margin-top:12px">' + (c.serial ? 'PIN' : 'TOKEN') + '</div><div style="font-family:Consolas,monospace;font-size:22px;font-weight:bold;letter-spacing:2px;color:#16306b">' + esc(c.pin) + '</div><div style="font-size:12px;color:#5d6b7a;margin-top:10px">Card ' + c.n + ' of ' + cards.length + '</div></td></tr></table>').join('');
  const share = 'https://wa.me/?text=' + encodeURIComponent('Hello, I bought my result checker token from ExamInfo and it was fast and easy. Visit www.examinfo.com.ng for tokens, JAMB help, news and more.');
  const html = '<div style="max-width:540px;margin:0 auto;font-family:Arial,sans-serif;background:#f1f6f2;padding:12px"><div style="background:#16306b;color:#fff;padding:18px 14px;text-align:center;border-radius:14px 14px 0 0"><div style="font-size:24px;font-weight:bold;letter-spacing:1px">EXAM INFO</div><div style="font-size:13px;color:#ffd566;margin-top:4px">Helping students across Nigeria since 2016</div></div><div style="padding:18px 16px;background:#fff;border:1px solid #cfe0d4;border-top:0;border-radius:0 0 14px 14px;color:#1b2430;font-size:15px;line-height:1.55"><p style="font-size:18px;margin:0 0 8px"><b>Welcome to ExamInfo, ' + esc(o.name) + '!</b></p><p style="margin:0 0 6px">Thank you for choosing us. Your payment was received and your ' + exam + ' result checker ' + (plural ? 'tokens are' : 'token is') + ' ready below.</p>' + cardsHtml + '<p style="text-align:center;margin:18px 0"><a href="' + link + '" style="background:#1f7a4d;color:#fff;padding:12px 22px;border-radius:24px;text-decoration:none;font-weight:bold;display:inline-block">Open and save your token card</a></p><div style="background:#fff4cc;border-left:5px solid #f2b632;border-radius:8px;padding:12px 14px;font-size:14px"><b>Please keep it safe.</b> Do not share your PIN with anyone. Save the card picture or take a screenshot of this email.</div><div style="background:#eaf3ed;border-radius:10px;padding:14px;margin-top:16px;text-align:center"><b style="color:#16306b;font-size:16px">Love our service? Tell your friends!</b><br><span style="font-size:14px">Please refer ExamInfo to your classmates, your friends and your school. They can buy tokens, read education news and get help with JAMB, post-UTME and more.</span><br><a href="' + share + '" style="background:#25d366;color:#fff;padding:10px 20px;border-radius:22px;text-decoration:none;font-weight:bold;display:inline-block;margin-top:10px">Share on WhatsApp</a></div><p style="font-size:14px;text-align:center;margin:16px 0 0">Need help? Chat us on WhatsApp: <a href="https://wa.me/2349045195158" style="color:#1d4ed8;font-weight:bold">09045195158</a></p><p style="font-size:12px;color:#5d6b7a;text-align:center;margin:14px 0 0">Order ' + esc(o.ref) + ' &middot; ' + naira(o.amount) + '<br>ExamInfo is independent and is not an exam body. www.examinfo.com.ng</p></div></div>';
  await sendMail(o.email, 'Welcome to ExamInfo: your ' + o.exam + ' token is ready', text, html);
  o.emailed = true; save();
}


const practice = require('./lib/practice');
const libQuestions = () => Object.values(lib.entries).filter((e) => e.published && e.practice !== false).flatMap((e) => practice.extract(e));
const community = require('./lib/community')({ send, body, limited, ipOf, readJson, writeJson, isAdmin, E, libQuestions });
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'); const p = u.pathname; const ip = ipOf(req);
    if (await community(req, res, u, p)) return;

    // ----- public pages -----
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, 'index.html');
    if (req.method === 'GET' && p === '/admin') return serveFile(res, 'admin.html', LIBFRAME);   // shown inside YOUR Blogger page only (FRAME_ALLOW); the password is still needed
    if (req.method === 'GET' && p === '/verify') return serveFile(res, 'verify.html', NOFRAME);

    // ----- token card picture (needs the order key) -----
    if (req.method === 'GET' && p === '/card') {
      const o = orders[u.searchParams.get('ref')];
      if (!o || !safeEq(o.key, u.searchParams.get('key') || '') || o.status !== 'delivered') return send(res, 404, 'Not found', 'text/plain');
      const card = cardsOf(o)[Number(u.searchParams.get('n')) - 1]; if (!card) return send(res, 404, 'Not found', 'text/plain');
      const cards = cardsOf(o), code = ensureCode(o);
      const svg = cardSvg({ exam: o.exam, name: o.name, serial: card.serial, pin: card.pin, code: code + '-' + card.n, qrUrl: SITE_URL + '/verify?c=' + code + '-' + card.n,
        date: dateText(o.deliveredAt || o.created), n: card.n, total: cards.length, used: !!(o.used && o.used[card.n]) });
      return send(res, 200, svg, 'image/svg+xml; charset=utf-8');
    }
    // ----- public verify: shows if this card is a real ExamInfo purchase and its used/unused mark -----
    if (req.method === 'GET' && p === '/api/verify') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Admin login needed.' });
      const f = findByCode(u.searchParams.get('c'));
      if (!f) return send(res, 200, { found: false });
      const mark = (f.o.used || {})[f.card.n];
      return send(res, 200, { found: true, exam: f.o.exam, name: f.o.name, phone: f.o.phone, email: f.o.email, ref: f.o.ref, amount: f.o.amount, issued: dateText(f.o.deliveredAt || f.o.created), card: f.card.n, of: f.cards.length,
        endsWith: String(f.card.pin).slice(-4), used: !!mark, usedAt: mark ? mark.at : null, usedBy: mark ? mark.by : null });
    }
    // ----- buyer marks a card as used / not used -----
    if (req.method === 'POST' && p === '/api/mark-used') {
      const d = JSON.parse((await body(req)).toString() || '{}'); const o = orders[d.ref];
      if (!o || !safeEq(o.key, String(d.key || '')) || o.status !== 'delivered' || !cardsOf(o)[Number(d.n) - 1]) return send(res, 404, { error: 'Not found.' });
      o.used = o.used || {};
      if (d.used) o.used[Number(d.n)] = { at: new Date().toISOString(), by: 'buyer' }; else delete o.used[Number(d.n)];
      save(); return send(res, 200, { ok: true, used: !!d.used });
    }

    // ----- public api -----
    if (req.method === 'GET' && p === '/api/products') {
      const items = Object.keys(settings.products).map((k) => ({ exam: k, price: unitPrice(settings.products[k]) }));
      return send(res, 200, { items, maxQty: settings.maxQty, whatsapp: settings.whatsapp, test: MOCK, emailOn: mailOn(), about: settings.about });
    }
    if (req.method === 'POST' && p === '/api/order') {
      if (limited(ip, 'order', 8, 60000)) return send(res, 429, { error: 'Too many tries. Wait a minute.' });
      const d = JSON.parse((await body(req)).toString() || '{}');
      const exam = String(d.exam || '').toUpperCase(), prod = settings.products[exam];
      const qty = Math.floor(Number(d.qty)), name = String(d.name || '').trim(), email = String(d.email || '').trim();
      const phone = String(d.phone || '').replace(/[\s-]/g, '');
      if (!prod || !unitPrice(prod)) return send(res, 400, { error: 'This token is not available right now.' });
      if (!(qty >= 1 && qty <= settings.maxQty)) return send(res, 400, { error: 'Choose 1 to ' + settings.maxQty + ' tokens.' });
      if (name.length < 2 || name.length > 60) return send(res, 400, { error: 'Enter your full name.' });
      if (!/^(\+?234|0)\d{10}$/.test(phone)) return send(res, 400, { error: 'Enter a valid Nigerian phone number.' });
      if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) return send(res, 400, { error: 'Enter a valid email.' });
      const unit = unitPrice(prod);
      const o = { ref: newRef(), key: rid(12), exam, qty, name, phone, email, unit, cost: prod.cost, amount: unit * qty, status: 'pending', created: new Date().toISOString(), tokens: [], tries: 0 };
      orders[o.ref] = o; save();
      try { return send(res, 200, { ref: o.ref, key: o.key, checkoutUrl: await startPayment(o) }); }
      catch (e) { o.status = 'failed_to_start'; o.err = String(e.message).slice(0, 200); save(); console.error(e.message); return send(res, 502, { error: 'Payment could not start. Try again.' }); }
    }
    if (req.method === 'GET' && p === '/api/order') {
      const o = orders[u.searchParams.get('ref')];
      if (!o || !safeEq(o.key, u.searchParams.get('key') || '')) return send(res, 404, { error: 'Order not found.' });
      if (o.status === 'pending' || o.status === 'paid') await settle(o);
      return send(res, 200, publicView(o));
    }

    // ----- JAMB practice questions: pay, then check -----
    if (p.startsWith('/api/cbt/')) {
      const cors = corsFor(req);
      if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain', cors);
      if (req.method === 'GET' && p === '/api/cbt/info') return send(res, 200, { price: CBT_PRICE, hours: CBT_HOURS, test: MOCK }, null, cors);
      if (req.method === 'POST' && p === '/api/cbt/order') {
        if (limited(ip, 'cbt', 10, 60000)) return send(res, 429, { error: 'Too many tries. Wait a minute.' }, null, cors);
        const d = JSON.parse((await body(req)).toString() || '{}');
        const name = String(d.name || '').trim(), email = String(d.email || '').trim(), reg = String(d.reg || '').replace(/\s/g, '');
        if (name.length < 3 || name.length > 60) return send(res, 400, { error: 'Enter your full name.' }, null, cors);
        if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) return send(res, 400, { error: 'Enter a valid email.' }, null, cors);
        const _d = new Date(), _y = _d.getMonth() > 4 ? _d.getFullYear() + 1 : _d.getFullYear();   // same exam-year rule as the page
        if (!new RegExp('^' + _y + '\\d{7}[A-Za-z]{2}$').test(reg)) return send(res, 400, { error: 'Please enter a valid registration number.' }, null, cors);
        const o = { ref: newRef(), key: rid(12), kind: 'cbt', name, email, reg, amount: CBT_PRICE, status: 'pending', created: new Date().toISOString() };
        cbtOrders[o.ref] = o; saveCbt();
        try { return send(res, 200, { ref: o.ref, key: o.key, checkoutUrl: await startPayment(o) }, null, cors); }
        catch (e) { o.status = 'failed_to_start'; o.err = String(e.message).slice(0, 200); saveCbt(); console.error(e.message); return send(res, 502, { error: 'Payment could not start. Try again.' }, null, cors); }
      }
      if (req.method === 'GET' && p === '/api/cbt/status') {
        const o = cbtOrders[u.searchParams.get('ref')];
        if (!o || !safeEq(o.key, u.searchParams.get('key') || '')) return send(res, 404, { error: 'Payment not found.' }, null, cors);
        if (o.status === 'pending') await cbtCheck(o);
        return send(res, 200, cbtView(o), null, cors);
      }
      return send(res, 404, { error: 'Not found' }, null, cors);
    }

    // ----- Monnify webhook: only a trigger, we re-check with Monnify -----
    if (req.method === 'POST' && p === '/webhook/monnify') {
      const raw = await body(req, 100000);
      const expect = crypto.createHmac('sha512', E.MONNIFY_SECRET_KEY || 'x').update(raw).digest('hex');
      if (MOCK || !safeEq(String(req.headers['monnify-signature'] || ''), expect)) return send(res, 401, 'bad signature', 'text/plain');
      let ref = ''; try { const j = JSON.parse(raw.toString()); ref = j.eventData && j.eventData.paymentReference; } catch (e) { /* ignore */ }
      if (orders[ref]) settle(orders[ref]).catch(() => {});
      if (cbtOrders[ref]) cbtCheck(cbtOrders[ref]).catch(() => {});
      return send(res, 200, 'ok', 'text/plain');
    }

    // ----- test payment screen for JAMB practice (only when MOCK_MODE=true) -----
    if (MOCK && p === '/mock-pay' && cbtOrders[u.searchParams.get('ref')]) {
      const o = cbtOrders[u.searchParams.get('ref')];
      if (!safeEq(o.key, u.searchParams.get('key') || '')) return send(res, 404, 'Not found', 'text/plain');
      if (req.method === 'POST') { o.mockPaid = true; saveCbt(); return send(res, 302, '', 'text/plain', { Location: BLOGGER_URL + '/?cbt=' + o.ref + '&key=' + o.key }); }
      return send(res, 200, '<meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;max-width:420px;margin:40px auto;padding:16px"><h2>TEST payment</h2><p>No real money. Pay <b>' + naira(o.amount) + '</b> for JAMB practice questions?</p><form method=post><button style="padding:14px 22px;font-size:1rem;background:#1f7a4d;color:#fff;border:0;border-radius:8px">Pay (test)</button></form>', 'text/html; charset=utf-8');
    }
    // ----- test payment screen (only when MOCK_MODE=true) -----
    if (MOCK && p === '/mock-pay') {
      const o = orders[u.searchParams.get('ref')];
      if (!o || !safeEq(o.key, u.searchParams.get('key') || '')) return send(res, 404, 'Not found', 'text/plain');
      if (req.method === 'POST') { o.mockPaid = true; save(); return send(res, 302, '', 'text/plain', { Location: '/?ref=' + o.ref + '&key=' + o.key }); }
      return send(res, 200, '<meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;max-width:420px;margin:40px auto;padding:16px"><h2>TEST payment</h2><p>No real money. Pay <b>' + naira(o.amount) + '</b> for ' + o.qty + ' ' + o.exam + '?</p><form method=post><button style="padding:14px 22px;font-size:1rem;background:#1f7a4d;color:#fff;border:0;border-radius:8px">Pay (test)</button></form>', 'text/html; charset=utf-8');
    }

    // ----- admin -----
    if (req.method === 'GET' && p === '/library') return serveFile(res, 'library.html', LIBFRAME);
    if (req.method === 'POST' && p === '/library/enter') {          // form post from the Blogger page or from /library
      const f = new URLSearchParams((await body(req, 2000)).toString());
      const r = enterPin(req, f.get('pin'), ip);
      const ex = String(f.get('exam') || '').toUpperCase(), exq = EXAM_LIST.includes(ex) ? ex : '';
      const hdr = { Location: '/library' + (r.ok ? (exq ? '?exam=' + exq : '') : '?e=' + (r.code === 429 ? 2 : r.code === 403 ? 3 : 1) + (exq ? '&exam=' + exq : '')) };
      if (r.cookie) hdr['Set-Cookie'] = r.cookie;
      return send(res, 303, '', 'text/plain', hdr);
    }
    if (req.method === 'POST' && p === '/api/library/enter') {
      const d = JSON.parse((await body(req, 2000)).toString() || '{}');
      const r = enterPin(req, d.pin, ip);
      if (!r.ok) return send(res, r.code || 401, { error: r.error });
      return send(res, 200, { ok: true, label: r.label }, null, r.cookie ? { 'Set-Cookie': r.cookie } : {});
    }
    if (req.method === 'POST' && p === '/api/library/logout') {
      const a = libAuth(req); if (a) { a.pin.sessions = a.pin.sessions.filter((x) => x.s !== a.sid); saveLib(); }
      return send(res, 200, { ok: true }, null, { 'Set-Cookie': 'ei_lib=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }
    if (p.startsWith('/api/library/') || p.startsWith('/library/img/')) {
      const a = libAuth(req); if (!a) return send(res, 401, { error: 'Enter your PIN.' });
      if (req.method === 'GET' && p === '/api/library/list') {
        const items = Object.values(lib.entries).filter((e) => e.published && pinCan(a.pin, e.id)).sort((x, y) => (y.year - x.year) || (x.created < y.created ? 1 : -1)).map((e) => entryPublic(e, false));
        return send(res, 200, { label: a.pin.label, items });
      }
      if (req.method === 'GET' && p === '/api/library/entry') {
        const e = lib.entries[u.searchParams.get('id')]; if (!e || !e.published || !pinCan(a.pin, e.id)) return send(res, 404, { error: 'Not found' });
        return send(res, 200, Object.assign(entryPublic(e, true), { label: a.pin.label }));
      }
      if (req.method === 'GET' && p.startsWith('/library/img/')) {
        const id = p.slice('/library/img/'.length);
        if (!Object.values(lib.entries).some((e) => e.published && pinCan(a.pin, e.id) && (e.images || []).includes(id))) return send(res, 404, 'Not found', 'text/plain');
        return sendImage(res, id);
      }
      return send(res, 404, { error: 'Not found' });
    }
    if (req.method === 'GET' && p === '/auth.js') return serveFile(res, 'auth.js');
    if (req.method === 'GET' && p === '/back.js') return serveFile(res, 'back.js');
    { const em = /^\/emblems\/(waec|neco|nabteb)\.jpg$/.exec(p); if (req.method === 'GET' && em) return serveFile(res, 'emblems/' + em[1] + '.jpg'); }
    if (req.method === 'GET' && (p === '/terms' || p === '/privacy')) return serveFile(res, p.slice(1) + '.html');
    if (req.method === 'POST' && p === '/admin/login') {
      if (limited(ip, 'login', 6, 600000) || locked()) return send(res, 429, { error: 'Too many tries. Wait 15 minutes, or use Forgot password.' });
      const d = JSON.parse((await body(req)).toString() || '{}');
      if (!pwOk(String(d.password || ''))) { failed.push(Date.now()); return send(res, 401, { error: 'Wrong password.' }); }
      return send(res, 200, { ok: true, defaultPw: !!auth.defaultPw }, null, { 'Set-Cookie': 'ei_admin=' + makeSession() + '; HttpOnly; SameSite=' + ADMIN_SAMESITE + '; Path=/; Max-Age=28800' + (SECURE_COOKIE ? '; Secure' : '') });
    }
    if (req.method === 'POST' && p === '/admin/logout') return send(res, 200, { ok: true }, null, { 'Set-Cookie': 'ei_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    if (req.method === 'GET' && p === '/admin/session') return send(res, 200, { admin: isAdmin(req) });
    if (req.method === 'GET' && p === '/admin/recovery') return send(res, 200, { options: recoveryList() });
    if (req.method === 'POST' && p === '/admin/forgot') {
      const d = JSON.parse((await body(req)).toString() || '{}');
      const now = Date.now(); auth.sent = (auth.sent || []).filter((t) => now - t < 3600000);
      if (limited(ip, 'forgot', 3, 900000) || auth.sent.length >= 5) return send(res, 429, { error: 'Too many requests. Try again in an hour.' });
      if (!recoveryList().some((x) => x.id === d.id)) return send(res, 400, { error: 'Choose one of the options.' });
      const code = String(crypto.randomInt(100000, 1000000));
      try {
        if (!(await sendOtp(d.id, code))) return send(res, 503, { error: 'Code sending is not set up yet. See README, section Forgot password.' });
      } catch (e) { console.error(e.message); return send(res, 502, { error: 'Could not send the code. Try another option.' }); }
      auth.sent.push(now); auth.otp = { hash: scrypt(code, auth.salt), exp: now + 600000, tries: 0 }; saveAuth();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/admin/reset') {
      if (limited(ip, 'reset', 10, 900000)) return send(res, 429, { error: 'Too many tries.' });
      const d = JSON.parse((await body(req)).toString() || '{}'); const pw = String(d.password || '');
      if (pw.length < 6 || pw.length > 100) return send(res, 400, { error: 'New password must be at least 6 characters.' });
      const otp = auth.otp;
      if (!otp || Date.now() > otp.exp || otp.tries >= 5) { auth.otp = null; saveAuth(); return send(res, 400, { error: 'Code expired. Ask for a new one.' }); }
      otp.tries++; saveAuth();
      if (!safeEq(scrypt(String(d.code || '').trim(), auth.salt), otp.hash)) return send(res, 400, { error: 'Wrong code.' });
      auth.salt = rid(16); auth.hash = scrypt(pw, auth.salt); auth.epoch++; auth.defaultPw = false; auth.otp = null; saveAuth();
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/admin/api/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Login needed.' });
      if (req.method === 'GET' && p === '/admin/api/state') {
        const list = Object.values(orders).sort((a, b) => (a.created < b.created ? 1 : -1));
        const done = list.filter((o) => o.status === 'delivered');
        return send(res, 200, {
          mock: MOCK, settings: Object.assign({}, settings, { recovery: undefined }), defaultPw: !!auth.defaultPw, mailOn: mailOn(), smsOn: smsOn(), recovery: recoveryList(),
          totals: { sales: done.length, revenue: done.reduce((s, o) => s + o.amount, 0), markup: done.reduce((s, o) => s + (o.amount - (o.supplierCharged || o.cost * o.qty)), 0), needAttention: list.filter((o) => o.status === 'paid_not_delivered').length },
          orders: list.slice(0, 200).map((o) => ({ ref: o.ref, exam: o.exam, qty: o.qty, amount: o.amount, name: o.name, phone: o.phone, email: o.email, status: o.status, created: o.created, err: o.err || '', raw: o.status === 'paid_not_delivered' ? (o.providerRaw || '') : '', tokens: o.tokens, code: o.code || '', cards: o.status === 'delivered' ? cardsOf(o).map((c) => ({ n: c.n, used: !!(o.used && o.used[c.n]) })) : [] }))
        });
      }
      if (req.method === 'POST' && p === '/admin/api/settings') {
        const d = JSON.parse((await body(req)).toString() || '{}');
        const mk = Math.round(Number(d.markup)); if (mk >= 0 && mk <= 100000) settings.markup = mk;
        for (const k of Object.keys(settings.products)) {
          const x = d.products && d.products[k]; if (!x) continue;
          const c = Math.round(Number(x.cost)); if (c >= 0 && c <= 1000000) settings.products[k].cost = c;
          settings.products[k].on = !!x.on;
          const mk2 = (x.markup === '' || x.markup === null || x.markup === undefined) ? null : Math.round(Number(x.markup));
          settings.products[k].markup = (mk2 !== null && mk2 >= 0 && mk2 <= 100000) ? mk2 : null;
        }
        if (d.about) { settings.about.line = String(d.about.line || '').slice(0, 120); settings.about.trustedBy = String(d.about.trustedBy || '').slice(0, 40); }
        save(); return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && p === '/admin/api/library') {
        const pins = Object.keys(lib.pins).map((id) => { const x = lib.pins[id]; return { id, label: x.label, tail: x.tail, max: x.max === 0 ? 0 : (x.max || 3), exp: x.exp || null, revoked: !!x.revoked, created: x.created, uses: x.uses || 0, lastUsed: x.lastUsed || null,
          devices: (x.sessions || []).filter((y) => Date.now() - y.at < SESSION_MS).length, all: x.all === true || !Array.isArray(x.entries), entries: Array.isArray(x.entries) ? x.entries.filter((i) => lib.entries[i]).map((i) => ({ id: i, title: lib.entries[i].title })) : [] }; }).sort((a, b) => (a.created < b.created ? 1 : -1));
        const entries = Object.values(lib.entries).sort((x, y) => (x.created < y.created ? 1 : -1)).map((e) => Object.assign(entryPublic(e, true), { practice: e.practice !== false, practiceCount: practice.extract(e).length, published: !!e.published }));
        return send(res, 200, { exams: EXAM_LIST, entries, pins, aiOn: !!AI_KEY, bloggerOn: BLOGGER_ON(), pinDigits: PIN_DIGITS });
      }
      if (req.method === 'GET' && p.startsWith('/admin/api/library/img/')) return sendImage(res, p.slice('/admin/api/library/img/'.length));
      if (req.method === 'POST' && p === '/admin/api/library/upload') {
        const buf = await body(req, 6 * 1024 * 1024); const t = imgType(buf);
        if (!t) return send(res, 400, { error: 'Only JPG, PNG or WEBP pictures.' });
        const id = rid(12); fs.writeFileSync(path.join(LIB_DIR, id + '.' + t), buf); return send(res, 200, { id });
      }
      if (req.method === 'POST' && p === '/admin/api/post/make') {
        if (!AI_KEY) return send(res, 503, { error: 'AI is not set up yet. Add ANTHROPIC_API_KEY to the .env file, then restart the site.' });
        if (limited(ip, 'aipost', 20, 3600000)) return send(res, 429, { error: 'Too many posts this hour. Try again later.' });
        const d = JSON.parse((await body(req, 100000)).toString() || '{}'); let text = String(d.text || '').slice(0, 20000); const url = d.url ? safeUrl(d.url) : '';
        if (d.url && !url) return send(res, 400, { error: 'That link is not allowed. Paste the article text instead.' });
        try { if (!text.trim() && url) text = await readPage(url); if (text.trim().length < 80) return send(res, 400, { error: 'Not enough text. Paste the article text or a working link.' });
          const o = await aiPost(text); if (!o.title || o.paragraphs.length < 2) return send(res, 502, { error: 'The AI did not write a full post. Try again.' });
          const srcName = String(d.source || '').slice(0, 60) || (url ? new URL(url).hostname.replace(/^www\./, '') : '');
          return send(res, 200, { ok: true, title: o.title, labels: o.labels, description: o.description, imageQuery: o.imageQuery || '', html: postHtml(o, srcName, url || ''), bloggerOn: BLOGGER_ON() }); }
        catch (e) { return send(res, 502, { error: e.message }); }
      }
      if (req.method === 'POST' && p === '/admin/api/post/draft') {
        if (!BLOGGER_ON()) return send(res, 503, { error: 'Blogger is not connected yet. Copy the post and paste it in Blogger (HTML view).' });
        if (limited(ip, 'bdraft', 30, 3600000)) return send(res, 429, { error: 'Too many drafts this hour.' });
        const d = JSON.parse((await body(req, 100000)).toString() || '{}'); const title = String(d.title || '').trim().slice(0, 150), html = String(d.html || '').slice(0, 60000);
        if (title.length < 3 || html.length < 20) return send(res, 400, { error: 'Write the post first.' });
        try { const r = await bloggerDraft(title, html, (Array.isArray(d.labels) ? d.labels : []).slice(0, 5).map((x) => String(x).slice(0, 30))); return send(res, 200, { ok: true, url: r.url }); }
        catch (e) { return send(res, 502, { error: e.message }); }
      }
      if (req.method === 'POST' && p === '/admin/api/library/arrange') {
        if (!AI_KEY) return send(res, 503, { error: 'AI is not set up yet. Add ANTHROPIC_API_KEY to the .env file, then restart the site.' });
        if (limited(ip, 'ai', 15, 3600000)) return send(res, 429, { error: 'Too many AI requests this hour. Try again later.' });
        const d = JSON.parse((await body(req, 200000)).toString() || '{}');
        if (d.written !== true) return send(res, 400, { error: 'Tick the box: this exam has already been written.' });
        const raw = String(d.raw || '').slice(0, 60000), ids = (Array.isArray(d.images) ? d.images : []).filter((x) => IMG_ID.test(x) && imgFile(x)).slice(0, 12);
        if (!raw.trim() && !ids.length) return send(res, 400, { error: 'Paste some text or add pictures first.' });
        try { const result = await aiArrange(raw, ids, { exam: String(d.exam || '').slice(0, 10), year: String(d.year || '').slice(0, 4), subject: String(d.subject || '').slice(0, 60) }); return send(res, 200, { ok: true, result, order: result.picture_order.map((n) => ids[n - 1]), skipped: result.skip_pictures.map((n) => ids[n - 1]), sent: ids }); }
        catch (e) { return send(res, 502, { error: e.message }); }
      }
      if (req.method === 'POST' && p === '/admin/api/library/entry') {
        const d = JSON.parse((await body(req, 200000)).toString() || '{}');
        const old = d.id ? lib.entries[d.id] : null; if (d.id && !old) return send(res, 404, { error: 'Entry not found.' });
        const r = readEntry(d, old); if (r.error) return send(res, 400, r);
        lib.entries[r.value.id] = r.value; saveLib(); return send(res, 200, { ok: true, id: r.value.id });
      }
      if (req.method === 'POST' && p === '/admin/api/library/entry-delete') {
        const d = JSON.parse((await body(req, 2000)).toString() || '{}'); const e = lib.entries[d.id]; if (!e) return send(res, 404, { error: 'Not found' });
        delete lib.entries[d.id];
        for (const k of Object.keys(lib.pins)) { if (Array.isArray(lib.pins[k].entries)) lib.pins[k].entries = lib.pins[k].entries.filter((i) => i !== d.id); }
        for (const im of (e.images || [])) if (!Object.values(lib.entries).some((x) => (x.images || []).includes(im))) { const f = imgFile(im); if (f) fs.unlinkSync(f.f); }
        saveLib(); return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/admin/api/library/pin') {
        const d = JSON.parse((await body(req, 2000)).toString() || '{}');
        const custom = normPin(d.pin); if (d.pin && custom.length < (PIN_DIGITS || 6)) return send(res, 400, { error: 'A PIN you type must have at least ' + (PIN_DIGITS || 6) + ' letters or numbers.' });
        const owner = (pn) => Object.keys(lib.pins).find((k) => safeEq(lib.pins[k].h, pinHash(pn)));
        let pin = custom ? (PIN_DIGITS ? custom : custom.slice(0, 4) + '-' + custom.slice(4)) : newPin();
        if (!custom && PIN_DIGITS) {
          for (let t = 0; t < 200 && owner(pin); t++) pin = newPin();
          if (owner(pin) && 10 ** PIN_DIGITS <= 100000) {   // every PIN is taken: look for a free one, else take over the one used least recently (expired or revoked first)
            let best = null;
            for (let i = 0; i < 10 ** PIN_DIGITS; i++) {
              const c = String(i).padStart(PIN_DIGITS, '0'), id = owner(c); if (!id) { best = { c, rank: -1 }; break; }
              const x = lib.pins[id], dead = x.revoked || (x.exp && Date.now() > x.exp) ? 0 : 1, last = Date.parse(x.lastUsed || x.created) || 0, rank = dead * 1e15 + last;
              if (!best || rank < best.rank) best = { c, rank };
            }
            if (best) pin = best.c;
          }
        }
        const ents = (Array.isArray(d.entries) ? d.entries : []).filter((i) => lib.entries[i]).slice(0, 50);
        if (!d.all && !ents.length) return send(res, 400, { error: 'Choose the page this PIN opens.' });
        const days = Math.floor(Number(d.days)) || 0, max = (d.max === '' || d.max == null || !(Number(d.max) >= 1)) ? 0 : Math.min(100000, Math.floor(Number(d.max)));   // 0 = unlimited devices (any number of students)
        const fresh = { label: String(d.label || 'Student').slice(0, 40), max, exp: days > 0 ? Date.now() + days * 86400000 : null, created: new Date().toISOString(), sessions: [], ep: ((owner(pin) && lib.pins[owner(pin)].ep) || 0) + 1, uses: 0, lastUsed: null, revoked: false, all: !!d.all, entries: d.all ? [] : ents };
        const oid = owner(pin);
        if (oid) {   // this PIN already belongs to an older page: the NEW page takes it over and the old page stops opening with it
          const x = lib.pins[oid], before = (x.all === true || !Array.isArray(x.entries)) ? 'everything' : x.entries.map((i) => lib.entries[i] && lib.entries[i].title).filter(Boolean).join(', ') || 'a deleted page';
          Object.assign(x, fresh); saveLib(); return send(res, 200, { ok: true, pin, replaced: true, before });
        }
        lib.pins[rid(6)] = Object.assign(fresh, { h: pinHash(pin), tail: normPin(pin).slice(-2) });
        saveLib(); return send(res, 200, { ok: true, pin });
      }
      if (req.method === 'POST' && p === '/admin/api/library/pin-update') {
        const d = JSON.parse((await body(req, 2000)).toString() || '{}'); const x = lib.pins[d.id]; if (!x) return send(res, 404, { error: 'Not found' });
        if (d.action === 'delete') delete lib.pins[d.id];
        else if (d.action === 'revoke') { x.revoked = true; x.sessions = []; x.ep = (x.ep || 0) + 1; }
        else if (d.action === 'restore') x.revoked = false;
        else if (d.action === 'reset') { x.sessions = []; x.ep = (x.ep || 0) + 1; }
        else if (d.action === 'scope') { const ents = (Array.isArray(d.entries) ? d.entries : []).filter((i) => lib.entries[i]); if (!d.all && !ents.length) return send(res, 400, { error: 'Choose at least one page.' }); x.all = !!d.all; x.entries = d.all ? [] : ents; }
        saveLib(); return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/admin/api/password') {
        const d = JSON.parse((await body(req)).toString() || '{}'); const pw = String(d.password || '');
        if (!pwOk(String(d.old || ''))) return send(res, 401, { error: 'Old password is wrong.' });
        if (pw.length < 6 || pw.length > 100) return send(res, 400, { error: 'New password must be at least 6 characters.' });
        auth.salt = rid(16); auth.hash = scrypt(pw, auth.salt); auth.epoch++; auth.defaultPw = false; saveAuth();
        return send(res, 200, { ok: true }, null, { 'Set-Cookie': 'ei_admin=' + makeSession() + '; HttpOnly; SameSite=' + ADMIN_SAMESITE + '; Path=/; Max-Age=28800' + (SECURE_COOKIE ? '; Secure' : '') });
      }
      if (req.method === 'POST' && p === '/admin/api/mark') {
        const d = JSON.parse((await body(req)).toString() || '{}'); const o = orders[d.ref];
        if (!o || o.status !== 'delivered' || !cardsOf(o)[Number(d.n) - 1]) return send(res, 404, { error: 'Not found.' });
        o.used = o.used || {};
        if (d.used) o.used[Number(d.n)] = { at: new Date().toISOString(), by: 'admin' }; else delete o.used[Number(d.n)];
        save(); return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/admin/api/retry') {
        const d = JSON.parse((await body(req)).toString() || '{}'); const o = orders[d.ref];
        if (!o || !o.paidAt || o.status === 'delivered') return send(res, 400, { error: 'Nothing to retry.' });
        o.tries = 0; await settle(o); return send(res, 200, { status: o.status });
      }
      return send(res, 404, { error: 'Not found' });
    }

    send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    console.error(e.message);
    send(res, 400, { error: 'Bad request' });
  }
});

server.listen(PORT, () => console.log('ExamInfo Pay running on ' + SITE_URL + (MOCK ? '  [TEST MODE: fake payments and fake tokens]' : '  [LIVE MODE]')));

if (auth.defaultPw) console.log('NOTE: the admin password is still the default. Change it in /admin.');
// Safety: in live mode, refuse to start without the keys.
if (!MOCK) {
  for (const k of ['MONNIFY_API_KEY', 'MONNIFY_SECRET_KEY', 'MONNIFY_CONTRACT_CODE', 'VTU_API_KEY']) {
    if (!E[k]) { console.error('Missing ' + k + ' in .env'); process.exit(1); }
  }
}
