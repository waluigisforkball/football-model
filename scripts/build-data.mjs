#!/usr/bin/env node
/**
 * NFL Slate — nightly data build
 *
 * Runs in GitHub Actions (.github/workflows/nightly-data.yml). Downloads the heavy
 * nflverse files, computes the rate tables with the SAME code the worker uses
 * (worker/nfl-data-worker.js — one source of truth), and writes small JSON files
 * to data/, which GitHub Pages serves next to index.html.
 *
 * Why: parsing a season of player stats (8+ MB of CSV) exceeds a free-tier
 * Cloudflare Worker's limits. A build machine doesn't care.
 *
 * Zero maintenance:
 *  - Season is worked out from the date (June onward = that year's season).
 *  - Files are only rewritten when their content changes, so quiet days don't commit.
 *  - meta.heartbeat changes monthly, so the offseason still gets one commit a month
 *    and GitHub doesn't disable the schedule for inactivity.
 *
 * Local run:  node scripts/build-data.mjs      (SEASON=2026 to override)
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT     = path.join(ROOT, 'data');
const WORKER  = path.join(ROOT, 'worker', 'nfl-data-worker.js');
const WINDOWS = [3, 5, 8];   // the page's Last 3 / 5 / 8 selector; "Season" uses the season block

const now = new Date();
const SEASON = +(process.env.SEASON ||
  (now.getUTCMonth() + 1 >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1));
const PRIOR = SEASON - 1;

/* Load the worker's own functions without deploying it: strip the module export
   and evaluate the file in a sandbox that has Node's fetch/Response. */
function loadWorker() {
  const src = fs.readFileSync(WORKER, 'utf8')
    .replace(/export\s+default\s*\{/, 'const __default = {')
    + '\n;globalThis.__w = { playerRates, teamRates, getText, parseCSV };';
  const ctx = { fetch, Response, Request, Headers, URL, URLSearchParams, console,
                caches: { default: { match: async () => undefined, put: async () => {} } } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: WORKER });
  return ctx.__w;
}
const W = loadWorker();
const call = async (fn, qs) => {
  const r = await fn(new URL(`https://build.local/x?${qs}`));
  const body = await r.json();
  if (r.status !== 200) throw new Error(body.error || `status ${r.status}`);
  return body;
};

/** Player rates with every window in one file: players[id].lasts[n]. */
async function playerFile(season, windows) {
  const base = await call(W.playerRates, `season=${season}&lastn=${windows[0] || 5}`);
  for (const p of Object.values(base.players)) { p.lasts = {}; delete p.last; delete p.lastn; }
  for (const n of windows) {
    const d = await call(W.playerRates, `season=${season}&lastn=${n}`);
    for (const [id, p] of Object.entries(d.players))
      if (base.players[id]) base.players[id].lasts[n] = p.last;
  }
  delete base.lastn;
  base.windows = windows;
  return base;
}

/** Skill-position roster status for every published week (the page picks the latest ≤ its week). */
async function rosterFile(season) {
  const rows = W.parseCSV(await W.getText(`weekly_rosters/roster_weekly_${season}.csv`))
    .filter(r => /^(QB|RB|WR|TE|FB)$/.test(r.position));
  const weeks = {};
  for (const r of rows) (weeks[r.week] = weeks[r.week] || []).push([r.full_name, r.team, r.position, r.status]);
  for (const k of Object.keys(weeks)) weeks[k].sort((a, b) => (a[1] + a[0]).localeCompare(b[1] + b[0]));
  return { season, weeks };
}

async function statsThroughWeek(season) {
  const rows = W.parseCSV(await W.getText(`stats_team/stats_team_week_${season}.csv`));
  return rows.filter(r => r.season_type === 'REG').reduce((m, r) => Math.max(m, +r.week || 0), 0);
}

/* Write only on change, so an unchanged day produces no commit. */
fs.mkdirSync(OUT, { recursive: true });
const changed = [];
function put(name, obj) {
  const f = path.join(OUT, name), s = JSON.stringify(obj);
  if (fs.existsSync(f) && fs.readFileSync(f, 'utf8') === s) return;
  fs.writeFileSync(f, s);
  changed.push(name);
}

const files = [], errors = [];
async function job(name, fn) {
  try { put(name, await fn()); files.push(name); console.log('ok   ' + name); }
  catch (e) {
    // Current-season files legitimately don't exist yet in the summer.
    const expected = /upstream 404/.test(e.message);
    (expected ? console.log : console.error)((expected ? 'skip ' : 'FAIL ') + name + ' — ' + e.message);
    if (!expected) errors.push(`${name}: ${e.message}`);
    if (fs.existsSync(path.join(OUT, name))) files.push(name);   // keep serving the last good copy
  }
}

// Last season is final but cheap to rebuild — rebuilding means any logic change in
// the worker flows into the priors automatically. Unchanged output = no commit.
await job(`player-rates-${PRIOR}.json`, async () => {
  const d = await playerFile(PRIOR, []);
  for (const p of Object.values(d.players)) { delete p.lasts; delete p.snap_drift; }
  return d;
});
await job(`team-rates-${PRIOR}.json`,   () => call(W.teamRates, `season=${PRIOR}`));
await job(`player-rates-${SEASON}.json`, () => playerFile(SEASON, WINDOWS));
await job(`team-rates-${SEASON}.json`,  () => call(W.teamRates, `season=${SEASON}`));
await job(`roster-${SEASON}.json`,      () => rosterFile(SEASON));

let through = null;
try { through = await statsThroughWeek(SEASON); } catch (e) { /* offseason */ }

const metaPath = path.join(OUT, 'meta.json');
const old = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
const meta = {
  season: SEASON, prior_season: PRIOR, windows: WINDOWS,
  stats_through_week: through, files: files.sort(),
  heartbeat: now.toISOString().slice(0, 7),   // YYYY-MM: one offseason commit a month keeps the schedule alive
  generated: old.generated || null,
};
const same = JSON.stringify({ ...old, generated: null }) === JSON.stringify({ ...meta, generated: null });
if (changed.length || !same) meta.generated = now.toISOString();
put('meta.json', meta);

console.log(`\nseason ${SEASON} (prior ${PRIOR}) · stats through week ${through} · changed: ${changed.join(', ') || 'nothing'}`);
if (errors.length) { console.error('\nFailures:\n  ' + errors.join('\n  ')); process.exit(1); }
