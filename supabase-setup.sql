-- NAM! — Supabase setup
-- Run once in the Supabase SQL editor for the shared project nfvxmkknkxysjksyhbek:
-- https://supabase.com/dashboard/project/nfvxmkknkxysjksyhbek/sql
--
-- All tables use the nam_ prefix to coexist with other apps in the shared project.
-- Both tables are family-shared (no per-user column, by design — see CLAUDE.md) and
-- are read/written only via the service-role key in api/favorites.js and
-- api/preferences.js. RLS is enabled with no anon/authenticated policies so the
-- anon key (used by index.html for auth only) cannot read or write them directly.

CREATE TABLE IF NOT EXISTS nam_favorites (
    id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    label      TEXT        NOT NULL,
    loc        TEXT        NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nam_prefs (
    id    TEXT PRIMARY KEY,
    value JSONB NOT NULL
);

ALTER TABLE nam_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE nam_prefs     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "nam_favorites: service only" ON nam_favorites;
DROP POLICY IF EXISTS "nam_prefs: service only"     ON nam_prefs;

CREATE POLICY "nam_favorites: service only" ON nam_favorites FOR ALL USING (false);
CREATE POLICY "nam_prefs: service only"     ON nam_prefs     FOR ALL USING (false);
