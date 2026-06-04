// nam-config.js — NAM! Configuration v2.3.0
// ─────────────────────────────────────────────
// All app constants and tunables live here.
// Update this file without touching nam.js logic.
// Must be loaded BEFORE nam.js in index.html.

// ── API Keys & Endpoints ──────────────────────────────────────────────────────
const MAPBOX_TOKEN     = 'pk.eyJ1IjoiY2hhcmxlc2xvZ2ljIiwiYSI6ImNtbzd0cnUzNDA1aXAycm9yMnM0OXAwMHcifQ.wtd5BEe5_auNkv96uM9j2w';
const GOOGLE_SHEET_URL = 'https://script.google.com/macros/s/AKfycbzS1DjJONkIGz2WEh0hT_6feZNYOE6RN73Iz_LxRk8rHvxAR-xzXUNnD_vk-r06QWKA/exec';

// ── App Identity ──────────────────────────────────────────────────────────────
const APP_VERSION = 'v2.3.6';

// ── Cache Settings ────────────────────────────────────────────────────────────
const LIFE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // Life list cache duration (1 week)
const OBS_CACHE_KEY  = 'nam_obs_cache';           // localStorage key for observation cache

// ── Map Settings ──────────────────────────────────────────────────────────────
const BASEMAP_CYCLE  = ['streets', 'hybrid', 'usgs']; // Cycle order for basemap button
const PARCEL_WMS_URL = 'https://feature.geographic.texas.gov/arcgis/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/WMSServer';
const PARCEL_MIN_ZOOM = 15; // Minimum zoom level to enable parcel layer

// ── AI Models ─────────────────────────────────────────────────────────────────
const AI_MODELS = [
    { id: 'gemini-2.5-flash',                        name: 'Gemini 2.5 Flash', via: 'gemini'                     },
    { id: 'llama-3.3-70b-versatile',                 name: 'Groq Llama 3.3',   via: 'groq',      truncate: true  },
    { id: 'meta-llama/llama-3.3-70b-instruct:free',  name: 'Llama 3.3 (OR)',   via: 'openrouter'                 },
    { id: 'openai/gpt-oss-120b:free',                name: 'GPT-OSS 120B',     via: 'openrouter'                 },
    { id: 'nvidia/nemotron-3-super-120b-a12b:free',  name: 'Nemotron 120B',    via: 'openrouter'                 },
    { id: 'gpt-oss-120b',                            name: 'Cerebras 120B',    via: 'cerebras'                   },
];
const AI_DEFAULT_RANK = [
    'gemini-2.5-flash',
    'llama-3.3-70b-versatile',
    'gpt-oss-120b',
    'openai/gpt-oss-120b:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'meta-llama/llama-3.3-70b-instruct:free',
];
