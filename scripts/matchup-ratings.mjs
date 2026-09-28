/**
 * Opponent-adjusted team run/pass ratings — used by scripts/build-data.mjs.
 *
 * Display only: nothing here feeds picks, probabilities, spreads or props.
 *
 * Per team, four units: run offense, run defense, pass offense, pass defense.
 * Each is an opponent-adjusted SUCCESS RATE, in percentage points vs league average,
 * plus a companion adjusted yards per play.
 *
 *  Success (our own yardage rule — NOT nflverse's EPA-based `success` column):
 *    1st down  gain >= 40% of the distance
 *    2nd down  gain >= 60%
 *    3rd/4th   gain >= the full distance (a conversion). Yardage, not the
 *              `first_down` flag, so a penalty first down doesn't count.
 *
 *  Plays kept: regular season, pass==1 (includes sacks and scrambles) or rush==1.
 *  Dropped: no_play, kneels, spikes, two-point tries, and plays where the offense's
 *  win probability is under 10% or over 90% (garbage time), or missing.
 *
 *  Opponent adjustment: each game is scored against what that opponent normally
 *  allows (or produces), with the opponent's number computed from its OTHER games.
 *  Offense and defense ratings depend on each other, so this repeats until the
 *  changes are negligible (max 10 passes).
 *
 *  Early-season shrinkage: every team is treated as having k extra league-average
 *  games — k = 2 for passing, 3 for rushing — so a rating = raw × games/(games+k).
 *  Unlike the main model, last season is NOT blended in.
 *
 *  Windows ("Last 3 wks", "Last 5 wks"): a team's rating from only its games in
 *  those weeks, each game still adjusted by the opponent's FULL-season number
 *  (a 3-game sample can't also estimate every opponent). Same shrinkage, on the
 *  window's game count. Written only once the season is longer than the window.
 */

export const K_GAMES = { pass: 2, rush: 3 };
export const WINDOWS = [3, 5];
const WP_LO = 0.10, WP_HI = 0.90, MAX_ITER = 10, TOL = 1e-5;
const COLS = ['season_type', 'game_id', 'week', 'posteam', 'defteam', 'down', 'ydstogo', 'yards_gained',
              'pass', 'rush', 'wp', 'qb_kneel', 'qb_spike', 'play_type', 'two_point_attempt'];

/** Lean CSV parse: only the columns we need. The full file has ~370 columns and
    grows past 100 MB by December, so objects for every field would be wasteful. */
export function parsePbp(text) {
  const out = [];
  let idx = null, row = [], field = '', q = false, col = 0;
  const want = new Map();                       // column index -> name
  const endRow = () => {
    if (!idx) {                                 // header
      idx = row;
      row.forEach((h, i) => { if (COLS.includes(h)) want.set(i, h); });
      const missing = COLS.filter(c => !row.includes(c));
      if (missing.length) throw new Error('play-by-play is missing columns: ' + missing.join(', '));
    } else if (row.length > 1) {
      const o = {};
      for (const [i, h] of want) o[h] = row[i] ?? '';
      out.push(o);
    }
    row = []; col = 0;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(idx && !want.has(col) ? '' : field); field = ''; col++; }
    else if (c === '\n') { row.push(field); field = ''; endRow(); }
    else if (c !== '\r') { if (!idx || want.has(col)) field += c; }
  }
  if (field.length || row.length) { row.push(field); endRow(); }
  return out;
}

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const one = v => v === '1' || v === '1.0' || v === 'TRUE' || v === 'true';

/** The play filter and success rule. Returns null for plays that don't count. */
export function scorePlay(r) {
  if (r.season_type && r.season_type !== 'REG') return null;
  if (!r.posteam || !r.defteam) return null;
  const pass = one(r.pass), rush = one(r.rush);
  if (!pass && !rush) return null;
  if (r.play_type === 'no_play' || r.play_type === 'qb_kneel' || r.play_type === 'qb_spike') return null;
  if (one(r.qb_kneel) || one(r.qb_spike) || one(r.two_point_attempt)) return null;
  const wp = num(r.wp);
  if (wp === null || wp < WP_LO || wp > WP_HI) return null;
  const down = num(r.down), togo = num(r.ydstogo), yds = num(r.yards_gained);
  if (!(down >= 1 && down <= 4) || !(togo > 0) || yds === null) return null;
  const need = down === 1 ? 0.4 * togo : down === 2 ? 0.6 * togo : togo;
  return { unit: pass ? 'pass' : 'rush', off: r.posteam, def: r.defteam, game: r.game_id,
           week: num(r.week), success: yds >= need ? 1 : 0, yards: yds };
}

/* ------------------------------------------------------------------ math */

/** Weighted mean of adjusted game values; [] -> null. */
function wmean(xs) {
  let s = 0, w = 0;
  for (const x of xs) { s += x.v * x.n; w += x.n; }
  return w ? s / w : null;
}

/**
 * One unit (pass or rush), one stat (success rate or yards per play).
 * games: [{ id, off, def, n, v }] — v is that offense's value in that game.
 * Returns edges in raw units: off[t] = how much more t produces than average,
 * def[t] = how much more t ALLOWS than average (positive = leaky). Both shrunk.
 */
function solve(games, lg, k) {
  const teams = new Set();
  for (const g of games) { teams.add(g.off); teams.add(g.def); }
  const byOff = new Map(), byDef = new Map();
  for (const t of teams) { byOff.set(t, []); byDef.set(t, []); }
  for (const g of games) { byOff.get(g.off).push(g); byDef.get(g.def).push(g); }

  const shrink = (e, n) => e === null ? 0 : e * n / (n + k);
  let off = new Map([...teams].map(t => [t, 0])), def = new Map([...teams].map(t => [t, 0]));
  let raw = { off: new Map(), def: new Map() }, iters = 0;

  /* A team's edge on one side, from its games except `skip`, each adjusted for
     that game's opponent using the other side's current (shrunk) edges. */
  const sideEdge = (list, oppEdge, oppKey, skip) => {
    const xs = [];
    for (const g of list) if (g !== skip) xs.push({ n: g.n, v: g.v - oppEdge.get(g[oppKey]) });
    const m = wmean(xs);
    return { e: m === null ? null : m - lg, games: xs.length };
  };

  for (iters = 1; iters <= MAX_ITER; iters++) {
    const nOff = new Map(), nDef = new Map(), rOff = new Map(), rDef = new Map();
    for (const t of teams) {
      // Offense: each game adjusted by what THAT defense allows in its other games.
      const oxs = byOff.get(t).map(g => {
        const d = sideEdge(byDef.get(g.def), off, 'off', g);
        return { n: g.n, v: g.v - shrink(d.e, d.games) };
      });
      const om = wmean(oxs), og = oxs.length;
      rOff.set(t, om === null ? null : om - lg);
      nOff.set(t, shrink(rOff.get(t), og));
      // Defense: each game adjusted by what THAT offense produces in its other games.
      const dxs = byDef.get(t).map(g => {
        const o = sideEdge(byOff.get(g.off), def, 'def', g);
        return { n: g.n, v: g.v - shrink(o.e, o.games) };
      });
      const dm = wmean(dxs), dg = dxs.length;
      rDef.set(t, dm === null ? null : dm - lg);
      nDef.set(t, shrink(rDef.get(t), dg));
    }
    let delta = 0;
    for (const t of teams) delta = Math.max(delta, Math.abs(nOff.get(t) - off.get(t)), Math.abs(nDef.get(t) - def.get(t)));
    off = nOff; def = nDef; raw = { off: rOff, def: rDef };
    if (delta < TOL) break;
  }
  /* One side's ratings from a subset of each team's games (the window), opponents
     adjusted with the converged full-season edges — the same formula as the last pass. */
  const subset = keep => {
    const r = { off: new Map(), def: new Map(), raw: { off: new Map(), def: new Map() },
                games: { off: new Map(), def: new Map() }, plays: { off: new Map(), def: new Map() } };
    for (const t of teams) {
      const og = byOff.get(t).filter(keep), dg = byDef.get(t).filter(keep);
      const oxs = og.map(g => { const d = sideEdge(byDef.get(g.def), off, 'off', g); return { n: g.n, v: g.v - shrink(d.e, d.games) }; });
      const dxs = dg.map(g => { const o = sideEdge(byOff.get(g.off), def, 'def', g); return { n: g.n, v: g.v - shrink(o.e, o.games) }; });
      const om = wmean(oxs), dm = wmean(dxs);
      r.raw.off.set(t, om === null ? null : om - lg); r.off.set(t, shrink(r.raw.off.get(t), oxs.length));
      r.raw.def.set(t, dm === null ? null : dm - lg); r.def.set(t, shrink(r.raw.def.get(t), dxs.length));
      r.games.off.set(t, og.length); r.games.def.set(t, dg.length);
      r.plays.off.set(t, og.reduce((s, g) => s + g.n, 0)); r.plays.def.set(t, dg.reduce((s, g) => s + g.n, 0));
    }
    return r;
  };

  return { off, def, raw, iters: Math.min(iters, MAX_ITER), subset,
           games: { off: t => byOff.get(t).length, def: t => byDef.get(t).length },
           plays: { off: t => byOff.get(t).reduce((s, g) => s + g.n, 0), def: t => byDef.get(t).reduce((s, g) => s + g.n, 0) } };
}

/** Percentile, 0–100, where 100 = best in the league at that unit. */
function percentiles(vals) {
  const xs = [...vals.values()], n = xs.length, out = new Map();
  for (const [t, v] of vals) {
    const below = xs.filter(x => x < v).length, ties = xs.filter(x => x === v).length - 1;
    out.set(t, n > 1 ? Math.round(100 * (below + ties / 2) / (n - 1)) : 50);
  }
  return out;
}

const r1 = v => +(v).toFixed(1), r2 = v => +(v).toFixed(2), r4 = v => +(v).toFixed(4);

export function matchupRatings(rows, season) {
  const plays = [];
  for (const r of rows) { const p = scorePlay(r); if (p) plays.push(p); }
  if (!plays.length) throw new Error('no qualifying plays');

  const out = { season, through_week: plays.reduce((m, p) => Math.max(m, p.week || 0), 0),
    method: { success: '1st >=40% of distance, 2nd >=60%, 3rd/4th conversion (yardage)',
              wp_window: [WP_LO, WP_HI], shrink_games: K_GAMES, max_iterations: MAX_ITER },
    league: {}, iterations: {}, teams: {} };

  for (const unit of ['pass', 'rush']) {
    const agg = new Map();                                  // game|off -> totals
    for (const p of plays) {
      if (p.unit !== unit) continue;
      const key = p.game + '|' + p.off;
      const a = agg.get(key) || { id: p.game, week: p.week, off: p.off, def: p.def, n: 0, s: 0, y: 0 };
      a.n++; a.s += p.success; a.y += p.yards;
      agg.set(key, a);
    }
    const games = [...agg.values()];
    const N = games.reduce((s, g) => s + g.n, 0);
    const lgSr = games.reduce((s, g) => s + g.s, 0) / N, lgY = games.reduce((s, g) => s + g.y, 0) / N;
    const k = K_GAMES[unit];
    const sr = solve(games.map(g => ({ ...g, v: g.s / g.n })), lgSr, k);
    const yp = solve(games.map(g => ({ ...g, v: g.y / g.n })), lgY, k);
    out.league[unit] = { sr: r4(lgSr), ypp: r2(lgY), plays: N };
    out.iterations[unit] = { sr: sr.iters, ypp: yp.iters };

    // "good" orientation: + is good for that unit (offense produces more, defense allows less)
    const good = { off: new Map(), def: new Map() };
    for (const t of sr.off.keys()) { good.off.set(t, sr.off.get(t)); good.def.set(t, -sr.def.get(t)); }
    const pct = { off: percentiles(good.off), def: percentiles(good.def) };

    for (const side of ['off', 'def']) for (const t of sr[side].keys()) {
      const e = sr[side].get(t), ey = yp[side].get(t), sign = side === 'off' ? 1 : -1;
      const rawE = sr.raw[side].get(t);
      (out.teams[t] = out.teams[t] || {})[`${unit}_${side}`] = {
        pp: r1(sign * e * 100),                 // rating: + = good for this unit
        edge: r4(e),                            // raw direction: + = produces (off) / allows (def) more than average
        sr: r4(lgSr + e),                       // adjusted success rate (produced / allowed)
        raw_pp: rawE === null ? null : r1(sign * rawE * 100),   // before shrinkage
        ypp: r2(lgY + ey), ypp_edge: r2(ey),    // adjusted yards per play, edge in same raw direction
        pct: pct[side].get(t),
        games: sr.games[side](t), plays: sr.plays[side](t),
      };
    }

    // Windows: only once the season is longer than the window (before that it IS the season).
    for (const n of WINDOWS) {
      if (out.through_week <= n) continue;
      const from = out.through_week - n + 1, keep = g => g.week >= from;
      const ws = sr.subset(keep), wy = yp.subset(keep);
      const W = ((out.windows = out.windows || {})[n] = out.windows[n] || { from_week: from, through_week: out.through_week, teams: {} });
      const wgood = { off: new Map(), def: new Map() };
      for (const t of ws.off.keys()) { wgood.off.set(t, ws.off.get(t)); wgood.def.set(t, -ws.def.get(t)); }
      const wpct = { off: percentiles(wgood.off), def: percentiles(wgood.def) };
      for (const side of ['off', 'def']) for (const t of ws[side].keys()) {
        const e = ws[side].get(t), ey = wy[side].get(t), sign = side === 'off' ? 1 : -1, rawE = ws.raw[side].get(t);
        (W.teams[t] = W.teams[t] || {})[`${unit}_${side}`] = {
          pp: r1(sign * e * 100), edge: r4(e), sr: r4(lgSr + e),
          raw_pp: rawE === null ? null : r1(sign * rawE * 100),
          ypp: r2(lgY + ey), ypp_edge: r2(ey), pct: wpct[side].get(t),
          games: ws.games[side].get(t), plays: ws.plays[side].get(t),
        };
      }
    }
  }
  if (out.windows) for (const W of Object.values(out.windows))
    W.teams = Object.fromEntries(Object.keys(W.teams).sort().map(t => [t, W.teams[t]]));
  // Stable key order so an unchanged day writes an identical file (no commit).
  out.teams = Object.fromEntries(Object.keys(out.teams).sort().map(t => [t, out.teams[t]]));
  return out;
}

/** Team names, colours and logo links from nflverse's teams_colors_logos.csv, keyed by
    abbreviation. Logos are LINKS to images hosted by ESPN (Wikipedia as a backup) — nothing
    is copied into the repo. Only https links on those two hosts are kept. */
const LOGO_HOST = /^https:\/\/(a\.espncdn\.com|upload\.wikimedia\.org)\//;
const HEX = /^#[0-9a-fA-F]{6}$/;
export function teamInfo(rows, abbrs) {
  const out = {};
  for (const r of rows) {
    if (!abbrs.has(r.team_abbr)) continue;
    const logos = [r.team_logo_espn, r.team_logo_wikipedia].filter(u => LOGO_HOST.test(u || ''));
    out[r.team_abbr] = { name: r.team_name || r.team_abbr, nick: r.team_nick || '',
      color: HEX.test(r.team_color) ? r.team_color : null,
      color2: HEX.test(r.team_color2) ? r.team_color2 : null, logos };
  }
  return Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]]));
}
