# NAM!

Real-time nature observation aggregator. Pulls iNaturalist + eBird data around a GPS or searched location, displays on a Leaflet map with species cards, life-list matching, and heatmap hotspots.

## Deploy Workflow

Commit → push to GitHub → Vercel auto-deploys via GitHub integration.
Do **not** use `vercel --prod` directly.

## Architecture

Static HTML + Vercel serverless API functions. No build step.

```
nam/
├── index.html          — single-page app (Leaflet map, all UI)
├── nam.js              — all app logic
├── nam.css             — styles
├── nam-config.js       — constants (API keys, tunables) — loaded before nam.js
├── nam-sw.js           — service worker (stale-while-revalidate for HTML/JS/CSS)
├── nam-icon.svg        — app icon
├── api/
│   ├── ebird-proxy.js  — GET /api/ebird-proxy — proxies eBird API, keeps key server-side
│   └── favorites.js    — GET/POST/DELETE /api/favorites — shared saved locations (Supabase)
└── vercel.json         — security headers
```

**2 serverless functions** (well within Vercel Hobby 12-function limit).

## eBird Integration

Two sequential API calls per scan, both with `maxResults=10000`:

```
GET /api/ebird-proxy?lat=…&lng=…&dist=…&mode=recent&maxResults=10000
GET /api/ebird-proxy?lat=…&lng=…&dist=…&mode=notable&maxResults=10000
```

**Why `maxResults=10000`:** eBird's default is 100. In a busy area this silently cuts off results — rare birds added late in the list are dropped. Always request the max.

**Notable merge:** eBird sometimes excludes rare/provisional birds from the `geo/recent` endpoint — they only appear in `geo/recent/notable`. After both fetches, any notable observation not already in recent is merged in. Without this, notable-only birds are silently dropped. The debug log reports `eBird notable-only merge: +N obs` when this fires.

The proxy (`api/ebird-proxy.js`) validates lat/lng, clamps dist/back/maxResults, allowlists mode/detail, and keeps the eBird API key server-side.

## Favorites

Saved locations are stored in `nam_favorites` on the shared Supabase project. No auth — the table is shared across all users (family app). Favorites saved by one person appear on everyone's device.

**Supabase table** (run once in Supabase SQL editor):
```sql
CREATE TABLE nam_favorites (
    id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    label      TEXT        NOT NULL,
    loc        TEXT        NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**API endpoint** (`api/favorites.js`): uses service role key server-side.
- `GET /api/favorites` — list all, newest first
- `POST /api/favorites` body `{label, loc}` — add
- `DELETE /api/favorites?id=<uuid>` — remove

**UI:** In the location modal, type a destination → `★ SAVE AS FAVORITE` appears → tap to save. Saved chips appear in a **SAVED** section above the hardcoded chips, each with a `✕` to remove.

**localStorage migration:** On first load after the Supabase switch, any favorites stored in `localStorage` under `nam_favorites` are automatically migrated to Supabase and the localStorage key is cleared.

## Environment Variables

Set in Vercel dashboard for the `nam` project:

| Variable | Value |
|----------|-------|
| `EBIRD_API_KEY` | eBird API key |
| `SUPABASE_URL` | `https://nfvxmkknkxysjksyhbek.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | (from Supabase dashboard → Settings → API) |

Mapbox token (`MAPBOX_TOKEN`) is a public `pk.` token in `nam-config.js` — URL-restricted in the Mapbox dashboard (no env var needed).

## Version Display & PWA

`NAM_VERSION` in `index.html` and `APP_CACHE` in `nam-sw.js` must always match (e.g., both `v2.4.2`). Bump both together on every deploy — the version is the SW cache name, so mismatches cause stale JS to be served.

The SW uses **stale-while-revalidate** for HTML, JS, and CSS: serves cached immediately, fetches fresh in background. A version bump forces a new cache key so updated files are fetched.

Version is shown in the page title (`NAM! v2.4.2`) and `nam-config.js` also has an `APP_VERSION` constant — keep it in sync or remove it (it's informational only).

## Hardcoded Location Chips

Quick-access chips are hardcoded in `index.html` inside `#quickChips`. Chips with `data-lat`/`data-lng` bypass geocoding (use for ambiguous names). Chips with only `data-loc` geocode via Mapbox on click.

User-saved favorites appear above these in `#userFavSection`, rendered dynamically from Supabase.
