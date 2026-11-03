#!/usr/bin/env node
// BL-557 daily check: does every published odds page still say exactly what the document says?
//
//   node _tools/training-odds/check.mjs                  compare the pages in this checkout with the production document
//   node _tools/training-odds/check.mjs --deployed       compare the pages served at config.siteUrl instead
//   node _tools/training-odds/check.mjs --input f.json   compare against a local copy of the document
//   node _tools/training-odds/check.mjs --dev            compare against the dev database's document
//   node _tools/training-odds/check.mjs --root <dir>     read the pages under <dir>
//
// Exits 1 on any value mismatch, missing galaxy, extra galaxy, missing page, or a galaxy the
// document marks invalid (so the owner keeps hearing about it). Exits 0 when every page matches.
//
// This file deliberately does NOT import build.mjs. It reads the page text and compares it with
// the document's own strings (percent, amountText, levelCapText, ...), so a renderer bug that
// prints the wrong field is caught here instead of being reproduced. publishedAt is never compared.
//
// BL-558: a galaxy whose entry carries `upcoming` also has a pointer and an odds change block. Both
// are compared value by value against the document: every changed outcome before -> after, the open
// instant, the reason, and (kind "scheduled") the whole next table with its "was" values. A page
// that shows a block the document does not have, or misses one it has, fails the check.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SITE_ROOT, loadConfig, parseArgs, loadDocument, normalizeDocument, loadLocales,
  pagePath, pageFile, statusText,
} from './lib.mjs';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

function text(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function first(re, s) {
  const m = re.exec(s);
  return m ? m : null;
}

// data-k cells inside one element, by name. A name that appears twice is reported, not overwritten.
function cellsOf(html, errors, where) {
  const cells = {};
  for (const c of html.matchAll(/data-k="(\w+)"[^>]*>([\s\S]*?)<\/(?:td|span|strong)>/g)) {
    if (c[1] in cells) errors.push(`${where}: ${c[1]} appears twice`);
    cells[c[1]] = text(c[2]);
  }
  return cells;
}

// BL-558: the odds change block, cut out of the galaxy section by its end marker.
function parseNotice(id, kind, html, errors, gid) {
  const n = { id, kind, changes: [], rows: new Map() };
  const date = first(/<time data-k="udate" datetime="([^"]*)"/, html);
  const when = first(/<time data-k="uwhen" datetime="([^"]*)"[^>]*>([\s\S]*?)<\/time>/, html);
  const reason = first(/data-k="reason"[^>]*>([\s\S]*?)<\/span>/, html);
  const dup = first(/data-k="udupxp"[^>]*>([\s\S]*?)<\/span>/, html);
  n.date = date ? date[1] : null;
  n.when = when ? when[1] : null;
  n.whenText = when ? text(when[2]) : null;
  n.reason = reason ? text(reason[1]) : null;
  n.dupxp = dup ? text(dup[1]) : null;
  for (const m of html.matchAll(/<li data-change="([^"]*)">([\s\S]*?)<\/li>/g)) {
    n.changes.push({ key: m[1], cells: cellsOf(m[2], errors, `${gid} change ${m[1]}`) });
  }
  for (const r of html.matchAll(/<tr[^>]*\bdata-urow="([^"]*)"([^>]*)>([\s\S]*?)<\/tr>/g)) {
    if (n.rows.has(r[1])) errors.push(`${gid}: upcoming row ${r[1]} appears twice`);
    n.rows.set(r[1], { highlighted: /\bclass="is-changed"/.test(r[2]), cells: cellsOf(r[3], errors, `${gid} upcoming row ${r[1]}`) });
  }
  return n;
}

// Pulls the facts the check compares out of one built page. Every value is the visible text of
// an element the generator marks with data-k, so an edited figure is read back as edited.
function parsePage(html) {
  const page = { lang: null, galaxies: [], options: [], jumps: [], errors: [] };
  const lang = first(/<html[^>]*\blang="([^"]+)"/, html);
  page.lang = lang ? lang[1] : null;

  const sel = first(/<select[^>]*id="galaxy-select"[^>]*>([\s\S]*?)<\/select>/, html);
  if (!sel) page.errors.push('no galaxy dropdown (#galaxy-select)');
  else for (const m of sel[1].matchAll(/<option value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)) page.options.push({ id: text(m[1]), name: text(m[2]) });

  const jump = first(/<nav[^>]*id="galaxy-jump"[^>]*>([\s\S]*?)<\/nav>/, html);
  if (!jump) page.errors.push('no jump list (#galaxy-jump)');
  else for (const m of jump[1].matchAll(/<a href="#([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) page.jumps.push({ id: text(m[1]), name: text(m[2]) });

  const start = html.indexOf('<div id="galaxy-views">');
  const end = html.indexOf('<!-- /galaxy-views -->');
  if (start < 0 || end < start) {
    page.errors.push('no galaxy list (#galaxy-views)');
    return page;
  }
  const views = html.slice(start, end);
  const heads = [...views.matchAll(/<section class="galaxy" id="([^"]*)"[^>]*>/g)];
  heads.forEach((h, i) => {
    let body = views.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : views.length);
    const g = { id: text(h[1]), rows: new Map(), notice: null, pointer: null };
    const nb = first(/<section class="upcoming" id="([^"]*)" data-kind="([^"]*)"[^>]*>([\s\S]*?)<\/section><!-- \/upcoming -->/, body);
    if (nb) {
      g.notice = parseNotice(text(nb[1]), nb[2], nb[3], page.errors, g.id);
      body = body.replace(nb[0], '');
    }
    const ptr = first(/<a class="upcoming-pointer"[^>]*href="#([^"]*)"[^>]*>([\s\S]*?)<\/a>/, body);
    if (ptr) {
      const pd = first(/<time data-k="pdate" datetime="([^"]*)"/, ptr[2]);
      const pc = first(/data-k="pcount"[^>]*>([\s\S]*?)<\/span>/, ptr[2]);
      g.pointer = { href: text(ptr[1]), date: pd ? pd[1] : null, count: pc ? text(pc[1]) : null };
    }
    const name = first(/data-k="name"[^>]*>([\s\S]*?)<\/span>/, body);
    const round = first(/data-k="round"[^>]*>([\s\S]*?)<\/span>/, body);
    const status = first(/data-k="status"[^>]*>([\s\S]*?)<\/dd>/, body);
    const eff = first(/<time data-k="effective" datetime="([^"]*)"[^>]*>([\s\S]*?)<\/time>/, body);
    const dup = first(/data-k="dupxp"[^>]*>([\s\S]*?)<\/span>/, body);
    g.name = name ? text(name[1]) : null;
    g.round = round ? text(round[1]) : null;
    g.status = status ? text(status[1]) : null;
    g.effectiveIso = eff ? eff[1] : null;
    g.effectiveText = eff ? text(eff[2]) : null;
    g.dupxp = dup ? text(dup[1]) : null;
    g.unavailable = /data-k="unavailable"/.test(body);
    for (const r of body.matchAll(/<tr[^>]*\bdata-row="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = {};
      for (const c of r[2].matchAll(/data-k="(\w+)"[^>]*>([\s\S]*?)<\/(?:td|span)>/g)) cells[c[1]] = text(c[2]);
      if (g.rows.has(r[1])) page.errors.push(`${g.id}: row ${r[1]} appears twice`);
      g.rows.set(r[1], cells);
    }
    page.galaxies.push(g);
  });
  return page;
}

function compare(where, page, galaxies, t, locale) {
  const problems = [...page.errors.map(e => `${where}: ${e}`)];
  const p = msg => problems.push(`${where}: ${msg}`);
  const eq = (label, actual, expected) => { if (actual !== expected) p(`${label} is ${JSON.stringify(actual)}, document says ${JSON.stringify(expected)}`); };

  if (page.lang !== locale) p(`<html lang> is ${JSON.stringify(page.lang)}, expected ${JSON.stringify(locale)}`);

  const want = galaxies.map(g => g.id);
  const have = page.galaxies.map(g => g.id);
  for (const id of want) if (!have.includes(id)) p(`MISSING galaxy ${id}`);
  for (const id of have) if (!want.includes(id)) p(`EXTRA galaxy ${id} (not in the document)`);
  if (want.join() !== have.join() && want.every(id => have.includes(id)) && have.every(id => want.includes(id))) {
    p(`galaxies out of order: ${have.join(', ')} (expected ${want.join(', ')})`);
  }
  eq('dropdown', page.options.map(o => `${o.id}=${o.name}`).join(' | '), galaxies.map(g => `${g.id}=${g.name}`).join(' | '));
  eq('jump list', page.jumps.map(o => `${o.id}=${o.name}`).join(' | '), galaxies.map(g => `${g.id}=${g.name}`).join(' | '));

  for (const g of galaxies) {
    const pg = page.galaxies.find(x => x.id === g.id);
    if (!pg) continue;
    const at = s => `${g.id} ${s}`;
    // The table in force: the entry's own, or (BL-558 kind "scheduled") the previous round's.
    const v = g.inForce;
    eq(at('name'), pg.name, g.name);
    eq(at('round'), pg.round, v.roundLabel);
    eq(at('status'), pg.status, v.status === undefined ? null : statusText(t, v.status));
    if (v.effectiveFromMs === undefined) {
      if (pg.effectiveIso !== null) p(`${g.id} shows an effective date ${pg.effectiveIso} the document does not have`);
    } else {
      eq(at('effective date'), pg.effectiveIso, new Date(v.effectiveFromMs).toISOString());
      if (!pg.effectiveText) p(`${g.id} effective date has no visible text`);
    }

    const rowsWanted = new Map();
    if (g.valid) {
      for (const r of v.experience) rowsWanted.set(r.key, { amount: r.amountText, pct: r.percent });
      if (v.experience.length) rowsWanted.set('exp-total', { pct: v.experienceTotalPercent });
      for (const r of v.captains) rowsWanted.set(r.key, { captain: r.captain, cap: r.levelCapText, pct: r.percent });
      if (v.captains.length) rowsWanted.set('cap-total', { pct: v.captainsTotalPercent });
      rowsWanted.set('total', { pct: '100.0%' });
      if (pg.unavailable) p(`${g.id} says "unavailable" but the document has a valid table`);
      eq(at('duplicate-captain XP'), pg.dupxp, v.captains.length && v.duplicateXpAmountText !== undefined ? v.duplicateXpAmountText : null);
    } else if (!pg.unavailable) {
      p(`${g.id} is invalid in the document (${g.invalidReason}) but the page does not say "unavailable"`);
    }
    eq(at('row order'), [...pg.rows.keys()].join(','), [...rowsWanted.keys()].join(','));
    for (const [key, cells] of rowsWanted) {
      const got = pg.rows.get(key);
      if (!got) continue;
      for (const [k, val] of Object.entries(cells)) eq(at(`${key}.${k}`), got[k] === undefined ? null : got[k], val);
    }
    compareNotice(g, pg, t, p, eq);
  }
  return problems;
}

// Exact cell comparison: every expected cell, and no cell the document does not account for.
function eqCells(label, got, want, p, eq) {
  for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
    if (!(k in want)) p(`${label}.${k} is ${JSON.stringify(got[k])}, the document has no such value`);
    else eq(`${label}.${k}`, k in got ? got[k] : null, want[k]);
  }
}

// BL-558: the pointer and the odds change block, against the document's `upcoming`.
function compareNotice(g, pg, t, p, eq) {
  const at = s => `${g.id} ${s}`;
  const u = g.upcoming;
  if (!u) {
    if (pg.pointer) p(`${g.id} shows an odds change pointer the document does not have`);
    if (pg.notice) p(`${g.id} shows an odds change block the document does not have`);
    return;
  }
  const sched = u.kind === 'scheduled';
  const iso = new Date(sched ? u.opensAtMs : u.detectedAt).toISOString();
  const id = `${g.id}-${sched ? 'upcoming' : 'changes'}`;
  if (!pg.pointer) p(`${g.id} has no odds change pointer (the document has a "${u.kind}" change)`);
  else {
    eq(at('pointer link'), pg.pointer.href, id);
    eq(at('pointer date'), pg.pointer.date, iso);
    eq(at('pointer count'), pg.pointer.count, String(u.changeCount));
  }
  const n = pg.notice;
  if (!n) {
    p(`${g.id} has no odds change block (the document has a "${u.kind}" change)`);
    return;
  }
  eq(at('notice kind'), n.kind, u.kind);
  eq(at('notice id'), n.id, id);
  eq(at('notice date'), n.date, iso);
  eq(at('notice time'), n.when, iso);
  if (!n.whenText) p(`${g.id} notice time has no visible text`);
  // text() collapses the page's whitespace; lib.mjs only trims the reason, so collapse it here too.
  eq(at('notice reason'), n.reason, !sched && u.reason !== undefined ? u.reason.replace(/\s+/g, ' ') : null);

  // What changes: every outcome that is not unchanged, and every Level Cap that moved, before -> after.
  const listed = [...u.experience, ...u.captains].filter(r => r.status !== 'unchanged' || r.levelCapChanged);
  eq(at('change list'), n.changes.map(c => c.key).join(','), listed.map(r => r.key).join(','));
  for (const r of listed) {
    const got = n.changes.find(c => c.key === r.key);
    if (!got) continue;
    const want = r.captain !== undefined ? { captain: r.captain } : { amount: (r.new || r.previous).amountText };
    if (r.status !== 'unchanged') {
      want.from = r.previous ? r.previous.percent : t['change.new'];
      want.to = r.new ? r.new.percent : t['change.removed'];
    }
    if (r.levelCapChanged) {
      want.capfrom = r.previous.levelCapText;
      want.capto = r.new.levelCapText;
    }
    eqCells(at(`change ${r.key}`), got.cells, want, p, eq);
  }

  // kind "scheduled": the full next table, from the new side, with "was" where a figure moves.
  const rowsWanted = new Map();
  if (sched) {
    const pctCells = r => {
      if (r.status === 'added') return { pct: r.new.percent, isnew: t['upcoming.newOutcome'] };
      if (r.status === 'changed' && r.previous.percent !== r.new.percent) return { pct: r.new.percent, was: r.previous.percent };
      return { pct: r.new.percent };
    };
    const totalCells = tot => (tot.previous === tot.new ? { pct: tot.new } : { pct: tot.new, was: tot.previous });
    const lit = r => r.status !== 'unchanged' || r.levelCapChanged;
    const exp = u.experience.filter(r => r.new);
    const cap = u.captains.filter(r => r.new);
    for (const r of exp) rowsWanted.set(r.key, { lit: lit(r), cells: { amount: r.new.amountText, ...pctCells(r) } });
    if (exp.length) rowsWanted.set('exp-total', { lit: false, cells: totalCells(u.totals.experience) });
    for (const r of cap) {
      const capCells = r.levelCapChanged ? { cap: r.new.levelCapText, capwas: r.previous.levelCapText } : { cap: r.new.levelCapText };
      rowsWanted.set(r.key, { lit: lit(r), cells: { captain: r.captain, ...capCells, ...pctCells(r) } });
    }
    if (cap.length) rowsWanted.set('cap-total', { lit: false, cells: totalCells(u.totals.captains) });
    rowsWanted.set('total', { lit: false, cells: { pct: '100.0%' } });
    eq(at('upcoming duplicate-captain XP'), n.dupxp, cap.length && g.duplicateXpAmountText !== undefined ? g.duplicateXpAmountText : null);
  }
  eq(at('upcoming row order'), [...n.rows.keys()].join(','), [...rowsWanted.keys()].join(','));
  for (const [key, w] of rowsWanted) {
    const got = n.rows.get(key);
    if (!got) continue;
    if (got.highlighted !== w.lit) p(`${g.id} upcoming ${key} is ${got.highlighted ? '' : 'not '}highlighted; the document says it ${w.lit ? 'changes' : 'does not change'}`);
    eqCells(at(`upcoming ${key}`), got.cells, w.cells, p, eq);
  }
}

async function readPage(cfg, root, locale, deployed) {
  if (deployed) {
    const url = `${cfg.siteUrl}${pagePath(cfg, locale)}?check=${Date.now()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) return { where: url, error: `HTTP ${res.status}` };
    return { where: url, html: await res.text() };
  }
  const file = pageFile(root, cfg, locale);
  if (!existsSync(file)) return { where: file, error: 'page file does not exist' };
  return { where: file, html: readFileSync(file, 'utf8') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const root = args.root ? resolve(String(args.root)) : SITE_ROOT;
  const locales = loadLocales(cfg);
  const { source, doc } = await loadDocument(cfg, args);
  const galaxies = normalizeDocument(doc, cfg);

  const problems = [];
  for (const g of galaxies) {
    if (!g.valid) problems.push(`document: ${g.id} is valid:false (${g.invalidReason}); players see "odds temporarily unavailable"`);
  }
  for (const { locale, t } of locales) {
    const r = await readPage(cfg, root, locale, Boolean(args.deployed));
    if (r.error) { problems.push(`${r.where}: ${r.error}`); continue; }
    problems.push(...compare(r.where, parsePage(r.html), galaxies, t, locale));
  }

  console.log(`document: ${source}`);
  console.log(`galaxies: ${galaxies.map(g => g.id).join(', ')}; locales: ${locales.map(l => l.locale).join(', ')}; pages: ${args.deployed ? 'deployed site' : root}`);
  if (problems.length) {
    for (const x of problems) console.error(`MISMATCH ${x}`);
    console.error(`${problems.length} problem(s). The odds page does not match the odds document.`);
    process.exit(1);
  }
  console.log('OK: every page matches the document.');
}

main().catch(e => {
  console.error(`ERROR ${e.message}`);
  process.exit(1);
});
