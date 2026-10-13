// ExamInfo live team game: same code runs on the server (real games) and in the page (practice with bots).
// Rules: any number of teams, any team size. Every round is ONE question. Team 1 answers first, then team 2, and so on.
// During a team's turn the FIRST teammate to tap an answer locks the answer for the whole team.
// The right answer is hidden until every team has answered; then it is shown for a few seconds and the next question starts.
var ArenaCore = (function () {
  var TURN_MS = 30000, REVEAL_MS = 3500;
  function mk(cfg, now) {
    var teams = [], i; for (i = 0; i < cfg.teams; i++) { teams.push({ name: (cfg.names && cfg.names[i]) || ('Team ' + (i + 1)) }); }
    return { code: cfg.code, exam: cfg.exam || '', subject: cfg.subject || 'Mixed', n: cfg.n, size: cfg.size, teams: teams, players: [], status: 'lobby', qs: [], r: 0, ti: 0, phase: 'ask', t0: 0,
      cur: teams.map(function () { return null; }), scores: teams.map(function () { return 0; }), hist: [], created: now, pc: {}, pre: null, startAt: 0, ev: [], evn: 0, rm: {} };
  }
  function counts(a) { return a.teams.map(function (_, i) { return a.players.filter(function (p) { return p.team === i; }).length; }); }
  function fullAll(a) { return counts(a).every(function (x) { return x >= a.size; }); }
  function addPlayer(a, id, name, team) {
    var c = counts(a), t = (team != null && team >= 0 && team < a.teams.length) ? team : c.indexOf(Math.min.apply(null, c));
    if (c[t] >= a.size) { return null; } var p = { id: id, name: name, team: t }; a.players.push(p); return p;
  }
  function start(a, qs, now) {
    if (a.status !== 'lobby') { return 'This game has already started.'; }
    if (counts(a).some(function (x) { return x < 1; })) { return 'Every team needs at least one player.'; }
    if (!qs || !qs.length) { return 'No questions found.'; }
    a.qs = qs; a.n = qs.length; a.status = 'running'; a.r = 0; a.ti = 0; a.phase = 'ask'; a.t0 = now; return null;
  }
  function lock(a, team, by, choice, now, timeout) {
    a.cur[team] = { by: by, choice: choice, timeout: !!timeout };
    if (team < a.teams.length - 1) { a.ti = team + 1; a.t0 = now; } else { a.phase = 'reveal'; a.t0 = now; }
  }
  function tick(a, now) {
    if (a.status === 'running' || a.status === 'done') { a.players.forEach(function (p) { if (p.seen && !p.away && !p.gone && now - p.seen > 12000) { p.away = true; emit(a, 'left', p); } }); }
    if (a.status === 'countdown' && now >= a.startAt) { a.status = 'lobby'; var e0 = start(a, a.pre, a.startAt); if (e0) { a.status = 'lobby'; } }
    var guard = 0;
    while (a.status === 'running' && guard++ < 500) {
      if (a.phase === 'ask' && now - a.t0 >= TURN_MS) { lock(a, a.ti, null, -1, a.t0 + TURN_MS, true); continue; }
      if (a.phase === 'reveal' && now - a.t0 >= REVEAL_MS) {
        var q = a.qs[a.r], t0 = a.t0 + REVEAL_MS;
        a.cur.forEach(function (c, i) { if (c && c.choice === q.a) { a.scores[i]++; if (c.by) { a.pc[c.by] = (a.pc[c.by] || 0) + 1; } } });
        a.hist.push(a.cur); a.cur = a.teams.map(function () { return null; }); a.r++;
        if (a.r >= a.qs.length) { a.status = 'done'; } else { a.ti = 0; a.phase = 'ask'; a.t0 = t0; }
        continue;
      }
      break;
    }
  }
  function answer(a, pid, choice, now) {
    tick(a, now); var p = a.players.filter(function (x) { return x.id === pid; })[0];
    if (!p) { return 'You are not in this game.'; }
    if (a.status !== 'running' || a.phase !== 'ask') { return 'Wait for the next question.'; }
    if (p.team !== a.ti) { return 'It is not your team\'s turn.'; }
    if (a.cur[a.ti]) { return 'Your team has already answered.'; }
    var q = a.qs[a.r]; if (!(choice >= 0 && choice < q.o.length)) { return 'Choose an answer.'; }
    lock(a, a.ti, pid, choice, now, false); tick(a, now); return null;
  }
  function find(a, id) { return a.players.filter(function (x) { return x.id === id; })[0] || null; }
  function emit(a, type, p) { a.ev.push({ n: ++a.evn, type: type, name: p.name, team: p.team }); if (a.ev.length > 40) { a.ev.shift(); } }
  function ping(a, pid, away, now) {
    var p = find(a, pid); if (!p || p.gone) { return; } p.seen = now;
    if (!!away !== !!p.away) { p.away = !!away; emit(a, away ? 'left' : 'back', p); }
  }
  function quit(a, pid, now) {
    var p = find(a, pid); if (!p || p.gone) { return; } emit(a, 'quit', p);
    if (a.status === 'lobby' || a.status === 'countdown') {
      a.players = a.players.filter(function (x) { return x.id !== pid; });
      if (a.hostB === pid && !a.players.some(function (x) { return x.team === 1; })) { a.hostB = ''; }
      if (a.status === 'countdown') { a.status = 'lobby'; }
    } else { p.gone = true; }
  }
  function rematch(a, pid, now, qs) {
    if (a.status !== 'done') { return 'The game is not finished yet.'; }
    var p = find(a, pid); if (!p || p.gone) { return 'You are not in this game.'; }
    p.away = false; p.seen = now; a.rm[pid] = 1;
    var act = a.players.filter(function (x) { return !x.gone && !x.away; });
    if (!act.every(function (x) { return a.rm[x.id]; })) { return null; }
    a.players = act;
    if (counts(a).some(function (x) { return x < 1; })) { a.rm = {}; return 'The other team has left, so there is nobody to play against.'; }
    var nq = (qs && qs.length >= 5) ? qs : a.qs.slice().sort(function () { return Math.random() - 0.5; });
    a.pre = nq; a.qs = []; a.n = nq.length; a.scores = a.teams.map(function () { return 0; }); a.cur = a.teams.map(function () { return null; });
    a.hist = []; a.pc = {}; a.r = 0; a.ti = 0; a.phase = 'ask'; a.rm = {}; a.status = 'countdown'; a.startAt = now + 4500; return null;
  }
  function name(a, id) { var p = a.players.filter(function (x) { return x.id === id; })[0]; return p ? p.name : ''; }
  function view(a, pid, now) {
    tick(a, now); var me = a.players.filter(function (x) { return x.id === pid; })[0] || null;
    var v = { code: a.code, status: a.status, exam: a.exam, subject: a.subject, n: a.n, size: a.size, me: me ? { id: me.id, name: me.name, team: me.team } : null, host: a.players[0] ? a.players[0].id : '',
      teams: a.teams.map(function (t, i) { return { name: t.name, members: a.players.filter(function (p) { return p.team === i; }).map(function (p) { return p.name; }) }; }), scores: a.scores.slice() };
    if (a.status === 'running') {
      var q = a.qs[a.r]; v.round = a.r + 1; v.phase = a.phase; v.turn = a.ti; v.left = a.phase === 'ask' ? Math.max(0, TURN_MS - (now - a.t0)) : 0;
      v.q = { q: q.q, o: q.o, f: q.f || '', subject: q.subject || '' };
      v.locked = a.cur.map(function (c) { return c ? { by: c.by ? name(a, c.by) : '', timeout: c.timeout } : null; });
      if (a.phase === 'reveal') { v.reveal = { correct: q.a, picks: a.cur.map(function (c) { return { choice: c ? c.choice : -1, by: c && c.by ? name(a, c.by) : '' }; }) }; }
    }
    if (a.status === 'countdown') { v.startIn = Math.max(0, a.startAt - now); }
    if (a.status === 'done') {
      v.pct = a.scores.map(function (s) { return a.n ? Math.round(s * 100 / a.n) : 0; });
      v.players = a.players.map(function (p) { return { name: p.name, team: p.team, correct: a.pc[p.id] || 0 }; }).sort(function (x, y) { return y.correct - x.correct; });
    }
    v.ev = a.ev.slice(-12);
    if (a.status === 'done') { var act = a.players.filter(function (x) { return !x.gone && !x.away; }); v.rm = { yes: act.filter(function (x) { return a.rm[x.id]; }).map(function (x) { return x.name; }), need: act.length }; }
    return v;
  }
  return { TURN_MS: TURN_MS, REVEAL_MS: REVEAL_MS, mk: mk, fullAll: fullAll, addPlayer: addPlayer, start: start, answer: answer, view: view, tick: tick, ping: ping, quit: quit, rematch: rematch };
})();
if (typeof module !== 'undefined') { module.exports = ArenaCore; }
