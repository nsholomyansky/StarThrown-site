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
    const body = views.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : views.length);
    const g = { id: text(h[1]), rows: new Map() };
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
    eq(at('name'), pg.name, g.name);
    eq(at('round'), pg.round, g.roundLabel);
    eq(at('status'), pg.status, g.status === undefined ? null : statusText(t, g.status));
    if (g.effectiveFromMs === undefined) {
      if (pg.effectiveIso !== null) p(`${g.id} shows an effective date ${pg.effectiveIso} the document does not have`);
    } else {
      eq(at('effective date'), pg.effectiveIso, new Date(g.effectiveFromMs).toISOString());
      if (!pg.effectiveText) p(`${g.id} effective date has no visible text`);
    }

    const rowsWanted = new Map();
    if (g.valid) {
      for (const r of g.experience) rowsWanted.set(r.key, { amount: r.amountText, pct: r.percent });
      if (g.experience.length) rowsWanted.set('exp-total', { pct: g.experienceTotalPercent });
      for (const r of g.captains) rowsWanted.set(r.key, { captain: r.captain, cap: r.levelCapText, pct: r.percent });
      if (g.captains.length) rowsWanted.set('cap-total', { pct: g.captainsTotalPercent });
      rowsWanted.set('total', { pct: '100.0%' });
      if (pg.unavailable) p(`${g.id} says "unavailable" but the document has a valid table`);
      eq(at('duplicate-captain XP'), pg.dupxp, g.captains.length && g.duplicateXpAmountText !== undefined ? g.duplicateXpAmountText : null);
    } else if (!pg.unavailable) {
      p(`${g.id} is invalid in the document (${g.invalidReason}) but the page does not say "unavailable"`);
    }
    eq(at('row order'), [...pg.rows.keys()].join(','), [...rowsWanted.keys()].join(','));
    for (const [key, cells] of rowsWanted) {
      const got = pg.rows.get(key);
      if (!got) continue;
      for (const [k, v] of Object.entries(cells)) eq(at(`${key}.${k}`), got[k] === undefined ? null : got[k], v);
    }
  }
  return problems;
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
