// BL-557 — tests for the training-odds page generator (build.mjs) and the daily check (check.mjs).
//
//   node --test "_tools/training-odds/test/*.test.mjs"
//
// No npm dependencies (Node 22 built-ins only). Every test builds into its own temp directory with
// --root, from a local --input document, so nothing here touches the network or the committed pages.
// Documents are SYNTHETIC (fixtures/synthetic-*.json, plus variants derived from them below).
//
// What a player loses if each block regresses:
//   no-JS        the page shows nothing (or one galaxy) when script is blocked; search engines see less
//   identical    two galaxies with the same odds collapse into one, and a player cannot find theirs
//   deep link    a shared #galaxy_002 link opens the wrong galaxy's odds
//   determinism  the hourly Action commits a "changed" page every hour with no odds change
//   locales      a language page renders an English or {placeholder} hole in a legal disclosure
//   check        the daily check passes a page whose odds differ from the document (AC-W6)
//   notice       (BL-558) an odds change is not announced before it takes effect, says the wrong
//                before/after or date, or a page without `upcoming` changes at all (switch off)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(TOOL, 'build.mjs');
const CHECK = join(TOOL, 'check.mjs');
const DEV_FIXTURE = join(TOOL, 'fixtures', 'synthetic-dev-2026-10-23.json');
const EDGE_FIXTURE = join(TOOL, 'fixtures', 'synthetic-edge-cases.json');
const UPCOMING_FIXTURE = join(TOOL, 'fixtures', 'synthetic-upcoming.json');
const CONFIG = JSON.parse(readFileSync(join(TOOL, 'config.json'), 'utf8'));

const tmpDirs = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'bl557-odds-'));
  tmpDirs.push(d);
  return d;
}
process.on('exit', () => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function writeDoc(doc) {
  const f = join(tmp(), 'doc.json');
  writeFileSync(f, JSON.stringify(doc), 'utf8');
  return f;
}

function build(inputFile) {
  const root = tmp();
  const r = run(BUILD, ['--input', inputFile, '--root', root]);
  return { root, ...r, page: (loc = 'en') => readFileSync(join(root, ...(loc === 'en' ? [] : [loc]), CONFIG.pageFile), 'utf8') };
}

const devDoc = () => JSON.parse(readFileSync(DEV_FIXTURE, 'utf8'));
const stripMeta = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !k.startsWith('_')));

/** Each galaxy section's opening tag and body, in page order. */
function sections(html) {
  const start = html.indexOf('<div id="galaxy-views">');
  const end = html.indexOf('<!-- /galaxy-views -->');
  assert.ok(start >= 0 && end > start, 'page has a galaxy-views block');
  const views = html.slice(start, end);
  const heads = [...views.matchAll(/<section class="galaxy" id="([^"]*)"([^>]*)>/g)];
  return heads.map((h, i) => ({
    id: h[1],
    attrs: h[2],
    body: views.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : views.length),
  }));
}

// ---------------------------------------------------------------------------
// The deep-link script, run for real in a vm against a minimal DOM.
// ---------------------------------------------------------------------------

function runPickerScript(html, hash) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1]; // first block: picker + language links
  const ids = sections(html).map((s) => s.id);
  const listeners = {};
  const replaced = [];
  const mkSection = (id) => ({
    id,
    attrs: {},
    classList: { contains: (c) => c === 'galaxy' },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener() {},
    closest(sel) { return sel === '.galaxy' ? this : null; },
  });
  const secs = ids.map(mkSection);
  const views = { id: 'galaxy-views', children: secs };
  for (const s of secs) s.parentNode = views;
  const picker = { id: 'galaxy-select', value: '', addEventListener: (t, f) => { listeners[t] = f; } };
  const wrap = { id: 'galaxy-picker', hidden: true };
  const jump = { id: 'galaxy-jump', hidden: false };
  const byId = { 'galaxy-select': picker, 'galaxy-picker': wrap, 'galaxy-jump': jump, 'galaxy-views': views };
  for (const s of secs) byId[s.id] = s;
  // Elements inside a galaxy (e.g. BL-558's #galaxy_002-upcoming) resolve to their galaxy.
  sections(html).forEach((s, i) => {
    for (const m of s.body.matchAll(/\bid="([^"]+)"/g)) {
      if (!byId[m[1]]) byId[m[1]] = { id: m[1], closest: (sel) => (sel === '.galaxy' ? secs[i] : null) };
    }
  });
  const rootClasses = new Set(['no-js']);
  const history = { replaceState: (_s, _t, url) => replaced.push(url) };
  const location = { hash };
  const document = {
    documentElement: { classList: { add: (c) => rootClasses.add(c), remove: (c) => rootClasses.delete(c) } },
    getElementById: (id) => byId[id] || null,
    querySelectorAll: () => [],
  };
  const window = { history, addEventListener() {} };
  vm.runInNewContext(script, { document, window, history, location, decodeURIComponent, encodeURIComponent });
  return {
    // Getters: read the state at assertion time, after any later change().
    get visible() { return secs.filter((s) => !('hidden' in s.attrs)).map((s) => s.id); },
    get hiddenValues() { return secs.filter((s) => 'hidden' in s.attrs).map((s) => s.attrs.hidden); },
    picker, wrap, jump, rootClasses, replaced,
    change: (id) => { picker.value = id; listeners.change(); },
  };
}

// ---------------------------------------------------------------------------
// No-JS static content (AC-W2)
// ---------------------------------------------------------------------------

test('JS off: every galaxy is in the static HTML, visible, with Graves at 0.2%', () => {
  const doc = stripMeta(devDoc());
  const b = build(DEV_FIXTURE);
  assert.equal(b.code, 0, b.err);
  const html = b.page();
  assert.match(html, /<html lang="en" class="no-js">/);
  assert.match(html, /<div class="galaxy-picker" id="galaxy-picker" hidden>/, 'dropdown ships hidden');
  assert.doesNotMatch(/<nav class="jump"[^>]*>/.exec(html)[0], /hidden/, 'jump list ships visible');

  const secs = sections(html);
  assert.deepEqual(secs.map((s) => s.id), Object.keys(doc).sort());
  for (const s of secs) {
    assert.doesNotMatch(s.attrs, /hidden/, `${s.id} must not ship hidden`);
    assert.ok(s.body.includes(`>${doc[s.id].galaxyName}<`), `${s.id} shows its name`);
    assert.match(s.body, /data-k="captain">Graves</, `${s.id} lists Graves`);
    assert.match(s.body, /data-k="pct">0\.2%</, `${s.id} shows 0.2%`);
    // Every outcome row of the document is in this galaxy's static HTML.
    const rowKeys = [...s.body.matchAll(/data-row="([xc]\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(rowKeys, [...Object.keys(doc[s.id].experience).sort(), ...Object.keys(doc[s.id].captains).sort()]);
  }
});

test('identical odds in two galaxies stay two separate entries (never merged)', () => {
  const doc = stripMeta(devDoc());
  const twin = JSON.parse(JSON.stringify(doc.galaxy_001));
  twin.galaxyId = 'galaxy_009';
  twin.galaxyName = 'Twin';
  const b = build(writeDoc({ galaxy_001: doc.galaxy_001, galaxy_009: twin }));
  assert.equal(b.code, 0, b.err);
  const secs = sections(b.page());
  assert.deepEqual(secs.map((s) => s.id), ['galaxy_001', 'galaxy_009']);
  for (const s of secs) assert.match(s.body, /data-k="pct">0\.2%</);
  assert.equal([...b.page().matchAll(/<option value="/g)].length, 2);
});

// ---------------------------------------------------------------------------
// Deep link (AC-W4)
// ---------------------------------------------------------------------------

test('deep link #galaxy_002 selects it; others are hidden until-found; dropdown shown, jump list hidden', () => {
  const html = build(DEV_FIXTURE).page();
  const r = runPickerScript(html, '#galaxy_002');
  assert.deepEqual(r.visible, ['galaxy_002']);
  assert.deepEqual(r.hiddenValues, ['until-found']);
  assert.equal(r.picker.value, 'galaxy_002');
  assert.equal(r.wrap.hidden, false);
  assert.equal(r.jump.hidden, true);
  assert.ok(r.rootClasses.has('js') && !r.rootClasses.has('no-js'));
});

test('unknown hash and no hash both fall back to the first galaxy in galaxy-ID order', () => {
  const doc = stripMeta(devDoc());
  // Insert out of order: the first in ID order must still win.
  const later = JSON.parse(JSON.stringify(doc.galaxy_001));
  later.galaxyId = 'galaxy_010';
  const html = build(writeDoc({ galaxy_010: later, galaxy_002: doc.galaxy_002 })).page();
  for (const hash of ['#nope', '', '#']) {
    const r = runPickerScript(html, hash);
    assert.deepEqual(r.visible, ['galaxy_002'], `hash ${JSON.stringify(hash)}`);
  }
});

test('choosing from the dropdown shows that galaxy and writes it to the URL hash', () => {
  const r = runPickerScript(build(DEV_FIXTURE).page(), '');
  r.change('galaxy_002');
  assert.deepEqual(r.visible, ['galaxy_002']);
  assert.deepEqual(r.replaced, ['#galaxy_002']);
});

// ---------------------------------------------------------------------------
// Determinism (commit only on content change)
// ---------------------------------------------------------------------------

test('output is deterministic: same document, reordered keys or a new publishedAt give identical bytes', () => {
  const doc = stripMeta(devDoc());
  const reordered = Object.fromEntries(Object.entries(doc).reverse().map(([k, v]) => {
    const copy = Object.fromEntries(Object.entries(v).reverse());
    copy.publishedAt = 9999999999999;
    return [k, copy];
  }));
  const a = build(DEV_FIXTURE);
  const b = build(writeDoc(reordered));
  for (const loc of CONFIG.locales) assert.equal(a.page(loc), b.page(loc), `locale ${loc}`);
  // A rebuild into the same root reports no page changed.
  const again = run(BUILD, ['--input', DEV_FIXTURE, '--root', a.root]);
  assert.match(again.out, /pages changed: 0\//);
});

// ---------------------------------------------------------------------------
// Locales
// ---------------------------------------------------------------------------

test('all 7 locale files exist and share one key set with matching placeholders and tags', () => {
  const dir = join(TOOL, 'i18n');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')).sort();
  assert.deepEqual(files, [...CONFIG.locales].sort());
  const en = JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8'));
  const shape = (s) => [...s.matchAll(/\{\w+\}|<\/?strong>/g)].map((m) => m[0]).sort().join(' ');
  for (const loc of CONFIG.locales) {
    const t = JSON.parse(readFileSync(join(dir, `${loc}.json`), 'utf8'));
    assert.deepEqual(Object.keys(t).sort(), Object.keys(en).sort(), `${loc} key set`);
    for (const k of Object.keys(en)) assert.equal(shape(t[k]), shape(en[k]), `${loc}.${k} placeholders/tags`);
  }
});

test('every locale page is built and none leaks a {placeholder}', () => {
  const b = build(DEV_FIXTURE);
  for (const loc of CONFIG.locales) {
    const html = b.page(loc);
    assert.match(html, new RegExp(`<html lang="${loc}" `));
    assert.doesNotMatch(html.replace(/<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>/g, ''), /\{\w+\}/, loc);
  }
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test('an empty document writes nothing (a fault never blanks the page)', () => {
  const b = build(writeDoc({}));
  assert.equal(b.code, 1);
  assert.equal(existsSync(join(b.root, CONFIG.pageFile)), false);
});

test('an invalid galaxy renders "unavailable" and the build exits 3 (owner alert)', () => {
  const b = build(EDGE_FIXTURE);
  assert.equal(b.code, 3, b.err);
  const g3 = sections(b.page()).find((s) => s.id === 'galaxy_003');
  assert.match(g3.body, /data-k="unavailable"/);
  assert.doesNotMatch(g3.body, /data-k="pct"/);
});

// ---------------------------------------------------------------------------
// Daily check (AC-W6)
// ---------------------------------------------------------------------------

test('check.mjs exits 0 on a clean build', () => {
  const b = build(DEV_FIXTURE);
  const r = run(CHECK, ['--input', DEV_FIXTURE, '--root', b.root]);
  assert.equal(r.code, 0, r.err);
});

test('check.mjs exits non-zero when one published percent is altered', () => {
  const b = build(DEV_FIXTURE);
  const file = join(b.root, 'ko', CONFIG.pageFile);
  const html = readFileSync(file, 'utf8');
  const sec = sections(html).find((s) => s.id === 'galaxy_002');
  const tampered = sec.body.replace('data-k="pct">0.2%<', 'data-k="pct">0.3%<');
  assert.notEqual(tampered, sec.body, 'tamper applied');
  writeFileSync(file, html.replace(sec.body, tampered), 'utf8');
  const r = run(CHECK, ['--input', DEV_FIXTURE, '--root', b.root]);
  assert.equal(r.code, 1);
  assert.match(r.err, /galaxy_002 c\d+\.pct is "0\.3%", document says "0\.2%"/);
});

test('check.mjs exits non-zero when the page is missing a galaxy the document has', () => {
  const doc = stripMeta(devDoc());
  const b = build(writeDoc({ galaxy_001: doc.galaxy_001 }));
  const r = run(CHECK, ['--input', DEV_FIXTURE, '--root', b.root]);
  assert.equal(r.code, 1);
  assert.match(r.err, /MISSING galaxy galaxy_002/);
});

// ---------------------------------------------------------------------------
// Environment guards: no SYNTHETIC or dev odds over the published pages; no dev host by default.
// Each runs a COPY of the tool, so its "site root" is a temp directory: a broken guard writes there,
// never over this checkout's training-odds.html.
// ---------------------------------------------------------------------------

function toolCopy() {
  const site = tmp();
  cpSync(TOOL, join(site, '_tools', 'training-odds'), { recursive: true });
  return { site, build: join(site, '_tools', 'training-odds', 'build.mjs'), check: join(site, '_tools', 'training-odds', 'check.mjs') };
}

test('--input without --root refuses and writes nothing to the site root', () => {
  const c = toolCopy();
  const r = run(c.build, ['--input', DEV_FIXTURE]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--input and --dev build only into --root/);
  assert.equal(existsSync(join(c.site, CONFIG.pageFile)), false);
});

test('--dev without --root refuses before reading anything', () => {
  const c = toolCopy();
  const r = run(c.build, ['--dev']);
  assert.equal(r.code, 1);
  assert.match(r.err, /--input and --dev build only into --root/);
  assert.equal(existsSync(join(c.site, CONFIG.pageFile)), false);
});

test('the shipped config never names the dev host, and an unset databaseHost refuses without touching the network', () => {
  // Staging during the beta, production from launch (owner, 2026-11-03); never dev's odds on starthrown.com.
  assert.equal(typeof CONFIG.databaseHost, 'string');
  assert.doesNotMatch(CONFIG.databaseHost, /ai-wars-dev/);
  assert.notEqual(CONFIG.databaseHost, CONFIG.devDatabaseHost);
  assert.match(CONFIG.devDatabaseHost, /^ai-wars-dev-/);
  const c = toolCopy();
  const cfgPath = join(c.site, '_tools', 'training-odds', 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ ...CONFIG, databaseHost: null }), 'utf8');
  for (const script of [c.build, c.check]) {
    const r = run(script, []);
    assert.equal(r.code, 1);
    assert.match(r.err, /databaseHost is not set/);
  }
  assert.equal(existsSync(join(c.site, CONFIG.pageFile)), false);
});

test('--save-document saves exactly the document the pages were built from', () => {
  const root = tmp();
  const saved = join(tmp(), 'saved.json');
  const r = run(BUILD, ['--input', DEV_FIXTURE, '--root', root, '--save-document', saved]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(readFileSync(saved, 'utf8')), devDoc());
  assert.equal(run(CHECK, ['--input', saved, '--root', root]).code, 0);
});

test('a galaxy holding only BL-558\'s reserved upcoming child is skipped, not a failed build', () => {
  const doc = stripMeta(devDoc());
  doc.galaxy_000 = { upcoming: { roundId: '001', note: 'SYNTHETIC reserved for BL-558' } };
  const f = writeDoc(doc);
  const b = build(f);
  assert.equal(b.code, 0, b.err);
  assert.match(b.err, /galaxy_000: only the reserved "upcoming" child/);
  assert.deepEqual(sections(b.page()).map((s) => s.id), ['galaxy_001', 'galaxy_002']);
  assert.equal(run(CHECK, ['--input', f, '--root', b.root]).code, 0);
});

// ---------------------------------------------------------------------------
// BL-558: odds change notice (publicTrainingOdds/{g}.upcoming; spec W-4d, N-1, N-6, N-8)
// fixtures/synthetic-upcoming.json: galaxy_001 mid-round change with a reason, galaxy_002 the
// approved mockup example (frames B1/B2/C2), galaxy_003 added / removed / Level Cap / late open.
// ---------------------------------------------------------------------------

const upDoc = () => JSON.parse(readFileSync(UPCOMING_FIXTURE, 'utf8'));
const visible = (html) => html.replace(/<span class="arrow" aria-hidden="true">→<\/span>/g, '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const noticeOf = (body) => {
  const m = /<section class="upcoming"[\s\S]*?<\/section><!-- \/upcoming -->/.exec(body);
  return m ? m[0] : null;
};

test('no upcoming: no notice markup or styles, and upcoming:null builds the same bytes (switch off)', () => {
  const plain = build(DEV_FIXTURE);
  const doc = stripMeta(devDoc());
  for (const g of Object.values(doc)) g.upcoming = null;
  const nulled = build(writeDoc(doc));
  for (const loc of CONFIG.locales) {
    const html = plain.page(loc);
    assert.equal(nulled.page(loc), html, loc);
    assert.doesNotMatch(html, /upcoming|is-changed|change-list|data-urow/, loc);
  }
});

test('scheduled (mockup B1/B2): Round 1 stays in force, pointer first, Round 2 block with was-values', () => {
  const b = build(UPCOMING_FIXTURE);
  assert.equal(b.code, 0, b.err);
  const html = b.page();
  const g2 = sections(html).find((s) => s.id === 'galaxy_002');
  const main = g2.body.replace(noticeOf(g2.body), '');
  // The table in force is Round 1's (the previous side), with no status for the next round.
  assert.match(main, /data-k="round">1</);
  assert.doesNotMatch(main, /data-k="status"/);
  assert.match(main, /datetime="2026-09-24T20:00:30\.763Z"/);
  assert.match(main, /data-k="captain">Graves<\/td><td class="col-num" data-k="cap">50<\/td><td class="col-pct" data-k="pct">0\.2%/);
  // The pointer comes before the first table and links to the block (works without script).
  assert.ok(main.indexOf('upcoming-pointer') < main.indexOf('<table'), 'pointer before the tables');
  assert.match(visible(main), /Odds change on January 1, 2027\. Round 2 changes 3 outcomes\. See the upcoming odds ↓/);
  assert.match(main, /href="#galaxy_002-upcoming"/);
  const block = noticeOf(g2.body);
  assert.match(block, /id="galaxy_002-upcoming" data-kind="scheduled"/);
  const text = visible(block);
  assert.match(text, /From January 1, 2027: Round 2 odds/);
  assert.match(text, /Takes effect when Round 2 starts, January 1, 2027 at 20:00 UTC\./);
  assert.match(text, /100 Experience18\.0% changes to 17\.6%/);
  assert.match(text, /Quell0\.5% changes to 0\.7%/);
  assert.match(text, /Graves0\.2% changes to 0\.4%/);
  assert.match(text, /Every other outcome and every Level Cap stays the same\./);
  // The full next table: changed rows highlighted with "was", unchanged rows plain.
  assert.equal([...block.matchAll(/data-urow="[xc]\d+"/g)].length, 25);
  assert.equal([...block.matchAll(/class="is-changed"/g)].length, 3);
  assert.match(block, /data-k="captain">Graves<\/td><td class="col-num" data-k="cap">50<\/td><td class="col-pct"><strong data-k="pct">0\.4%<\/strong><span class="was">was <span data-k="was">0\.2%<\/span>/);
  assert.match(block, /data-k="captain">Teklan<\/td><td class="col-num" data-k="cap">12<\/td><td class="col-pct" data-k="pct">3\.2%<\/td>/);
  assert.match(block, /data-urow="exp-total"><td>Experience combined<\/td><td class="col-pct"><strong data-k="pct">61\.5%<\/strong><span class="was">was <span data-k="was">61\.9%/);
  assert.match(block, /data-urow="cap-total"><td colspan="2">Captains combined<\/td><td class="col-pct"><strong data-k="pct">38\.5%<\/strong>/);
});

test('scheduled: added, removed and Level Cap changes; the table in force keeps its own order', () => {
  const html = build(UPCOMING_FIXTURE).page();
  const g3 = sections(html).find((s) => s.id === 'galaxy_003');
  const block = noticeOf(g3.body);
  const main = g3.body.replace(block, '');
  // In force (Round 4): Lirra and Teklan tie at 25.0%, so name order, as the publisher sorts a table.
  assert.deepEqual([...main.matchAll(/data-k="captain">(\w+)</g)].map((m) => m[1]), ['Lirra', 'Teklan']);
  assert.match(main, /data-k="amount">100</, 'the removed outcome is still in force');
  const text = visible(block);
  assert.match(text, /Takes effect on January 2, 2027 at 09:30 UTC\./, 'opens after the announced start: no "when Round 5 starts"');
  assert.match(text, /100 Experience20\.0% changes to removed/);
  assert.match(text, /150 Experiencenew changes to 20\.0%/);
  assert.match(text, /Vekknew changes to 15\.0%/);
  assert.match(text, /TeklanLevel Cap12 changes to 14/);
  assert.match(text, /Every other outcome and Level Cap stays the same\./);
  // Next table: the removed outcome is gone, the added ones say "new outcome", Teklan's cap says "was 12".
  assert.doesNotMatch(block, /data-urow="x002"/);
  assert.match(block, /data-urow="x003" class="is-changed"><td><span data-k="amount">150<\/span> Experience<\/td><td class="col-pct"><strong data-k="pct">20\.0%<\/strong><span class="was" data-k="isnew">new outcome<\/span>/);
  assert.match(block, /data-urow="c001" class="is-changed"><td data-k="captain">Teklan<\/td><td class="col-num"><strong data-k="cap">14<\/strong><span class="was">was <span data-k="capwas">12<\/span><\/span><\/td><td class="col-pct" data-k="pct">25\.0%<\/td>/);
  // A group total that does not move has no "was".
  assert.match(block, /data-urow="exp-total"><td>Experience combined<\/td><td class="col-pct" data-k="pct">50\.0%<\/td>/);
});

test('midRound (N-6): the change log with the reason, escaped and marked English; tables stay the entry\'s', () => {
  const b = build(UPCOMING_FIXTURE);
  const g1 = sections(b.page()).find((s) => s.id === 'galaxy_001');
  const block = noticeOf(g1.body);
  const main = g1.body.replace(block, '');
  assert.match(main, /data-k="status">Active</);
  assert.match(main, /data-k="captain">Graves<\/td><td class="col-num" data-k="cap">50<\/td><td class="col-pct" data-k="pct">0\.3%/);
  assert.match(visible(main), /Odds changed on October 20, 2026\. 2 outcomes changed\. See what changed ↓/);
  assert.match(block, /id="galaxy_001-changes" data-kind="midRound"/);
  assert.match(visible(block), /Odds changed on October 20, 2026 In effect since October 20, 2026 at 14:02 UTC\./);
  assert.match(block, /<span data-k="reason" lang="en">Corrected a data-entry error: Graves &amp; Teklan odds were swapped &lt;by 0\.1%&gt;\.<\/span>/);
  assert.match(visible(block), /Teklan3\.2% changes to 3\.1%/);
  assert.doesNotMatch(block, /data-urow=/, 'no second table: the tables above are already the new ones');
  // Korean page: localized labels, the reason verbatim.
  const ko = noticeOf(sections(b.page('ko')).find((s) => s.id === 'galaxy_001').body);
  assert.match(visible(ko), /2026년 10월 20일 확률 변경/);
  assert.match(visible(ko), /사유: Corrected a data-entry error/);
});

test('deep link #galaxy_002-upcoming opens Andromeda', () => {
  const r = runPickerScript(build(UPCOMING_FIXTURE).page(), '#galaxy_002-upcoming');
  assert.deepEqual(r.visible, ['galaxy_002']);
});

test('with notices: every locale builds, no {placeholder} leaks, output is deterministic', () => {
  const a = build(UPCOMING_FIXTURE);
  const doc = upDoc();
  const reordered = Object.fromEntries(Object.entries(doc).reverse().map(([k, v]) => {
    const copy = Object.fromEntries(Object.entries(v).reverse());
    copy.upcoming = Object.fromEntries(Object.entries(copy.upcoming).reverse());
    copy.publishedAt = 9999999999999;
    return [k, copy];
  }));
  const b = build(writeDoc(reordered));
  for (const loc of CONFIG.locales) {
    const html = a.page(loc);
    assert.equal(b.page(loc), html, `locale ${loc}`);
    assert.doesNotMatch(html.replace(/<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>/g, ''), /\{\w+\}/, loc);
    assert.equal([...html.matchAll(/<!-- \/upcoming -->/g)].length, 3, loc);
  }
});

test('an effective date still ahead reads "take effect on", not "in effect since"', () => {
  const root = tmp();
  const r = run(BUILD, ['--input', DEV_FIXTURE, '--root', root, '--now', '0']);
  assert.equal(r.code, 0, r.err);
  const html = readFileSync(join(root, CONFIG.pageFile), 'utf8');
  assert.match(html, /<dt>Odds take effect on<\/dt>/);
  assert.doesNotMatch(build(DEV_FIXTURE).page(), /take effect on/);
});

test('a malformed upcoming writes nothing: unknown schemaVersion, a new side unlike the table, a wrong count', () => {
  const cases = {
    schema: (d) => { d.galaxy_002.upcoming.schemaVersion = 2; },
    table: (d) => { d.galaxy_002.upcoming.rows.c019.new.percent = '0.5%'; },
    count: (d) => { d.galaxy_002.upcoming.changeCount = 4; },
    round: (d) => { d.galaxy_002.upcoming.roundId = '009'; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const doc = upDoc();
    mutate(doc);
    const b = build(writeDoc(doc));
    assert.equal(b.code, 1, name);
    assert.equal(existsSync(join(b.root, CONFIG.pageFile)), false, name);
  }
});

test('check.mjs passes a clean notice build and fails a wrong "was", a missing block, or an extra one', () => {
  const b = build(UPCOMING_FIXTURE);
  assert.equal(run(CHECK, ['--input', UPCOMING_FIXTURE, '--root', b.root]).code, 0);

  const file = join(b.root, 'ja', CONFIG.pageFile);
  const html = readFileSync(file, 'utf8');
  writeFileSync(file, html.replace('data-k="was">0.2%<', 'data-k="was">0.3%<'), 'utf8');
  let r = run(CHECK, ['--input', UPCOMING_FIXTURE, '--root', b.root]);
  assert.equal(r.code, 1);
  assert.match(r.err, /galaxy_002 upcoming c\d+\.was is "0\.3%", document says "0\.2%"/);

  writeFileSync(file, html.replace(noticeOf(sections(html).find((s) => s.id === 'galaxy_003').body), ''), 'utf8');
  r = run(CHECK, ['--input', UPCOMING_FIXTURE, '--root', b.root]);
  assert.equal(r.code, 1);
  assert.match(r.err, /galaxy_003 has no odds change block/);

  // A page still showing a notice after the window closed (the document dropped `upcoming`).
  const doc = upDoc();
  delete doc.galaxy_001.upcoming;
  writeFileSync(file, html, 'utf8');
  r = run(CHECK, ['--input', writeDoc(doc), '--root', b.root]);
  assert.equal(r.code, 1);
  assert.match(r.err, /galaxy_001 shows an odds change block the document does not have/);
});

test('check.mjs passes a hand-set reason with a newline and a double space, and the page escapes it', () => {
  // The page text is whitespace-collapsed when read back; the document's reason is only trimmed.
  const doc = upDoc();
  doc.galaxy_001.upcoming.reason = 'Graves & Teklan\nwere  swapped <b>';
  const f = writeDoc(doc);
  const b = build(f);
  assert.equal(b.code, 0, b.err);
  const r = run(CHECK, ['--input', f, '--root', b.root]);
  assert.equal(r.code, 0, r.err);
  assert.match(b.page(), /<span data-k="reason" lang="en">Graves &amp; Teklan\nwere  swapped &lt;b&gt;<\/span>/);
});
// Cross-seam (Bender, BL-558): fixtures/synthetic-publisher-bl558.json is the publicTrainingOdds
// document the REAL functions publisher (trainingOddsPublisher + trainingOddsNotice, switch ON)
// emitted for four synthetic galaxies: a scheduled change with an added, a removed and a Level Cap
// change (seam_a), an N-6 mid-round change with a hand-set reason (seam_b), an unchanged next round
// (seam_c), and a change whose open instant is pushed past the start by the 24 h floor (seam_d).
// Defect caught: the generator's strict upcoming validation rejecting what the publisher really
// writes, which fails the hourly site build for as long as a notice is up. Regenerate from
// Admin Portal/functions when either side's contract changes.
const PUBLISHER_FIXTURE = join(TOOL, 'fixtures', 'synthetic-publisher-bl558.json');
const PUBLISHER_NOW = '1794420001000';

test('a document emitted by the real BL-558 publisher builds, passes check.mjs, and words the floor case', () => {
  const root = tmp();
  const r = run(BUILD, ['--input', PUBLISHER_FIXTURE, '--root', root, '--now', PUBLISHER_NOW]);
  assert.equal(r.code, 0, r.err);
  assert.equal(run(CHECK, ['--input', PUBLISHER_FIXTURE, '--root', root]).code, 0);
  const html = readFileSync(join(root, CONFIG.pageFile), 'utf8');
  const kinds = Object.fromEntries(sections(html).map((s) => [s.id, (/data-kind="(\w+)"/.exec(s.body) || [])[1] || null]));
  assert.deepEqual(kinds, { galaxy_seam_a: 'scheduled', galaxy_seam_b: 'midRound', galaxy_seam_c: null, galaxy_seam_d: 'scheduled' });
  const text = (id) => visible(noticeOf(sections(html).find((s) => s.id === id).body));
  assert.match(text('galaxy_seam_a'), /Takes effect when Round 2 starts/);
  assert.match(text('galaxy_seam_d'), /Takes effect on /, 'opensAt is 24 h after the lock, later than the start');
  assert.doesNotMatch(text('galaxy_seam_d'), /when Round 2 starts/);
  assert.match(html, /<span data-k="reason" lang="en">Fixed a typo &lt;b&gt;&amp; more&lt;\/b&gt;<\/span>/);
});
