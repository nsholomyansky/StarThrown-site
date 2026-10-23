#!/usr/bin/env node
// BL-557: renders the Captain Training odds page from the public per-galaxy odds document.
//
//   node _tools/training-odds/build.mjs                  read the production document (config.json databaseHost)
//   node _tools/training-odds/build.mjs --root <dir>     write the pages under <dir> instead of the site root
//   node _tools/training-odds/build.mjs --input f.json --root <dir>   read a local copy (needs --root)
//   node _tools/training-odds/build.mjs --dev --root <dir>            read the dev database (needs --root)
//   node _tools/training-odds/build.mjs --save-document f.json        also save the document it built from
//
// A local or dev document can never be written over the site's own pages: a SYNTHETIC fixture or
// a dev table published at starthrown.com would look like the real disclosure.
//
// Writes training-odds.html (default locale) and <locale>/training-odds.html for every other
// locale that has a strings file in i18n/. Same document + same strings = byte-identical output:
// no build time, no publishedAt, galaxies in galaxy-id order, rows in key order.
//
// Exit codes: 0 pages written; 3 pages written but at least one galaxy is valid:false (its entry
// says "temporarily unavailable"; the Action fails so the owner hears about it); 1 nothing written.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SITE_ROOT, loadConfig, parseArgs, loadDocument, normalizeDocument, loadLocales,
  pagePath, pageFile, statusText, fmt, esc,
} from './lib.mjs';

const CSS = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:         #05080f;
      --bg-mid:     #080d1a;
      --accent:     #4f8fff;
      --accent-dim: #1a3a72;
      --glow:       rgba(79, 143, 255, 0.18);
      --gold:       #f0c060;
      --gold-dim:   rgba(240, 192, 96, 0.12);
      --text:       #d8e4f5;
      --text-muted: #6b84a8;
      --white:      #ffffff;
    }

    html, body { height: 100%; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: 'Space Grotesk', sans-serif;
      font-weight: 400;
      line-height: 1.7;
      overflow-x: hidden;
    }

    #starfield { position: fixed; inset: 0; z-index: 0; pointer-events: none; }

    .page {
      position: relative; z-index: 1; min-height: 100vh;
      display: flex; flex-direction: column; align-items: center;
      padding: 1.5rem 1.5rem 2.5rem;
    }
    .page::before {
      content: ''; position: fixed; top: -20vh; left: 50%; transform: translateX(-50%);
      width: 900px; height: 600px;
      background: radial-gradient(ellipse at center, rgba(40, 80, 180, 0.22) 0%, transparent 70%);
      pointer-events: none; z-index: 0;
    }
    main { position: relative; z-index: 1; max-width: 760px; width: 100%; flex: 1; padding-bottom: 3rem; }

    /* Nav */
    .nav {
      position: relative; z-index: 10; width: 100%; max-width: 900px; margin-bottom: 2rem;
      display: flex; justify-content: space-between; align-items: center;
    }
    .nav-home { display: block; line-height: 0; border-radius: 6px; }
    .nav-logo { height: 40px; width: auto; opacity: 0.85; transition: opacity 0.2s, filter 0.2s; }
    .nav-home:hover .nav-logo, .nav-home:focus-visible .nav-logo { opacity: 1; filter: drop-shadow(0 0 8px rgba(240, 192, 96, 0.45)); }
    .nav-home:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }

    /* Site menu (hamburger) */
    .site-menu { position: relative; z-index: 5; }
    .menu-toggle {
      display: flex; flex-direction: column; justify-content: center; gap: 4px;
      width: 40px; height: 40px; padding: 0 10px;
      background: rgba(8, 13, 26, 0.7); border: 1px solid rgba(240,192,96,0.35); border-radius: 8px; cursor: pointer;
    }
    .menu-toggle span { display: block; width: 100%; height: 2px; background: var(--gold); border-radius: 1px; transition: transform 0.2s, opacity 0.2s; }
    .menu-toggle[aria-expanded="true"] span:nth-child(1) { transform: translateY(6px) rotate(45deg); }
    .menu-toggle[aria-expanded="true"] span:nth-child(2) { opacity: 0; }
    .menu-toggle[aria-expanded="true"] span:nth-child(3) { transform: translateY(-6px) rotate(-45deg); }
    .menu-toggle:focus-visible, .menu-panel a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .menu-panel {
      position: absolute; top: calc(100% + 0.5rem); right: 0; min-width: 180px; padding: 0.4rem;
      background: linear-gradient(135deg, rgba(14,20,36,0.97) 0%, rgba(20,24,34,0.97) 100%);
      border: 1px solid rgba(240,192,96,0.35); border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(240,192,96,0.08); text-align: left;
    }
    .menu-panel[hidden] { display: none; }
    .menu-panel a {
      display: block; padding: 0.65rem 0.9rem;
      font-family: 'Orbitron', sans-serif; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.14em;
      text-transform: uppercase; color: var(--gold); text-decoration: none; border-radius: 8px;
    }
    .menu-panel a:hover { background: rgba(240,192,96,0.1); }

    /* Page title */
    .guide-title {
      font-family: 'Orbitron', sans-serif; font-weight: 700; font-size: clamp(1rem, 3vw, 1.4rem);
      letter-spacing: 0.1em; text-transform: uppercase; color: var(--gold); margin-bottom: 0.6rem; line-height: 1.35;
    }
    .guide-lede { font-size: 0.9rem; font-weight: 300; color: var(--text); margin-bottom: 1.25rem; }
    .divider {
      width: 60px; height: 1px; background: linear-gradient(90deg, transparent, var(--gold), transparent);
      margin: 0 0 1.75rem; opacity: 0.5;
    }

    /* Language switcher (section-pill look) */
    .lang-switch { margin: -0.5rem 0 1.25rem; }
    .lang-switch ul { list-style: none; display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .lang-switch a {
      display: inline-block; padding: 0.3rem 0.85rem; border: 1px solid rgba(240,192,96,0.25); border-radius: 999px;
      font-size: 0.75rem; color: var(--text); text-decoration: none; transition: border-color 0.2s, color 0.2s;
    }
    .lang-switch a:hover { border-color: var(--gold); color: var(--gold); }
    .lang-switch a[aria-current="page"] { border-color: var(--gold); color: var(--gold); background: var(--gold-dim); }
    .lang-switch a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* Cards */
    .guide-section {
      margin-bottom: 1rem; padding: 1.25rem 1.5rem; border-radius: 16px;
      background:
        radial-gradient(ellipse at 15% 0%, rgba(79,143,255,0.12) 0%, transparent 60%),
        linear-gradient(135deg, rgba(255,255,255,0.03) 0%, rgba(240,192,96,0.04) 100%);
      border: 1px solid rgba(79, 143, 255, 0.18);
    }
    .guide-section > :first-child { margin-top: 0; }
    .guide-body h2, .group-title {
      font-family: 'Orbitron', sans-serif; font-weight: 700; font-size: 0.8rem; letter-spacing: 0.12em;
      text-transform: uppercase; color: var(--gold); margin: 0 0 0.9rem; padding-bottom: 0.45rem;
      border-bottom: 1px solid rgba(79, 143, 255, 0.15);
    }
    .guide-body p, .guide-body li { font-size: 0.8rem; color: var(--text); }
    .guide-body p { margin-bottom: 1rem; }
    .guide-body p:last-child { margin-bottom: 0; }
    .guide-body ul { padding-left: 1.4rem; }
    .guide-body li { margin-bottom: 0.45rem; }
    .guide-body strong { color: var(--white); font-weight: 500; }
    a.inline { color: var(--accent); text-decoration: none; }
    .group-note { font-size: 0.8rem; color: var(--text); margin: 0; }
    .note-callout {
      border-left: 3px solid var(--gold); background: var(--gold-dim); padding: 0.85rem 1.2rem;
      border-radius: 0 8px 8px 0; margin: 0; font-size: 0.8rem; color: var(--text); line-height: 1.6;
    }
    .note-callout strong { color: var(--gold); font-weight: 500; }

    /* Galaxy picker (shown by script) and jump list (shown without script) */
    .galaxy-picker, .jump {
      margin: 0 0 1.5rem; padding: 1rem 1.5rem; border-radius: 16px; border: 1px solid rgba(240,192,96,0.35);
      background: radial-gradient(ellipse at top left, rgba(240,192,96,0.10), transparent 60%), rgba(8,13,26,0.6);
    }
    .galaxy-picker[hidden], .jump[hidden] { display: none; }
    .galaxy-picker label {
      display: block; font-family: 'Orbitron', sans-serif; font-size: 0.62rem; font-weight: 700;
      letter-spacing: 0.15em; text-transform: uppercase; color: var(--gold);
    }
    .galaxy-picker select {
      display: block; width: 100%; min-height: 46px; margin-top: 0.5rem; padding: 0.65rem 2.8rem 0.65rem 1rem;
      font: 500 1rem 'Space Grotesk', sans-serif; color: var(--white); -webkit-appearance: none; appearance: none;
      background:
        url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20width%3D%2714%27%20height%3D%279%27%20viewBox%3D%270%200%2014%209%27%3E%3Cpath%20d%3D%27M1%201l6%206%206-6%27%20fill%3D%27none%27%20stroke%3D%27%23f0c060%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27/%3E%3C/svg%3E") no-repeat right 1rem center / 14px 9px,
        linear-gradient(180deg, #3a4558 0%, #222a38 50%, #161c27 51%, #2a3446 100%);
      border: 1px solid rgba(120,170,255,0.55); border-radius: 6px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.25), 0 0 12px rgba(79,143,255,0.3); cursor: pointer;
    }
    .galaxy-picker select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .galaxy-picker select option { background: #161c27; color: #fff; }
    .galaxy-picker .hint { margin-top: 0.55rem; font-size: 0.75rem; color: var(--text-muted); }
    .jump p { font-size: 0.8rem; color: var(--text); margin-bottom: 0.6rem; }
    .jump ul { list-style: none; display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .jump a {
      display: inline-block; padding: 0.5rem 1rem; border: 1px solid rgba(120,170,255,0.55); border-radius: 6px;
      background: linear-gradient(180deg, #3a4558 0%, #222a38 50%, #161c27 51%, #2a3446 100%);
      color: #a9cfff; font-family: 'Orbitron', sans-serif; font-size: 0.68rem; font-weight: 700;
      letter-spacing: 0.14em; text-transform: uppercase; text-decoration: none;
    }
    .jump a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* One section per galaxy. Without script every galaxy shows, one after another. */
    .no-js .galaxy + .galaxy { margin-top: 2.75rem; padding-top: 2rem; border-top: 1px solid rgba(240,192,96,0.3); }
    .galaxy-head { margin-bottom: 1.1rem; }
    .galaxy-name {
      font-family: 'Orbitron', sans-serif; font-weight: 700; font-size: clamp(1.05rem, 3.6vw, 1.5rem);
      letter-spacing: 0.1em; text-transform: uppercase; color: var(--white); line-height: 1.3;
      text-shadow: 0 0 18px rgba(79,143,255,0.4);
    }
    .facts { display: flex; flex-wrap: wrap; gap: 0.35rem 2rem; margin-top: 0.55rem; }
    .fact dt {
      font-family: 'Orbitron', sans-serif; font-size: 0.56rem; font-weight: 700; letter-spacing: 0.15em;
      text-transform: uppercase; color: var(--text-muted); line-height: 1.6;
    }
    .fact dd { font-size: 0.9rem; font-weight: 500; color: var(--white); line-height: 1.5; }
    .unavailable strong { display: block; color: var(--gold); font-weight: 500; margin-bottom: 0.2rem; }

    /* Tables */
    .table-wrap { overflow-x: auto; margin: 1.25rem 0 0; border-radius: 10px; border: 1px solid rgba(79, 143, 255, 0.15); }
    .group-note + .table-wrap, .note-callout + .table-wrap { margin-top: 0.9rem; }
    .table-wrap.total { margin-top: 0; margin-bottom: 1rem; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
    thead tr { background: rgba(79, 143, 255, 0.12); }
    thead th {
      padding: 0.7rem 1rem; text-align: left; font-family: 'Orbitron', sans-serif; font-size: 0.62rem; font-weight: 700;
      letter-spacing: 0.15em; text-transform: uppercase; color: var(--gold); white-space: nowrap;
    }
    thead th.col-pct, thead th.col-num { text-align: right; }
    tbody tr { border-top: 1px solid rgba(255, 255, 255, 0.05); transition: background 0.15s; }
    tbody tr:hover { background: rgba(79, 143, 255, 0.06); }
    tbody td { padding: 0.6rem 1rem; color: var(--text); vertical-align: middle; }
    tbody td.col-pct, tbody td.col-num { text-align: right; font-variant-numeric: tabular-nums; color: var(--white); }
    tbody tr.row-subtotal { border-top: 1px solid rgba(79, 143, 255, 0.25); background: rgba(79, 143, 255, 0.05); }
    tbody tr.row-subtotal td, tbody tr.row-subtotal td.col-pct {
      font-weight: 500; color: var(--accent); letter-spacing: 0.04em; padding-top: 0.55rem; padding-bottom: 0.55rem;
    }
    tbody tr.row-total { border-top: 2px solid rgba(79, 143, 255, 0.35); background: rgba(79, 143, 255, 0.09); }
    tbody tr.row-total td, tbody tr.row-total td.col-pct {
      font-family: 'Orbitron', sans-serif; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.1em;
      text-transform: uppercase; color: var(--gold); padding-top: 0.65rem; padding-bottom: 0.65rem;
    }

    /* Back link */
    .back-row { margin-top: 2.5rem; text-align: center; }
    .faq-btn {
      display: inline-block; padding: 0.6rem 1.4rem;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 45%),
        linear-gradient(180deg, #3a4558 0%, #222a38 50%, #161c27 51%, #2a3446 100%);
      border: 1px solid rgba(120, 170, 255, 0.55); border-radius: 6px; color: #a9cfff;
      font-family: 'Orbitron', sans-serif; font-size: 0.68rem; font-weight: 700; letter-spacing: 0.14em;
      text-transform: uppercase; text-decoration: none;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.25), 0 0 12px rgba(79,143,255,0.3); transition: filter 0.25s, box-shadow 0.25s;
    }
    .faq-btn:hover { filter: brightness(1.15); box-shadow: inset 0 1px 0 rgba(255,255,255,0.3), 0 0 22px rgba(79,143,255,0.5); }
    .faq-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* Footer */
    footer { position: relative; z-index: 1; text-align: center; padding: 1.5rem; border-top: 1px solid rgba(255, 255, 255, 0.05); width: 100%; }
    .studio-credit { font-family: 'Orbitron', sans-serif; font-size: 0.75rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-muted); }
    .studio-link { color: rgba(255, 255, 255, 0.3); text-decoration: none; transition: color 0.2s; }
    .studio-link:hover { color: rgba(255, 255, 255, 0.6); }
    .footer-links {
      display: flex; flex-wrap: wrap; justify-content: center; gap: 0.25rem 1.25rem;
      font-size: 0.75rem; letter-spacing: 0.05em; margin: 0.45rem 0 0.35rem;
    }

    @media (max-width: 480px) {
      .page { padding: 1.5rem 1.25rem 2.5rem; }
      main { padding-top: 2rem; }
      .guide-section { padding: 1.1rem 1.1rem; }
      .galaxy-picker, .jump { padding: 0.9rem 1.1rem; }
      table { font-size: 0.75rem; }
      thead th { white-space: normal; letter-spacing: 0.08em; }
      thead th, tbody td { padding-left: 0.5rem; padding-right: 0.5rem; }
      .footer-links { gap: 0 1rem; }
      .footer-links a { padding: 0.4rem 0; }
    }
    @media (max-width: 400px) {
      thead th, tbody td { padding-left: 0.4rem; padding-right: 0.4rem; }
    }
    @media (prefers-reduced-motion: reduce) {
      .menu-toggle span, tbody tr, .faq-btn, .lang-switch a { transition: none; }
    }
`;

const SCRIPTS = `
  <script>
    // Galaxy picker. Every galaxy is in the HTML; this only shows one and hides the rest.
    // Without script nothing is hidden and the jump list stands in for the dropdown.
    (function () {
      var root = document.documentElement;
      var picker = document.getElementById('galaxy-select');
      var wrap = document.getElementById('galaxy-picker');
      var jump = document.getElementById('galaxy-jump');
      var views = document.getElementById('galaxy-views');
      if (!picker || !views) return;
      var sections = Array.prototype.filter.call(views.children, function (el) { return el.classList.contains('galaxy'); });
      if (!sections.length) return;
      root.classList.remove('no-js');
      root.classList.add('js');
      wrap.hidden = false;
      jump.hidden = true;
      function idFromHash(hash) {
        if (!hash || hash.length < 2) return null;
        var id;
        try { id = decodeURIComponent(hash.slice(1)); } catch (e) { return null; }
        var target = document.getElementById(id);
        if (!target || !target.closest) return null;
        var g = target.closest('.galaxy');
        return g && g.parentNode === views ? g.id : null;
      }
      function show(id) {
        sections.forEach(function (s) {
          if (s.id === id) s.removeAttribute('hidden');
          else s.setAttribute('hidden', 'until-found');
        });
        picker.value = id;
      }
      picker.addEventListener('change', function () {
        show(picker.value);
        if (window.history && history.replaceState) history.replaceState(null, '', '#' + encodeURIComponent(picker.value));
      });
      // Find-in-page can reveal a hidden galaxy (hidden="until-found"); keep the dropdown in step.
      sections.forEach(function (s) { s.addEventListener('beforematch', function () { show(s.id); }); });
      window.addEventListener('hashchange', function () { var id = idFromHash(location.hash); if (id) show(id); });
      show(idFromHash(location.hash) || sections[0].id);
    }());

    // Language links keep the selected galaxy.
    (function () {
      var links = document.querySelectorAll('.lang-switch a');
      Array.prototype.forEach.call(links, function (a) {
        a.addEventListener('click', function () {
          if (location.hash) a.setAttribute('href', a.getAttribute('href').split('#')[0] + location.hash);
        });
      });
    }());
  </script>

  <script>
    // Procedural starfield
    (function () {
      const canvas = document.getElementById('starfield');
      const ctx = canvas.getContext('2d');
      let stars = [];
      const STAR_COUNT = 260;
      function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
      function seed() {
        stars = [];
        for (let i = 0; i < STAR_COUNT; i++) {
          stars.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            r: Math.random() * 1.2 + 0.2,
            alpha: Math.random() * 0.6 + 0.15,
            twinkle: Math.random() * Math.PI * 2,
            twinkleSpeed: 0.008 + Math.random() * 0.012,
          });
        }
      }
      function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        stars.forEach(s => {
          s.twinkle += s.twinkleSpeed;
          const a = s.alpha * (0.6 + 0.4 * Math.sin(s.twinkle));
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(200, 220, 255, ' + a + ')';
          ctx.fill();
        });
        requestAnimationFrame(draw);
      }
      resize(); seed(); requestAnimationFrame(draw);
      let resizeTimer;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { resize(); seed(); }, 150);
      });
    }());
  </script>

  <script>
    // Site menu
    (function () {
      const btn = document.querySelector('.menu-toggle');
      const panel = document.getElementById('menu-panel');
      function setOpen(open) { btn.setAttribute('aria-expanded', String(open)); panel.hidden = !open; }
      btn.addEventListener('click', () => setOpen(panel.hidden));
      document.addEventListener('click', (e) => { if (!panel.hidden && !e.target.closest('.site-menu')) setOpen(false); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { setOpen(false); btn.focus(); } });
    }());
  </script>
`;

function renderGalaxy(g, t, dateFmt) {
  const heading = fmt(esc(t['galaxy.heading']), { name: `<span data-k="name">${esc(g.name)}</span>` });
  const headingPlain = esc(fmt(t['galaxy.heading'], { name: g.name }));
  const roundPlain = esc(g.roundLabel);
  const ctx = { galaxy: headingPlain, round: roundPlain };
  const out = [];
  out.push(`      <section class="galaxy" id="${esc(g.id)}" aria-label="${fmt(esc(t['galaxy.ariaLabel']), ctx)}">`);
  out.push(`        <header class="galaxy-head">`);
  out.push(`          <h2 class="galaxy-name">${heading}</h2>`);
  out.push(`          <dl class="facts">`);
  out.push(`            <div class="fact"><dt>${esc(t['facts.round'])}</dt><dd>${fmt(esc(t['facts.roundValue']), { round: `<span data-k="round">${roundPlain}</span>` })}</dd></div>`);
  if (g.status !== undefined) {
    out.push(`            <div class="fact"><dt>${esc(t['facts.status'])}</dt><dd data-k="status">${esc(statusText(t, g.status))}</dd></div>`);
  }
  if (g.effectiveFromMs !== undefined) {
    const iso = new Date(g.effectiveFromMs).toISOString();
    out.push(`            <div class="fact"><dt>${esc(t['facts.effective'])}</dt><dd><time data-k="effective" datetime="${iso}">${esc(dateFmt.format(g.effectiveFromMs))}</time></dd></div>`);
  }
  out.push(`          </dl>`);
  out.push(`        </header>`);

  if (!g.valid) {
    out.push(`        <div class="guide-section unavailable" data-k="unavailable" role="status">`);
    out.push(`          <p class="group-note"><strong>${esc(t['unavailable.title'])}</strong>${esc(t['unavailable.body'])}</p>`);
    out.push(`        </div>`);
    out.push(`      </section>`);
    return out.join('\n');
  }

  if (g.experience.length) {
    out.push(`        <section class="guide-section odds-group exp" aria-label="${fmt(esc(t['exp.ariaLabel']), ctx)}">`);
    out.push(`          <h3 class="group-title">${esc(t['exp.title'])}</h3>`);
    out.push(`          <p class="group-note">${esc(t['exp.note'])}</p>`);
    out.push(`          <div class="table-wrap"><table>`);
    out.push(`            <caption class="sr-only">${fmt(esc(t['exp.caption']), ctx)}</caption>`);
    out.push(`            <thead><tr><th scope="col">${esc(t['exp.colOutcome'])}</th><th scope="col" class="col-pct">${esc(t['exp.colOdds'])}</th></tr></thead>`);
    out.push(`            <tbody>`);
    for (const r of g.experience) {
      const label = fmt(esc(t['exp.rowLabel']), { amount: `<span data-k="amount">${esc(r.amountText)}</span>` });
      out.push(`<tr data-row="${esc(r.key)}"><td>${label}</td><td class="col-pct" data-k="pct">${esc(r.percent)}</td></tr>`);
    }
    out.push(`<tr class="row-subtotal" data-row="exp-total"><td>${esc(t['exp.subtotal'])}</td><td class="col-pct" data-k="pct">${esc(g.experienceTotalPercent)}</td></tr>`);
    out.push(`            </tbody></table></div>`);
    out.push(`        </section>`);
  }

  if (g.captains.length) {
    out.push(`        <section class="guide-section odds-group cap" aria-label="${fmt(esc(t['cap.ariaLabel']), ctx)}">`);
    out.push(`          <h3 class="group-title">${esc(t['cap.title'])}</h3>`);
    if (g.duplicateXpAmountText !== undefined) out.push(`          <div class="note-callout"><strong>${esc(t['cap.duplicateLead'])}</strong> ${fmt(esc(t['cap.duplicateBody']), { amount: `<span data-k="dupxp">${esc(g.duplicateXpAmountText)}</span>` })}</div>`);
    out.push(`          <div class="table-wrap"><table>`);
    out.push(`            <caption class="sr-only">${fmt(esc(t['cap.caption']), ctx)}</caption>`);
    out.push(`            <thead><tr><th scope="col">${esc(t['cap.colCaptain'])}</th><th scope="col" class="col-num">${esc(t['cap.colLevelCap'])}</th><th scope="col" class="col-pct">${esc(t['cap.colOdds'])}</th></tr></thead>`);
    out.push(`            <tbody>`);
    for (const r of g.captains) {
      out.push(`<tr data-row="${esc(r.key)}"><td data-k="captain">${esc(r.captain)}</td><td class="col-num" data-k="cap">${esc(r.levelCapText)}</td><td class="col-pct" data-k="pct">${esc(r.percent)}</td></tr>`);
    }
    out.push(`<tr class="row-subtotal" data-row="cap-total"><td colspan="2">${esc(t['cap.subtotal'])}</td><td class="col-pct" data-k="pct">${esc(g.captainsTotalPercent)}</td></tr>`);
    out.push(`            </tbody></table></div>`);
    out.push(`        </section>`);
  }

  // A valid table adds up to exactly 1 (the publisher checks it in exact decimal), so the total is 100.0%.
  out.push(`        <div class="table-wrap total"><table><tbody><tr class="row-total" data-row="total"><td>${esc(t['total.label'])}</td><td class="col-pct" data-k="pct">100.0%</td></tr></tbody></table></div>`);
  out.push(`      </section>`);
  return out.join('\n');
}

export function renderPage(cfg, current, built, galaxies) {
  const { locale, t } = current;
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' });
  const self = cfg.siteUrl + pagePath(cfg, locale);
  const alternates = built.map(b => `  <link rel="alternate" hreflang="${b.locale}" href="${cfg.siteUrl}${pagePath(cfg, b.locale)}" />`);
  alternates.push(`  <link rel="alternate" hreflang="x-default" href="${cfg.siteUrl}${pagePath(cfg, cfg.defaultLocale)}" />`);

  const langSwitch = built.length > 1
    ? [
        `      <nav class="lang-switch" aria-label="${esc(t['lang.label'])}">`,
        `        <ul>${built.map(b => `<li><a href="${pagePath(cfg, b.locale)}" hreflang="${b.locale}" lang="${b.locale}"${b.locale === locale ? ' aria-current="page"' : ''}>${esc(cfg.localeNames[b.locale] || b.locale)}</a></li>`).join('')}</ul>`,
        `      </nav>`,
      ].join('\n')
    : '';

  const options = galaxies.map((g, i) => `<option value="${esc(g.id)}"${i === 0 ? ' selected' : ''}>${esc(g.name)}</option>`).join('');
  const jumps = galaxies.map(g => `<li><a href="#${esc(g.id)}">${esc(g.name)}</a></li>`).join('');

  const email = '<a href="mailto:support@starthrown.com" class="inline">support@starthrown.com</a>';
  const studio = '<a href="https://boundlessalchemy.io" target="_blank" rel="noopener" class="studio-link">Boundless Alchemy</a>';

  return `<!DOCTYPE html>
<!-- GENERATED by _tools/training-odds/build.mjs from the public odds document (BL-557). Do not edit by hand:
     the hourly training-odds Action overwrites this file. Words: _tools/training-odds/i18n/${locale}.json. -->
<html lang="${locale}" class="no-js">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="${esc(t['meta.description'])}" />
  <title>${esc(t['meta.title'])}</title>
  <link rel="canonical" href="${self}" />
${alternates.join('\n')}

  <meta property="og:type" content="website" />
  <meta property="og:url" content="${self}" />
  <meta property="og:title" content="${esc(t['meta.title'])}" />
  <meta property="og:description" content="${esc(t['meta.ogDescription'])}" />
  <meta property="og:image" content="${cfg.siteUrl}/share-card.jpg" />
  <meta property="og:site_name" content="Star Thrown" />

  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Space+Grotesk:wght@300;400;500&display=swap" rel="stylesheet" />

  <style>${CSS}  </style>
</head>

<body>

  <canvas id="starfield" aria-hidden="true"></canvas>

  <div class="page">
    <nav class="nav" aria-label="${esc(t['nav.siteLabel'])}">
      <a href="/" class="nav-home" aria-label="${esc(t['nav.homeLabel'])}"><img src="/StarThrownLogo.png" alt="${esc(t['nav.logoAlt'])}" class="nav-logo" /></a>
      <div class="site-menu">
        <button type="button" class="menu-toggle" aria-expanded="false" aria-controls="menu-panel" aria-label="${esc(t['nav.menuLabel'])}">
          <span></span><span></span><span></span>
        </button>
        <div class="menu-panel" id="menu-panel" hidden>
          <a href="/beta">${esc(t['menu.beta'])}</a>
          <a href="/guides/">${esc(t['menu.guides'])}</a>
          <a href="/support">${esc(t['menu.support'])}</a>
        </div>
      </div>
    </nav>

    <main>
      <h1 class="guide-title">${esc(t['page.title'])}</h1>
      <p class="guide-lede">${esc(t['page.lede'])}</p>
${langSwitch ? langSwitch + '\n' : ''}      <div class="divider"></div>

      <div class="galaxy-picker" id="galaxy-picker" hidden>
        <label for="galaxy-select">${esc(t['picker.label'])}</label>
        <select id="galaxy-select" class="galaxy-select" aria-controls="galaxy-views">${options}</select>
        <p class="hint">${esc(t['picker.hint'])}</p>
      </div>
      <nav class="jump" id="galaxy-jump" aria-label="${esc(t['jump.label'])}">
        <p>${esc(t['jump.intro'])}</p>
        <ul>${jumps}</ul>
      </nav>

      <div id="galaxy-views">
${galaxies.map(g => renderGalaxy(g, t, dateFmt)).join('\n\n')}
      </div><!-- /galaxy-views -->

      <article class="guide-body">
        <section class="guide-section">
          <h2>${esc(t['how.title'])}</h2>
          <p>${t['how.p1Html']}</p>
          <p>${t['how.p2Html']}</p>
          <p>${esc(t['how.p3'])}</p>
        </section>
        <section class="guide-section">
          <h2>${esc(t['notes.title'])}</h2>
          <ul>
            <li>${esc(t['notes.server'])}</li>
            <li>${esc(t['notes.independent'])}</li>
            <li>${esc(t['notes.rounds'])}</li>
            <li>${fmt(t['notes.contactHtml'], { email })}</li>
          </ul>
        </section>
      </article>

      <p class="back-row"><a href="/" class="faq-btn">${esc(t['back.home'])}</a></p>
    </main>
  </div>

  <footer>
    <p class="studio-credit">${fmt(t['footer.creditHtml'], { studio })}</p>
    <nav class="footer-links" aria-label="${esc(t['footer.label'])}">
      <a href="/privacy" class="studio-link">${esc(t['footer.privacy'])}</a>
      <a href="/terms" class="studio-link">${esc(t['footer.terms'])}</a>
      <a href="/beta" class="studio-link">${esc(t['footer.beta'])}</a>
      <a href="https://discord.gg/vVs73yb7wU" target="_blank" rel="noopener" class="studio-link">${esc(t['footer.discord'])}</a>
      <a href="mailto:press@boundlessalchemy.io" class="studio-link">${fmt(esc(t['footer.press']), { email: 'press@boundlessalchemy.io' })}</a>
    </nav>
  </footer>
${SCRIPTS}
</body>
</html>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if ((args.input || args.dev) && !args.root) {
    throw new Error('--input and --dev build only into --root <dir>, never over the site\'s published pages.');
  }
  const root = args.root ? resolve(String(args.root)) : SITE_ROOT;

  // Everything is read, validated and rendered before the first write, so a bad document or a
  // bad strings file leaves the published pages exactly as they were.
  const locales = loadLocales(cfg);
  const { source, doc } = await loadDocument(cfg, args);
  const galaxies = normalizeDocument(doc, cfg);
  // The Action's daily check compares against exactly the document this run built from.
  if (args['save-document']) writeFileSync(resolve(String(args['save-document'])), JSON.stringify(doc), 'utf8');
  const pages = locales.map(l => ({ file: pageFile(root, cfg, l.locale), html: renderPage(cfg, l, locales, galaxies) }));

  let changed = 0;
  for (const p of pages) {
    const before = existsSync(p.file) ? readFileSync(p.file, 'utf8') : null;
    if (before === p.html) continue;
    mkdirSync(dirname(p.file), { recursive: true });
    writeFileSync(p.file, p.html, 'utf8');
    changed++;
    console.log(`wrote ${p.file}`);
  }
  console.log(`source: ${source}`);
  console.log(`galaxies: ${galaxies.map(g => g.id + (g.valid ? '' : ' (UNAVAILABLE)')).join(', ')}`);
  console.log(`locales: ${locales.map(l => l.locale).join(', ')}; pages changed: ${changed}/${pages.length}`);

  const invalid = galaxies.filter(g => !g.valid);
  if (invalid.length) {
    for (const g of invalid) {
      console.error(`ERROR ${g.id}: the document marks this galaxy's table invalid (${g.invalidReason}); its entry says the odds are temporarily unavailable.`);
    }
    process.exitCode = 3;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error(`ERROR ${e.message}`);
    console.error('Nothing was written.');
    process.exit(1);
  });
}
