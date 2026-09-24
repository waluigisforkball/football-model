/**
 * NFL Slate — data worker  (v2.5)
 *
 * Bindings required (Cloudflare dashboard → Worker → Settings):
 *   KV namespace : ODDS_CACHE
 *   Secrets      : ODDS_KEY_1, ODDS_KEY_2, ODDS_KEY_3
 *
 * Endpoints:
 *   GET /health
 *   GET /weeks?season=2026
 *   GET /slate?season=2026&week=3
 *   GET /team-rates?season=2025
 *   GET /player-rates?season=2026&lastn=5
 *   GET /injuries?season=2026&week=3
 *   GET /oline?season=2026&week=3
 *   GET /roster?season=2026&week=3              <-- skill-position roster status
 *   GET /props?week=3[&force=1][&markets=...]     <-- SPENDS CREDITS. Manual only.
 *   GET /props/status?week=3                       <-- free; what's in cache
 *   GET /raw/<release>/<file>
 *   GET  /plays?season=2026[&week=3]              <-- logged board plays (result tracking)
 *   POST /plays        {season, week, plays:[…]}  <-- page logs its board after each odds pull
 *   POST /plays/bet    {season, week, play, bet}  <-- "I bet this" toggle
 *   (POSTs need the X-Log-Key header — keeps stray traffic out; not a real secret)
 */

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const ODDS = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl';

const TTL = { slate:300, weeks:3600, rates:21600, injuries:900, oline:900, roster:900, raw:1800 };
const PROPS_TTL = 3600;               // 1 hour — override with &force=1
const DEFAULT_MARKETS = 'player_pass_yds,player_rush_yds,player_reception_yds,player_receptions';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Log-Key',
};

/* Odds API uses full team names; nflverse uses abbreviations. */
const TEAM_ABBR = {
  'Arizona Cardinals':'ARI','Atlanta Falcons':'ATL','Baltimore Ravens':'BAL','Buffalo Bills':'BUF',
  'Carolina Panthers':'CAR','Chicago Bears':'CHI','Cincinnati Bengals':'CIN','Cleveland Browns':'CLE',
  'Dallas Cowboys':'DAL','Denver Broncos':'DEN','Detroit Lions':'DET','Green Bay Packers':'GB',
  'Houston Texans':'HOU','Indianapolis Colts':'IND','Jacksonville Jaguars':'JAX','Kansas City Chiefs':'KC',
  'Las Vegas Raiders':'LV','Los Angeles Chargers':'LAC','Los Angeles Rams':'LA','Miami Dolphins':'MIA',
  'Minnesota Vikings':'MIN','New England Patriots':'NE','New Orleans Saints':'NO','New York Giants':'NYG',
  'New York Jets':'NYJ','Philadelphia Eagles':'PHI','Pittsburgh Steelers':'PIT','San Francisco 49ers':'SF',
  'Seattle Seahawks':'SEA','Tampa Bay Buccaneers':'TB','Tennessee Titans':'TEN','Washington Commanders':'WAS',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // /props and /plays manage their own KV state — never serve them from the edge cache
    const useEdge = request.method === 'GET' && !path.startsWith('/props') && !path.startsWith('/plays');
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    if (useEdge) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }

    let res;
    try {
      if      (path === '/health')        res = json({ ok:true, ts:Date.now(), kv: !!env.ODDS_CACHE });
      else if (path === '/weeks')         res = await weeks(url);
      else if (path === '/slate')         res = await slate(url);
      else if (path === '/team-rates')    res = await frozen(env, 'team', url, teamRates);
      else if (path === '/player-rates')  res = await frozen(env, 'player', url, playerRates);
      else if (path === '/injuries')      res = await injuries(url);
      else if (path === '/oline')         res = await oline(url);
      else if (path === '/roster')        res = await roster(url);
      else if (path === '/props/status')  res = await propsStatus(url, env);
      else if (path === '/props')         res = await props(url, env);
      else if (path === '/plays' && request.method === 'POST')     res = await logPlays(request, env);
      else if (path === '/plays/bet' && request.method === 'POST') res = await betPlay(request, env);
      else if (path === '/plays')         res = await getPlays(url, env);
      else if (path.startsWith('/raw/'))  res = await raw(path.slice(5));
      else res = json({ error:'unknown endpoint', path }, 0, 404);
    } catch (err) {
      res = json({ error: String(err && err.message || err) }, 0, 502);
    }

    if (useEdge && res.status === 200) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};

/* ---------------------------------------------------------------- helpers */

function json(obj, ttl = 0, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type':'application/json',
               'Cache-Control': ttl ? `public, max-age=${ttl}` : 'no-store' },
  });
}

async function getText(assetPath) {
  const r = await fetch(`${BASE}/${assetPath}`, {
    cf: { cacheEverything:true, cacheTtl:600 },
    headers: { 'User-Agent':'nfl-slate-worker' },
  });
  if (!r.ok) throw new Error(`upstream ${r.status} for ${assetPath}`);
  return await r.text();
}

function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i+1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).filter(r => r.length > 1)
    .map(r => { const o = {}; head.forEach((h,i) => o[h] = r[i] ?? ''); return o; });
}

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const f0  = v => num(v) || 0;

/* A finished season never changes, so compute its rates once and keep them in KV.
   Parsing a full season of player stats + snaps is the heaviest thing this worker
   does; doing it on every cold edge-cache miss is how the prior fetch fails. */
async function frozen(env, kind, url, fn) {
  const season = +(url.searchParams.get('season') || 0);
  const done = season && season < new Date().getUTCFullYear();
  if (!done || !env.ODDS_CACHE) return fn(url);
  const key = `rates:v22:${kind}:${season}:${url.searchParams.get('lastn') || ''}`;
  const hit = await env.ODDS_CACHE.get(key);
  if (hit) return new Response(hit, { headers: { ...CORS, 'Content-Type':'application/json',
                                                 'Cache-Control':`public, max-age=${TTL.rates}` } });
  const res = await fn(url);
  if (res.status === 200) {
    const body = await res.clone().text();
    await env.ODDS_CACHE.put(key, body, { expirationTtl: 60*60*24*7 });
  }
  return res;
}

/* ------------------------------------------------------------- schedules */

let _games = null, _gamesAt = 0;
async function loadGames() {
  if (_games && Date.now() - _gamesAt < 300000) return _games;
  _games = parseCSV(await getText('schedules/games.csv'));
  _gamesAt = Date.now();
  return _games;
}

function shapeGame(g) {
  return {
    game_id:g.game_id, season:num(g.season), week:num(g.week), game_type:g.game_type,
    gameday:g.gameday, weekday:g.weekday, gametime:g.gametime,
    away:g.away_team, home:g.home_team,
    away_score:num(g.away_score), home_score:num(g.home_score), location:g.location,
    spread:num(g.spread_line), total:num(g.total_line),           // spread>0 = home favored
    away_ml:num(g.away_moneyline), home_ml:num(g.home_moneyline),
    away_rest:num(g.away_rest), home_rest:num(g.home_rest), div_game:g.div_game === '1',
    roof:g.roof, surface:g.surface, temp:num(g.temp), wind:num(g.wind),
    away_qb:g.away_qb_name, home_qb:g.home_qb_name,
    away_coach:g.away_coach, home_coach:g.home_coach, stadium:g.stadium,
  };
}

async function slate(url) {
  const season = url.searchParams.get('season') || '2026';
  const week = url.searchParams.get('week');
  const out = (await loadGames())
    .filter(g => g.season === String(season) && (!week || g.week === String(week)))
    .map(shapeGame);
  return json({ season:+season, week: week ? +week : null, count:out.length, games:out }, TTL.slate);
}

async function weeks(url) {
  const season = url.searchParams.get('season') || '2026';
  const games = (await loadGames()).filter(g => g.season === String(season) && g.game_type === 'REG');
  const m = new Map();
  for (const g of games) {
    const w = +g.week;
    const e = m.get(w) || { week:w, games:0, played:0, first:g.gameday, last:g.gameday };
    e.games++; if (g.home_score !== '') e.played++;
    if (g.gameday < e.first) e.first = g.gameday;
    if (g.gameday > e.last)  e.last  = g.gameday;
    m.set(w, e);
  }
  const list = [...m.values()].sort((a,b) => a.week - b.week);
  const cur = list.find(w => w.played < w.games) || list[list.length-1];
  return json({ season:+season, current: cur ? cur.week : 1, weeks:list }, TTL.weeks);
}

/* ------------------------------------------------------------ team rates */

async function teamRates(url) {
  const season = url.searchParams.get('season') || '2025';
  const [txt, games] = await Promise.all([
    getText(`stats_team/stats_team_week_${season}.csv`),
    loadGames(),
  ]);
  const rows = parseCSV(txt).filter(r => r.season_type === 'REG');

  const blank = () => ({ games:0, dropbacks:0, carries:0, plays:0, pass_yards:0, rush_yards:0,
                         air_yards:0, attempts:0, sacks:0, pass_epa:0, rush_epa:0, points:0 });
  const off = new Map(), def = new Map();
  const get = (m,t) => { if (!m.has(t)) m.set(t, blank()); return m.get(t); };

  for (const r of rows) {
    const att = f0(r.attempts), sk = f0(r.sacks_suffered), car = f0(r.carries);
    const db = att + sk, plays = db + car;
    const add = a => {
      a.games++; a.dropbacks += db; a.carries += car; a.plays += plays;
      a.attempts += att; a.sacks += sk;
      a.pass_yards += f0(r.passing_yards); a.rush_yards += f0(r.rushing_yards);
      a.air_yards  += f0(r.passing_air_yards);
      a.pass_epa   += f0(r.passing_epa);   a.rush_epa  += f0(r.rushing_epa);
    };
    add(get(off, r.team));
    if (r.opponent_team) add(get(def, r.opponent_team));
  }
  for (const g of games) {
    if (g.season !== String(season) || g.game_type !== 'REG') continue;
    const hs = num(g.home_score), as = num(g.away_score);
    if (hs === null || as === null) continue;
    if (off.has(g.home_team)) off.get(g.home_team).points += hs;
    if (off.has(g.away_team)) off.get(g.away_team).points += as;
    if (def.has(g.home_team)) def.get(g.home_team).points += as;
    if (def.has(g.away_team)) def.get(g.away_team).points += hs;
  }

  const rate = a => a && a.games ? {
    games:a.games,
    plays_pg:+(a.plays/a.games).toFixed(2),
    dropbacks_pg:+(a.dropbacks/a.games).toFixed(2),
    carries_pg:+(a.carries/a.games).toFixed(2),
    attempts_pg:+(a.attempts/a.games).toFixed(2),
    pass_rate:+(a.dropbacks/Math.max(1,a.plays)).toFixed(4),
    adot:a.attempts ? +(a.air_yards/a.attempts).toFixed(2) : null,
    sack_rate:+(a.sacks/Math.max(1,a.dropbacks)).toFixed(4),
    ypa:a.attempts ? +(a.pass_yards/a.attempts).toFixed(2) : null,
    ypc:a.carries ? +(a.rush_yards/a.carries).toFixed(2) : null,
    epa_play:+((a.pass_epa+a.rush_epa)/Math.max(1,a.plays)).toFixed(4),
    points_pg:+(a.points/a.games).toFixed(2),
  } : null;

  const teams = {};
  for (const t of new Set([...off.keys(), ...def.keys()]))
    teams[t] = { offense:rate(off.get(t)), defense:rate(def.get(t)) };

  const ov = Object.values(teams).map(t => t.offense).filter(Boolean);
  const dv = Object.values(teams).map(t => t.defense).filter(Boolean);
  const mean = (arr,k) => +(arr.reduce((s,v) => s + (v[k] || 0), 0) / Math.max(1,arr.length)).toFixed(4);
  const league = {
    plays_pg:mean(ov,'plays_pg'), dropbacks_pg:mean(ov,'dropbacks_pg'), carries_pg:mean(ov,'carries_pg'),
    attempts_pg:mean(ov,'attempts_pg'), pass_rate:mean(ov,'pass_rate'), adot:mean(ov,'adot'),
    ypa:mean(ov,'ypa'), ypc:mean(ov,'ypc'), points_pg:mean(ov,'points_pg'), sack_rate:mean(ov,'sack_rate'),
    def_ypa:mean(dv,'ypa'), def_attempts_pg:mean(dv,'attempts_pg'),
  };
  return json({ season:+season, league, teams }, TTL.rates);
}

/* ----------------------------------------------------------- player rates
   Per-player usage shares, season-to-date plus a trailing lastN window.
   Shares denominate against the player's own team totals in the same weeks,
   so a player who missed games isn't punished for weeks he didn't play. */

async function playerRates(url) {
  const season = url.searchParams.get('season') || '2026';
  const lastN = Math.max(1, Math.min(10, +(url.searchParams.get('lastn') || 5)));

  const [pTxt, sTxt] = await Promise.all([
    getText(`stats_player/stats_player_week_${season}.csv`),
    getText(`snap_counts/snap_counts_${season}.csv`).catch(() => ''),
  ]);
  const rows = parseCSV(pTxt)
    .filter(r => r.season_type === 'REG' && /^(QB|RB|WR|TE|FB)$/.test(r.position));

  const teamWk = new Map();                       // `${team}|${week}` -> {tgt, car, pa}
  for (const r of rows) {
    const k = `${r.team}|${r.week}`;
    const t = teamWk.get(k) || { tgt:0, car:0, pa:0 };
    t.tgt += f0(r.targets); t.car += f0(r.carries); t.pa += f0(r.attempts);
    teamWk.set(k, t);
  }

  const snaps = new Map();                        // offense_pct is a DECIMAL (1.0 = 100%)
  for (const s of parseCSV(sTxt)) {
    if (!s.player) continue;
    snaps.set(`${s.player}|${s.week}`, f0(s.offense_pct));
  }

  const byPlayer = new Map();
  for (const r of rows) {
    const id = r.player_id;
    const p = byPlayer.get(id) || {
      player_id:id, name:r.player_display_name || r.player_name, pos:r.position, team:r.team, wk:[],
    };
    p.team = r.team;
    const tw = teamWk.get(`${r.team}|${r.week}`) || { tgt:0, car:0, pa:0 };
    // snap_counts keys on the FULL name; stats' player_name is abbreviated ("B.Robinson")
    const snapKey = `${r.player_display_name || r.player_name}|${r.week}`;
    p.wk.push({
      week:+r.week,
      att:f0(r.attempts), pass_yards:f0(r.passing_yards), pass_tds:f0(r.passing_tds),
      carries:f0(r.carries), rush_yards:f0(r.rushing_yards),
      targets:f0(r.targets), receptions:f0(r.receptions), rec_yards:f0(r.receiving_yards),
      air_yards:f0(r.receiving_air_yards),
      target_share: num(r.target_share) !== null ? num(r.target_share) : (tw.tgt ? f0(r.targets)/tw.tgt : null),
      carry_share: tw.car ? f0(r.carries)/tw.car : null,
      // team-side denominators for the weeks this player appeared — the client
      // shrinks shares by team opportunities, not by games
      team_att:tw.pa, team_targets:tw.tgt, team_carries:tw.car,
      snap_pct: snaps.has(snapKey) ? snaps.get(snapKey) : null,
    });
    byPlayer.set(id, p);
  }

  const agg = ws => {
    if (!ws.length) return null;
    const S = k => ws.reduce((s,w) => s + (w[k] || 0), 0);
    const avgOf = k => {
      const v = ws.map(w => w[k]).filter(x => x !== null && x !== undefined);
      return v.length ? v.reduce((s,x) => s+x, 0)/v.length : null;
    };
    const att = S('att'), car = S('carries'), tgt = S('targets');
    const tAtt = S('team_att'), tTgt = S('team_targets'), tCar = S('team_carries');
    const ts = avgOf('target_share'), cs = avgOf('carry_share'), sp = avgOf('snap_pct');
    return {
      games:ws.length,
      // raw opportunity totals — the unit the client shrinks in
      att, carries:car, targets:tgt,
      team_att:tAtt, team_targets:tTgt, team_carries:tCar,
      // share of team pass attempts in his games; volume-weighted, so a garbage-time
      // cameo barely moves a starter's number
      att_share: tAtt ? +(att/tAtt).toFixed(4) : null,
      att_pg:+(att/ws.length).toFixed(2),
      ypa: att ? +(S('pass_yards')/att).toFixed(2) : null,
      pass_td_pg:+(S('pass_tds')/ws.length).toFixed(3),
      carries_pg:+(car/ws.length).toFixed(2),
      ypc: car ? +(S('rush_yards')/car).toFixed(2) : null,
      targets_pg:+(tgt/ws.length).toFixed(2),
      ypt: tgt ? +(S('rec_yards')/tgt).toFixed(2) : null,
      catch_rate: tgt ? +(S('receptions')/tgt).toFixed(3) : null,
      adot: tgt ? +(S('air_yards')/tgt).toFixed(2) : null,
      target_share: ts !== null ? +ts.toFixed(4) : null,
      carry_share:  cs !== null ? +cs.toFixed(4) : null,
      snap_pct:     sp !== null ? +sp.toFixed(3) : null,
      // highest single-game snap share in the window: a role signal one early exit can't fake
      snap_max: (() => { const v = ws.map(w => w.snap_pct).filter(x => x !== null && x !== undefined);
                         return v.length ? +Math.max.apply(null, v).toFixed(3) : null; })(),
      // games in the window at under half his best snap share (left early, eased back in)
      short_games: (() => { const v = ws.map(w => w.snap_pct).filter(x => x !== null && x !== undefined);
                            const mx = v.length ? Math.max.apply(null, v) : 0;
                            return mx >= 0.5 ? v.filter(x => x < mx * 0.5).length : 0; })(),
    };
  };

  const players = {};
  for (const p of byPlayer.values()) {
    const ws = p.wk.sort((a,b) => a.week - b.week);
    const sn = ws.filter(w => w.snap_pct !== null);
    const drift = sn.length >= 2
      ? +(sn[sn.length-1].snap_pct - sn[sn.length-2].snap_pct).toFixed(3) : null;
    players[p.player_id] = {
      name:p.name, pos:p.pos, team:p.team,
      season:agg(ws), last:agg(ws.slice(-lastN)), lastn:lastN,
      weeks_played:ws.length, snap_drift:drift,
    };
  }
  return json({ season:+season, lastn:lastN, count:Object.keys(players).length, players }, TTL.rates);
}

/* -------------------------------------------------------------- injuries */

async function injuries(url) {
  const season = url.searchParams.get('season') || '2026';
  const week = url.searchParams.get('week');
  const rows = parseCSV(await getText(`injuries/injuries_${season}.csv`));
  const out = rows.filter(r => !week || r.week === String(week)).map(r => ({
    team:r.team, week:num(r.week), name:r.full_name || '', position:r.position,
    status:r.report_status || '', practice:r.practice_status || '',
    injury:r.report_primary_injury || r.practice_primary_injury || '',
  })).filter(r => r.status || r.practice);
  return json({ season:+season, week: week ? +week : null, count:out.length, injuries:out }, TTL.injuries);
}

/* ---------------------------------------------------------------- roster
   Weekly roster status for skill players. Catches what the injury report can't:
   a player on IR (RES) or cut isn't on the report at all, but his share from
   earlier weeks would otherwise stay in the model. Uses the latest published
   week at or before the requested one. */

async function roster(url) {
  const season = url.searchParams.get('season') || '2026';
  const week = +(url.searchParams.get('week') || 1);
  const rows = parseCSV(await getText(`weekly_rosters/roster_weekly_${season}.csv`))
    .filter(r => /^(QB|RB|WR|TE|FB)$/.test(r.position) && +r.week <= week);
  const used = rows.reduce((m, r) => Math.max(m, +r.week), 0);
  const players = rows.filter(r => +r.week === used).map(r => ({
    name:r.full_name, team:r.team, pos:r.position, status:r.status,
  }));
  return json({ season:+season, week, week_used:used || null, count:players.length, players }, TTL.roster);
}

/* ---------------------------------------------------------------- o-line
   Depth charts are unusable (47MB of timestamped snapshots), but linemen who
   start play ~every snap. So join the injury report to snap share and keep
   only linemen who were carrying a starter's workload. */

async function oline(url) {
  const season = url.searchParams.get('season') || '2026';
  const week = +(url.searchParams.get('week') || 1);
  const [iTxt, sTxt] = await Promise.all([
    getText(`injuries/injuries_${season}.csv`),
    getText(`snap_counts/snap_counts_${season}.csv`).catch(() => ''),
  ]);

  const best = new Map();
  for (const s of parseCSV(sTxt)) {
    if (!/^(T|G|C|OL|OT|OG)$/.test(s.position)) continue;
    if (+s.week >= week) continue;
    const prev = best.get(s.player);
    if (!prev || +s.week > prev.week)
      best.set(s.player, { week:+s.week, pct:f0(s.offense_pct), team:s.team, pos:s.position });
  }

  const hits = [];
  for (const r of parseCSV(iTxt)) {
    if (r.week !== String(week)) continue;
    if (!/^(T|G|C|OL|OT|OG)$/.test(r.position)) continue;
    const st = (r.report_status || '').toLowerCase();
    if (!/out|doubtful|questionable/.test(st)) continue;

    let sn = best.get(r.full_name);
    if (!sn) {
      const ln = (r.last_name || (r.full_name || '').split(' ').slice(-1)[0] || '').toLowerCase();
      if (ln) for (const [k,v] of best) {
        if (v.team === r.team && k.toLowerCase().endsWith(ln)) { sn = v; break; }
      }
    }
    if (!sn || sn.pct < 0.60) continue;      // not a starter — ignore
    hits.push({
      team:r.team, name:r.full_name, position:r.position, status:r.report_status,
      injury:r.report_primary_injury || '', snap_pct:+sn.pct.toFixed(3), from_week:sn.week,
    });
  }

  const byTeam = {};
  for (const h of hits) {
    if (!byTeam[h.team]) byTeam[h.team] = { out:0, doubtful:0, questionable:0, players:[] };
    const t = byTeam[h.team], s = h.status.toLowerCase();
    if (s.indexOf('out') === 0) t.out++;
    else if (s.indexOf('doubt') === 0) t.doubtful++;
    else t.questionable++;
    t.players.push(h);
  }
  for (const t of Object.values(byTeam))
    t.severity = +Math.min(1, (t.out + t.doubtful*0.6 + t.questionable*0.25) / 2.5).toFixed(3);

  return json({ season:+season, week, teams:byTeam, count:hits.length }, TTL.oline);
}

/* ----------------------------------------------------------------- props
   SPENDS CREDITS. Only reached when the user presses the button.
   Cost = markets x regions per event. 4 markets x 16 games = 64 credits. */

function kvKey(week) { return `props:v1:${week}`; }

async function propsStatus(url, env) {
  const week = +(url.searchParams.get('week') || 1);
  if (!env.ODDS_CACHE) return json({ error:'ODDS_CACHE KV binding missing' }, 0, 500);
  const raw = await env.ODDS_CACHE.get(kvKey(week));
  if (!raw) return json({ week, cached:false });
  const d = JSON.parse(raw);
  return json({ week, cached:true, cached_at:d.cached_at,
                age_s:Math.round((Date.now()-d.cached_at)/1000),
                count:(d.props || []).length,
                credits_remaining:d.credits_remaining, events:d.events });
}

async function oddsFetch(env, path, params) {
  const keys = [env.ODDS_KEY_1, env.ODDS_KEY_2, env.ODDS_KEY_3].filter(Boolean);
  if (!keys.length) throw new Error('no ODDS_KEY_* secrets configured');
  let lastErr = null;
  for (const key of keys) {
    const qs = new URLSearchParams(Object.assign({}, params, { apiKey:key }));
    const r = await fetch(`${ODDS}${path}?${qs}`);
    if (r.ok) {
      return { data: await r.json(),
               remaining: r.headers.get('x-requests-remaining'),
               used: r.headers.get('x-requests-used') };
    }
    lastErr = `${r.status}`;
    if (r.status !== 401 && r.status !== 429) break;   // real error, not a quota problem
  }
  throw new Error(`odds api: ${lastErr}`);
}

/* The main US books. Small offshore feeds pile onto low rungs and make them look
   like consensus, so the line is chosen from these when any of them are present. */
const CORE_BOOKS = ['draftkings','fanduel','betmgm','caesars','espnbet','betrivers','pointsbetus','williamhill_us'];

/** Pick the line by median among core books, then the best price on each side of it. */
function consensus(entries) {
  const twoSided = entries.filter(e => e.over !== null && e.under !== null);
  const pool = twoSided.length ? twoSided : entries;
  const core = pool.filter(e => CORE_BOOKS.indexOf(e.book) >= 0);
  const judge = core.length ? core : pool;

  const pts = judge.map(e => e.line).sort((a,b) => a-b);
  const median = pts[Math.floor((pts.length-1)/2)];

  // best price on each side AT the chosen line
  let over = null, under = null, over_book = null, under_book = null, books = 0;
  for (const e of pool) {
    if (e.line !== median) continue;
    books++;
    if (e.over  !== null && (over  === null || e.over  > over))  { over  = e.over;  over_book  = e.book; }
    if (e.under !== null && (under === null || e.under > under)) { under = e.under; under_book = e.book; }
  }
  const all = [...new Set(pool.map(e => e.line))];
  return {
    line: median, over, under, over_book, under_book, books,
    n_lines: all.length,
    core_books: core.length,
    line_spread: all.length > 1 ? +(Math.max.apply(null,all) - Math.min.apply(null,all)).toFixed(1) : 0,
  };
}

async function props(url, env) {
  if (!env.ODDS_CACHE) return json({ error:'ODDS_CACHE KV binding missing' }, 0, 500);
  const week = +(url.searchParams.get('week') || 1);
  const force = url.searchParams.get('force') === '1';
  const markets = url.searchParams.get('markets') || DEFAULT_MARKETS;

  const cached = await env.ODDS_CACHE.get(kvKey(week));
  if (cached) {
    const d = JSON.parse(cached);
    const age = (Date.now() - d.cached_at) / 1000;
    if (!force && age < PROPS_TTL)
      return json(Object.assign({}, d, { from_cache:true, age_s:Math.round(age) }));
  }

  const ev = await oddsFetch(env, '/events', {});      // events endpoint costs 0 credits
  const events = (ev.data || []).slice(0, 20);

  const rows = [], rungs = {};
  let remaining = ev.remaining, spent = 0;
  for (const e of events) {
    let d;
    try {
      const r = await oddsFetch(env, `/events/${e.id}/odds`,
        { regions:'us', markets, oddsFormat:'american' });
      d = r.data;
      if (r.remaining !== null && r.remaining !== undefined) remaining = r.remaining;
      spent++;
    } catch (err) { continue; }

    const away = TEAM_ABBR[d.away_team] || d.away_team;
    const home = TEAM_ABBR[d.home_team] || d.home_team;

    const grouped = new Map();
    for (const bk of d.bookmakers || []) {
      for (const mk of bk.markets || []) {
        // Key by player AND point. A book can quote several rungs for one player;
        // collapsing them pairs an Over from one rung with an Under from another.
        const byRung = new Map();
        for (const o of mk.outcomes || []) {
          const nm = o.description || o.name;
          if (!nm || o.point === undefined || o.point === null) continue;
          const rk = `${nm}|${o.point}`;
          const g = byRung.get(rk) || { line:o.point, over:null, under:null, book:bk.key, player:nm };
          if (/over/i.test(o.name))  g.over  = o.price;
          if (/under/i.test(o.name)) g.under = o.price;
          byRung.set(rk, g);
        }
        for (const g of byRung.values()) {
          const k = `${g.player}|${mk.key}`;
          if (!grouped.has(k)) grouped.set(k, []);
          grouped.get(k).push(g);
        }
      }
    }

    for (const [k, entries] of grouped) {
      const bar = k.lastIndexOf('|');
      const player = k.slice(0, bar), market = k.slice(bar+1);
      for (const [line, f] of rungFairs(entries)) rungs[`${normKey(player)}|${market}|${line}`] = f;
      const c = consensus(entries);
      if (c.line === undefined || c.line === null) continue;
      rows.push({
        player, market, away, home, game:`${away}@${home}`, commence:e.commence_time,
        line:c.line, over:c.over, under:c.under,
        over_book:c.over_book, under_book:c.under_book,
        books:c.books, n_lines:c.n_lines, line_spread:c.line_spread, core_books:c.core_books,
      });
    }
  }

  const payload = {
    week, cached_at:Date.now(), events:spent, props:rows,
    credits_remaining: remaining ? +remaining : null,
    markets: markets.split(','),
  };
  await env.ODDS_CACHE.put(kvKey(week), JSON.stringify(payload), { expirationTtl: 60*60*24 });
  await env.ODDS_CACHE.put(rungKey(week), JSON.stringify({ at:payload.cached_at, rungs }), { expirationTtl: 60*60*24*3 });
  try { await updateCloses(env, week, rows, rungs); } catch (e) { /* never fail an odds pull over logging */ }
  return json(Object.assign({}, payload, { from_cache:false, age_s:0 }));
}

/* ----------------------------------------------------------------- plays
   Result tracking. Every board edge is logged once, when it first appears after
   an odds pull, with the model's numbers and the market's fair price at that
   moment. Each later odds pull BEFORE kickoff overwrites its "close" — so the
   closing line is the last price seen before the game started. The nightly build
   reads these and grades them against nflverse stats. */

const LOG_KEY = 'forkball-log-1';
const seasonNow = () => { const d = new Date(); return d.getUTCMonth() + 1 >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; };
const playsKey = (season, week) => `plays:v1:${season}:${week}`;
const rungKey = week => `rungs:v1:${week}`;
/* Same idea as the page's normName: "St. Brown" and "St.Brown" are one player. */
const normKey = s => (s||'').toLowerCase().replace(/[.'`\-]/g,' ').replace(/\s+(jr|sr|ii|iii|iv|v)\s*$/,'').replace(/\s+/g,'');
const amProb = a => a === null || a === undefined ? null : a > 0 ? 100/(a+100) : -a/(-a+100);

/** Fair P(over) at every rung any book posted: each book de-vigged on its own,
    then the median across core books (all books if no core book has that rung).
    Used for BOTH the logged price and the close, so CLV compares like with like. */
function rungFairs(entries){
  const by = new Map();
  for (const e of entries) {
    if (e.over === null || e.under === null) continue;
    const po = amProb(e.over), pu = amProb(e.under);
    if (!po || !pu) continue;
    const r = by.get(e.line) || { core:[], all:[] };
    const f = po/(po+pu);
    r.all.push(f); if (CORE_BOOKS.indexOf(e.book) >= 0) r.core.push(f);
    by.set(e.line, r);
  }
  const out = [];
  for (const [line, r] of by) {
    const xs = (r.core.length ? r.core : r.all).sort((a,b) => a-b);
    const m = xs.length % 2 ? xs[(xs.length-1)/2] : (xs[xs.length/2-1] + xs[xs.length/2]) / 2;
    out.push([line, [+m.toFixed(4), xs.length]]);
  }
  return out;
}

async function readPlays(env, season, week){
  const raw = await env.ODDS_CACHE.get(playsKey(season, week));
  return raw ? JSON.parse(raw) : { season, week, plays:{} };
}
async function writePlays(env, d){
  d.updated = Date.now();
  await env.ODDS_CACHE.put(playsKey(d.season, d.week), JSON.stringify(d));
}

/** Fair probability of THIS play's side at THIS play's line, from a rung index. */
function sideFair(rungs, p){
  const r = rungs && rungs[`${normKey(p.player)}|${p.market}|${p.line}`];
  if (!r) return null;
  return p.dir === 'over' ? r[0] : +(1 - r[0]).toFixed(4);
}

/* Called on every fresh odds pull. Games that have kicked off keep the close they had. */
async function updateCloses(env, week, rows, rungs){
  const d = await readPlays(env, seasonNow(), week);
  const now = Date.now();
  const cons = new Map(rows.map(r => [`${normKey(r.player)}|${r.market}`, r]));
  let touched = 0;
  for (const p of Object.values(d.plays)) {
    if (!p.commence || Date.parse(p.commence) <= now) continue;
    const c = cons.get(`${normKey(p.player)}|${p.market}`);
    if (!c) continue;                       // pulled off the board (injury news): keep the last close
    p.close = { at:now, line:c.line, fair:sideFair(rungs, p),
                price: p.dir === 'over' ? c.over : c.under };
    touched++;
  }
  if (touched) await writePlays(env, d);
}

function checkKey(request){ return request.headers.get('X-Log-Key') === LOG_KEY; }

/* Fields the page may send. Anything else is dropped. */
const PLAY_FIELDS = ['player','pid','market','dir','line','price','book','game','game_id','commence',
                     'p','fair','ev','pts','mean','w','opp','badges','settings'];
function cleanPlay(x){
  const o = {};
  for (const k of PLAY_FIELDS) if (x[k] !== undefined) o[k] = x[k];
  if (!o.player || !o.market || !o.dir || typeof o.line !== 'number') return null;
  if (o.dir !== 'over' && o.dir !== 'under') return null;
  return o;
}
const playId = p => `${normKey(p.player)}|${p.market}|${p.dir}|${p.line}`;

async function logPlays(request, env){
  if (!checkKey(request)) return json({ error:'bad log key' }, 0, 403);
  if (!env.ODDS_CACHE) return json({ error:'ODDS_CACHE KV binding missing' }, 0, 500);
  const body = await request.json();
  const season = +body.season, week = +body.week;
  if (!season || !week) return json({ error:'season and week required' }, 0, 400);
  const d = await readPlays(env, season, week);
  const rr = await env.ODDS_CACHE.get(rungKey(week));
  const rungs = rr ? JSON.parse(rr).rungs : null;
  const now = Date.now();
  let added = 0, late = 0;
  for (const x of (body.plays || []).slice(0, 300)) {
    const p = cleanPlay(x); if (!p) continue;
    const id = playId(p);
    if (d.plays[id]) continue;                                  // first sighting wins
    if (p.commence && Date.parse(p.commence) <= now) { late++; continue; }   // no logging after kickoff
    p.id = id; p.logged_at = now; p.source = 'board'; p.bet = false;
    const f = sideFair(rungs, p);
    if (f !== null) p.fair = f;                                 // same method as the close
    p.close = { at:now, line:p.line, fair:p.fair ?? null, price:p.price ?? null };
    d.plays[id] = p; added++;
  }
  if (added) await writePlays(env, d);
  return json({ ok:true, added, late, total:Object.keys(d.plays).length });
}

async function betPlay(request, env){
  if (!checkKey(request)) return json({ error:'bad log key' }, 0, 403);
  if (!env.ODDS_CACHE) return json({ error:'ODDS_CACHE KV binding missing' }, 0, 500);
  const body = await request.json();
  const season = +body.season, week = +body.week;
  const p = body.play && cleanPlay(body.play);
  if (!season || !week || !p) return json({ error:'season, week and play required' }, 0, 400);
  const d = await readPlays(env, season, week);
  const id = playId(p);
  if (!d.plays[id]) {
    // Bet on something the board didn't log (different slider settings). Keep it,
    // but out of the model's record.
    if (p.commence && Date.parse(p.commence) <= Date.now()) return json({ error:'game has started' }, 0, 409);
    p.id = id; p.logged_at = Date.now(); p.source = 'manual';
    p.close = { at:p.logged_at, line:p.line, fair:p.fair ?? null, price:p.price ?? null };
    d.plays[id] = p;
  }
  d.plays[id].bet = !!body.bet;
  d.plays[id].bet_at = Date.now();
  await writePlays(env, d);
  return json({ ok:true, id, bet:d.plays[id].bet });
}

async function getPlays(url, env){
  if (!env.ODDS_CACHE) return json({ error:'ODDS_CACHE KV binding missing' }, 0, 500);
  const season = +(url.searchParams.get('season') || seasonNow());
  const week = url.searchParams.get('week');
  const weeks = [];
  if (week) weeks.push(await readPlays(env, season, +week));
  else {
    const ls = await env.ODDS_CACHE.list({ prefix:`plays:v1:${season}:` });
    for (const k of ls.keys) { const raw = await env.ODDS_CACHE.get(k.name); if (raw) weeks.push(JSON.parse(raw)); }
  }
  const plays = [];
  for (const w of weeks) for (const p of Object.values(w.plays || {})) plays.push(Object.assign({ week:w.week }, p));
  return json({ season, plays });
}

/* -------------------------------------------------------------------- raw */

async function raw(assetPath) {
  if (!/^[A-Za-z0-9_\-]+\/[A-Za-z0-9_\-.]+$/.test(assetPath))
    return json({ error:'bad asset path' }, 0, 400);
  return new Response(await getText(assetPath), {
    headers: { ...CORS, 'Content-Type':'text/csv', 'Cache-Control':`public, max-age=${TTL.raw}` },
  });
}
