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

test('the shipped config names no production host, and a plain build refuses without touching the network', () => {
  assert.equal(CONFIG.databaseHost, null, 'databaseHost is set only when production serves the document');
  assert.match(CONFIG.devDatabaseHost, /^ai-wars-dev-/);
  const c = toolCopy();
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
