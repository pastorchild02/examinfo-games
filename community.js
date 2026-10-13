'use strict';
// Free practice test (single, pair, group). No npm packages.
// Questions come from YOUR own bank (data/questions.json or the sample file) and, if you set it, one question API
// whose terms allow it (QUESTION_API_URL + QUESTION_API_TOKEN in .env). Nothing is scraped from other websites.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function (ctx) {
  const { send, body, limited, ipOf, isAdmin, readJson, writeJson, E } = ctx;
  const libQuestions = ctx.libQuestions || (() => []);
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  const rid = (n) => crypto.randomBytes(n).toString('hex');
  const clean = (s, max) => String(s == null ? '' : s).replace(/[<>\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const J = (res, code, o) => send(res, code, o, null, CORS);

  // ---------- comments ----------
  let comments = readJson('comments.json', {});
  const saveC = () => writeJson('comments.json', comments);
  const POSTID = /^[a-z0-9-]{1,40}$/;

  // ---------- question bank ----------
  function loadBank() {
    let b = readJson('questions.json', null);
    if (!Array.isArray(b) || !b.length) { try { b = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions-sample.json'), 'utf8')); } catch (e) { b = []; } }
    b = b.filter((q) => q && q.q && Array.isArray(q.o) && q.o.length >= 2 && Number.isInteger(q.a));
    return b.concat(libQuestions());      // questions from YOUR library pages are always up to date
  }
  async function fromApi(subject, n) {
    if (!E.QUESTION_API_URL || !E.QUESTION_API_TOKEN) return [];
    try {
      const url = E.QUESTION_API_URL + (E.QUESTION_API_URL.includes('?') ? '&' : '?') + 'subject=' + encodeURIComponent(subject || '') + '&limit=' + n;
      const r = await fetch(url, { headers: { AccessToken: E.QUESTION_API_TOKEN } });
      const j = await r.json(); let arr = j.data || j.questions || j; if (!Array.isArray(arr)) arr = [arr];
      const out = [];
      for (const x of arr) {
        const opt = x.option || x.options || {}; const keys = Object.keys(opt).filter((k) => opt[k]); const ans = String(x.answer || '').toLowerCase();
        if (!x.question || keys.length < 2 || !keys.includes(ans)) continue;
        out.push({ id: 'x' + rid(4), subject: subject || 'Mixed', q: clean(x.question, 600), o: keys.map((k) => clean(opt[k], 200)), a: keys.indexOf(ans) });
      }
      return out;
    } catch (e) { return []; }
  }
  const seenIp = {};
  setInterval(() => { const now = Date.now(); for (const k of Object.keys(seenIp)) if (now - seenIp[k].at > 30 * 86400000) delete seenIp[k]; }, 3600000).unref();
  async function pick(subject, n, exam, ip) {
    n = Math.max(1, Math.min(100, Number(n) || 20));
    const all = loadBank(); const subj = subject && subject !== 'Mixed' ? subject : '';
    const ex = String(exam || '').toUpperCase();
    let pool = all.filter((q) => (!ex || !q.exam || q.exam === ex) && (!subj || q.subject.toLowerCase() === subj.toLowerCase()));
    if (!ex) pool = pool.concat(await fromApi(subj, n));
    if (ip) {   // the same visitor (same IP) gets new questions each visit; when everything was seen, the memory starts again
      const s = seenIp[ip] || (seenIp[ip] = { ids: new Set(), at: Date.now() }); s.at = Date.now();
      const fresh = pool.filter((q) => !s.ids.has(q.id));
      if (fresh.length >= Math.min(n, pool.length)) pool = fresh; else s.ids.clear();
    }
    const qs = shuffle(pool).slice(0, n);
    if (ip) { const s = seenIp[ip]; qs.forEach((q) => s.ids.add(q.id)); if (s.ids.size > 5000) s.ids.clear(); }
    return qs.map((q) => { const idx = shuffle(q.o.map((_, i) => i)); return { id: q.id, subject: q.subject, exam: q.exam || '', year: q.year || 0, f: q.f || '', topic: q.topic || '', q: q.q, o: idx.map((i) => q.o[i]), a: idx.indexOf(q.a) }; });
  }
  const strip = (q) => ({ id: q.id, subject: q.subject, q: q.q, o: q.o });
  const meta = () => { const ex = {}, gen = new Set(); for (const q of loadBank()) { if (q.exam) { (ex[q.exam] = ex[q.exam] || new Set()).add(q.subject); } else gen.add(q.subject); } const o = {}; Object.keys(ex).sort().forEach((k) => { o[k] = Array.from(ex[k]).sort(); }); return { exams: o, general: Array.from(gen).sort() }; };


  // ---------- live team game (arena) ----------
  const Arena = require('./arena-core');
  const arenas = {}, keys = {}, queues = {}, qmap = {};
  const ACODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const aCode = () => { let x; do { x = ''; for (let i = 0; i < 5; i++) x += ACODE[crypto.randomInt(0, ACODE.length)]; } while (arenas[x]); return x; };
  setInterval(() => { const now = Date.now(); for (const k of Object.keys(arenas)) if (now - arenas[k].created > 4 * 3600 * 1000) { delete arenas[k]; delete keys[k]; } }, 600000).unref();
  setInterval(() => { const now = Date.now(); for (const k of Object.keys(qmap)) if (now - qmap[k].last > 120000) delete qmap[k]; }, 60000).unref();
  const qMatch = (qk) => {
    const now = Date.now(); const L = (queues[qk] || []).filter((e) => now - e.last < 15000 && !e.res); queues[qk] = L;
    if (!L.length) return; const size = L[0].size; if (L.length < size * 2) return;
    const grp = L.splice(0, size * 2), f = grp[0];
    const a = Arena.mk({ code: aCode(), teams: 2, size, n: f.qs.length, exam: f.exam, subject: f.subject, names: ['Team A', 'Team B'] }, now);
    a.match = true; a.pre = f.qs; a.hostB = ''; keys[a.code] = {};
    grp.forEach((e, i) => { const pid = rid(3), key = rid(8); Arena.addPlayer(a, pid, e.name, i % 2); keys[a.code][pid] = key; if (i === 1) a.hostB = pid; e.res = { code: a.code, pid, key }; });
    arenas[a.code] = a; a.status = 'countdown'; a.startAt = now + 4500;
  };
  const clampI = (v, lo, hi, d) => { v = Math.floor(Number(v)); return v >= lo && v <= hi ? v : d; };
  const aAuth = (code, pid, key) => { const a = arenas[String(code || '').toUpperCase()]; return a && keys[a.code] && keys[a.code][pid] && keys[a.code][pid] === key ? a : null; };

  // ---------- news picture from the source's own share image (shown from the source, never copied to this site) ----------
  const ogCache = {};
  function okUrl(u) { try { const x = new URL(String(u)); if (!/^https?:$/.test(x.protocol)) return null; const h = x.hostname.toLowerCase(); if (h === 'localhost' || h.endsWith('.local') || h.includes(':') || /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return null; return x.href; } catch (e) { return null; } }
  async function ogImage(u) {
    const hit = ogCache[u]; if (hit && Date.now() - hit.at < 86400000) return hit.img;
    let img = ''; const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
    try { const r = await fetch(u, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'ExamInfoLinkPreview/1.0' } }); const h = (await r.text()).slice(0, 300000);
      const m = h.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i) || h.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
      if (m) { const abs = new URL(m[1].replace(/&amp;/g, '&'), u).href; if (/^https:/.test(abs)) img = abs; } } catch (e) { img = ''; } finally { clearTimeout(t); }
    ogCache[u] = { img, at: Date.now() }; return img;
  }

  // ---------- rooms ----------
  const rooms = {};
  const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const newCode = () => { let c; do { c = ''; for (let i = 0; i < 5; i++) c += CODE[crypto.randomInt(0, CODE.length)]; } while (rooms[c]); return c; };
  setInterval(() => { const now = Date.now(); for (const c of Object.keys(rooms)) if (now - rooms[c].created > 3 * 3600 * 1000) delete rooms[c]; }, 600000).unref();
  const gradeOf = (p) => p >= 75 ? 'A1' : p >= 70 ? 'B2' : p >= 65 ? 'B3' : p >= 60 ? 'C4' : p >= 55 ? 'C5' : p >= 50 ? 'C6' : p >= 45 ? 'D7' : p >= 40 ? 'E8' : 'F9';
  const teamsOf = (r) => r.mode === 'pair' ? ['A', 'B'] : ['A', 'B'];
  const cap = (r) => (r.mode === 'pair' ? 1 : r.size);
  function slice(r, p) {
    if (!r.split || r.mode === 'pair') return r.questions;
    const mine = r.players.filter((x) => x.team === p.team); const i = mine.indexOf(p); const per = Math.ceil(r.questions.length / mine.length);
    return r.questions.slice(i * per, (i + 1) * per);
  }
  function finish(r) {
    const now = Date.now();
    if (r.status === 'running' && (r.players.every((p) => p.done) || now > r.endsAt)) {
      for (const p of r.players) if (!p.done) { p.done = true; p.answers = p.answers || []; score(r, p); }
      r.status = 'done';
    }
  }
  function score(r, p) {
    const qs = slice(r, p); let c = 0; (p.answers || []).forEach((a, i) => { if (qs[i] && a === qs[i].a) c++; });
    p.score = c; p.total = qs.length; p.pct = qs.length ? Math.round(c * 100 / qs.length) : 0; p.grade = gradeOf(p.pct);
  }
  function view(r, p) {
    finish(r);
    const out = { code: r.code, mode: r.mode, size: r.size, subject: r.subject, exam: r.exam, n: r.n, split: r.split, status: r.status, host: r.players[0] && r.players[0].id, endsAt: r.endsAt || 0,
      players: r.players.map((x) => ({ id: x.id, name: x.name, team: x.team, done: x.done })) };
    if (r.status === 'running' && p) out.questions = slice(r, p).map(strip);
    if (r.status === 'done') {
      out.results = r.players.map((x) => ({ id: x.id, name: x.name, team: x.team, score: x.score, total: x.total, pct: x.pct, grade: x.grade, secs: x.secs || 0 }));
      const t = {}; for (const x of out.results) { t[x.team] = t[x.team] || { team: x.team, score: 0, total: 0, secs: 0, members: [] }; t[x.team].score += x.score; t[x.team].total += x.total; t[x.team].secs += x.secs; t[x.team].members.push(x.name); }
      out.teams = Object.values(t).map((x) => Object.assign(x, { pct: x.total ? Math.round(x.score * 100 / x.total) : 0 })).sort((a, b) => b.pct - a.pct || a.secs - b.secs);
      out.winner = out.teams.length > 1 && out.teams[0].pct === out.teams[1].pct && out.teams[0].secs === out.teams[1].secs ? 'draw' : (out.teams[0] || {}).team;
    }
    return out;
  }
  const auth = (r, pid, key) => { const p = r && r.players.find((x) => x.id === pid); return p && key && p.key === key ? p : null; };
  const addPlayer = (r, name) => {
    const counts = { A: 0, B: 0 }; r.players.forEach((x) => counts[x.team]++);
    const team = counts.A <= counts.B ? 'A' : 'B';
    if (counts[team] >= cap(r)) return null;
    const p = { id: rid(3), key: rid(8), name: clean(name, 20) || 'Player', team, done: false }; r.players.push(p); return p;
  };

  const board = { wk: '', rows: {} };
  const weekKey = () => { const d = new Date(), k = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - k); return d.toISOString().slice(0, 10); };

  return async function handle(req, res, u, p) {
    if (!p.startsWith('/api/comments') && !p.startsWith('/api/quiz') && !p.startsWith('/api/arena') && p !== '/api/og') return false;
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return true; }
    const ip = ipOf(req); const q = u.searchParams;
    const post = async () => JSON.parse((await body(req, 40000)).toString() || '{}');
    // ----- comments -----
    if (p === '/api/comments' && req.method === 'GET') {
      const id = q.get('post') || ''; if (!POSTID.test(id)) return J(res, 400, { error: 'Bad post' }), true;
      return J(res, 200, { comments: (comments[id] || []).slice(-100) }), true;
    }
    if (p === '/api/comments/counts' && req.method === 'GET') {
      const o = {}; String(q.get('ids') || '').split(',').filter((x) => POSTID.test(x)).slice(0, 60).forEach((id) => { o[id] = (comments[id] || []).length; });
      return J(res, 200, o), true;
    }
    if (p === '/api/comments' && req.method === 'POST') {
      if (limited(ip, 'cm', 6, 60000)) return J(res, 429, { error: 'Too many comments. Wait a minute.' }), true;
      const d = await post(); const id = String(d.post || ''); const name = clean(d.name, 30), text = clean(d.text, 500);
      if (!POSTID.test(id)) return J(res, 400, { error: 'Bad post' }), true;
      if (name.length < 2) return J(res, 400, { error: 'Enter your name.' }), true;
      if (text.length < 2) return J(res, 400, { error: 'Write your comment.' }), true;
      if (/https?:|www\.|\.com|\.ng\b/i.test(text)) return J(res, 400, { error: 'Links are not allowed in comments.' }), true;
      const c = { id: rid(4), name, text, at: new Date().toISOString() };
      (comments[id] = comments[id] || []).push(c); if (comments[id].length > 500) comments[id].shift(); saveC();
      return J(res, 200, { ok: true, comment: c }), true;
    }
    if (p === '/api/comments/delete' && req.method === 'POST') {
      if (!isAdmin(req)) return J(res, 401, { error: 'Admin login needed.' }), true;
      const d = await post(); comments[d.post] = (comments[d.post] || []).filter((c) => c.id !== d.id); saveC(); return J(res, 200, { ok: true }), true;
    }
    // ----- news picture -----
    if (p === '/api/og' && req.method === 'GET') {
      if (limited(ip, 'og', 90, 60000)) return J(res, 429, { error: 'Slow down.' }), true;
      const u = okUrl(q.get('u')); if (!u) return J(res, 400, { img: '' }), true;
      return J(res, 200, { img: await ogImage(u) }), true;
    }
    // ----- weekly study leaderboard (kept in memory; clears on restart and every new week) -----
    if (p === '/api/arena/board-submit' && req.method === 'POST') {
      if (limited(ip, 'bs', 30, 60000)) return J(res, 429, { error: 'Slow down.' }), true;
      const d = await post(); const id = String(d.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 24), name = clean(d.name, 20);
      if (id.length < 6 || name.length < 2) return J(res, 400, { error: 'Enter a name of at least 2 letters.' }), true;
      const wk = weekKey(); if (board.wk !== wk) { board.wk = wk; board.rows = {}; }
      board.rows[id] = { name, pts: clampI(d.pts, 0, 200, 0), streak: clampI(d.streak, 0, 400, 0) };
      return J(res, 200, { ok: true }), true;
    }
    if (p === '/api/arena/board-top' && req.method === 'GET') {
      const wk = weekKey(); if (board.wk !== wk) { board.wk = wk; board.rows = {}; }
      const top = Object.keys(board.rows).map((k) => ({ id: k, name: board.rows[k].name, pts: board.rows[k].pts, streak: board.rows[k].streak })).sort((a, b) => b.pts - a.pts || b.streak - a.streak).slice(0, 20);
      return J(res, 200, { week: wk, top }), true;
    }
    // ----- live team game -----
    if (p === '/api/arena/create' && req.method === 'POST') {
      if (limited(ip, 'ac', 10, 60000)) return J(res, 429, { error: 'Too many games. Wait a minute.' }), true;
      const d = await post(); const teams = clampI(d.teams, 2, 10, 2), size = clampI(d.size, 1, 20, 3), n = [10, 20, 50, 100].includes(Number(d.n)) ? Number(d.n) : 10;
      const names = (Array.isArray(d.teamNames) ? d.teamNames : []).slice(0, teams).map((x) => clean(x, 20));
      const a = Arena.mk({ code: aCode(), teams, size, n, exam: String(d.exam || '').toUpperCase().slice(0, 10), subject: clean(d.subject, 60) || 'Mixed', names }, Date.now());
      const pid = rid(3), key = rid(8); Arena.addPlayer(a, pid, clean(d.name, 20) || 'Player', clampI(d.team, 0, teams - 1, 0)); arenas[a.code] = a; keys[a.code] = { [pid]: key };
      return J(res, 200, { code: a.code, pid, key, state: Arena.view(a, pid, Date.now()) }), true;
    }
    // ----- team match by link (3 v 3 or 5 v 5): host A makes it, first opener can host B, others pick a team, full = countdown then start -----
    if (p === '/api/arena/match-create' && req.method === 'POST') {
      if (limited(ip, 'mc', 10, 60000)) return J(res, 429, { error: 'Too many games. Wait a minute.' }), true;
      let d; try { d = JSON.parse((await body(req, 300000)).toString() || '{}'); } catch (e) { return J(res, 400, { error: 'Bad request.' }), true; }
      const size = Number(d.size) === 5 ? 5 : 3;
      const qs = (Array.isArray(d.qs) ? d.qs : []).slice(0, 100).map((x) => ({ q: clean(x && x.q, 600), o: Array.isArray(x && x.o) ? x.o.slice(0, 5).map((t) => clean(t, 200)) : [], a: Number(x && x.a), f: clean(x && x.f, 120), subject: clean(x && x.subject, 60) })).filter((x) => x.q && x.o.length >= 2 && Number.isInteger(x.a) && x.a >= 0 && x.a < x.o.length);
      if (qs.length < 5) return J(res, 400, { error: 'Not enough questions to start a match.' }), true;
      const tn = clean(d.teamName, 20); if (!tn) return J(res, 400, { error: 'Type your team name.' }), true;
      const a = Arena.mk({ code: aCode(), teams: 2, size, n: qs.length, exam: String(d.exam || '').toUpperCase().slice(0, 10), subject: clean(d.subject, 60) || 'Mixed', names: [tn, 'Team B'] }, Date.now());
      a.match = true; a.pre = qs; a.hostB = '';
      const pid = rid(3), key = rid(8); Arena.addPlayer(a, pid, clean(d.name, 20) || 'Player', 0); arenas[a.code] = a; keys[a.code] = { [pid]: key };
      return J(res, 200, { code: a.code, pid, key, state: Arena.view(a, pid, Date.now()) }), true;
    }
    if (p === '/api/arena/match-info' && req.method === 'GET') {
      const a = arenas[String(q.get('code') || '').toUpperCase()]; if (!a || !a.match) return J(res, 404, { error: 'This game was not found. Ask your friend for a new link.' }), true;
      Arena.tick(a, Date.now()); const v = Arena.view(a, '', Date.now());
      return J(res, 200, { code: a.code, status: (a.status === 'lobby' && Date.now() - a.created > 2 * 3600 * 1000) ? 'expired' : a.status, exam: a.exam, subject: a.subject, n: a.n, size: a.size, hostedB: !!a.hostB, teams: v.teams, startIn: v.startIn || 0 }), true;
    }
    if (p === '/api/arena/match-join' && req.method === 'POST') {
      if (limited(ip, 'mj', 40, 60000)) return J(res, 429, { error: 'Slow down.' }), true;
      const d = await post(); const a = arenas[String(d.code || '').toUpperCase()];
      if (!a || !a.match) return J(res, 404, { error: 'This game was not found. Ask your friend for a new link.' }), true;
      Arena.tick(a, Date.now());
      if (a.status !== 'lobby') return J(res, 400, { error: a.status === 'done' ? 'This game has ended. Create your own game and share it with your friends.' : 'This game is full or has already started.' }), true;
      const want = (d.team === 'B' || d.team === 1) ? 1 : 0;
      if (want === 1 && !a.hostB) { const tn = clean(d.teamName, 20); if (!tn) return J(res, 400, { error: 'Type a team name to host Team B.' }), true; a.teams[1].name = tn; }
      const pid = rid(3), key = rid(8); const pl = Arena.addPlayer(a, pid, clean(d.name, 20) || 'Player', want);
      if (!pl) return J(res, 400, { error: 'That team is full. Pick the other team.' }), true;
      const becameHost = want === 1 && !a.hostB; if (becameHost) a.hostB = pid;
      keys[a.code][pid] = key;
      if (Arena.fullAll(a)) { a.status = 'countdown'; a.startAt = Date.now() + 4500; }
      return J(res, 200, { code: a.code, pid, key, team: want, hostedB: becameHost, state: Arena.view(a, pid, Date.now()) }), true;
    }
    if (p === '/api/arena/join' && req.method === 'POST') {
      if (limited(ip, 'aj', 30, 60000)) return J(res, 429, { error: 'Slow down.' }), true;
      const d = await post(); const a = arenas[String(d.code || '').toUpperCase()];
      if (!a) return J(res, 404, { error: 'Game not found. Check the code.' }), true;
      if (a.status !== 'lobby') return J(res, 400, { error: 'This game has already started.' }), true;
      const pid = rid(3), key = rid(8); const pl = Arena.addPlayer(a, pid, clean(d.name, 20) || 'Player', d.team === '' || d.team == null ? null : clampI(d.team, 0, a.teams.length - 1, null));
      if (!pl) return J(res, 400, { error: 'That team is full. Pick another team.' }), true;
      keys[a.code][pid] = key; return J(res, 200, { code: a.code, pid, key, state: Arena.view(a, pid, Date.now()) }), true;
    }
    const big = async () => JSON.parse((await body(req, 300000)).toString() || '{}');
    const cleanQs = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 100).map((x) => ({ q: clean(x && x.q, 600), o: Array.isArray(x && x.o) ? x.o.slice(0, 5).map((t) => clean(t, 200)) : [], a: Number(x && x.a), f: clean(x && x.f, 120), subject: clean(x && x.subject, 60) })).filter((x) => x.q && x.o.length >= 2 && x.a >= 0 && x.a < x.o.length);
    if (p === '/api/arena/ping' && req.method === 'POST') {
      let d; try { d = JSON.parse((await body(req, 2000)).toString() || '{}'); } catch (e) { return J(res, 400, { error: 'Bad request.' }), true; }
      const a = aAuth(d.code, d.pid, d.key); if (!a) return J(res, 403, { error: 'Not allowed.' }), true;
      if (d.quit) Arena.quit(a, d.pid, Date.now()); else Arena.ping(a, d.pid, !!d.away, Date.now());
      return J(res, 200, { ok: true }), true;
    }
    if (p === '/api/arena/rematch' && req.method === 'POST') {
      let d; try { d = await big(); } catch (e) { return J(res, 400, { error: 'Bad request.' }), true; }
      const a = aAuth(d.code, d.pid, d.key); if (!a) return J(res, 403, { error: 'Not allowed.' }), true;
      const err = Arena.rematch(a, d.pid, Date.now(), cleanQs(d.qs));
      if (err) return J(res, 400, { error: err }), true; return J(res, 200, { ok: true }), true;
    }
    if (p === '/api/arena/queue-join' && req.method === 'POST') {
      if (limited(ip, 'qj', 20, 60000)) return J(res, 429, { error: 'Slow down.' }), true;
      let d; try { d = await big(); } catch (e) { return J(res, 400, { error: 'Bad request.' }), true; }
      const size = Number(d.size) === 5 ? 5 : 3, qs = cleanQs(d.qs); if (qs.length < 5) return J(res, 400, { error: 'Not enough questions to start a match.' }), true;
      const exam = String(d.exam || '').toUpperCase().slice(0, 10), subject = clean(d.subject, 60) || 'Mixed', qk = size + '|' + exam + '|' + subject;
      const e = { tk: rid(8), name: clean(d.name, 20) || 'Player', qs, exam, subject, size, qk, last: Date.now(), res: null };
      qmap[e.tk] = e; (queues[qk] = queues[qk] || []).push(e); qMatch(qk); return J(res, 200, { tk: e.tk }), true;
    }
    if (p === '/api/arena/queue-poll' && req.method === 'GET') {
      const e = qmap[String(q.get('tk') || '')]; if (!e) return J(res, 404, { error: 'You left the queue. Please try again.' }), true;
      e.last = Date.now(); if (!e.res) qMatch(e.qk);
      if (e.res) return J(res, 200, Object.assign({ matched: true }, e.res)), true;
      return J(res, 200, { waiting: (queues[e.qk] || []).length, need: e.size * 2 }), true;
    }
    if (p === '/api/arena/queue-leave' && req.method === 'POST') {
      const d = await post(); const e = qmap[String(d.tk || '')];
      if (e && !e.res) { queues[e.qk] = (queues[e.qk] || []).filter((x) => x !== e); delete qmap[e.tk]; } return J(res, 200, { ok: true }), true;
    }
    if (p === '/api/arena/state' && req.method === 'GET') {
      const a = arenas[String(q.get('code') || '').toUpperCase()]; if (!a) return J(res, 404, { error: 'Game not found.' }), true;
      const ok = aAuth(q.get('code'), q.get('pid'), q.get('key')); return J(res, 200, Arena.view(a, ok ? q.get('pid') : '', Date.now())), true;
    }
    if (p === '/api/arena/start' && req.method === 'POST') {
      const d = await post(); const a = aAuth(d.code, d.pid, d.key); if (!a) return J(res, 403, { error: 'Not allowed.' }), true;
      if (a.players[0].id !== d.pid) return J(res, 403, { error: 'Only the person who made the game can start it.' }), true;
      const qs = (await pick(a.subject, a.n, a.exam)).map((x) => ({ q: x.q, o: x.o, a: x.a, f: x.f, subject: x.subject }));
      const err = Arena.start(a, qs, Date.now()); return err ? J(res, 400, { error: err }) : J(res, 200, Arena.view(a, d.pid, Date.now())), true;
    }
    if (p === '/api/arena/answer' && req.method === 'POST') {
      const d = await post(); const a = aAuth(d.code, d.pid, d.key); if (!a) return J(res, 403, { error: 'Not allowed.' }), true;
      const err = Arena.answer(a, d.pid, Number(d.choice), Date.now()); return J(res, err ? 400 : 200, err ? { error: err, state: Arena.view(a, d.pid, Date.now()) } : Arena.view(a, d.pid, Date.now())), true;
    }
    // ----- quiz -----
    if (p === '/api/quiz/meta' || p === '/api/quiz/subjects') return J(res, 200, meta()), true;
    if (p === '/api/quiz/questions' && req.method === 'GET') {
      if (limited(ip, 'qq', 30, 60000)) return J(res, 429, { error: 'Slow down.' }), true;
      return J(res, 200, { questions: await pick(q.get('subject'), q.get('n'), q.get('exam'), ip) }), true;   // single player practice: answers included
    }
    if (p === '/api/quiz/room' && req.method === 'POST') {
      if (limited(ip, 'qr', 10, 60000)) return J(res, 429, { error: 'Too many rooms. Wait a minute.' }), true;
      const d = await post(); const mode = d.mode === 'pair' ? 'pair' : 'team'; const size = mode === 'pair' ? 1 : (Number(d.size) === 5 ? 5 : 3);
      const questions = await pick(d.subject, d.n, d.exam); if (!questions.length) return J(res, 400, { error: 'No questions for that subject yet.' }), true;
      const r = { code: newCode(), mode, size, subject: clean(d.subject, 60) || 'Mixed', exam: String(d.exam || '').toUpperCase().slice(0, 10), n: questions.length, split: !!d.split && mode === 'team', questions, status: 'lobby', created: Date.now(), players: [] };
      const pl = addPlayer(r, d.name); rooms[r.code] = r; return J(res, 200, { code: r.code, pid: pl.id, key: pl.key, room: view(r, pl) }), true;
    }
    if (p === '/api/quiz/join' && req.method === 'POST') {
      if (limited(ip, 'qj', 20, 60000)) return J(res, 429, { error: 'Slow down.' }), true;
      const d = await post(); const r = rooms[String(d.code || '').toUpperCase()];
      if (!r) return J(res, 404, { error: 'Room not found. Check the code.' }), true;
      if (r.status !== 'lobby') return J(res, 400, { error: 'This game has already started.' }), true;
      const pl = addPlayer(r, d.name); if (!pl) return J(res, 400, { error: 'This room is full.' }), true;
      return J(res, 200, { code: r.code, pid: pl.id, key: pl.key, room: view(r, pl) }), true;
    }
    if (p === '/api/quiz/room' && req.method === 'GET') {
      const r = rooms[String(q.get('code') || '').toUpperCase()]; if (!r) return J(res, 404, { error: 'Room not found.' }), true;
      return J(res, 200, view(r, auth(r, q.get('pid'), q.get('key')))), true;
    }
    if (p === '/api/quiz/start' && req.method === 'POST') {
      const d = await post(); const r = rooms[String(d.code || '').toUpperCase()]; const pl = auth(r, d.pid, d.key);
      if (!pl || r.players[0] !== pl) return J(res, 403, { error: 'Only the room creator can start.' }), true;
      if (r.status !== 'lobby') return J(res, 400, { error: 'Already started.' }), true;
      const a = r.players.filter((x) => x.team === 'A').length, b = r.players.length - a;
      if (!a || !b) return J(res, 400, { error: 'Wait for the other side to join first.' }), true;
      r.status = 'running'; r.startedAt = Date.now(); r.endsAt = Date.now() + Math.max(120000, r.n * 45000) + 15000;
      return J(res, 200, view(r, pl)), true;
    }
    if (p === '/api/quiz/submit' && req.method === 'POST') {
      const d = await post(); const r = rooms[String(d.code || '').toUpperCase()]; const pl = auth(r, d.pid, d.key);
      if (!pl || r.status !== 'running' || pl.done) return J(res, 400, { error: 'Cannot submit now.' }), true;
      pl.answers = (Array.isArray(d.answers) ? d.answers : []).slice(0, 100).map((x) => (Number.isInteger(x) ? x : -1)); pl.secs = Math.round((Date.now() - r.startedAt) / 1000); pl.done = true; score(r, pl);
      finish(r); return J(res, 200, view(r, pl)), true;
    }
    return J(res, 404, { error: 'Not found' }), true;
  };
};
