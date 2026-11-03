// Shared plumbing for build.mjs and check.mjs: config, the public odds document, i18n.
// Rendering lives in build.mjs only, and check.mjs never imports it, so the daily check
// compares the page against the document's raw values rather than against the renderer.
// No npm dependencies: Node 22 built-ins and global fetch only.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
export const SITE_ROOT = resolve(TOOL_DIR, '..', '..');

export function loadConfig() {
  return JSON.parse(readFileSync(join(TOOL_DIR, 'config.json'), 'utf8'));
}

// databaseHost is the PRODUCTION database and stays null until production serves the document:
// starthrown.com must never show another environment's odds as the disclosure. --dev reads
// devDatabaseHost instead, for previews only (build.mjs refuses --dev without --root).
export function databaseHost(cfg, args = {}) {
  const host = args.dev ? cfg.devDatabaseHost : cfg.databaseHost;
  if (typeof host !== 'string' || host === '') {
    throw new Error(args.dev
      ? 'config.json devDatabaseHost is not set.'
      : 'config.json databaseHost is not set: there is no production odds document yet, so nothing is published. '
        + 'See _tools/training-odds/README.md, "Switch to production". (Dev preview: --dev --root <dir>.)');
  }
  return host;
}

export function documentUrl(cfg, args = {}) {
  return `https://${databaseHost(cfg, args)}/${cfg.documentPath}.json`;
}

// Command-line flags: --input <file> reads a local document instead of the database,
// --dev reads the dev database, --root <dir> reads/writes pages under <dir> instead of the site root.
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

// Reads the public odds document. No credential: the node is public-read by rule.
export async function loadDocument(cfg, args) {
  if (args.input) {
    const file = resolve(String(args.input));
    return { source: file, doc: JSON.parse(readFileSync(file, 'utf8')) };
  }
  const url = documentUrl(cfg, args);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { accept: 'application/json' } });
  } catch (e) {
    throw new Error(`Could not reach ${url}: ${e.message}`);
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`GET ${url} returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  return { source: url, doc: JSON.parse(body) };
}

const GALAXY_ID = /^[A-Za-z0-9_-]+$/;
const INVALID_REASONS = new Set(['no_table', 'invalid_entry', 'sum_not_one', 'multiple_duplicate_amounts']);
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Row keys are x001.. / c001..; order by the number, not the string, so x1000 sorts after x999.
export function orderedRows(obj, prefix) {
  if (!obj) return [];
  const re = new RegExp('^' + prefix + '(\\d+)$');
  return Object.keys(obj)
    .map(k => {
      const m = re.exec(k);
      if (!m) throw new Error(`Unexpected row key "${k}" (expected ${prefix}NNN)`);
      return [Number(m[1]), k];
    })
    .sort((a, b) => a[0] - b[0] || byCodeUnit(a[1], b[1]))
    .map(([, k]) => ({ key: k, ...obj[k] }));
}

// Validates the whole document and returns galaxies sorted by galaxy id (code-unit order,
// never locale order, so the output does not depend on the machine). Throws on anything that
// would make the page wrong; the caller then writes nothing.
export function normalizeDocument(doc, cfg) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('The odds document is empty or not an object. Refusing to publish a page with no galaxies.');
  }
  // A galaxy holding only BL-558's `upcoming` child has no current odds yet (e.g. during
  // spin-up, before the publisher's first write). Skip it rather than fail every galaxy's build.
  const ids = Object.keys(doc).sort(byCodeUnit).filter(id => {
    const e = doc[id];
    const upcomingOnly = e !== null && typeof e === 'object' && !Array.isArray(e)
      && Object.keys(e).length > 0 && Object.keys(e).every(k => k === 'upcoming');
    if (upcomingOnly) console.error(`WARN publicTrainingOdds/${id}: only the reserved "upcoming" child (BL-558), no current odds yet; not shown.`);
    return !upcomingOnly;
  });
  if (ids.length === 0) throw new Error('The odds document has no galaxies. Refusing to publish a page with no galaxies.');
  const str = (v, what) => {
    if (typeof v !== 'string' || v === '') throw new Error(`${what} is missing or not a string`);
    return v;
  };
  return ids.map(id => {
    const e = doc[id];
    const where = `publicTrainingOdds/${id}`;
    if (!GALAXY_ID.test(id)) throw new Error(`${where}: galaxy id has characters outside [A-Za-z0-9_-]`);
    if (!e || typeof e !== 'object') throw new Error(`${where}: entry is not an object`);
    if (e.schemaVersion !== cfg.schemaVersion) {
      throw new Error(`${where}: schemaVersion ${JSON.stringify(e.schemaVersion)} is not the supported ${cfg.schemaVersion}. Update the generator first.`);
    }
    if (e.galaxyId !== id) throw new Error(`${where}: galaxyId ${JSON.stringify(e.galaxyId)} does not equal its key`);
    str(e.galaxyName, `${where}/galaxyName`);
    str(e.roundLabel, `${where}/roundLabel`);
    if (e.roundStatus !== undefined && e.roundStatus !== null) str(e.roundStatus, `${where}/roundStatus`);
    if (typeof e.valid !== 'boolean') throw new Error(`${where}/valid is not a boolean`);
    for (const f of ['roundStartMs', 'tableFrozenAt', 'effectiveFromMs']) {
      if (e[f] !== undefined && e[f] !== null && !Number.isSafeInteger(e[f])) throw new Error(`${where}/${f} is not an integer`);
    }
    const g = {
      id,
      name: e.galaxyName,
      roundLabel: e.roundLabel,
      status: typeof e.roundStatus === "string" ? e.roundStatus : undefined,
      effectiveFromMs: Number.isSafeInteger(e.effectiveFromMs) ? e.effectiveFromMs : undefined,
      valid: e.valid,
      invalidReason: e.invalidReason,
      experience: [],
      captains: [],
    };
    if (!e.valid) {
      if (e.upcoming !== undefined && e.upcoming !== null) throw new Error(`${where}/upcoming: present on a galaxy whose table is valid:false`);
      if (!INVALID_REASONS.has(e.invalidReason)) {
        console.error(`WARN ${where}: invalidReason ${JSON.stringify(e.invalidReason)} is not one of the known values`);
      }
      return g;
    }
    g.experience = orderedRows(e.experience, 'x').map(r => {
      const w = `${where}/experience/${r.key}`;
      return { key: r.key, amountText: str(r.amountText, `${w}/amountText`), percent: str(r.percent, `${w}/percent`) };
    });
    g.captains = orderedRows(e.captains, 'c').map(r => {
      const w = `${where}/captains/${r.key}`;
      return {
        key: r.key,
        captain: str(r.captain, `${w}/captain`),
        levelCapText: str(r.levelCapText, `${w}/levelCapText`),
        percent: str(r.percent, `${w}/percent`),
      };
    });
    if (g.experience.length === 0 && g.captains.length === 0) throw new Error(`${where}: valid but has no outcomes`);
    if (g.experience.length) g.experienceTotalPercent = str(e.experienceTotalPercent, `${where}/experienceTotalPercent`);
    if (g.captains.length) {
      g.captainsTotalPercent = str(e.captainsTotalPercent, `${where}/captainsTotalPercent`);
      // Optional: the publisher omits it rather than name one number when it cannot (spec P-8).
      if (e.duplicateXpAmountText !== undefined && e.duplicateXpAmountText !== null) {
        g.duplicateXpAmountText = str(e.duplicateXpAmountText, `${where}/duplicateXpAmountText`);
      }
    }
    if (e.upcoming !== undefined && e.upcoming !== null) {
      g.upcoming = normalizeUpcoming(e.upcoming, e, g, `${where}/upcoming`, cfg);
      if (g.upcoming.kind === 'scheduled') g.inForce = inForceFromPrevious(g.upcoming);
    }
    return g;
  }).map(g => ({ ...g, inForce: g.inForce || inForceFromEntry(g) }));
}

// ---------------------------------------------------------------------------------------------
// BL-558: the `upcoming` child (docs/firebase/publicTrainingOdds.md "/upcoming" in the game repo).
// A projection of the round's odds-change notice, present only while a change is being posted:
//   kind "scheduled"  the entry's top-level table is the NEXT round's and is not in force yet;
//                     the table in force is the `previous` side of `rows`.
//   kind "midRound"   an urgent fix (N-6): the top-level table IS in force; `rows` says what it was.
// Absent (the switch is off, or nothing changed): none of this runs and the page is BL-557's.
// ---------------------------------------------------------------------------------------------

const UPCOMING_KINDS = new Set(['scheduled', 'midRound']);
const ROW_STATUSES = new Set(['unchanged', 'changed', 'added', 'removed']);
const PLAIN_DEC = /^\d+(\.\d+)?$/;

// Exact comparison of two non-negative plain decimal strings ("0.032" vs "0.1"). Ordering only:
// the generator still never computes an odds figure, it prints the document's strings.
export function compareDecText(a, b) {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const an = ai.replace(/^0+(?=\d)/, '');
  const bn = bi.replace(/^0+(?=\d)/, '');
  if (an.length !== bn.length) return an.length < bn.length ? -1 : 1;
  if (an !== bn) return an < bn ? -1 : 1;
  const n = Math.max(af.length, bf.length);
  const ap = af.padEnd(n, '0');
  const bp = bf.padEnd(n, '0');
  return ap < bp ? -1 : ap > bp ? 1 : 0;
}

// .NET OrdinalIgnoreCase, as the publisher's compareCaptains uses it.
function upperOrdinal(s) {
  let out = '';
  for (const ch of s.split('')) {
    const u = ch.toUpperCase();
    out += u.length === 1 ? u : ch;
  }
  return out;
}

function normalizeUpcoming(u, e, g, where, cfg) {
  if (typeof u !== 'object' || Array.isArray(u)) throw new Error(`${where} is not an object`);
  if (u.schemaVersion !== cfg.upcomingSchemaVersion) {
    throw new Error(`${where}: schemaVersion ${JSON.stringify(u.schemaVersion)} is not the supported ${cfg.upcomingSchemaVersion}. Update the generator first.`);
  }
  if (!UPCOMING_KINDS.has(u.kind)) throw new Error(`${where}/kind ${JSON.stringify(u.kind)} is not "scheduled" or "midRound"`);
  const str = (v, what) => {
    if (typeof v !== 'string' || v === '') throw new Error(`${what} is missing or not a string`);
    return v;
  };
  const ms = (v, what, required) => {
    if (v === undefined || v === null) {
      if (required) throw new Error(`${what} is missing`);
      return undefined;
    }
    if (!Number.isSafeInteger(v)) throw new Error(`${what} is not an integer`);
    return v;
  };
  const dec = (v, what) => {
    if (typeof v !== 'string' || !PLAIN_DEC.test(v)) throw new Error(`${what} is not a plain decimal string`);
    return v;
  };
  const roundId = str(u.roundId, `${where}/roundId`);
  if (roundId !== e.roundId) throw new Error(`${where}/roundId "${roundId}" is not the entry's round "${e.roundId}"`);
  const out = {
    kind: u.kind,
    roundId,
    roundLabel: str(u.roundLabel, `${where}/roundLabel`),
    announcedStartMs: ms(u.announcedStartMs, `${where}/announcedStartMs`, false),
    opensAtMs: ms(u.opensAtMs, `${where}/opensAtMs`, u.kind === 'scheduled'),
    detectedAt: ms(u.detectedAt, `${where}/detectedAt`, u.kind === 'midRound'),
    experience: [],
    captains: [],
  };
  if (u.reason !== undefined && u.reason !== null) {
    if (typeof u.reason !== 'string') throw new Error(`${where}/reason is not a string`);
    if (u.reason.trim() !== '') out.reason = u.reason.trim();
  }
  if (u.previous !== undefined && u.previous !== null) {
    const p = u.previous;
    if (typeof p !== 'object') throw new Error(`${where}/previous is not an object`);
    out.previous = {
      roundId: str(p.roundId, `${where}/previous/roundId`),
      roundLabel: str(p.roundLabel, `${where}/previous/roundLabel`),
      effectiveFromMs: ms(p.effectiveFromMs, `${where}/previous/effectiveFromMs`, false),
    };
  } else if (u.kind === 'scheduled') {
    throw new Error(`${where}/previous is missing: a scheduled change must name the table in force`);
  }
  if (!Number.isSafeInteger(u.changeCount) || u.changeCount < 1) throw new Error(`${where}/changeCount is not a positive integer`);
  out.changeCount = u.changeCount;

  const rows = u.rows;
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw new Error(`${where}/rows is missing or not an object`);
  const stray = Object.keys(rows).filter(k => !/^[xc]/.test(k));
  if (stray.length) throw new Error(`${where}/rows has unexpected key(s) ${stray.join(', ')}`);
  const pick = prefix => Object.fromEntries(Object.entries(rows).filter(([k]) => k.startsWith(prefix)));
  const side = (s, w, isCaptain) => {
    if (s === undefined || s === null) return undefined;
    if (typeof s !== 'object') throw new Error(`${w} is not an object`);
    const o = {
      amount: dec(s.amount, `${w}/amount`),
      amountText: str(s.amountText, `${w}/amountText`),
      weight: dec(s.weight, `${w}/weight`),
      percent: str(s.percent, `${w}/percent`),
    };
    if (isCaptain) o.levelCapText = str(s.levelCapText, `${w}/levelCapText`);
    return o;
  };
  const row = (r, isCaptain) => {
    const w = `${where}/rows/${r.key}`;
    if (!ROW_STATUSES.has(r.status)) throw new Error(`${w}/status ${JSON.stringify(r.status)} is not one of ${[...ROW_STATUSES].join(', ')}`);
    const o = {
      key: r.key,
      status: r.status,
      levelCapChanged: false,
      previous: side(r.previous, `${w}/previous`, isCaptain),
      new: side(r.new, `${w}/new`, isCaptain),
    };
    if (isCaptain) o.captain = str(r.captain, `${w}/captain`);
    if ((o.status === 'added') !== (o.previous === undefined)) throw new Error(`${w}: only an "added" row has no previous side`);
    if ((o.status === 'removed') !== (o.new === undefined)) throw new Error(`${w}: only a "removed" row has no new side`);
    if (r.levelCapChanged !== undefined && r.levelCapChanged !== null) {
      if (r.levelCapChanged !== true || !isCaptain || !o.previous || !o.new) throw new Error(`${w}/levelCapChanged is only true, on a Captain row with both sides`);
      o.levelCapChanged = true;
    }
    return o;
  };
  out.experience = orderedRows(pick('x'), 'x').map(r => row(r, false));
  out.captains = orderedRows(pick('c'), 'c').map(r => row(r, true));
  const counted = [...out.experience, ...out.captains].filter(r => r.status !== 'unchanged').length;
  if (counted !== out.changeCount) throw new Error(`${where}/changeCount is ${out.changeCount} but ${counted} row(s) are not "unchanged"`);

  const totals = u.totals || {};
  out.totals = {};
  for (const [grp, rs] of [['experience', out.experience], ['captains', out.captains]]) {
    if (!rs.length) continue;
    const t = totals[grp];
    if (!t || typeof t !== 'object') throw new Error(`${where}/totals/${grp} is missing`);
    out.totals[grp] = { previous: str(t.previous, `${where}/totals/${grp}/previous`), new: str(t.new, `${where}/totals/${grp}/new`) };
  }

  // The new side IS the entry's top-level table (both kinds). If the two disagree the page would
  // contradict itself, so refuse it, as every other inconsistency here is refused. Level Cap is not
  // compared: a Level Cap-only edit after the notice updates the table and not the notice (N-5).
  const newExp = out.experience.filter(r => r.new);
  const newCap = out.captains.filter(r => r.new);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const expOk = same(newExp.map(r => `${r.new.amountText}=${r.new.percent}`), g.experience.map(r => `${r.amountText}=${r.percent}`));
  const capOk = same(newCap.map(r => `${r.captain}=${r.new.percent}`), g.captains.map(r => `${r.captain}=${r.percent}`));
  if (!expOk || !capOk) throw new Error(`${where}: the new side of rows is not the entry's own table`);
  if (newExp.length && out.totals.experience.new !== g.experienceTotalPercent) throw new Error(`${where}/totals/experience/new is not the entry's experienceTotalPercent`);
  if (newCap.length && out.totals.captains.new !== g.captainsTotalPercent) throw new Error(`${where}/totals/captains/new is not the entry's captainsTotalPercent`);
  return out;
}

// The rows a change lists: every outcome that is not unchanged, and every Level Cap that moved.
export function changedRows(u) {
  return [...u.experience, ...u.captains].filter(r => r.status !== 'unchanged' || r.levelCapChanged);
}

// The duplicate-captain XP amount of one side, or undefined unless every Captain row agrees.
function sideDuplicateXp(captains, sideName) {
  const amounts = [...new Set(captains.filter(r => r[sideName]).map(r => r[sideName].amountText))];
  return amounts.length === 1 ? amounts[0] : undefined;
}

// What a galaxy's main tables show: the table in force now.
function inForceFromEntry(g) {
  return {
    roundLabel: g.roundLabel,
    status: g.status,
    effectiveFromMs: g.effectiveFromMs,
    experience: g.experience,
    captains: g.captains,
    experienceTotalPercent: g.experienceTotalPercent,
    captainsTotalPercent: g.captainsTotalPercent,
    duplicateXpAmountText: g.duplicateXpAmountText,
  };
}

// kind "scheduled": the previous side of rows, in the order the publisher gives a table of its own
// (CompareExperience: amount ascending, weight descending; CompareCaptains: weight descending, then
// name OrdinalIgnoreCase, then ordinal), so the table in force reads as it did before the notice.
// The entry's status is the next round's, so no status is shown against the previous round.
function inForceFromPrevious(u) {
  const idx = new Map([...u.experience, ...u.captains].map((r, i) => [r.key, i]));
  const cmpOrd = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const expOrder = (a, b) => compareDecText(a.previous.amount, b.previous.amount)
    || compareDecText(b.previous.weight, a.previous.weight) || idx.get(a.key) - idx.get(b.key);
  const capOrder = (a, b) => compareDecText(b.previous.weight, a.previous.weight)
    || cmpOrd(upperOrdinal(a.captain), upperOrdinal(b.captain)) || cmpOrd(a.captain, b.captain)
    || idx.get(a.key) - idx.get(b.key);
  const exp = u.experience.filter(r => r.previous).sort(expOrder);
  const cap = u.captains.filter(r => r.previous).sort(capOrder);
  return {
    roundLabel: u.previous.roundLabel,
    status: undefined,
    effectiveFromMs: u.previous.effectiveFromMs,
    experience: exp.map(r => ({ key: r.key, amountText: r.previous.amountText, percent: r.previous.percent })),
    captains: cap.map(r => ({ key: r.key, captain: r.captain, levelCapText: r.previous.levelCapText, percent: r.previous.percent })),
    experienceTotalPercent: exp.length ? u.totals.experience.previous : undefined,
    captainsTotalPercent: cap.length ? u.totals.captains.previous : undefined,
    duplicateXpAmountText: sideDuplicateXp(u.captains, 'previous'),
  };
}

// Plural category for a count: the strings files carry a ".one" and an ".other" form.
export function plural(locale, n) {
  return new Intl.PluralRules(locale).select(n) === 'one' ? 'one' : 'other';
}

// Locales that have a strings file. A locale with no file is not built and is not offered in
// the language switcher; Dora adds the file and the next run publishes that language.
// A file that lacks any key the default locale has fails the run: a half-translated legal
// disclosure is worse than a missing language.
export function loadLocales(cfg) {
  const base = JSON.parse(readFileSync(join(TOOL_DIR, 'i18n', `${cfg.defaultLocale}.json`), 'utf8'));
  const keys = Object.keys(base);
  const out = [];
  for (const locale of cfg.locales) {
    const p = join(TOOL_DIR, 'i18n', `${locale}.json`);
    if (!existsSync(p)) continue;
    const t = locale === cfg.defaultLocale ? base : JSON.parse(readFileSync(p, 'utf8'));
    const missing = keys.filter(k => typeof t[k] !== 'string' || t[k] === '');
    if (missing.length) throw new Error(`i18n/${locale}.json is missing ${missing.length} key(s): ${missing.join(', ')}`);
    for (const k of Object.keys(t)) {
      if (!(k in base)) console.error(`WARN i18n/${locale}.json has key "${k}" that ${cfg.defaultLocale}.json does not`);
    }
    out.push({ locale, t });
  }
  if (!out.length || out[0].locale !== cfg.defaultLocale) {
    throw new Error(`The default locale "${cfg.defaultLocale}" must be first in config.locales and have a strings file`);
  }
  return out;
}

// Site path of a locale's page: /training-odds.html for the default, /ko/training-odds.html otherwise.
export function pagePath(cfg, locale) {
  return locale === cfg.defaultLocale ? `/${cfg.pageFile}` : `/${locale}/${cfg.pageFile}`;
}

export function pageFile(root, cfg, locale) {
  return locale === cfg.defaultLocale ? join(root, cfg.pageFile) : join(root, locale, cfg.pageFile);
}

// The three known statuses are translated; anything else prints verbatim.
export function statusText(t, status) {
  const k = `status.${status}`;
  return typeof t[k] === 'string' ? t[k] : status;
}

// Replaces {name} placeholders. Values are inserted as given; callers pass escaped HTML.
export function fmt(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
}

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
