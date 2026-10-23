# Training odds page generator (BL-557)

`training-odds.html` and its translations are **generated**. Do not edit them by hand: the hourly
Action overwrites them. Change the words in `i18n/<locale>.json` and the layout in `build.mjs`.

This folder is `_tools/`, with a leading underscore, on purpose: the site is published by GitHub
Pages' classic (Jekyll) build from `main`, and Jekyll does not publish a folder whose name starts with
`_`. So this README, the config and the SYNTHETIC fixtures are never served at starthrown.com.

## How it works

1. The game backend (`trainingOddsPublisher.js`, Admin Portal) writes a public, read-only odds
   document to the database at `publicTrainingOdds/{galaxyId}`: one entry per galaxy, odds only, no
   player data. Its fields are defined in the game repo at `docs/firebase/publicTrainingOdds.md`.
2. `.github/workflows/training-odds.yml` runs **every hour at :07** (the publisher runs at :02, after
   the game's :00 round tick). It reads that document over the database's public REST API
   (`https://<databaseHost>/publicTrainingOdds.json`, no credential) and runs `build.mjs`, which
   renders one static page per language. If a page changed, the Action commits it to `main` and GitHub
   Pages publishes it. If nothing changed, it commits nothing.
3. **Once a day** (the 05:07 UTC run), the same run then runs `check.mjs` against **the document it
   just built from**: first the pages in this repo, then the live site, retrying for up to 15 minutes
   while GitHub Pages publishes the push. It fails on any wrong value, missing galaxy or extra galaxy.

A failed run is how problems reach the owner: GitHub emails the workflow's owner when a scheduled
run fails.

### What the page does

- **Every galaxy is in the HTML** as text, in galaxy-id order, and galaxies with identical odds are
  still listed separately. Find-in-page and search engines see all of them.
- **With JavaScript**, a galaxy dropdown shows one galaxy at a time. Script only hides the others
  (`hidden="until-found"`, so find-in-page in Chrome and Edge can still reveal them).
- **Without JavaScript**, the dropdown stays hidden, every galaxy is shown one after another, and a
  "Jump to" list links to each one.
- **Deep link**: `training-odds.html#galaxy_002` opens with that galaxy selected. No hash, or an
  unknown one, selects the first galaxy in galaxy-id order. Choosing from the dropdown updates the
  hash, so the URL can be shared. The language links keep the selected galaxy.
- Every figure is printed exactly as the document has it (`percent`, `amountText`, `levelCapText`,
  `duplicateXpAmountText`). The generator never does arithmetic on odds. `publishedAt` is never shown.
- A galaxy the document marks `valid: false` shows "Odds temporarily unavailable", and the run fails.

## Files

| File | What it is |
|---|---|
| `config.json` | `databaseHost` (the production database; **`null` until production serves the document**, and every run fails until it is set), `devDatabaseHost` (previews only), page file name, site URL, locales |
| `i18n/<locale>.json` | Every word on the page. `en.json` is the reference: other locales must have every key it has |
| `lib.mjs` | Shared plumbing: reading the config, the document and the strings, and validating the document |
| `build.mjs` | Renders the pages |
| `check.mjs` | The daily check. It does not import `build.mjs`: it reads the page text and compares it with the document |
| `fixtures/synthetic-*.json` | **SYNTHETIC test documents**, hand-built for local runs. `synthetic-dev-2026-10-23.json` was assembled on 2026-10-23 from the live dev source tables (galaxy_001 round 003, galaxy_002 round 001), **not** produced by the publisher. `synthetic-edge-cases.json` adds an invalid galaxy, an unknown status, a missing date, a missing Level Cap, a name that needs escaping, and a reserved `upcoming` child |

## Run it locally

Node 22 or later. No `npm install`: there are no dependencies.

```sh
node _tools/training-odds/build.mjs                      # read the production document, write the pages
node _tools/training-odds/check.mjs                      # compare the pages in this checkout with it
node _tools/training-odds/check.mjs --deployed           # compare the live site instead

# Previews, which must name --root: a local or dev document is never written over the site's pages.
node _tools/training-odds/build.mjs --dev --root /tmp/odds        # the dev database's document
node _tools/training-odds/build.mjs --input _tools/training-odds/fixtures/synthetic-dev-2026-10-23.json --root /tmp/odds
node _tools/training-odds/check.mjs --input _tools/training-odds/fixtures/synthetic-dev-2026-10-23.json --root /tmp/odds

node --test _tools/training-odds/test/training-odds.test.mjs     # the generator's tests
```

Exit codes. `build.mjs`: `0` pages written, `3` pages written but a galaxy is unavailable, `1` nothing
written. `check.mjs`: `0` everything matches, `1` anything else. `build.mjs --save-document <file>`
also saves the document it built from (the daily check reads it with `--input`).

`build.mjs` validates everything and renders every page before it writes the first one, so an
unreachable, empty or malformed document leaves the published pages exactly as they were. It refuses
a document with no galaxies, and a `schemaVersion` it does not know.

The output is deterministic: the same document and the same strings give byte-identical pages. There
is no build time in the page.

## Switch to production

1. Deploy the `publicTrainingOdds` security rule (`.read: true`, `.write: false`) and the publisher to
   the production project first.
2. Find production's database host in the Firebase console (Realtime Database, the URL above the
   data), and confirm it answers without a credential:
   `curl -s https://<host>/publicTrainingOdds.json` must print the odds document, not `Permission denied`.
3. Set `databaseHost` in `config.json` to that host (no `https://`, no path), and commit to `main`.
   ⚠️ Never set it to the dev host: the page on starthrown.com is the legal disclosure for the
   players of the production game, and dev's tables are not the ones they roll against.
4. Run the workflow by hand (Actions → Training odds → Run workflow → `build`), then `check`.

## Add a language

1. Copy `i18n/en.json` to `i18n/<locale>.json` (one of the codes in `config.json` `locales`).
2. Translate every value. Keep the `{placeholders}` exactly. Keys ending in `Html` may contain
   `<strong>`; keep the tags. Numbers and percentages are printed exactly as the document has them in
   every language, so do not translate them.
3. Run `build.mjs`, then `check.mjs`, and commit `i18n/<locale>.json` with the new
   `<locale>/training-odds.html`.

A locale with no strings file is not built and not offered in the language links. A strings file that
is missing any key fails the run and writes nothing.

## Known limits

- **The document must exist and be public.** Until `databaseHost` is set, and until the rule is
  deployed there, every run fails without writing (the second case returns `401 Permission denied`).
- **The page only knows what the document says.** If the publisher stops updating the document, the
  page and the check still agree. That failure is reported by the game backend: the publisher's
  scheduled function fails when any galaxy fails to publish (see Cloud Logging for
  `publishTrainingOddsHourly`).
- **App Check.** If App Check enforcement is ever switched on for the Realtime Database, the
  credential-free read stops working.
- **Dates are in UTC.** "Odds in effect since" is the document's `effectiveFromMs`, printed as a UTC
  date in the page's language (the `<time datetime>` attribute has the exact instant).
- **Schedules drift.** GitHub may start a scheduled run late under load, and disables schedules in a
  public repository after 60 days with no commits. A daily check that is not running alerts no one.
- **The `upcoming` child** (next round's odds) is reserved for BL-558. This version ignores it, and
  skips (with a warning) a galaxy that has only `upcoming` and no current odds yet.
