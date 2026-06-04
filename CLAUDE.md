# NAM!

Real-time nature observation aggregator. Pulls iNaturalist + eBird data around a GPS or searched location, displays on a Leaflet map with species cards, life-list matching, and heatmap hotspots.

## Deploy Workflow

Commit → push to GitHub → Vercel auto-deploys via GitHub integration.
Do **not** use `vercel --prod` directly.

## Architecture

Static HTML + Vercel serverless API functions. No build step.

```
nam/
├── index.html          — single-page app (Leaflet map, AI drawer, all UI)
├── nam.js              — all app logic (including AI chat)
├── nam.css             — styles
├── nam-config.js       — constants (API keys, tunables, AI_MODELS registry) — loaded before nam.js
├── marked.umd.js       — self-hosted markdown renderer (used by AI chat)
├── nam-sw.js           — service worker (stale-while-revalidate for HTML/JS/CSS)
├── nam-icon.svg        — app icon
├── api/
│   ├── ebird-proxy.js  — GET /api/ebird-proxy — proxies eBird API, keeps key server-side
│   ├── favorites.js    — GET/POST/DELETE /api/favorites — shared saved locations (Supabase)
│   ├── preferences.js  — GET/POST /api/preferences — key-value prefs (Supabase nam_prefs)
│   └── infer-keys.js   — GET /api/infer-keys — returns AI API keys from server env vars
└── vercel.json         — security headers
```

**4 serverless functions** (well within Vercel Hobby 12-function limit).

## eBird Integration

Two sequential API calls per scan, both with `maxResults=10000`:

```
GET /api/ebird-proxy?lat=…&lng=…&dist=…&mode=recent&maxResults=10000
GET /api/ebird-proxy?lat=…&lng=…&dist=…&mode=notable&maxResults=10000
```

**Why `maxResults=10000`:** eBird's default is 100. In a busy area this silently cuts off results — rare birds added late in the list are dropped. Always request the max.

**Notable merge:** eBird sometimes excludes rare/provisional birds from the `geo/recent` endpoint — they only appear in `geo/recent/notable`. After both fetches, any notable observation not already in recent is merged in. Without this, notable-only birds are silently dropped. The debug log reports `eBird notable-only merge: +N obs` when this fires.

The proxy (`api/ebird-proxy.js`) validates lat/lng, clamps dist/back/maxResults, allowlists mode/detail, and keeps the eBird API key server-side.

## AI Chat

A right-side chat drawer powered by the user's own AI API keys. Feeds live scan data as context so the AI knows what's nearby, what's notable, and what the user's targets are.

### UI

- **💬 bubble** — fixed bottom-right button (above the ↑ action circle), opens/closes `#aiDrawer`. Pulses a badge dot when 🎯 targets are in the current scan.
- **Drawer** — 320px right-side panel with: header (model badge, ⤢ fullscreen toggle, ✕ close), scan summary grid, message thread, favorite question chips, input + Send.
- **Scan summary** — after a scan, shows a 2×2 grid: iNat count · eBird count · ⭐ Notable · 🎯 Targets.
- **Model attribution badge** — blue chip at the top of each assistant response bubble showing which model answered.
- **Fullscreen toggle** — ⤢/⤡ button expands drawer to full viewport width.
- **⚙ AI Settings** — collapsible section in Advanced Config with key inputs (Gemini, Groq, OpenRouter, Cerebras) and a drag-order model rank list.

### Context building (`buildAiContext` in `nam.js`)

Reads live in-memory state — no extra fetches:
- Location name + coords
- Life list: seen/total + target count
- iNat observations labeled "nearby community sightings by other people"
- eBird observations (same label)

Each line: `🎯/⭐/•  Common Name (Sci Name) — date — location`
- 🎯 = target species (in user's wanted list, spotted nearby)
- ⭐ = eBird notable (rare for area)
- • = already seen

🎯 and ⭐ observations are always included with full detail. Regular • observations are included up to the model's `maxInputTokens` budget (see below). Conversation history resets on every new scan.

### Model registry (`AI_MODELS` in `nam-config.js`)

```js
const AI_MODELS = [
  { id: 'gemini-2.5-flash',                       name: 'Gemini 2.5 Flash', via: 'gemini'                    },
  { id: 'llama-3.3-70b-versatile',                name: 'Groq Llama 3.3',   via: 'groq',   maxInputTokens: 9000 },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 (OR)',   via: 'openrouter'                },
  { id: 'openai/gpt-oss-120b:free',               name: 'GPT-OSS 120B',     via: 'openrouter'                },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 120B',    via: 'openrouter'                },
  { id: 'gpt-oss-120b',                           name: 'Cerebras 120B',    via: 'cerebras'                  },
];
```

`maxInputTokens` is set on models with published token limits. **Groq free tier** has a 12,000 TPM cap — `9000` = 12,000 − 2,048 output − 950 overhead. `buildAiContext(maxInputTokens)` computes a char budget (`maxInputTokens × 4 − fixedChars − 3000 reserve`) and fills regular obs until it's exhausted. Models without this flag get full context. To add a new limited model, just add `maxInputTokens: N` to its entry.

### Model rank

User-ordered list of models stored in Supabase `nam_prefs` under key `ai_rank`. Loaded on init via `GET /api/preferences?key=ai_rank`. Primary model = first in rank with a key set. After a response, lazy "See [Model X]'s answer" buttons fetch alternatives on demand. On error, a "Try [Next] →" button appears.

Each model call builds its own messages via `_aiBuildMessages(historySnapshot, model)` so per-model truncation applies correctly even in "see another" paths.

### Favorite questions

⭐ icon to the left of each sent question bubble. Tap to save. Saved questions appear as chips above the input — tap to re-ask instantly, ✕ to delete. Stored in Supabase `nam_prefs` under key `ai_favs`.

### Supabase tables (one-time setup)

```sql
CREATE TABLE nam_prefs (id text PRIMARY KEY, value jsonb NOT NULL);
```

Keys in use: `ai_rank` (model order array), `ai_favs` (saved question strings array).

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
| `INFER_KEY_GEMINI` | Gemini API key (shared with infer project) |
| `INFER_KEY_GROQ` | Groq API key (shared with infer project) |
| `INFER_KEY_OPENROUTER` | OpenRouter API key (shared with infer project) |
| `INFER_KEY_CEREBRAS` | Cerebras API key (shared with infer project) |

Mapbox token (`MAPBOX_TOKEN`) is a public `pk.` token in `nam-config.js` — URL-restricted in the Mapbox dashboard (no env var needed).

AI keys are served to the browser by `api/infer-keys.js` and populate the key inputs in ⚙ AI Settings. The localStorage key names (`infer-key-gemini` etc.) match infer, so keys entered in infer work in NAM automatically.

## Version Display & PWA

`NAM_VERSION` in `index.html` and `APP_CACHE` in `nam-sw.js` must always match (e.g., both `v2.4.2`). Bump both together on every deploy — the version is the SW cache name, so mismatches cause stale JS to be served.

The SW uses **stale-while-revalidate** for HTML, JS, and CSS: serves cached immediately, fetches fresh in background. A version bump forces a new cache key so updated files are fetched.

Version is shown in the page title (`NAM! v2.4.2`) and `nam-config.js` also has an `APP_VERSION` constant — keep it in sync or remove it (it's informational only).

## Hardcoded Location Chips

Quick-access chips are hardcoded in `index.html` inside `#quickChips`. Chips with `data-lat`/`data-lng` bypass geocoding (use for ambiguous names). Chips with only `data-loc` geocode via Mapbox on click.

User-saved favorites appear above these in `#userFavSection`, rendered dynamically from Supabase.
