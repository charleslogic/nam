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
