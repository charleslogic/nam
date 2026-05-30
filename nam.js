// NAM! Nature Around Me - Logic v2.3.0
//         // ─────────────────────────────────────────────
        //  SERVICE WORKER REGISTRATION
        // ─────────────────────────────────────────────
        if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
            navigator.serviceWorker.register('nam-sw.js')
                .then(reg => dlog('SW registered, scope=' + reg.scope, 'sw'))
                .catch(e => { console.warn('[SW] reg failed:', e); dlog('SW reg FAILED: ' + e.message, 'error'); });
            // Listen for messages from SW (tile cache stats etc)
            navigator.serviceWorker.addEventListener('message', e => {
                if (e.data?.type === 'PRECACHE_DONE') {
                    dlog('SW precache done: ' + e.data.count + '/' + e.data.total + ' tiles', 'sw');
                }
            });
        }

        // ─────────────────────────────────────────────
        //  CONSTANTS  (defined in nam-config.js)
        // ─────────────────────────────────────────────
        let maxCachedZoom = 16; // tracks highest zoom browsed; saved with obs cache

        // ─────────────────────────────────────────────
        //  OUTPUT ENCODING — third-party data (iNat/eBird place names, common
        //  names, dates, photo/observation URLs) is rendered into innerHTML.
        //  esc() guards text + quoted-attribute contexts; safeUrl() rejects any
        //  scheme other than http/https (blocks javascript:/data: in href/src).
        // ─────────────────────────────────────────────
        const esc = s => String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const safeUrl = u => {
            const s = String(u ?? '');
            return /^https?:\/\//i.test(s) ? esc(s) : '#';
        };

        // ─────────────────────────────────────────────
        //  DEBUG LOGGER
        // ─────────────────────────────────────────────
        const DEBUG_MAX = 100;
        const _debugBuffer = [];
        let _debugVisible = false;

        function dlog(msg, type) {
            type = type || 'info';
            const ts = new Date().toTimeString().slice(0, 8);
            const entry = { ts, msg: String(msg), type };
            _debugBuffer.push(entry);
            if (_debugBuffer.length > DEBUG_MAX) _debugBuffer.shift();
            if (_debugVisible) _debugRender(entry);
            const con = type === 'error' ? console.error : type === 'warn' ? console.warn : console.log;
            con('[NAM ' + ts + ']', msg);
        }

        function _debugRender(entry) {
            const log = document.getElementById('debugLog');
            if (!log) return;
            const div = document.createElement('div');
            div.className = 'debug-entry ' + entry.type;
            div.textContent = entry.ts + ' [' + entry.type.toUpperCase().slice(0, 5).padEnd(5, ' ') + '] ' + entry.msg;
            log.appendChild(div);
            log.scrollTop = log.scrollHeight;
            const cnt = document.getElementById('debugCount');
            if (cnt) cnt.textContent = '(' + _debugBuffer.length + ')';
        }

        function _debugRenderAll() {
            const log = document.getElementById('debugLog');
            if (!log) return;
            log.innerHTML = '';
            _debugBuffer.forEach(e => _debugRender(e));
        }

        function toggleDebugPanel() {
            _debugVisible = !_debugVisible;
            const panel = document.getElementById('debugPanel');
            const btn = document.getElementById('btnDebug');
            if (panel) panel.style.display = _debugVisible ? 'block' : 'none';
            if (btn) {
                btn.style.borderColor = _debugVisible ? '#fff' : '#a855f7';
                btn.style.color = _debugVisible ? '#fff' : '#a855f7';
                btn.style.background = _debugVisible ? '#7c3aed' : '';
            }
            if (_debugVisible) _debugRenderAll();
        }

        // ─────────────────────────────────────────────
        //  STATE
        // ─────────────────────────────────────────────
        let rawData = [];
        let fullLifeList = [];   // complete sheet — ALL birds
        let fullWantedList = [];   // unseen subset — used for target matching on scan cards
        let activeFilter = null;
        let activeTaxon = 3;
        let map = null;
        let markers = [];
        let userMarker = null;
        let userCoords = null;
        let currentTileLayer = null;
        let geologyOverlay = null;
        let globalToggles = { ebird: false, wanted: false, notable: false };
        let preFilterScrollPos = 0;
        let galleryActive = false;
        let galleryScrollPos = 0;
        let locSortMode = 'rank';
        let isInitialLoad = true;
        let llFilter = 'all';
        let llQuery = '';

        // Parcel overlay state
        let parcelState = { on: false, controller: null, tileErrorCount: 0, layer: null, countdownTimer: null, tileCountdownTimer: null };
        let basemapIndex = 0; // starts on streets (OSM)

        // ─────────────────────────────────────────────
        //  HELPERS
        // ─────────────────────────────────────────────
        function isSeen(row) {
            const v = row.Seen ?? row.seen;
            return v === true || v === 'TRUE' || v === 1 || v === '1';
        }
        function hasPhoto(row) {
            const link = row.Link ?? row.link ?? '';
            return typeof link === 'string' && link.startsWith('http');
        }

        // ─────────────────────────────────────────────
        //  OFFLINE CACHE
        // ─────────────────────────────────────────────
        function loadOfflineCache() {
            try {
                const raw = localStorage.getItem(OBS_CACHE_KEY);
                if (!raw) { dlog('Offline cache: no data found', 'warn'); return false; }
                const cache = JSON.parse(raw);
                if (!cache.observations || cache.observations.length === 0) return false;
                dlog('Offline cache loaded: ' + cache.observations.length + ' obs from ' + (cache.location?.name || '?') + ', maxZoom=' + (cache.maxZoom ?? '?'), 'cache');
                rawData = cache.observations;
                userCoords = cache.location;
                activeTaxon = cache.taxon ?? 3;
                maxCachedZoom = cache.maxZoom ?? 14;
                // Sync taxon chip UI
                document.querySelectorAll('.chip').forEach(c => {
                    const val = c.dataset.taxon === 'null' ? null : parseInt(c.dataset.taxon, 10);
                    c.classList.toggle('active', val === activeTaxon);
                });
                updateBirdToggles();
                // Show offline banner with cache age and location
                dlog('Offline cache loaded: ' + cache.observations.length + ' obs from ' + (cache.location && cache.location.name || '?'), 'cache');
                const ageMs = Date.now() - (cache.timestamp || 0);
                const ageStr = ageMs < 3600000 ? Math.round(ageMs / 60000) + 'm ago'
                    : ageMs < 86400000 ? Math.round(ageMs / 3600000) + 'h ago'
                        : Math.round(ageMs / 86400000) + 'd ago';
                const locName = cache.location?.name || 'Unknown';
                const banner = document.getElementById('offlineBanner');
                banner.textContent = '📵 OFFLINE — ' + locName.toUpperCase() + ' · ' + rawData.length + ' obs · ' + ageStr;
                banner.classList.add('visible');
                document.getElementById('scanBtn').disabled = true;
                document.getElementById('scanBtn').style.opacity = '0.5';
                document.getElementById('scanHint').style.display = 'none';
                updateAboutLocationEcho();
                // Show UI sections
                document.getElementById('status').style.display = 'flex';
                document.getElementById('mapWrapper').style.display = 'block';
                document.getElementById('summaryArea').style.display = 'block';
                document.getElementById('resultsScrollTarget').style.display = 'block';
                document.getElementById('navDock').style.display = 'flex';
                document.getElementById('actionCircle').style.display = 'flex';
                return true;
            } catch (e) { console.warn('Offline cache load failed:', e); return false; }
        }

        // ── Disable/enable network-dependent UI based on online state ──
        function setOfflineUI() {
            // Banner
            const banner = document.getElementById('offlineBanner');
            if (fullLifeList.length === 0 || !rawData.length) return; // no cache, banner set by loadOfflineCache
            banner.classList.add('visible');

            // Scan button
            document.getElementById('scanBtn').disabled = true;
            document.getElementById('scanBtn').style.opacity = '0.5';

            // Set Location — geocoding won't work
            document.getElementById('btnSetLoc').disabled = true;
            document.getElementById('btnSetLoc').style.opacity = '0.4';
            document.getElementById('mapBtnSetLoc').disabled = true;
            document.getElementById('mapBtnSetLoc').style.opacity = '0.4';

            // Map cycle — disable to prevent black tiles from non-OSM sources
            document.getElementById('mapBtnBasemap').disabled = true;
            document.getElementById('mapBtnBasemap').style.opacity = '0.4';

            // Geology — turn off if active, disable button
            const geoBtn = document.getElementById('mapBtnGeo');
            if (geoBtn.classList.contains('geo-active')) {
                geoBtn.classList.remove('geo-active');
                if (geologyOverlay) { map.removeLayer(geologyOverlay); geologyOverlay = null; }
                document.getElementById('geoOpacityFloat').classList.remove('visible');
                document.getElementById('mapType').value = BASEMAP_CYCLE[basemapIndex];
            }
            geoBtn.disabled = true;
            geoBtn.style.opacity = '0.4';

            // Parcel — turn off if active, disable button
            if (parcelState.on) toggleParcelLayer();
            document.getElementById('mapBtnParcel').disabled = true;
            document.getElementById('mapBtnParcel').style.opacity = '';
            document.getElementById('mapBtnParcel').classList.add('parcel-disabled');
        }

        function setOnlineUI() {
            // Banner
            document.getElementById('offlineBanner').classList.remove('visible');

            // Scan button
            document.getElementById('scanBtn').disabled = false;
            document.getElementById('scanBtn').style.opacity = '1';

            // Set Location
            document.getElementById('btnSetLoc').disabled = false;
            document.getElementById('btnSetLoc').style.opacity = '1';
            document.getElementById('mapBtnSetLoc').disabled = false;
            document.getElementById('mapBtnSetLoc').style.opacity = '1';

            // Map cycle
            document.getElementById('mapBtnBasemap').disabled = false;
            document.getElementById('mapBtnBasemap').style.opacity = '1';

            // Geology
            const geoBtn = document.getElementById('mapBtnGeo');
            geoBtn.disabled = false;
            geoBtn.style.opacity = '1';

            // Parcel — re-enable based on zoom; clear any inline opacity so CSS class takes effect
            document.getElementById('mapBtnParcel').disabled = false;
            document.getElementById('mapBtnParcel').style.opacity = '';
            updateParcelZoomGate();
        }

        // Relay SW messages to debug log
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', event => {
                if (event.data && event.data.type === 'PRECACHE_DONE') {
                    dlog('SW precache: ' + event.data.count + '/' + event.data.total + ' tiles cached', 'cache');
                }
            });
        }

        // ─────────────────────────────────────────────
        //  CONNECTIVITY PROBE
        // ─────────────────────────────────────────────
        // navigator.onLine is unreliable on iOS — it returns true whenever any
        // network interface exists, including when data is too weak to complete
        // a request. This causes the app to attempt API fetches that hang
        // indefinitely on spotty signal, locking up the UI instead of falling
        // back to cached data. isReallyOnline() probes with a real HEAD request
        // and a timeout so the app behaves correctly even in poor signal.
        async function isReallyOnline(timeoutMs) {
            timeoutMs = timeoutMs || 4000;
            if (!navigator.onLine) return false;
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), timeoutMs);
                // Google's generate_204 endpoint — tiny, fast, CORS-safe, no-cache
                await fetch('https://www.gstatic.com/generate_204', {
                    method: 'HEAD', mode: 'no-cors', cache: 'no-store',
                    signal: ctrl.signal
                });
                clearTimeout(timer);
                return true;
            } catch (e) {
                dlog('Connectivity probe failed: ' + (e.name || e.message), 'warn');
                return false;
            }
        }

        // Listen for online/offline transitions
        window.addEventListener('online', async () => {
            // iOS fires 'online' the instant the interface comes up, before data
            // routing is actually restored. The first probe often fails. Retry
            // once after a short delay before giving up and staying in offline mode.
            dlog('Network: online event received — probing connectivity', 'info');
            let really = await isReallyOnline(3000);
            if (!really) {
                dlog('Network: first probe failed — retrying in 2.5s', 'warn');
                await new Promise(r => setTimeout(r, 2500));
                really = await isReallyOnline(4000);
            }
            if (really) {
                dlog('Network: back ONLINE (probe confirmed)', 'ok');
                setOnlineUI();
            } else {
                dlog('Network: probe failed after retry — staying offline', 'warn');
            }
        });
        window.addEventListener('offline', () => {
            dlog('Network: went OFFLINE', 'warn');
            const loaded = loadOfflineCache();
            if (loaded && map) { initMap(); applyView(); }
            setOfflineUI();
        });

        // ─────────────────────────────────────────────
        //  INIT
        // ─────────────────────────────────────────────
        function initApp() {
            dlog('NAM ' + APP_VERSION + ' started — ' + navigator.userAgent.slice(0, 60), 'info');
            dlog('Online: ' + navigator.onLine + ' | Platform: ' + (navigator.platform || 'unknown'), 'info');
            document.documentElement.setAttribute('data-theme', localStorage.getItem('nam_theme') || 'dark');

            const cached = localStorage.getItem('nam_life_list');
            const cachedTime = parseInt(localStorage.getItem('nam_life_list_time') || '0', 10);
            if (cached && (Date.now() - cachedTime < LIFE_CACHE_TTL)) {
                fullLifeList = JSON.parse(cached);
                fullWantedList = fullLifeList.filter(r => !isSeen(r));
                updateLifeListBar();
            }

            if (localStorage.getItem('nam_scanned')) {
                const hint = document.getElementById('scanHint');
                if (hint) hint.style.display = 'none';
            }

            attachListeners();
            updateBirdToggles();

            // On startup, probe real connectivity rather than trusting navigator.onLine.
            // Spotty signal returns onLine=true but requests hang — probing first means
            // the app loads cached data immediately instead of locking up on failed fetches.
            isReallyOnline(4000).then(online => {
                if (!online) {
                    dlog('Startup: offline or unreachable — loading cache', 'warn');
                    const loaded = loadOfflineCache();
                    if (loaded) { setTimeout(() => { initMap(); applyView(); setOfflineUI(); }, 300); }
                } else {
                    dlog('Startup: online confirmed', 'ok');
                }
            });
        }

        // ─────────────────────────────────────────────
        //  LISTENERS
        // ─────────────────────────────────────────────
        function attachListeners() {
            document.getElementById('configHeader').addEventListener('click', toggleCollapsible);
            document.getElementById('aboutHeader').addEventListener('click', toggleAboutCard);
            document.getElementById('btnResetGPS').addEventListener('click', () => getGPS(true));
            document.getElementById('btnSetLoc').addEventListener('click', promptLocation);
            document.getElementById('toggleEbird').addEventListener('click', () => toggleGlobalToggle('ebird'));
            document.getElementById('btnSync').addEventListener('click', forceSheetSync);
            document.getElementById('btnTheme').addEventListener('click', toggleTheme);
            document.getElementById('btnReload').addEventListener('click', () => location.reload(true));
            // Debug panel listeners
            const _dbgBtn = document.getElementById('btnDebug');
            const _dbgCopy = document.getElementById('debugCopyBtn');
            const _dbgClear = document.getElementById('debugClearBtn');
            if (_dbgBtn) _dbgBtn.addEventListener('click', toggleDebugPanel);
            if (_dbgCopy) _dbgCopy.addEventListener('click', () => {
                const text = _debugBuffer.map(e => e.ts + ' [' + e.type.toUpperCase() + '] ' + e.msg).join('\n');
                navigator.clipboard.writeText(text).then(() => {
                    _dbgCopy.textContent = '✅ Copied!';
                    setTimeout(() => { _dbgCopy.textContent = '📋 Copy'; }, 2000);
                }).catch(() => {
                    const ta = document.createElement('textarea');
                    ta.value = text; document.body.appendChild(ta); ta.select();
                    document.execCommand('copy'); document.body.removeChild(ta);
                });
            });
            if (_dbgClear) _dbgClear.addEventListener('click', () => {
                _debugBuffer.length = 0;
                const log = document.getElementById('debugLog'); if (log) log.innerHTML = '';
            });

            document.getElementById('mapBtnEbird').addEventListener('click', () => {
                if (activeTaxon !== 3) return;
                toggleGlobalToggle('ebird');
                document.getElementById('mapBtnEbird').classList.toggle('overlay-active', globalToggles.ebird);
            });
            document.getElementById('mapBtnSetLoc').addEventListener('click', promptLocation);
            document.getElementById('mapBtnResetGPS').addEventListener('click', () => getGPS(true));
            document.getElementById('mapBtnGeo').addEventListener('click', () => {
                const btn = document.getElementById('mapBtnGeo'), select = document.getElementById('mapType');
                if (btn.classList.contains('geo-active')) {
                    btn.classList.remove('geo-active'); changeMapType('none'); const cur = BASEMAP_CYCLE[basemapIndex]; select.value = cur; changeMapType(cur);
                    document.getElementById('geoOpacityFloat').classList.remove('visible');
                } else {
                    btn.classList.add('geo-active'); select.value = 'geology_macro'; changeMapType('geology_macro');
                    document.getElementById('geoOpacityFloat').classList.add('visible');
                }
            });

            document.getElementById('mapBtnParcel').addEventListener('click', toggleParcelLayer);
            document.getElementById('mapBtnBasemap').addEventListener('click', cycleBasemap);

            document.getElementById('radius').addEventListener('input', e => { document.getElementById('radiusChip').textContent = e.target.value + ' mi'; });
            document.getElementById('radiusChip').addEventListener('click', () => {
                document.getElementById('radiusChip').style.display = 'none';
                const inp = document.getElementById('radiusInput');
                inp.style.display = 'block'; inp.value = document.getElementById('radius').value; inp.focus(); inp.select();
            });
            function commitRadiusInput() {
                const inp = document.getElementById('radiusInput');
                let val = Math.min(30, Math.max(1, parseInt(inp.value, 10) || 1));
                document.getElementById('radius').value = val;
                document.getElementById('radiusChip').textContent = val + ' mi';
                inp.style.display = 'none'; document.getElementById('radiusChip').style.display = '';
            }
            document.getElementById('radiusInput').addEventListener('keydown', e => {
                if (e.key === 'Enter') commitRadiusInput();
                if (e.key === 'Escape') { document.getElementById('radiusInput').style.display = 'none'; document.getElementById('radiusChip').style.display = ''; }
            });
            document.getElementById('radiusInput').addEventListener('blur', commitRadiusInput);

            document.getElementById('gearBtn').addEventListener('click', () => {
                const c = document.getElementById('collapsibleContent');
                if (!c.classList.contains('open')) { c.classList.add('open'); document.getElementById('collapsibleChevron').classList.add('rotated'); }
                setTimeout(() => document.getElementById('advancedConfig').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
            });

            document.getElementById('mapType').addEventListener('change', e => changeMapType(e.target.value));
            document.getElementById('overlayOpacity').addEventListener('input', e => updateOverlayOpacity(e.target.value));
            document.getElementById('geoOpacityFloatSlider').addEventListener('input', e => {
                document.getElementById('overlayOpacity').value = e.target.value;
                document.getElementById('geoOpacityFloatLabel').textContent = e.target.value + '%';
                updateOverlayOpacity(e.target.value);
            });

            document.getElementById('taxaBar').addEventListener('click', e => {
                const chip = e.target.closest('.chip'); if (!chip) return;
                const raw = chip.dataset.taxon;
                activeTaxon = (raw === 'null') ? null : parseInt(raw, 10);
                activeFilter = null; globalToggles.ebird = false; globalToggles.wanted = false; globalToggles.notable = false;
                document.getElementById('toggleEbird').classList.remove('ebird-active');
                document.getElementById('btnWantedList').classList.remove('wanted-btn-active');
                document.getElementById('btnNotableList').classList.remove('notable-btn-active');
                const mapEb = document.getElementById('mapBtnEbird');
                if (mapEb) mapEb.classList.remove('overlay-active');
                document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active'); updateBirdToggles(); triggerScan();
            });

            document.getElementById('scanBtn').addEventListener('click', triggerScan);
            document.getElementById('speciesHeader').addEventListener('click', () => { document.getElementById('speciesCollapse').classList.toggle('open'); document.getElementById('speciesChevron').classList.toggle('rotated'); });
            document.getElementById('resultsHeader').addEventListener('click', () => { document.getElementById('resultsCollapse').classList.toggle('open'); document.getElementById('resultsChevron').classList.toggle('rotated'); });
            document.getElementById('locationHeader').addEventListener('click', e => {
                if (e.target.closest('#sortToggleBtn')) return;
                document.getElementById('locationCollapse').classList.toggle('open'); document.getElementById('locationChevron').classList.toggle('rotated');
            });
            document.getElementById('galleryBtn').addEventListener('click', e => { e.stopPropagation(); openGallery(); });
            document.getElementById('galleryCloseBtn').addEventListener('click', closeGallery);
            document.getElementById('sortToggleBtn').addEventListener('click', toggleLocSort);
            document.getElementById('btnWantedList').addEventListener('click', () => toggleGlobalToggle('wanted'));
            document.getElementById('btnNotableList').addEventListener('click', () => toggleGlobalToggle('notable'));
            document.getElementById('btnJumpHeat').addEventListener('click', () => smartJump('speciesScrollTarget'));
            document.getElementById('btnJumpLoc').addEventListener('click', () => smartJump('locationScrollTarget'));
            document.getElementById('btnJumpList').addEventListener('click', () => smartJump('resultsScrollTarget'));
            document.getElementById('actionCircle').addEventListener('click', handleActionClick);
            document.getElementById('btnCancelLoc').addEventListener('click', closeLocModal);
            document.getElementById('btnSubmitLoc').addEventListener('click', submitLocModal);
            document.getElementById('quickChips').addEventListener('click', e => {
                const chip = e.target.closest('.quick-chip'); if (!chip) return;
                if (chip.dataset.lat && chip.dataset.lng) {
                    // Pinned coords — bypass geocoding entirely (avoids ambiguous city names)
                    const lat = parseFloat(chip.dataset.lat), lng = parseFloat(chip.dataset.lng);
                    userCoords = { lat, lng, name: chip.dataset.loc };
                    closeLocModal(); isInitialLoad = true; updateAboutLocationEcho();
                    if (typeof Telemetry !== 'undefined') Telemetry.event('location_set', { method: 'pinned', name: chip.dataset.loc, lat, lng });
                    const _dur = 0.6;
                    if (map) map.flyTo([lat, lng], 13, { duration: _dur, easeLinearity: 0.4 });
                    setTimeout(() => runScan({ coords: { latitude: lat, longitude: lng } }), Math.round(_dur * 1000) + 200);
                } else {
                    document.getElementById('locInput').value = chip.dataset.loc; submitLocModal();
                }
            });
            document.getElementById('locInput').addEventListener('keydown', e => { if (e.key === 'Enter') submitLocModal(); });
            // zoomOverlay click removed — X button (zoomCloseBtn) handles close

            // Life List bar (replaces dock button)
            document.getElementById('lifeListBar').addEventListener('click', openLifeList);
            document.getElementById('llCloseBtn').addEventListener('click', closeLifeList);
            document.getElementById('llSearch').addEventListener('input', e => { llQuery = e.target.value.trim().toLowerCase(); document.getElementById('llClearSearch').classList.toggle('visible', llQuery.length > 0); renderLifeList(); });
            document.getElementById('llClearSearch').addEventListener('click', () => { document.getElementById('llSearch').value = ''; llQuery = ''; document.getElementById('llClearSearch').classList.remove('visible'); document.getElementById('llSearch').focus(); renderLifeList(); });
            ['llBtnAll', 'llBtnSeen', 'llBtnUnseen'].forEach(id => {
                document.getElementById(id).addEventListener('click', () => {
                    llFilter = document.getElementById(id).dataset.filter;
                    document.querySelectorAll('.ll-filter-btn').forEach(b => b.classList.remove('active-all', 'active-seen', 'active-unseen'));
                    document.getElementById(id).classList.add('active-' + llFilter);
                    renderLifeList();
                });
            });
        }

        // ─────────────────────────────────────────────
        //  SCAN PROGRESS UI
        // ─────────────────────────────────────────────
        function showScanProgress(showEbird) {
            document.getElementById('scanProgress').style.display = 'block';
            document.getElementById('status').style.display = 'none';
            ['Wanted', 'Inat', 'Ebird'].forEach(s => { setSpDot(s.toLowerCase(), 'waiting'); document.getElementById('spStatus' + s).textContent = 'Waiting…'; document.getElementById('spCount' + s).textContent = ''; });
            document.getElementById('spRowEbird').style.display = showEbird ? 'flex' : 'none';
            setSpProgress(0); setSpTicker('Initializing…', false);
            document.getElementById('spLabel').textContent = 'SCANNING…'; document.getElementById('spSublabel').textContent = 'Fetching observations';
        }
        function hideScanProgress() { document.getElementById('scanProgress').style.display = 'none'; }
        function setSpDot(source, state) { const dot = document.getElementById('spDot' + source.charAt(0).toUpperCase() + source.slice(1)); if (dot) dot.className = 'sp-dot ' + state; }
        function setSpStatus(source, text, count) { const s = source.charAt(0).toUpperCase() + source.slice(1); const el = document.getElementById('spStatus' + s); if (el) el.textContent = text; if (count !== undefined) { const c = document.getElementById('spCount' + s); if (c) c.textContent = count; } }
        function setSpProgress(pct) { document.getElementById('spProgressBar').style.width = pct + '%'; }
        function setSpTicker(text, live) { const el = document.getElementById('spTicker'); el.textContent = text; el.className = live ? 'live' : ''; }
        function setSpSublabel(text) { document.getElementById('spSublabel').textContent = text; }

        // ─────────────────────────────────────────────
        //  COLLAPSIBLE / ABOUT
        // ─────────────────────────────────────────────
        function toggleCollapsible() { document.getElementById('collapsibleContent').classList.toggle('open'); document.getElementById('collapsibleChevron').classList.toggle('rotated'); }
        function toggleAboutCard() {
            const content = document.getElementById('aboutContent'); content.classList.toggle('open'); document.getElementById('aboutChevron').classList.toggle('rotated');
            if (content.classList.contains('open') && !userCoords) getGPS(false); else if (userCoords) updateAboutLocationEcho();
        }
        function updateAboutLocationEcho() {
            if (!userCoords) return;
            const { lat, lng } = userCoords;
            document.getElementById('locStatusMsg').style.display = 'none'; document.getElementById('locDetails').style.display = 'block';
            document.getElementById('echoLat').innerText = lat.toFixed(6); document.getElementById('echoLng').innerText = lng.toFixed(6);
            document.getElementById('linkWeather').href = `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lng}`;
            document.getElementById('linkWindy').href = `https://www.windy.com/${lat}/${lng}?${lat},${lng},8,p:cities`;
            document.getElementById('linkWiki').href = `https://en.wikipedia.org/wiki/Special:Nearby?lat=${lat}&lon=${lng}`;
            document.getElementById('linkGMap').href = `https://www.google.com/maps?q=${lat},${lng}`;
            document.getElementById('linkINat').href = `https://www.inaturalist.org/observations?lat=${lat}&lng=${lng}`;
            document.getElementById('linkMacro').href = `https://macrostrat.org/map/loc/${lng}/${lat}#x=${lng}&y=${lat}&z=10`;
            document.getElementById('linkNatMap').href = `https://apps.nationalmap.gov/viewer/#/center/${lng},${lat}/zoom/13`;
            document.getElementById('linkOSM').href = `https://www.openstreetmap.org/#map=16/${lat}/${lng}`;
            const b = 0.05; document.getElementById('linkTrails').href = `https://www.alltrails.com/explore?b_tl_lat=${(lat + b).toFixed(2)}&b_tl_lng=${(lng - b).toFixed(2)}&b_br_lat=${(lat - b).toFixed(2)}&b_br_lng=${(lng + b).toFixed(2)}`;
        }
        function toggleTheme() { const t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'; document.documentElement.setAttribute('data-theme', t); localStorage.setItem('nam_theme', t); }
        function promptLocation() { document.getElementById('locModal').style.display = 'block'; document.getElementById('locInput').focus(); }
        function closeLocModal() { document.getElementById('locModal').style.display = 'none'; }
        // Calculate appropriate map animation duration based on distance
        // Short hops get smooth animation, long jumps get near-instant snap
        function _flyDuration(lat1, lng1, lat2, lng2) {
            const R = 3958.8; // miles
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLng = (lng2 - lng1) * Math.PI / 180;
            const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                      Math.sin(dLng/2) * Math.sin(dLng/2);
            const miles = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            if (miles < 5)   return 1.2;  // local — smooth
            if (miles < 30)  return 0.9;  // nearby — quick
            if (miles < 150) return 0.6;  // regional — fast
            return 0.4;                   // far away — snap with just a hint
        }

        async function submitLocModal() {
            const input = document.getElementById('locInput').value.trim(); if (!input) return;
            if (!navigator.onLine) { closeLocModal(); return; }

            // Show searching state on the button
            const submitBtn = document.getElementById('btnSubmitLoc');
            const origText = submitBtn.textContent;
            submitBtn.textContent = '🔍 Searching…';
            submitBtn.disabled = true;

            closeLocModal();

            // Clear any previous error message
            const _prevErr = document.getElementById('locError');
            if (_prevErr) _prevErr.textContent = '';

            try {
                const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(input)}.json?access_token=${MAPBOX_TOKEN}&limit=1&country=us`);
                if (!res.ok) throw new Error('Mapbox HTTP ' + res.status);
                const json = await res.json();
                const data = json.features || [];

                if (data.length > 0) {
                    const [lng, lat] = data[0].center;
                    userCoords = { lat, lng, name: data[0].text };
                    isInitialLoad = true; updateAboutLocationEcho();
                    dlog('Geocode OK: ' + userCoords.name + ' ' + lat.toFixed(4) + ',' + lng.toFixed(4), 'ok');
                    if (typeof Telemetry !== 'undefined') Telemetry.event('location_set', { method: 'geocode', name: userCoords.name, lat: parseFloat(lat.toFixed(4)), lng: parseFloat(lng.toFixed(4)) });
                    if (document.getElementById('collapsibleContent').classList.contains('open')) toggleCollapsible();
                    const _dur = userCoords ? _flyDuration(userCoords.lat, userCoords.lng, lat, lng) : 0.6;
                    setTimeout(() => { if (map) map.flyTo([lat, lng], 13, { duration: _dur, easeLinearity: 0.4 }); }, 100);
                    setTimeout(() => { runScan({ coords: { latitude: lat, longitude: lng } }); }, Math.round(_dur * 1000) + 200);
                } else {
                    dlog('Geocode failed: no results for "' + input + '"', 'warn');
                    // Re-open modal with error message
                    document.getElementById('locInput').value = input;
                    const modal = document.getElementById('locModal');
                    modal.style.display = 'block';
                    // Show inline error below input
                    let errEl = document.getElementById('locError');
                    if (!errEl) {
                        errEl = document.createElement('div');
                        errEl.id = 'locError';
                        errEl.style.cssText = 'color:#ef4444;font-size:12px;font-weight:800;margin:-10px 0 10px 0;text-align:center;';
                        document.getElementById('locInput').insertAdjacentElement('afterend', errEl);
                    }
                    errEl.textContent = '⚠️ Location not found — try a different search or add a state/country.';
                    document.getElementById('locInput').focus();
                    document.getElementById('locInput').select();
                }
            } catch (e) {
                dlog('Mapbox geocoding error: ' + e.message, 'error');
                document.getElementById('locModal').style.display = 'block';
                let errEl = document.getElementById('locError');
                if (!errEl) {
                    errEl = document.createElement('div');
                    errEl.id = 'locError';
                    errEl.style.cssText = 'color:#ef4444;font-size:12px;font-weight:800;margin:-10px 0 10px 0;text-align:center;';
                    document.getElementById('locInput').insertAdjacentElement('afterend', errEl);
                }
                errEl.textContent = '⚠️ Search failed — check your connection and try again.';
            } finally {
                submitBtn.textContent = origText;
                submitBtn.disabled = false;
            }
        }
        async function triggerScan() {
            // Use real connectivity probe — navigator.onLine is true on iOS even
            // with weak signal that can't complete a fetch, causing silent hangs.
            const online = await isReallyOnline(4000);
            if (!online) {
                dlog('triggerScan: offline — loading from cache', 'warn');
                loadOfflineCache();
                if (map) { initMap(); applyView(); }
                setOfflineUI();
                return;
            }
            if (userCoords) runScan({ coords: { latitude: userCoords.lat, longitude: userCoords.lng } }); else getGPS(false);
        }
        function getGPS(forceReset) {
            if (forceReset) { userCoords = null; activeFilter = null; isInitialLoad = true; if (document.getElementById('collapsibleContent').classList.contains('open')) toggleCollapsible(); }
            navigator.geolocation.getCurrentPosition(
                async pos => {
                    const lat = pos.coords.latitude, lng = pos.coords.longitude;
                    userCoords = { lat, lng, name: 'GPS' }; updateAboutLocationEcho();
                    dlog('GPS acquired: ' + lat.toFixed(4) + ', ' + lng.toFixed(4) + ' acc=' + Math.round(pos.coords.accuracy) + 'm', 'ok');

                    // Probe real connectivity — GPS works offline but navigator.onLine
                    // may be true with weak signal. Probe first to decide which path.
                    const online = await isReallyOnline(4000);

                    if (typeof Telemetry !== 'undefined') Telemetry.event('gps_acquired', {
                        lat: parseFloat(lat.toFixed(4)),
                        lng: parseFloat(lng.toFixed(4)),
                        accuracy_m: Math.round(pos.coords.accuracy),
                        offline: !online
                    });

                    if (!online) {
                        // Offline — just move the white dot and pan to current position,
                        // no scan, no zoom change, markers and cached data untouched
                        dlog('GPS reset offline — repositioning marker only', 'info');
                        if (map) {
                            // Move user marker to new position
                            if (userMarker) {
                                userMarker.setLatLng([lat, lng]);
                            } else {
                                const userIcon = L.divIcon({ className: 'custom-div-icon', html: "<div class='user-location-marker'></div>", iconSize: [22, 22], iconAnchor: [11, 11] });
                                userMarker = L.marker([lat, lng], { icon: userIcon, draggable: true, zIndexOffset: 1000 }).addTo(map);
                                userMarker.on('dragend', e => { const p = e.target.getLatLng(); userCoords = { lat: p.lat, lng: p.lng, name: 'Custom Point' }; updateAboutLocationEcho(); });
                            }
                            // Pan to new position at current zoom — no zoom change to preserve cached tiles
                            map.panTo([lat, lng], { animate: true, duration: 1.5 });
                        }
                        return;
                    }

                    // Online confirmed — full reset and rescan as before
                    if (forceReset && map) {
                        const _gpsDur = userCoords ? _flyDuration(userCoords.lat, userCoords.lng, lat, lng) : 0.6;
                        setTimeout(() => { map.flyTo([lat, lng], 13, { duration: _gpsDur, easeLinearity: 0.4 }); }, 100);
                        setTimeout(() => { runScan(pos); }, Math.round(_gpsDur * 1000) + 200);
                    } else {
                        runScan(pos);
                    }
                },
                err => {
                    dlog('GPS error: ' + err.message, 'warn');
                    if (!navigator.onLine) return; // offline GPS fail — silent, don't clobber cached data
                    runScan({ coords: { latitude: 32.7357, longitude: -97.1081 } });
                },
                { enableHighAccuracy: true }
            );
        }

        // ─────────────────────────────────────────────
        //  SHEET SYNC  — stores full life list + derives wanted subset
        // ─────────────────────────────────────────────
        async function forceSheetSync() {
            // Clear cache so fetch is always fresh
            dlog('Sheet sync started', 'info');
            localStorage.removeItem('nam_life_list');
            localStorage.removeItem('nam_life_list_time');
            fullLifeList = [];
            fullWantedList = [];
            const btn = document.getElementById('btnSync');
            const origText = btn.innerHTML;
            btn.innerHTML = '<span>⏳</span><span>SYNCING…</span>';
            btn.disabled = true;
            const _t0sheet = performance.now();
            try {
                const res = await fetch(GOOGLE_SHEET_URL); const json = await res.json();
                const _sheetMs = Math.round(performance.now() - _t0sheet);
                fullLifeList = json;
                fullWantedList = json.filter(row => !isSeen(row));
                localStorage.setItem('nam_life_list', JSON.stringify(fullLifeList));
                localStorage.setItem('nam_life_list_time', Date.now().toString());
                updateLifeListBar();
                dlog('Sheet sync OK: ' + json.length + ' species in ' + _sheetMs + 'ms', 'ok');
                dlog('Sheet sync OK: ' + fullLifeList.length + ' species', 'ok');
                if (typeof Telemetry !== 'undefined') Telemetry.event('sheet_sync', {
                    duration_ms: _sheetMs, species_count: json.length,
                    lat: userCoords ? parseFloat(userCoords.lat.toFixed(4)) : null,
                    lng: userCoords ? parseFloat(userCoords.lng.toFixed(4)) : null
                });
                btn.innerHTML = '<span>✅</span><span>SYNCED!</span>';
                updateLLSeenCount();
                // Re-scan with fresh data if we already have a location
                if (userCoords) setTimeout(() => triggerScan(), 600);
            } catch (e) {
                const _sheetMs = Math.round(performance.now() - _t0sheet);
                dlog('Sheet sync FAILED: ' + e.message, 'error');
                dlog('Sheet sync FAILED', 'error');
                if (typeof Telemetry !== 'undefined') Telemetry.error('sheet_sync_failed', e, { duration_ms: _sheetMs });
                btn.innerHTML = '<span>❌</span><span>FAILED</span>';
            }
            setTimeout(() => { btn.innerHTML = origText; btn.disabled = false; }, 2500);
        }

        // ─────────────────────────────────────────────
        //  FETCH — iNat attaches sheet_link from fullLifeList
        // ─────────────────────────────────────────────
        async function fetchINat(lat, lng, dist, dateStr) {
            setSpDot('inat', 'active'); setSpStatus('inat', 'Connecting…'); setStat('inat', 'active');
            dlog('iNat fetch: lat=' + lat.toFixed(4) + ' lng=' + lng.toFixed(4) + ' r=' + dist + 'mi taxon=' + activeTaxon, 'info');
            const _t0inat = performance.now();
            try {
                const url = `https://api.inaturalist.org/v1/observations?lat=${lat}&lng=${lng}&radius=${dist}&d1=${dateStr}&per_page=150${activeTaxon ? '&taxon_id=' + activeTaxon : ''}`;
                const res = await fetch(url);
                if (!res.ok) throw new Error('iNat HTTP ' + res.status);
                const text = await res.text();
                if (!text.trim()) throw new Error('iNat: empty response');
                let json;
                try { json = JSON.parse(text); } catch (je) { dlog('iNat raw: ' + text.slice(0, 80), 'error'); throw new Error('iNat JSON invalid: ' + je.message); }
                if (!json.results) { dlog('iNat raw: ' + text.slice(0, 80), 'error'); throw new Error('iNat: no results field in response'); }
                const results = json.results.map(obs => {
                    const latin = (obs.taxon?.name || '').toLowerCase();
                    const sheetRow = fullLifeList.find(w => (w.Latin2 || w.latin2 || '').toLowerCase() === latin);
                    return {
                        id: 'inat-' + obs.id, source: 'iNat',
                        common_name: obs.taxon?.preferred_common_name || obs.taxon?.name,
                        sci_name: obs.taxon?.name, location_str: obs.place_guess || 'Private',
                        photo: obs.photos?.[0]?.url.replace('square', 'small') ?? null,
                        is_wanted: fullWantedList.some(w => (w.Latin2 || w.latin2 || '').toLowerCase() === latin),
                        sheet_link: sheetRow && hasPhoto(sheetRow) ? (sheetRow.Link || sheetRow.link) : null,
                        lat: parseFloat(obs.location.split(',')[0]), lng: parseFloat(obs.location.split(',')[1]),
                        is_notable: (obs.quality_grade === 'research' && obs.threatened),
                        is_obscured: (obs.geoprivacy === 'obscured' || obs.taxon_geoprivacy === 'obscured'),
                        is_private: (obs.geoprivacy === 'private'),
                        uri: obs.uri, date: obs.observed_on_string
                    };
                });
                const _inatMs = Math.round(performance.now() - _t0inat);
                setSpDot('inat', 'done'); setSpStatus('inat', 'Done', results.length + ' obs'); setStat('inat', 'done'); setSpProgress(50);
                dlog('iNat OK: ' + results.length + ' obs in ' + _inatMs + 'ms', 'ok');
                if (typeof Telemetry !== 'undefined') Telemetry.event('inat_fetch', {
                    duration_ms: _inatMs, obs_count: results.length,
                    taxon: activeTaxon, radius_mi: parseInt(dist),
                    lat: parseFloat(lat.toFixed(4)), lng: parseFloat(lng.toFixed(4))
                });
                const notable = results.find(r => r.common_name);
                if (notable) setSpTicker(notable.common_name + (notable.location_str ? ' · ' + notable.location_str : ''), true);
                return results;
            } catch (e) {
                const _inatMs = Math.round(performance.now() - _t0inat);
                dlog('iNat FAILED: ' + e.message, 'error');
                if (typeof Telemetry !== 'undefined') Telemetry.error('inat_fetch_failed', e, { duration_ms: _inatMs, lat: parseFloat(lat.toFixed(4)), lng: parseFloat(lng.toFixed(4)) });
                setSpDot('inat', 'waiting'); setSpStatus('inat', 'Failed'); setStat('inat', ''); return [];
            }
        }

        async function fetchEBird(lat, lng, dist) {
            setSpDot('ebird', 'active'); setSpStatus('ebird', 'Connecting…'); setStat('ebird', 'active');
            dlog('eBird fetch started', 'info');
            const _t0ebird = performance.now();
            try {
                // Sequential fetches — parallel requests to same PHP proxy can cause race conditions
                const _t0recent = performance.now();
                const recentRes = await fetch(`/api/ebird-proxy?lat=${lat}&lng=${lng}&dist=${dist}&mode=recent`);
                if (!recentRes.ok) throw new Error('eBird recent HTTP ' + recentRes.status);
                const _t0notable = performance.now();
                const notableRes = await fetch(`/api/ebird-proxy?lat=${lat}&lng=${lng}&dist=${dist}&mode=notable`);
                const _recentMs = Math.round(_t0notable - _t0recent);
                const recentText = await recentRes.text();
                if (!recentText.trim()) throw new Error('eBird recent: empty response from proxy');
                let recentData;
                try { recentData = JSON.parse(recentText); } catch (je) { dlog('eBird recent raw: ' + recentText.slice(0, 80), 'error'); throw new Error('eBird recent JSON invalid: ' + je.message); }
                // Notable is best-effort — empty or failed response just means no notables, don't kill the whole fetch
                let notableIds = new Set();
                let _notableMs = 0, _notableCount = 0;
                try {
                    if (notableRes.ok) {
                        const notableText = await notableRes.text();
                        _notableMs = Math.round(performance.now() - _t0notable);
                        if (notableText.trim()) {
                            const notableData = JSON.parse(notableText);
                            notableIds = new Set(Array.isArray(notableData) ? notableData.map(n => n.subId + '|' + (n.speciesCode || n.sciName || '')) : []);
                            _notableCount = notableIds.size;
                            dlog('eBird notable: ' + notableIds.size + ' notable sightings in ' + _notableMs + 'ms', 'info');
                        } else { dlog('eBird notable: empty response (no notables)', 'info'); }
                    } else { dlog('eBird notable HTTP ' + notableRes.status + ' (ignored)', 'warn'); }
                } catch (ne) { dlog('eBird notable parse failed (ignored): ' + ne.message, 'warn'); }
                const results = recentData.map(obs => {
                    const latin = (obs.sciName || '').toLowerCase();
                    const sheetRow = fullLifeList.find(w => (w.Latin2 || w.latin2 || '').toLowerCase() === latin);
                    return {
                        id: 'ebird-' + obs.subId + '|' + (obs.speciesCode || obs.sciName || ''), source: 'eBird', common_name: obs.comName, sci_name: obs.sciName,
                        location_str: obs.locName || 'Private', photo: null,
                        is_wanted: fullWantedList.some(w => (w.Latin2 || w.latin2 || '').toLowerCase() === latin),
                        sheet_link: sheetRow && hasPhoto(sheetRow) ? (sheetRow.Link || sheetRow.link) : null,
                        lat: parseFloat(obs.lat), lng: parseFloat(obs.lng),
                        is_notable: notableIds.has(obs.subId + '|' + (obs.speciesCode || obs.sciName || '')),
                        is_obscured: (obs.locationPrivate === true || (obs.locName?.includes('Private') ?? false)),
                        is_private: false, uri: `https://ebird.org/checklist/${obs.subId}`, date: obs.obsDt
                    };
                });
                const _ebirdTotalMs = Math.round(performance.now() - _t0ebird);
                setSpDot('ebird', 'done'); setSpStatus('ebird', 'Done', results.length + ' obs'); setStat('ebird', 'done'); setSpProgress(75);
                dlog('eBird done: ' + results.length + ' obs in ' + _ebirdTotalMs + 'ms (recent=' + _recentMs + 'ms notable=' + _notableMs + 'ms)', 'ok');
                if (typeof Telemetry !== 'undefined') Telemetry.event('ebird_fetch', {
                    duration_ms: _ebirdTotalMs, recent_ms: _recentMs, notable_ms: _notableMs,
                    obs_count: results.length, notable_count: _notableCount,
                    radius_mi: parseInt(dist),
                    lat: parseFloat(lat.toFixed(4)), lng: parseFloat(lng.toFixed(4))
                });
                return results;
            } catch (e) {
                const _ebirdTotalMs = Math.round(performance.now() - _t0ebird);
                dlog('eBird FAILED: ' + e.message, 'error');
                if (typeof Telemetry !== 'undefined') Telemetry.error('ebird_fetch_failed', e, { duration_ms: _ebirdTotalMs, lat: parseFloat(lat.toFixed(4)), lng: parseFloat(lng.toFixed(4)) });
                setSpDot('ebird', 'waiting'); setSpStatus('ebird', 'Failed'); setStat('ebird', ''); return [];
            }
        }

        // ─────────────────────────────────────────────
        //  SCAN ORCHESTRATOR
        // ─────────────────────────────────────────────
        async function runScan(pos) {
            dlog('Scan started lat=' + pos.coords.latitude.toFixed(4) + ' lng=' + pos.coords.longitude.toFixed(4), 'info');
            // Guard: re-probe connectivity at scan time. triggerScan already checked,
            // but runScan can also be called directly (marker drag, geocode, etc.)
            // so verify again rather than assuming the caller confirmed online status.
            const online = await isReallyOnline(4000);
            if (!online) {
                const loaded = loadOfflineCache();
                if (loaded) { setTimeout(() => { initMap(); applyView(); }, 100); }
                return;
            }
            // Connectivity confirmed — ensure offline banner and disabled UI are cleared.
            // This handles the case where the online event probe failed (iOS slow routing
            // restore after airplane mode) but a user-triggered scan succeeds.
            setOnlineUI();
            const _t0scan = performance.now();
            const lat = pos.coords.latitude, lng = pos.coords.longitude;
            userCoords = { lat, lng, name: userCoords?.name || 'GPS' }; updateAboutLocationEcho();
            const dist = document.getElementById('radius').value;
            const dateStr = new Date(Date.now() - 604800000).toISOString().split('T')[0];
            const useEbird = (activeTaxon === 3 || activeTaxon === null);
            showScanProgress(useEbird); setSpProgress(5);

            const wantedFresh = fullLifeList.length > 0;
            if (wantedFresh) { setSpDot('wanted', 'done'); setSpStatus('wanted', 'Cached', fullWantedList.length + ' targets'); setStat('wanted', 'done'); setSpProgress(15); }

            const fetchPromises = [wantedFresh ? Promise.resolve() : forceSheetSync(), fetchINat(lat, lng, dist, dateStr)];
            if (useEbird) fetchPromises.push(fetchEBird(lat, lng, dist));
            setSpSublabel(useEbird ? 'iNaturalist + eBird running in parallel…' : 'iNaturalist running…');

            const results = await Promise.all(fetchPromises);
            // Re-derive wanted + sheet_link after sheet sync may have populated fullLifeList for first time
            const rederive = o => {
                const latin = (o.sci_name || '').toLowerCase();
                const sheetRow = fullLifeList.find(w => (w.Latin2 || w.latin2 || '').toLowerCase() === latin);
                return {
                    ...o,
                    is_wanted: fullWantedList.some(w => (w.Latin2 || w.latin2 || '').toLowerCase() === latin),
                    sheet_link: sheetRow && hasPhoto(sheetRow) ? (sheetRow.Link || sheetRow.link) : null
                };
            };
            rawData = [...(results[1] || []).map(rederive), ...(results[2] || []).map(rederive)]
                .sort((a, b) => new Date(b.date) - new Date(a.date));

            // Auto-save to offline cache — always overwrite with latest scan
            try {
                localStorage.setItem(OBS_CACHE_KEY, JSON.stringify({
                    observations: rawData,
                    location: userCoords,
                    taxon: activeTaxon,
                    timestamp: Date.now(),
                    maxZoom: maxCachedZoom
                }));
            } catch (e) { dlog('Obs cache write FAILED: ' + e.message, 'error'); }

            setSpProgress(100);
            const _scanMs = Math.round(performance.now() - _t0scan);
            dlog('Scan complete: ' + rawData.length + ' obs in ' + _scanMs + 'ms', 'ok');
            const targets = rawData.filter(r => r.is_wanted).length;
            document.getElementById('spLabel').textContent = 'SCAN COMPLETE'; setSpSublabel('Complete');
            if (targets > 0) setSpTicker(`${targets} wanted species found!`, true); else setSpTicker(`${rawData.length} observations loaded`, false);
            if (typeof Telemetry !== 'undefined') Telemetry.event('scan_complete', {
                duration_ms: _scanMs,
                obs_count: rawData.length,
                wanted_count: targets,
                taxon: activeTaxon,
                radius_mi: parseInt(dist),
                use_ebird: useEbird,
                sheet_cached: fullLifeList.length > 0,
                scan_lat: parseFloat(lat.toFixed(4)),
                scan_lng: parseFloat(lng.toFixed(4)),
                loc_name: userCoords.name || 'GPS'
            });

            await new Promise(r => setTimeout(r, 900));
            hideScanProgress();
            document.getElementById('status').style.display = 'flex';
            document.getElementById('mapWrapper').style.display = 'block'; // already shown early, safe to repeat
            document.getElementById('summaryArea').style.display = 'block';
            document.getElementById('resultsScrollTarget').style.display = 'block';
            document.getElementById('navDock').style.display = 'flex';
            document.getElementById('actionCircle').style.display = 'flex';
            initMap(); applyView(); // initMap() is idempotent — skips re-init if map exists
        }

        // ─────────────────────────────────────────────
        //  MAP
        // ─────────────────────────────────────────────
        function updateOverlayOpacity(val) { document.getElementById('opacityLabel').innerText = val + '%'; if (geologyOverlay) geologyOverlay.setOpacity(val / 100); }
        function changeMapType(type) {
            dlog('Map type: ' + type, 'info');
            if (!map) return; const isOverlay = type.startsWith('geology_') || type === 'none';
            if (isOverlay) {
                if (!currentTileLayer) changeMapType(BASEMAP_CYCLE[basemapIndex]); if (geologyOverlay) map.removeLayer(geologyOverlay);
                const controls = document.getElementById('overlayControls'); const op = document.getElementById('overlayOpacity').value / 100;
                if (type === 'geology_macro') {
                    const _tGeo0 = performance.now();
                    geologyOverlay = L.tileLayer('https://tiles.macrostrat.org/carto/{z}/{x}/{y}.png', { attribution: '© Macrostrat', opacity: op, zIndex: 500, maxZoom: 19 }).addTo(map);
                    geologyOverlay.once('load', () => {
                        const _geoMs = Math.round(performance.now() - _tGeo0);
                        const _zoom = map ? Math.round(map.getZoom()) : null;
                        dlog('Geology overlay loaded: macrostrat zoom=' + _zoom + ' ' + _geoMs + 'ms', 'info');
                        if (typeof Telemetry !== 'undefined') Telemetry.event('overlay_load', {
                            duration_ms: _geoMs, overlay: 'geology_macro', zoom: _zoom,
                            lat: userCoords ? parseFloat(userCoords.lat.toFixed(4)) : null,
                            lng: userCoords ? parseFloat(userCoords.lng.toFixed(4)) : null
                        });
                    });
                    controls.style.display = 'block';
                }
                else if (type === 'geology_sgmc') {
                    const _tSgmc0 = performance.now();
                    geologyOverlay = L.tileLayer.wms('https://mrdata.usgs.gov/services/sgmc', { layers: 'sgmc', format: 'image/png', transparent: true, version: '1.1.1', opacity: op, zIndex: 500 }).addTo(map);
                    geologyOverlay.once('load', () => {
                        const _sgmcMs = Math.round(performance.now() - _tSgmc0);
                        const _zoom = map ? Math.round(map.getZoom()) : null;
                        dlog('Geology overlay loaded: sgmc zoom=' + _zoom + ' ' + _sgmcMs + 'ms', 'info');
                        if (typeof Telemetry !== 'undefined') Telemetry.event('overlay_load', {
                            duration_ms: _sgmcMs, overlay: 'geology_sgmc', zoom: _zoom,
                            lat: userCoords ? parseFloat(userCoords.lat.toFixed(4)) : null,
                            lng: userCoords ? parseFloat(userCoords.lng.toFixed(4)) : null
                        });
                    });
                    controls.style.display = 'block';
                }
                else { controls.style.display = 'none'; geologyOverlay = null; } return;
            }
            if (currentTileLayer) map.removeLayer(currentTileLayer);
            let url, options = { attribution: '' };
            switch (type) {
                case 'hybrid': url = `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`; options = { attribution: '© Mapbox © DigitalGlobe', maxZoom: 20, tileSize: 512, zoomOffset: -1 }; break;
                case 'streets': url = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'; options = { attribution: '© OpenStreetMap contributors' }; break;
                case 'mapbox-streets': url = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`; options = { attribution: '© Mapbox © OpenStreetMap', maxZoom: 20, tileSize: 512, zoomOffset: -1 }; break;
                case 'terrain': url = 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png'; options = { attribution: '© OpenTopoMap contributors' }; break;
                case 'usgs': url = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}'; options = { attribution: 'Tiles courtesy of the U.S. Geological Survey', maxZoom: 20 }; break;
                case 'dark': url = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'; options = { attribution: '© CartoDB' }; break;
                default: url = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'; options = { attribution: 'Tiles © Esri' };
            }
            const _tTile0 = performance.now();
            currentTileLayer = L.tileLayer(url, options).addTo(map);

            // Log initial tile load on first 'load' event
            currentTileLayer.once('load', () => {
                // changeMapType 'load' fires on basemap switch — moveend handles navigation
                // so only log here if moveend hasn't already fired
                if (map && !map._tileLoadLogged) {
                    map._tileLoadLogged = true;
                    const _tileMs = Math.round(performance.now() - _tTile0);
                    const _zoom = map ? Math.round(map.getZoom()) : null;
                    const _center = map ? map.getCenter() : null;
                    dlog('Tiles loaded: ' + type + ' [load] zoom=' + _zoom + ' ' + _tileMs + 'ms'
                        + (_center ? ' center=' + _center.lat.toFixed(4) + ',' + _center.lng.toFixed(4) : ''), 'info');
                    if (typeof Telemetry !== 'undefined') Telemetry.event('tile_load', {
                        duration_ms: _tileMs, basemap: type, trigger: 'load', zoom: _zoom,
                        center_lat: _center ? parseFloat(_center.lat.toFixed(4)) : null,
                        center_lng: _center ? parseFloat(_center.lng.toFixed(4)) : null,
                        scan_lat: userCoords ? parseFloat(userCoords.lat.toFixed(4)) : null,
                        scan_lng: userCoords ? parseFloat(userCoords.lng.toFixed(4)) : null
                    });
                }
            });
            if (geologyOverlay) geologyOverlay.bringToFront(); if (parcelState && parcelState.layer) parcelState.layer.bringToFront();
        }

        function initMap() {
            if (!map) {
                map = L.map('map', { zoomControl: false, markerZoomAnimation: true, fadeAnimation: true }).setView([userCoords.lat, userCoords.lng], 12);
                changeMapType(document.getElementById('mapType').value);
                map.on('click', async e => {
                    if (!document.getElementById('mapType').value.startsWith('geology_')) return;
                    if (e.originalEvent._parcelHandled) return;
                    const { lat, lng } = e.latlng;
                    const popup = L.popup().setLatLng(e.latlng).setContent('<div style="color:var(--accent);font-weight:900;font-size:16px;">IDENTIFYING...</div>').openOn(map);
                    try {
                        const res = await fetch(`https://macrostrat.org/api/v2/mobile/point?lat=${lat}&lng=${lng}`); const json = await res.json();
                        if (json.success?.data) {
                            const d = json.success.data; let unitName, age, lith, desc;
                            if (Array.isArray(d) && d.length > 0 && d[0].units) { const unit = d[0].units[0]; unitName = unit.unit_name || unit.strat_name; age = unit.age; lith = unit.lith; desc = unit.environ || unit.descrip; }
                            else { unitName = d.name || d.map_info?.name || 'Unknown Unit'; age = d.age || d.map_info?.age || 'Unknown Age'; lith = Array.isArray(d.rocktype) ? d.rocktype.join(', ') : (d.rocktype || 'Not specified'); desc = d.desc || d.map_info?.descrip || 'Surface/Map unit details.'; }
                            const macroUrl = `https://macrostrat.org/map/loc/${lng}/${lat}#x=${lng}&y=${lat}&z=12`;
                            popup.setContent(`<div style="min-width:280px;color:var(--text-main);font-size:16px;"><h4 style="margin:0 0 10px 0;color:var(--accent);text-transform:uppercase;font-size:20px;font-weight:900;line-height:1.2;">${esc(unitName)}</h4><div style="margin-bottom:12px;font-weight:800;"><span style="opacity:0.7;font-weight:400;font-size:14px;text-transform:uppercase;">Age:</span> ${esc(age)}</div><div style="background:rgba(255,255,255,0.08);padding:15px;border-radius:12px;border:1px solid var(--border);"><b style="color:var(--accent);font-size:12px;text-transform:uppercase;letter-spacing:1px;">Lithology</b><div style="margin-top:6px;font-weight:700;line-height:1.4;">${esc(lith)}</div><hr style="border:0;border-top:1px solid var(--border);margin:12px 0;"><div class="geo-scroll-box"><span style="opacity:0.95;font-size:15px;line-height:1.5;">${esc(desc)}</span></div><div style="margin-top:15px;text-align:center;padding-top:10px;border-top:1px dashed var(--border);"><a href="${safeUrl(macroUrl)}" target="_blank" style="color:var(--link-blue);font-size:12px;font-weight:900;text-decoration:none;text-transform:uppercase;">🌐 View Full Macrostrat Map</a></div></div></div>`);
                        } else { popup.setContent("<div style='font-size:14px;font-weight:700;color:var(--text-dim);'>NO DATA FOUND.</div>"); }
                    } catch (err) { popup.setContent("<div style='color:var(--notable-red);font-weight:900;'>API ERROR</div>"); }
                });
                map.on('contextmenu', e => {
                    userCoords = { lat: e.latlng.lat, lng: e.latlng.lng, name: 'Dropped Pin' };
                    updateAboutLocationEcho(); if (userMarker) userMarker.setLatLng(e.latlng); isInitialLoad = true;
                    dlog('Location set: dropped pin ' + e.latlng.lat.toFixed(4) + ',' + e.latlng.lng.toFixed(4), 'info');
                    if (typeof Telemetry !== 'undefined') Telemetry.event('location_set', { method: 'dropped_pin', lat: parseFloat(e.latlng.lat.toFixed(4)), lng: parseFloat(e.latlng.lng.toFixed(4)) });
                    runScan({ coords: { latitude: e.latlng.lat, longitude: e.latlng.lng } });
                });
                setTimeout(() => map.invalidateSize(), 200);
                map.on('popupopen', () => { document.getElementById('mapOverlayBtns').style.opacity = '0'; document.getElementById('mapOverlayBtns').style.pointerEvents = 'none'; });
                map.on('popupclose', () => { document.getElementById('mapOverlayBtns').style.opacity = '1'; document.getElementById('mapOverlayBtns').style.pointerEvents = 'auto'; });

                // Parcel: zoom-gate on zoom change; parcel click takes priority over geology
                // Log tile load time after every flyTo/panTo — fires fresh each move
                let _moveTileT0 = 0;
                let _tileLogFired = false;
                function _logMapTile(trigger) {
                    if (_tileLogFired) return; _tileLogFired = true;
                    const _tileMs = Math.round(performance.now() - _moveTileT0);
                    const _zoom = map ? Math.round(map.getZoom()) : null;
                    const _center = map ? map.getCenter() : null;
                    const _type = BASEMAP_CYCLE[basemapIndex] || 'unknown';
                    dlog('Tiles loaded: ' + _type + ' [' + trigger + '] zoom=' + _zoom + ' ' + _tileMs + 'ms'
                        + (_center ? ' center=' + _center.lat.toFixed(4) + ',' + _center.lng.toFixed(4) : ''), 'info');
                    if (typeof Telemetry !== 'undefined') Telemetry.event('tile_load', {
                        duration_ms: _tileMs, basemap: _type, trigger: trigger, zoom: _zoom,
                        center_lat: _center ? parseFloat(_center.lat.toFixed(4)) : null,
                        center_lng: _center ? parseFloat(_center.lng.toFixed(4)) : null,
                        scan_lat: userCoords ? parseFloat(userCoords.lat.toFixed(4)) : null,
                        scan_lng: userCoords ? parseFloat(userCoords.lng.toFixed(4)) : null
                    });
                }
                map.on('movestart', () => { _moveTileT0 = performance.now(); _tileLogFired = false; map._tileLoadLogged = false; });
                map.on('moveend', () => {
                    if (_moveTileT0 === 0) return;
                    setTimeout(() => _logMapTile('moveend'), 600);
                });

                map.on('zoomend', () => {
                    updateParcelZoomGate();
                    // Track highest zoom browsed while online for offline tile cap
                    if (navigator.onLine) {
                        const z = Math.floor(map.getZoom());
                        if (z > maxCachedZoom) {
                            maxCachedZoom = z;
                            // Update the stored cache with new max zoom
                            try {
                                const raw = localStorage.getItem(OBS_CACHE_KEY);
                                if (raw) {
                                    const c = JSON.parse(raw);
                                    c.maxZoom = maxCachedZoom;
                                    localStorage.setItem(OBS_CACHE_KEY, JSON.stringify(c));
                                }
                            } catch (e) { }
                        }
                    }
                });
                map.on('click', function (e) {
                    if (!parcelState.on) return;
                    e.originalEvent._parcelHandled = true;
                    fireParcelFetch(e);
                });
            } else if (!map._flyToOptions) { map.panTo([userCoords.lat, userCoords.lng]); }

            updateParcelZoomGate();

            if (userMarker) userMarker.remove();
            const userIcon = L.divIcon({ className: 'custom-div-icon', html: "<div class='user-location-marker'></div>", iconSize: [22, 22], iconAnchor: [11, 11] });
            userMarker = L.marker([userCoords.lat, userCoords.lng], { icon: userIcon, draggable: true, zIndexOffset: 1000 }).addTo(map);
            userMarker.on('dragend', e => {
                const pos = e.target.getLatLng();
                userCoords = { lat: pos.lat, lng: pos.lng, name: 'Custom Point' };
                updateAboutLocationEcho(); isInitialLoad = true;
                dlog('Location set: marker drag ' + pos.lat.toFixed(4) + ',' + pos.lng.toFixed(4), 'info');
                if (typeof Telemetry !== 'undefined') Telemetry.event('location_set', { method: 'marker_drag', lat: parseFloat(pos.lat.toFixed(4)), lng: parseFloat(pos.lng.toFixed(4)) });
                runScan({ coords: { latitude: pos.lat, longitude: pos.lng } });
            });

            markers.forEach(m => m.marker.remove()); markers = [];
            rawData.forEach(o => {
                const isObscured = o.is_obscured || o.is_private;
                // wanted-marker listed after notable-marker so its !important purple wins over red
                const obsIcon = L.divIcon({ className: 'custom-div-icon', html: `<div class="custom-marker ${o.source === 'eBird' ? 'ebird-marker' : ''} ${o.is_notable ? 'notable-marker' : ''} ${o.is_wanted ? 'wanted-marker' : ''} ${isObscured ? 'obscured-marker' : ''}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
                // z-order: target (1000) > notable (500) > default (0); target+notable gets 1500
                const zIdx = o.is_wanted ? (o.is_notable ? 1500 : 1000) : (o.is_notable ? 500 : 0);
                const m = L.marker([o.lat, o.lng], { icon: obsIcon, zIndexOffset: zIdx }).addTo(map);
                m.on('click', () => setFilter('id', o.id)); markers.push({ id: o.id, marker: m });
            });
        }

        // ─────────────────────────────────────────────
        //  FILTER / VIEW
        // ─────────────────────────────────────────────
        function ensureResultsExpanded() { const rc = document.getElementById('resultsCollapse'), rch = document.getElementById('resultsChevron'); if (rc && !rc.classList.contains('open')) { rc.classList.add('open'); if (rch) rch.classList.add('rotated'); } }
        function setFilter(type, value) { if (!activeFilter) preFilterScrollPos = window.scrollY; activeFilter = { type, value }; const btn = document.getElementById('actionCircle'); btn.classList.add('filter-active'); btn.innerText = 'X'; applyView(); ensureResultsExpanded(); smartJump('resultsScrollTarget'); }
        function handleActionClick() {
            if (activeFilter) { activeFilter = null; const btn = document.getElementById('actionCircle'); btn.classList.remove('filter-active'); btn.innerText = '↑'; applyView(); if (galleryActive) openGallery(galleryScrollPos); else window.scrollTo({ top: preFilterScrollPos, behavior: 'instant' }); }
            else { window.scrollTo({ top: 0, behavior: 'smooth' }); }
        }
        function getCurrentFilteredList() {
            let l = rawData;
            if (globalToggles.ebird) l = l.filter(o => o.source === 'eBird');
            if (globalToggles.wanted) l = l.filter(o => o.is_wanted);
            if (globalToggles.notable) l = l.filter(o => o.is_notable);
            if (activeFilter) {
                if (activeFilter.type === 'id') l = l.filter(o => o.id === activeFilter.value);
                else if (activeFilter.type === 'species') l = l.filter(o => o.common_name === activeFilter.value);
                else if (activeFilter.type === 'location') l = l.filter(o => o.location_str === activeFilter.value);
            }
            return l;
        }
        function applyView() {
            const list = getCurrentFilteredList();
            markers.forEach(m => { if (list.some(l => l.id === m.id)) m.marker.addTo(map); else m.marker.remove(); });
            if (map && list.length > 0) {
                const bounds = L.latLngBounds([]); list.forEach(o => bounds.extend([o.lat, o.lng]));
                const padValue = window.innerWidth <= 768 ? [12, 12] : [22, 22];
                const zoomCap = navigator.onLine ? 18 : Math.min(maxCachedZoom, 16);
                if (activeFilter !== null) map.flyToBounds(bounds, { padding: padValue, minZoom: Math.min(14, zoomCap), maxZoom: zoomCap, duration: 0.8, easeLinearity: 0.4 });
                else if (isInitialLoad) { map.flyToBounds(bounds, { padding: padValue, maxZoom: zoomCap, duration: 0.8, easeLinearity: 0.4 }); isInitialLoad = false; }
                else map.fitBounds(bounds, { padding: padValue, maxZoom: zoomCap });
            }
            updateFinalStatus(list); renderStats(list); renderCards(list); updateWantedCount(); updateNotableCount();
        }

        // ─────────────────────────────────────────────
        //  RENDER
        // ─────────────────────────────────────────────
        function renderStats(list) {
            const species = {}, locs = {}, locObs = {};
            list.forEach(o => { species[o.common_name] = (species[o.common_name] || 0) + 1; locs[o.location_str] = (locs[o.location_str] || 0) + 1; if (o.is_obscured || o.is_private) locObs[o.location_str] = true; });
            const speciesCount = Object.keys(species).length;
            const locationCount = Object.keys(locs).length;
            const scEl = document.getElementById('speciesCount'); if (scEl) scEl.textContent = speciesCount > 0 ? `(${speciesCount})` : '';
            const lcEl = document.getElementById('locationCount'); if (lcEl) lcEl.textContent = locationCount > 0 ? `(${locationCount})` : '';
            document.getElementById('speciesContent').innerHTML = Object.entries(species).sort((a, b) => a[0].localeCompare(b[0])).map(([n, c]) => `<div class="summary-item" data-value="${encodeURIComponent(n)}">${esc(n)}</div><div style="padding:12px 0;">${c}</div>`).join('');
            let sl = Object.entries(locs); sl.sort((a, b) => locSortMode === 'rank' ? b[1] - a[1] : a[0].localeCompare(b[0]));
            document.getElementById('locationContent').innerHTML = sl.map(([n, c]) => `<div class="summary-item" data-value="${encodeURIComponent(n)}">${locObs[n] ? '🔒 ' : ''}${esc(n)}</div><div style="padding:12px 0;">${c}</div>`).join('');
        }

        function renderCards(list) {
            document.getElementById('results').innerHTML = list.map(o => {
                const notableTag = o.is_notable ? `<span class="card-tag tag-notable">NOTABLE</span>` : '';
                const wantedTag  = o.is_wanted  ? `<span class="card-tag tag-wanted">🎯 TARGET</span>` : '';
                const obscuredTag = (o.is_obscured || o.is_private) ? `<span class="card-tag tag-obscured">OBSCURED</span>` : '';
                const locPrefix = (o.is_obscured || o.is_private) ? '🔒 ' : '';
                const photoPill = o.sheet_link
                    ? `<a href="${safeUrl(o.sheet_link)}" target="_blank" class="pill-btn photo-pill" title="View photo on Google Photos">📷 AMY</a>`
                    : '';
                return `
        <div class="nature-card" style="${o.is_wanted ? 'border-left:8px solid var(--wanted-purple);' : ''}">
            <div class="img-container">${o.photo ? `<img src="${safeUrl(o.photo)}" data-medium="${esc(o.photo.replace('small', 'medium'))}" class="nature-img" alt="${esc(o.common_name)}">` : '🔭'}</div>
            <div class="card-body">
                <div><span class="com-name" data-value="${encodeURIComponent(o.common_name)}">${esc(o.common_name)}</span>${wantedTag}${notableTag}${obscuredTag}</div>
                <span class="sci-name">${esc(o.sci_name)}</span>
                <span class="obs-date">🕒 ${esc(o.date)}</span>
                <div class="loc-line" data-value="${encodeURIComponent(o.location_str)}">📍 ${locPrefix}${esc(o.location_str)}</div>
                <div class="pill-actions">
                    <a href="${safeUrl(o.uri)}" target="_blank" class="pill-btn">${esc(o.source)}</a>
                    <a href="https://www.google.com/maps?q=${o.lat},${o.lng}" target="_blank" class="pill-btn">G-MAP</a>
                    <button class="pill-btn btn-locate" data-id="${esc(o.id)}">LOCATE</button>
                    ${photoPill}
                </div>
            </div>
        </div>`;
            }).join('');
        }

        document.addEventListener('click', e => {
            const summaryItem = e.target.closest('#speciesContent .summary-item, #locationContent .summary-item');
            if (summaryItem) { const type = summaryItem.closest('#speciesContent') ? 'species' : 'location'; setFilter(type, decodeURIComponent(summaryItem.dataset.value)); return; }
            const comName = e.target.closest('#results .com-name'); if (comName) { setFilter('species', decodeURIComponent(comName.dataset.value)); return; }
            const locLine = e.target.closest('#results .loc-line'); if (locLine) { setFilter('location', decodeURIComponent(locLine.dataset.value)); return; }
            const locBtn = e.target.closest('#results .btn-locate'); if (locBtn) { setFilter('id', locBtn.dataset.id); return; }
            const img = e.target.closest('#results .nature-img'); if (img) { toggleZoom(img); return; }
        });

        // ─────────────────────────────────────────────
        //  LIFE LIST MODAL
        // ─────────────────────────────────────────────
        function updateLLSeenCount() {
            const seen = fullLifeList.filter(isSeen).length, total = fullLifeList.length;
            const el = document.getElementById('llSeenCount');
            if (el) el.textContent = total ? `${seen} / ${total} seen` : '';
        }
        function openLifeList() {
            if (fullLifeList.length === 0) {
                forceSheetSync().then(() => { document.getElementById('lifeListModal').classList.add('open'); renderLifeList(); });
                return;
            }
            document.getElementById('lifeListModal').classList.add('open');
            renderLifeList();
        }
        function closeLifeList() { document.getElementById('lifeListModal').classList.remove('open'); }

        function renderLifeList() {
            updateLLSeenCount();
            let rows = fullLifeList;
            if (llFilter === 'seen') rows = rows.filter(isSeen);
            if (llFilter === 'unseen') rows = rows.filter(r => !isSeen(r));
            if (llQuery) rows = rows.filter(r => {
                const sp = (r.Species || r.species || '').toLowerCase();
                const lat = (r.Latin2 || r.latin2 || '').toLowerCase();
                return sp.includes(llQuery) || lat.includes(llQuery);
            });

            const total = rows.length, seen = rows.filter(isSeen).length;
            document.getElementById('llStats').textContent = total === 0 ? 'No results' : `${total} species · ${seen} seen · ${total - seen} needed`;

            if (total === 0) { document.getElementById('llBody').innerHTML = `<div class="ll-empty">No species match your search.</div>`; return; }

            // Group rows by Group field, sorted alphabetically
            const groupMap = new Map();
            rows.forEach(r => {
                const g = r.Group || r.group || 'Other';
                if (!groupMap.has(g)) groupMap.set(g, []);
                groupMap.get(g).push(r);
            });
            // Sort groups A→Z, species within each group A→Z
            const sortedGroups = [...groupMap.entries()]
                .sort((a, b) => a[0].localeCompare(b[0]));
            sortedGroups.forEach(([, birds]) =>
                birds.sort((a, b) => (a.Species || a.species || '').localeCompare(b.Species || b.species || ''))
            );

            let html = '';
            sortedGroups.forEach(([groupName, birds]) => {
                html += `<div class="ll-group-header">${esc(groupName)} <span style="font-weight:400;opacity:0.6;">(${birds.length})</span></div>`;
                birds.forEach(r => {
                    const seen = isSeen(r);
                    const species = r.Species || r.species || '';
                    const latin2 = r.Latin2 || r.latin2 || '';
                    const code = r.Code || r.code || '';
                    const photoLink = hasPhoto(r) ? (r.Link || r.link) : null;
                    const ebirdCode = r.eBirdCode || r.ebirdcode || '';
                    const ebirdUrl = ebirdCode ? `https://ebird.org/species/${ebirdCode}` : '';
                    html += `
            <div class="ll-row">
                <div class="ll-seen-dot ${seen ? 'seen' : 'unseen'}" title="${seen ? 'Seen' : 'Not yet seen'}"></div>
                <div style="flex:1;min-width:0;">
                    <div class="ll-species">${esc(species)}</div>
                    <div class="ll-latin">${esc(latin2)}</div>
                </div>
                <div class="ll-code">${esc(code)}</div>
                ${ebirdUrl ? `<a href="${safeUrl(ebirdUrl)}" target="_blank" class="ll-photo-btn" style="background:#1a6c35;" title="View on eBird">🐦</a>` : `<div class="ll-photo-placeholder"></div>`}
                ${photoLink
                            ? `<a href="${safeUrl(photoLink)}" target="_blank" class="ll-photo-btn" title="View photo">📷</a>`
                            : `<div class="ll-photo-placeholder"></div>`}
            </div>`;
                });
            });

            document.getElementById('llBody').innerHTML = html;
        }

        // ─────────────────────────────────────────────
        //  TOGGLES
        // ─────────────────────────────────────────────
        function toggleGlobalToggle(k) {
            globalToggles[k] = !globalToggles[k];
            if (k === 'ebird') { document.getElementById('toggleEbird').classList.toggle('ebird-active', globalToggles[k]); const mapEb = document.getElementById('mapBtnEbird'); if (mapEb) mapEb.classList.toggle('overlay-active', globalToggles[k]); }
            else if (k === 'wanted') { document.getElementById('btnWantedList').classList.toggle('wanted-btn-active', globalToggles[k]); }
            else if (k === 'notable') { document.getElementById('btnNotableList').classList.toggle('notable-btn-active', globalToggles[k]); }
            applyView(); if (globalToggles[k]) ensureResultsExpanded();
        }
        function updateBirdToggles() {
            const show = (activeTaxon === 3);
            document.getElementById('btnWantedList').style.display = show ? 'block' : 'none';
            document.getElementById('toggleEbird').style.display = show ? 'grid' : 'none';
            const mapEb = document.getElementById('mapBtnEbird'); if (mapEb) mapEb.style.opacity = show ? '1' : '0.3';
        }
        function updateWantedCount() { const c = rawData.filter(r => r.is_wanted).length; const b = document.getElementById('btnWantedList'); if (b) b.innerText = c > 0 ? `🎯 ${c} TARGETS` : 'TARGETS'; }
        function updateNotableCount() { const c = rawData.filter(r => r.is_notable).length; const b = document.getElementById('btnNotableList'); if (b) { b.style.display = c > 0 ? 'block' : 'none'; b.innerText = `⭐ ${c} NOTABLE`; } }

        function updateLifeListBar() {
            const bar = document.getElementById('lifeListBar');
            const stats = document.getElementById('lifeListBarStats');
            if (!bar || !stats) return;
            if (fullLifeList.length === 0) { bar.style.display = 'none'; return; }
            const seen = fullLifeList.filter(isSeen).length;
            const needed = fullWantedList.length;
            stats.textContent = `${seen} seen · ${needed} needed`;
            bar.style.display = 'flex';
        }

        // ─────────────────────────────────────────────
        //  GALLERY
        // ─────────────────────────────────────────────
        function openGallery(restoreScroll = 0) {
            const list = getCurrentFilteredList().filter(o => o.photo);
            if (list.length === 0) { alert('No photos in current view.'); return; }
            galleryActive = true;
            document.getElementById('galleryGrid').innerHTML = list.map(o => `<div class="gallery-cell" data-id="${esc(o.id)}" title="${esc(o.common_name)}"><img src="${safeUrl(o.photo)}" loading="lazy" style="width:100%;aspect-ratio:1;object-fit:cover;display:block;"><div style="padding:4px 6px;font-size:10px;font-weight:800;color:var(--text-main);background:var(--card-bg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(o.common_name)}</div></div>`).join('');
            const modal = document.getElementById('galleryModal'); modal.style.display = 'block';
            requestAnimationFrame(() => { modal.scrollTop = restoreScroll; });
        }
        function closeGallery() { galleryActive = false; document.getElementById('galleryModal').style.display = 'none'; }
        document.getElementById('galleryGrid').addEventListener('click', e => {
            const cell = e.target.closest('.gallery-cell'); if (!cell) return;
            galleryScrollPos = document.getElementById('galleryModal').scrollTop;
            document.getElementById('galleryModal').style.display = 'none'; setFilter('id', cell.dataset.id);
        });
        function toggleLocSort() { locSortMode = (locSortMode === 'rank') ? 'alpha' : 'rank'; document.getElementById('sortLabel').innerText = locSortMode.toUpperCase(); renderStats(getCurrentFilteredList()); }

        // ─────────────────────────────────────────────
        //  PINCH TO ZOOM
        // ─────────────────────────────────────────────
        // ── Full-screen image viewer with pinch-zoom + pan ─────────────────
        let _ptz = { srcEl: null, scale: 1, panX: 0, panY: 0,
                     pinching: false, panning: false,
                     startDist: 0, startScale: 1,
                     startTouchX: 0, startTouchY: 0, startPanX: 0, startPanY: 0 };

        function _ptDist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }

        function _applyTransform() {
            const img = document.getElementById('zoomViewerImg');
            img.style.transform = `translate(calc(-50% + ${_ptz.panX}px), calc(-50% + ${_ptz.panY}px)) scale(${_ptz.scale})`;
        }

        function toggleZoom(el) {
            // Always open — tapping a card image always opens viewer
            const overlay  = document.getElementById('zoomOverlay');
            const viewer   = document.getElementById('zoomViewer');
            const viewImg  = document.getElementById('zoomViewerImg');
            const closeBtn = document.getElementById('zoomCloseBtn');

            // Load medium res if available
            viewImg.src = el.dataset.medium || el.src;
            viewImg.style.transform = 'translate(-50%, -50%) scale(1)';

            _ptz.srcEl = el; _ptz.scale = 1; _ptz.panX = 0; _ptz.panY = 0;
            _ptz.pinching = false; _ptz.panning = false;

            el.classList.add('zoomed');
            overlay.classList.add('visible');
            viewer.classList.add('visible');
            closeBtn.classList.add('visible');
        }

        // All touch handling on the viewer div — image has pointer-events:none
        (function () {
            const viewer = document.getElementById('zoomViewer');

            viewer.addEventListener('touchstart', e => {
                e.preventDefault();
                if (e.touches.length === 2) {
                    _ptz.pinching = true; _ptz.panning = false;
                    _ptz.startDist  = _ptDist(e.touches);
                    _ptz.startScale = _ptz.scale;
                } else if (e.touches.length === 1) {
                    _ptz.panning = true; _ptz.pinching = false;
                    _ptz.startTouchX = e.touches[0].clientX;
                    _ptz.startTouchY = e.touches[0].clientY;
                    _ptz.startPanX   = _ptz.panX;
                    _ptz.startPanY   = _ptz.panY;
                }
            }, { passive: false });

            viewer.addEventListener('touchmove', e => {
                e.preventDefault();
                if (_ptz.pinching && e.touches.length === 2) {
                    const ratio = _ptDist(e.touches) / _ptz.startDist;
                    _ptz.scale = Math.min(6, Math.max(1, _ptz.startScale * ratio));
                    _applyTransform();
                } else if (_ptz.panning && e.touches.length === 1 && _ptz.scale > 1) {
                    _ptz.panX = _ptz.startPanX + (e.touches[0].clientX - _ptz.startTouchX);
                    _ptz.panY = _ptz.startPanY + (e.touches[0].clientY - _ptz.startTouchY);
                    _applyTransform();
                }
            }, { passive: false });

            viewer.addEventListener('touchend', e => {
                if (e.touches.length < 2) _ptz.pinching = false;
                if (e.touches.length === 0) {
                    _ptz.panning = false;
                    // Snap back to 1x if pinched below threshold
                    if (_ptz.scale < 1.05) {
                        _ptz.scale = 1; _ptz.panX = 0; _ptz.panY = 0; _applyTransform();
                    }
                }
            });
        })();

        // X close button
        document.getElementById('zoomCloseBtn').addEventListener('click', _closeViewer);

        function _closeViewer() {
            const overlay  = document.getElementById('zoomOverlay');
            const viewer   = document.getElementById('zoomViewer');
            const viewImg  = document.getElementById('zoomViewerImg');
            const closeBtn = document.getElementById('zoomCloseBtn');
            overlay.classList.remove('visible');
            viewer.classList.remove('visible');
            closeBtn.classList.remove('visible');
            if (_ptz.srcEl) { _ptz.srcEl.classList.remove('zoomed'); _ptz.srcEl = null; }
            viewImg.src = '';
            _ptz.scale = 1; _ptz.panX = 0; _ptz.panY = 0;
        }

        // Keep old name so existing call sites work
        function _closePinchZoom() { _closeViewer(); }

        // ─────────────────────────────────────────────
        //  NAV / STATUS
        // ─────────────────────────────────────────────
        function smartJump(id) { const t = document.getElementById(id); if (t) window.scrollTo({ top: t.offsetTop - 95, behavior: 'smooth' }); }
        function resetStats() { document.getElementById('status').innerHTML = `<span id="stat-wanted" class="stat-part">WANTED LIST</span><span id="stat-inat" class="stat-part">iNATURALIST</span><span id="stat-ebird" class="stat-part">eBIRD</span>`; }
        function setStat(id, state) { const el = document.getElementById(`stat-${id}`); if (!el) return; el.className = 'stat-part ' + (state === 'active' ? 'stat-active' : state === 'done' ? 'stat-done' : ''); if (state === 'active') el.innerText = `SCANNING ${id.toUpperCase()}...`; if (state === 'done') el.innerText = `${id.toUpperCase()} OK`; }
        function updateFinalStatus(filteredList) {
            const hint = document.getElementById('scanHint');
            if (hint) { hint.style.display = 'none'; localStorage.setItem('nam_scanned', '1'); }
            const locName = (userCoords?.name || 'GPS').toUpperCase();
            document.getElementById('status').innerHTML = `<div style="display:flex;align-items:center;justify-content:center;gap:12px;width:100%;"><span style="color:var(--btn-leaf);font-size:14px;">✅</span><span style="letter-spacing:1px;color:var(--text-main);font-size:12px;">${esc(locName)}</span><span style="color:var(--border);font-weight:100;">|</span><span style="color:var(--accent);font-size:12px;">${filteredList.length} <span style="font-size:9px;opacity:0.6;">OF</span> ${rawData.length} OBS</span></div>`;
        }



        // ─────────────────────────────────────────────
        //  BASEMAP CYCLE
        // ─────────────────────────────────────────────
        function cycleBasemap() {
            basemapIndex = (basemapIndex + 1) % BASEMAP_CYCLE.length;
            const next = BASEMAP_CYCLE[basemapIndex];
            changeMapType(next);
            document.getElementById('mapType').value = next;
        }

        // ─────────────────────────────────────────────
        //  PARCEL LAYER
        // ─────────────────────────────────────────────
        function updateParcelZoomGate() {
            if (!map) return;
            const btn = document.getElementById('mapBtnParcel');
            const zoom = map.getZoom();
            if (parcelState.on) return; // stay in the mode once active
            if (zoom >= PARCEL_MIN_ZOOM) {
                btn.classList.remove('parcel-disabled');
                btn.title = 'Land Parcel Ownership';
            } else {
                btn.classList.add('parcel-disabled');
                btn.title = 'Zoom in to enable land parcels (zoom >= ' + PARCEL_MIN_ZOOM + ', currently ' + Math.floor(zoom) + ')';
            }
        }

        function toggleParcelLayer() {
            if (!map) return;
            const btn = document.getElementById('mapBtnParcel');
            const ERROR_THRESHOLD = 3;

            if (parcelState.on) {
                if (parcelState.tileCountdownTimer) { clearInterval(parcelState.tileCountdownTimer); parcelState.tileCountdownTimer = null; }
                if (parcelState.countdownTimer) { clearInterval(parcelState.countdownTimer); parcelState.countdownTimer = null; }
                if (parcelState.controller) { parcelState.controller.abort(); parcelState.controller = null; }
                if (parcelState.layer) { map.removeLayer(parcelState.layer); parcelState.layer = null; }
                parcelState.on = false;
                parcelState.tileErrorCount = 0;
                btn.classList.remove('parcel-active', 'parcel-tile-loading', 'parcel-fetching', 'parcel-error');
                btn.textContent = '\u{1F4CB}';
                btn.title = 'Land Parcel Ownership';
                map.closePopup();
                updateParcelZoomGate();
            } else {
                if (map.getZoom() < PARCEL_MIN_ZOOM) return;
                parcelState.on = true;
                parcelState.tileErrorCount = 0;

                const layer = L.tileLayer.wms(PARCEL_WMS_URL, {
                    layers: '0', format: 'image/png', transparent: true,
                    version: '1.1.1', className: 'bold-parcels'
                });
                layer.on('loading', () => {
                    parcelState.tileErrorCount = 0;
                    btn.classList.remove('parcel-active', 'parcel-error');
                    btn.classList.add('parcel-tile-loading');
                    // Clear any previous tile countdown and start fresh
                    if (parcelState.tileCountdownTimer) { clearInterval(parcelState.tileCountdownTimer); parcelState.tileCountdownTimer = null; }
                    let tileSecs = 60;
                    btn.textContent = tileSecs;
                    btn.title = 'Loading parcel tiles... (' + tileSecs + 's)';
                    parcelState.tileCountdownTimer = setInterval(() => {
                        tileSecs--;
                        btn.textContent = tileSecs;
                        btn.title = 'Loading parcel tiles... (' + tileSecs + 's)';
                        if (tileSecs <= 0) {
                            clearInterval(parcelState.tileCountdownTimer);
                            parcelState.tileCountdownTimer = null;
                            // Tile server timed out — full teardown, same as user tapping off
                            toggleParcelLayer();
                        }
                    }, 1000);
                });
                layer.on('tileerror', () => {
                    parcelState.tileErrorCount++;
                    if (parcelState.tileErrorCount >= ERROR_THRESHOLD) {
                        if (parcelState.tileCountdownTimer) { clearInterval(parcelState.tileCountdownTimer); parcelState.tileCountdownTimer = null; }
                        btn.classList.remove('parcel-tile-loading');
                        btn.classList.add('parcel-error');
                        btn.textContent = '!';
                        btn.title = 'Parcel server error - tap to retry';
                    }
                });
                layer.on('load', () => {
                    parcelState.tileErrorCount = 0;
                    if (parcelState.tileCountdownTimer) { clearInterval(parcelState.tileCountdownTimer); parcelState.tileCountdownTimer = null; }
                    btn.classList.remove('parcel-tile-loading', 'parcel-error');
                    btn.textContent = '\u{1F4CB}';
                    if (parcelState.on) { btn.classList.add('parcel-active'); btn.title = 'Tap to turn off land parcels'; }
                });
                layer.addTo(map);
                parcelState.layer = layer;
                btn.classList.add('parcel-tile-loading');
            }
        }

        async function fireParcelFetch(e) {
            const FETCH_TIMEOUT = 60;
            const btn = document.getElementById('mapBtnParcel');
            if (parcelState.controller) parcelState.controller.abort();
            if (parcelState.countdownTimer) { clearInterval(parcelState.countdownTimer); parcelState.countdownTimer = null; }
            const controller = new AbortController();
            parcelState.controller = controller;

            // Start countdown on button — ticking number, tap to cancel
            btn.classList.remove('parcel-active', 'parcel-tile-loading', 'parcel-error');
            btn.classList.add('parcel-fetching');
            let secondsLeft = FETCH_TIMEOUT;
            btn.textContent = secondsLeft;
            btn.title = 'Tap to cancel (' + secondsLeft + 's)';
            parcelState.countdownTimer = setInterval(() => {
                secondsLeft--;
                btn.textContent = secondsLeft;
                btn.title = 'Tap to cancel (' + secondsLeft + 's)';
                if (secondsLeft <= 0) {
                    clearInterval(parcelState.countdownTimer);
                    parcelState.countdownTimer = null;
                    controller.abort();
                }
            }, 1000);

            dlog('Parcel fetch: ' + e.latlng.lat.toFixed(5) + ',' + e.latlng.lng.toFixed(5), 'info');
            const size = map.getSize();
            const bbox = map.getBounds().toBBoxString();
            const x = Math.floor(map.latLngToContainerPoint(e.latlng).x);
            const y = Math.floor(map.latLngToContainerPoint(e.latlng).y);
            const infoUrl = PARCEL_WMS_URL + '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo&LAYERS=0&QUERY_LAYERS=0&BBOX=' + bbox + '&FEATURE_COUNT=1&HEIGHT=' + size.y + '&WIDTH=' + size.x + '&FORMAT=image/png&INFO_FORMAT=text/xml&SRS=EPSG:4326&X=' + x + '&Y=' + y;

            // Popup shows its own countdown too
            let popupSecondsLeft = FETCH_TIMEOUT;
            const loadingPopup = L.popup({ maxWidth: 260, autoClose: false, closeOnClick: false, autoPan: false })
                .setLatLng(e.latlng)
                .setContent('<div style="color:var(--accent);font-weight:700;font-size:12px;padding:2px 0;">Identifying... <span id="parcelPopupCountdown">' + popupSecondsLeft + 's</span></div>')
                .openOn(map);
            const popupTimer = setInterval(() => {
                popupSecondsLeft--;
                const el = document.getElementById('parcelPopupCountdown');
                if (el) el.textContent = popupSecondsLeft + 's';
                if (popupSecondsLeft <= 0) clearInterval(popupTimer);
            }, 1000);

            function restoreBtn() {
                clearInterval(parcelState.countdownTimer);
                parcelState.countdownTimer = null;
                clearInterval(popupTimer);
                btn.classList.remove('parcel-fetching');
                btn.textContent = '\u{1F4CB}';
                if (parcelState.on) { btn.classList.add('parcel-active'); btn.title = 'Tap to turn off land parcels'; }
                parcelState.controller = null;
            }

            try {
                const res = await fetch(infoUrl, { signal: controller.signal });
                const text = await res.text();
                restoreBtn();
                dlog('Parcel fetch OK, hasData=' + text.includes('<FIELDS'), 'ok');

                if (text.includes('<FIELDS')) {
                    dlog('Parcel data received OK', 'cache');
                    const parser = new DOMParser();
                    const xmlDoc = parser.parseFromString(text, 'text/xml');
                    const f = xmlDoc.getElementsByTagName('FIELDS')[0];
                    const rawDate = f.getAttribute('DATE_ACQ') || '';
                    const formattedDate = rawDate.length === 8
                        ? rawDate.substring(4, 6) + '/' + rawDate.substring(6, 8) + '/' + rawDate.substring(0, 4)
                        : 'N/A';
                    const area = f.getAttribute('LEGAL_AREA') || '';
                    const areaUnit = f.getAttribute('LGL_AREA_UNIT') || '';
                    const careOf = (f.getAttribute('NAME_CARE') || '').trim();
                    const yearBuilt = f.getAttribute('YEAR_BUILT') || '';

                    const html = '<div style="font-size:13px;line-height:1.5;color:var(--text-main);">'
                        + '<div style="color:var(--accent);font-size:10px;text-transform:uppercase;font-weight:900;letter-spacing:0.5px;border-bottom:1px solid var(--border);padding-bottom:5px;margin-bottom:8px;">Property Details</div>'
                        + '<div style="font-weight:900;font-size:14px;margin-bottom:4px;">' + esc(f.getAttribute('OWNER_NAME') || '—') + '</div>'
                        + '<div style="color:var(--text-dim);font-size:12px;margin-bottom:4px;">' + esc(f.getAttribute('SITUS_ADDR') || '—') + '</div>'
                        + '<div style="font-size:11px;color:var(--accent);">' + (area ? esc(area) + ' ' + esc(areaUnit) : '') + (area && f.getAttribute('COUNTY') ? ' &nbsp;·&nbsp; ' : '') + esc(f.getAttribute('COUNTY') || '') + ' County</div>'
                        + '</div>';
                    loadingPopup.setContent(html);
                } else {
                    dlog('Parcel: no data at this location', 'warn');
                    loadingPopup.setContent('<div style="color:var(--text-dim);font-size:13px;font-weight:700;font-style:italic;">No parcel data at this location.</div>');
                }
            } catch (err) {
                restoreBtn();
                if (err.name === 'AbortError') {
                    dlog('Parcel fetch cancelled', 'warn');
                    map.closePopup();
                } else {
                    dlog('Parcel fetch ERROR: ' + err.message, 'error');
                    loadingPopup.setContent('<div style="color:var(--notable-red);font-weight:900;font-size:13px;">Request failed. Try again.</div>');
                }
            }
        }

        initApp();
    