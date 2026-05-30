# NAM! — Security & Code Review

Reviewed 2026-05-29 (Opus wrote + implemented). Public, no-auth nature-observation app:
static frontend + one serverless proxy (`api/ebird-proxy.js`). Aggregates iNaturalist +
eBird data onto a Leaflet map. No login, no cookies, no database — so the threat model is
**rendering third-party user-generated content** and **client-side secrets**, not data
isolation.

Code fixes shipped in commit `<fill>`.

---

## Strong points (unchanged)

- **`ebird-proxy.js` is well-built**: validates lat/lng as floats, clamps `dist`/`back`/
  `maxResults`, allowlists `mode`/`detail`, keeps the eBird key server-side, returns generic
  errors. No SSRF/open-proxy — upstream URL is fixed to `api.ebird.org` with numeric/enum
  inputs only.
- Google Sheet integration is **read-only** (GET) — the owner's life list; no client write path.
- SW offline fallbacks are deliberate 503s with valid bodies; missing key → fail-closed config error.

---

## 1 — XSS via third-party UGC rendered into innerHTML (MEDIUM — fixed)

The app rendered API fields straight into `innerHTML` / Leaflet `setContent` with no
escaping. Field provenance is genuinely user-generated:
- `location_str` ← iNaturalist `place_guess` — **free text the observer types**
- `date` ← iNaturalist `observed_on_string` — **free text**
- `common_name` / `sci_name` ← iNat taxon names (community-editable)
- parcel popup `OWNER_NAME` / `SITUS_ADDR` ← Texas WMS (real-world names/addresses)
- macrostrat `unitName` / `lith` / `desc` ← geology API
- `<img src>` (quote-breakout → `onerror`) and `<a href>` (`javascript:` scheme)

No session/cookies to steal, but an attacker who posts a crafted iNaturalist observation
could run script in **every** user who scans that region (exfiltrate precise GPS, hijack the
page, abuse the Mapbox token, phish). Remotely triggerable, bounded impact.

**Fix — output encoding at every sink:**
- Added `esc()` (HTML-escape for text + quoted attributes) and `safeUrl()` (rejects any
  scheme but http/https → blocks `javascript:`/`data:` in href/src).
- Applied across: `renderStats`, `renderCards`, `openGallery`, `renderLifeList`,
  `updateFinalStatus`, the **macrostrat geology popup**, and the **Texas parcel popup**.

> Note: the **partial CSP** added in §2 is defense-in-depth only — output encoding is the
> real fix. A full `script-src` CSP isn't practical here (3 inline `<script>` blocks +
> `document.write` script injection would need a refactor).

---

## 2 — Code fixes (shipped)

| # | Finding | Severity | Fix | File |
|---|---------|----------|-----|------|
| 2.1 | XSS via third-party UGC (§1) | Medium | `esc()` + `safeUrl()` across all render sinks + both map popups | `nam.js` |
| 2.2 | Leaflet CSS+JS pinned but **no SRI** | Medium | `sha384` integrity (computed against live unpkg files) + `crossorigin` | `index.html` |
| 2.3 | Empty `vercel.json` — no headers | Low–Med | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, partial CSP (`frame-ancestors`/`object-src`/`base-uri`) | `vercel.json` |
| 2.4 | Missing `.gitignore` | Low | Created (`node_modules`, `.env*`, `.vercel`) | `.gitignore` |

---

## 3 — Manual items (not done in code — verify in dashboards)

| # | Finding | Severity | Action |
|---|---------|----------|--------|
| N2 | **Mapbox token** in `nam-config.js` is a public `pk.` token (expected in client code), but if **un-restricted** anyone can lift it and burn your quota/bill | Medium | ✅ **Resolved 2026-05-29** — token URL-restricted in the Mapbox account dashboard |
| N3 | **Google Apps Script** `/exec` URL is publicly readable (returns the life list to anyone) | Low | Confirm the script has no unauthenticated `doPost` that could mutate the sheet; accept the read exposure or add a token |

---

## 4 — Six known shared-monorepo issues

| # | Issue | Status |
|---|-------|--------|
| 1 | RLS off | ✅ N/A — no database/auth |
| 2 | Unpinned / SRI-less CDN | ❌ → **fixed** (2.2) |
| 3 | Empty `vercel.json` | ❌ → **fixed** (2.3) |
| 4 | Missing `.gitignore` | ❌ → **fixed** (2.4) |
| 5 | OAuth `state=user-id` | ✅ N/A |
| 6 | Raw `error.message` to client | ✅ Clean — proxy returns generic strings |

---

## 5 — Deferred

- **Full `script-src` CSP** — needs extracting the 3 inline `<script>` blocks and replacing
  `document.write` script injection. Output encoding (§1) is the real XSS mitigation; revisit
  CSP if desired.
