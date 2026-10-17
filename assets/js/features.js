/* AvmaDrive features: GPS reading, timeline, map, similar photos, ZIP / PDF export, video hover scrub.
   Classic script, loaded after extras.js (shares app.js globals). */
(function () {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const escH = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const locale = () => (window.LANG === 'es' ? 'es-ES' : 'ka-GE');
    const HOVER = () => window.matchMedia && matchMedia('(hover:hover)').matches;

    /* ======================= shared: full-screen panel ======================= */
    function panel(id, title, icon, extraHeader) {
        let el = $(id);
        if (el) el.remove();
        el = document.createElement('div');
        el.id = id;
        el.className = 'fixed inset-0 z-40 bg-slate-50 dark:bg-slate-950 flex flex-col';
        el.innerHTML = `<div class="flex items-center gap-3 px-3 sm:px-5 h-14 flex-shrink-0 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <span class="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center flex-shrink-0"><i class="fa-solid ${icon}"></i></span>
            <h2 class="font-bold text-slate-900 dark:text-white text-base sm:text-lg truncate">${escH(title)}</h2>
            <div class="pn-head flex items-center gap-2 ml-auto min-w-0">${extraHeader || ''}</div>
            <button type="button" class="pn-close w-9 h-9 rounded-xl text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer flex-shrink-0" title="დახურვა (Esc)"><i class="fa-solid fa-xmark text-lg"></i></button>
        </div><div class="pn-body flex-1 min-h-0 relative"></div>`;
        document.body.appendChild(el);
        el.querySelector('.pn-close').onclick = () => closePanel(id);
        return el;
    }
    const closers = {};
    function closePanel(id) {
        const el = $(id);
        if (!el) return;
        if (closers[id]) { try { closers[id](); } catch (e) {} }
        el.remove();
    }
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        const g = $('galleryModal');
        if (g && !g.classList.contains('hidden')) return;
        if (document.querySelector('.fixed.z-\\[80\\], .fixed.z-\\[90\\]')) return;
        for (const id of ['exportModal', 'simModal', 'mapModal', 'tlModal']) {
            if ($(id)) { e.preventDefault(); closePanel(id); return; }
        }
    });
    function closeSidebarMobile() {
        const sb = $('sidebar');
        if (sb && window.innerWidth < 768 && !sb.classList.contains('-translate-x-full')) sb.classList.add('-translate-x-full');
    }
    function allItems() {
        const out = [];
        folders.forEach(f => (f.mediaFiles || []).forEach((m, i) => out.push({ f, m, i })));
        return out;
    }
    function folderPath(f) {
        const n = []; let cur = f, g = 0;
        while (cur && g++ < 50) { n.unshift(cur.name); cur = cur.parentId ? folders.find(x => x.id === cur.parentId) : null; }
        return n.join(' / ');
    }
    // permission prompts must start inside the user's click
    function askRoots(items) {
        const roots = [...new Set(items.map(x => x.f.rootId).filter(r => r && rootHandles.has(r) && !accessGranted.has(r)))];
        return Promise.all(roots.map(r => requestAccess(r).then(ok => { if (ok) accessGranted.add(r); })));
    }
    const thumbCell = (it, cls) => mediaThumbHtml(it.m, it.f.id, it.i, cls || 'w-full h-full object-cover');

    /* ======================= GPS ======================= */
    function tiffGps(dv, base) {
        try {
            const len = dv.byteLength;
            const le = dv.getUint16(base) === 0x4949;
            const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
            if (u16(base + 2) !== 42) return 0;
            const find = (ifd, tag) => {
                if (ifd < 0 || ifd + 2 > len) return -1;
                const n = u16(ifd);
                for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (e + 12 > len) break; if (u16(e) === tag) return e; }
                return -1;
            };
            const g = find(base + u32(base + 4), 0x8825);
            if (g < 0) return 0;
            const gi = base + u32(g + 8);
            const ref = (tag) => { const e = find(gi, tag); return e < 0 ? '' : String.fromCharCode(dv.getUint8(e + 8)); };
            const dms = (tag) => {
                const e = find(gi, tag);
                if (e < 0) return NaN;
                const o = base + u32(e + 8);
                if (o + 24 > len) return NaN;
                const r = (k) => { const d = u32(o + k * 8 + 4); return d ? u32(o + k * 8) / d : 0; };
                return r(0) + r(1) / 60 + r(2) / 3600;
            };
            let lat = dms(2), lon = dms(4);
            if (!isFinite(lat) || !isFinite(lon)) return 0;
            if (ref(1).toUpperCase() === 'S') lat = -lat;
            if (ref(3).toUpperCase() === 'W') lon = -lon;
            if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return 0;
            return [+lat.toFixed(5), +lon.toFixed(5)];
        } catch (e) { return 0; }
    }
    async function mp4Gps(file) {
        let o = 0, guard = 0;
        while (o + 8 <= file.size && guard++ < 200) {
            const h = new DataView(await file.slice(o, o + 16).arrayBuffer());
            let sz = h.getUint32(0); const ty = h.getUint32(4);
            let hdr = 8;
            if (sz === 1) { if (h.byteLength < 16) return 0; sz = h.getUint32(8) * 4294967296 + h.getUint32(12); hdr = 16; }
            else if (sz === 0) sz = file.size - o;
            if (sz < hdr) return 0;
            if (ty === 0x6D6F6F76) {                                         // 'moov'
                const buf = new Uint8Array(await file.slice(o + hdr, o + Math.min(sz, 2 * 1024 * 1024)).arrayBuffer());
                let s = '';
                for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
                const m = s.match(/([+-]\d{1,2}\.\d{3,})([+-]\d{1,3}\.\d{3,})(?:[+-]\d+(?:\.\d+)?)?\//);
                if (!m) return 0;
                const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
                if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return 0;
                return [+lat.toFixed(5), +lon.toFixed(5)];
            }
            o += sz;
        }
        return 0;
    }
    window.readGps = async function (file, type, name) {
        try {
            if (type === 'video') return /\.(mp4|mov)$/i.test(name || '') ? await mp4Gps(file) : 0;
            return await readExifWith(file, type, name, tiffGps);
        } catch (e) { return 0; }
    };
    // scan everything that has not been checked yet; returns the number of newly found positions
    async function gpsScan(onProgress, shouldStop) {
        const jobs = [];
        folders.forEach(f => {
            if (!f.rootId) return;
            const live = rootHandles.has(f.rootId) && accessGranted.has(f.rootId);
            (f.mediaFiles || []).forEach(m => {
                if (!m.local || !m.path || m.gpsChecked === 1 || !exifCapable(m)) return;
                if (!live && !sessionFiles.has(f.rootId + '|' + m.path.join('/'))) return;
                jobs.push({ f, m });
            });
        });
        let i = 0, done = 0, found = 0;
        const worker = async () => {
            while (i < jobs.length && !(shouldStop && shouldStop())) {
                const { f, m } = jobs[i++];
                try {
                    const file = await resolveFile(f, m);
                    const g = await window.readGps(file, m.type, m.name);
                    if (g) { m.gps = g; found++; } else delete m.gps;
                    m.gpsChecked = 1;
                } catch (e) { /* no access */ }
                done++;
                if (onProgress && (done % 25 === 0 || done === jobs.length)) onProgress(done, jobs.length, found);
            }
        };
        await Promise.all(Array.from({ length: IS_TOUCH ? 2 : 5 }, worker));
        if (done) await persistData();
        return { total: jobs.length, done, found };
    }

    /* ======================= TIMELINE ======================= */
    const TL = { desc: true, type: 'all' };
    window.openTimeline = function () {
        closeSidebarMobile();
        const el = panel('tlModal', 'დროის ხაზი', 'fa-timeline', `
            <div class="hidden sm:flex bg-slate-100 dark:bg-slate-800 rounded-xl p-0.5 text-xs">
                ${[['all', 'ყველა'], ['image', 'ფოტო'], ['video', 'ვიდეო']].map(([v, l]) => `<button type="button" data-ty="${v}" class="tl-ty px-3 py-1.5 rounded-lg cursor-pointer font-medium">${l}</button>`).join('')}
            </div>
            <button type="button" id="tlSort" class="px-3 py-2 rounded-xl text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer whitespace-nowrap"></button>`);
        const body = el.querySelector('.pn-body');
        body.innerHTML = `<div id="tlScroll" class="absolute inset-0 overflow-y-auto pr-16 sm:pr-24 pl-3 sm:pl-6 pb-24"></div>
            <div id="tlRail" class="absolute right-1 sm:right-3 top-3 bottom-3 w-14 sm:w-20 overflow-y-auto text-right text-[11px] select-none"></div>
            <div id="tlBubble" class="pointer-events-none absolute right-16 sm:right-24 top-4 px-3 py-1.5 rounded-xl bg-slate-900 text-white text-xs font-semibold shadow-lg opacity-0 transition-opacity"></div>`;
        const sc = $('tlScroll'), rail = $('tlRail'), bubble = $('tlBubble');
        let sections = [], io = null, bubbleT = null;
        const monthName = (mo) => new Date(2000, mo, 1).toLocaleDateString(locale(), { month: 'long' });

        function build() {
            if (io) io.disconnect();
            const list = allItems().filter(x => TL.type === 'all' || x.m.type === TL.type).map(x => (x.t = fileDateMs(x.m), x));
            const groups = new Map();
            list.forEach(x => {
                const d = x.t ? new Date(x.t) : null;
                const k = d ? d.getFullYear() * 100 + d.getMonth() : 0;
                if (!groups.has(k)) groups.set(k, []);
                groups.get(k).push(x);
            });
            const keys = [...groups.keys()].filter(k => k).sort((a, b) => TL.desc ? b - a : a - b);
            if (groups.has(0)) keys.push(0);
            sections = keys.map(k => {
                const items = groups.get(k).sort((a, b) => TL.desc ? b.t - a.t : a.t - b.t);
                const y = Math.floor(k / 100), mo = k % 100;
                return { k, y, mo, items, label: k ? `${y} · ${monthName(mo)}` : 'თარიღის გარეშე' };
            });
            $('tlSort').innerHTML = `<i class="fa-solid ${TL.desc ? 'fa-arrow-down-wide-short' : 'fa-arrow-up-short-wide'} mr-1.5"></i>${TL.desc ? 'ახალი ზემოთ' : 'ძველი ზემოთ'}`;
            el.querySelectorAll('.tl-ty').forEach(b => { const on = b.dataset.ty === TL.type; b.className = 'tl-ty px-3 py-1.5 rounded-lg cursor-pointer font-medium ' + (on ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-300 shadow-sm' : 'text-slate-500'); });
            if (!list.length) { sc.innerHTML = '<div class="h-full flex items-center justify-center text-sm text-slate-500">ფაილები არ არის</div>'; rail.innerHTML = ''; return; }
            sc.innerHTML = sections.map((s, si) => `<section data-si="${si}" class="mb-4">
                <div class="sticky top-0 z-[2] -mx-3 sm:-mx-6 px-3 sm:px-6 py-2 bg-slate-50/95 dark:bg-slate-950/95 backdrop-blur flex items-baseline gap-2"><h3 class="font-bold text-slate-900 dark:text-white text-sm sm:text-base">${escH(s.label)}</h3><span class="text-xs text-slate-400">${s.items.length}</span></div>
                <div class="tl-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:6px"></div></section>`).join('');
            sc.querySelectorAll('.tl-grid').forEach((g, si) => { g.style.minHeight = estH(g, sections[si].items.length) + 'px'; });
            // rail: years, active year expands to its months
            drawRail(null);
            io = new IntersectionObserver((ents) => {
                ents.forEach(en => {
                    const g = en.target.querySelector('.tl-grid'), s = sections[+en.target.dataset.si];
                    if (en.isIntersecting) fill(g, s); else unfill(g);
                });
            }, { root: sc, rootMargin: '1400px 0px' });
            sc.querySelectorAll('section').forEach(s => io.observe(s));
            sc.scrollTop = 0; updateBubble(false);
        }
        function estH(g, n) {
            const w = Math.max(200, sc.clientWidth - 24 - (window.innerWidth < 640 ? 0 : 24));
            const cols = Math.max(1, Math.floor((w + 6) / (110 + 6)));
            const cell = (w - 6 * (cols - 1)) / cols;
            const rows = Math.ceil(n / cols);
            return Math.round(rows * cell + (rows - 1) * 6);
        }
        function fill(g, s) {
            if (g.dataset.on) return;
            g.dataset.on = '1';
            g.innerHTML = s.items.map((x, n) => `<button type="button" data-n="${n}" class="relative aspect-square rounded-lg overflow-hidden bg-slate-200 dark:bg-slate-800 cursor-pointer group">${thumbCell(x)}${x.m.type === 'video' ? `<span class="absolute bottom-1 right-1 bg-slate-900/80 text-white text-[9px] px-1.5 py-0.5 rounded-md"><i class="fa-solid fa-play mr-1"></i>${fmtDur(x.m.dur) || ''}</span>` : ''}${x.m.fav ? '<span class="absolute top-1 right-1 text-amber-400 text-[10px]"><i class="fa-solid fa-star"></i></span>' : ''}<span class="absolute inset-0 bg-black/0 group-hover:bg-black/15 transition"></span></button>`).join('');
            g.style.minHeight = '';
            observeLazy(g);
            g.onclick = (e) => {
                const b = e.target.closest('button[data-n]');
                if (!b) return;
                const x = s.items[+b.dataset.n];
                openGalleryModalAtIndex(x.f.id, x.i);
            };
        }
        function unfill(g) {
            if (!g.dataset.on) return;
            g.style.minHeight = g.offsetHeight + 'px';
            g.innerHTML = ''; delete g.dataset.on;
        }
        function drawRail(activeY) {
            const years = [];
            sections.forEach((s, si) => {
                let y = years.find(v => v.y === s.y && s.k);
                if (!y) { y = { y: s.k ? s.y : 0, n: 0, first: si, months: [] }; years.push(y); }
                y.n += s.items.length; y.months.push({ mo: s.mo, si, n: s.items.length });
            });
            rail.innerHTML = years.map(y => {
                const on = activeY === y.y;
                const head = `<button type="button" data-si="${y.first}" class="block w-full px-2 py-1 rounded-lg cursor-pointer ${on ? 'bg-indigo-600 text-white font-bold' : 'text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800'}">${y.y || '—'}<span class="opacity-60 ml-1">${y.n}</span></button>`;
                const months = on && y.y ? y.months.map(m => `<button type="button" data-si="${m.si}" class="block w-full px-2 py-0.5 rounded-md cursor-pointer text-slate-400 hover:text-indigo-600">${escH(monthName(m.mo).slice(0, 3))}</button>`).join('') : '';
                return head + months;
            }).join('');
        }
        function jump(si) {
            const s = sc.querySelector(`section[data-si="${si}"]`);
            if (s) sc.scrollTo({ top: s.offsetTop - 4, behavior: 'smooth' });
        }
        rail.onclick = (e) => { const b = e.target.closest('button[data-si]'); if (b) jump(+b.dataset.si); };
        let activeSi = -1, activeY = null;
        function updateBubble(show) {
            if (!sections.length) return;
            const top = sc.scrollTop + 60;
            let si = 0;
            const secs = sc.querySelectorAll('section');
            for (let i = 0; i < secs.length; i++) { if (secs[i].offsetTop <= top) si = i; else break; }
            const s = sections[si];
            if (si !== activeSi) {
                activeSi = si;
                bubble.textContent = s.label;
                const y = s.k ? s.y : 0;
                if (y !== activeY) { activeY = y; drawRail(y); }
            }
            if (show) { bubble.style.opacity = '1'; clearTimeout(bubbleT); bubbleT = setTimeout(() => { bubble.style.opacity = '0'; }, 900); }
        }
        let raf = 0;
        sc.addEventListener('scroll', () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; updateBubble(true); }); });
        $('tlSort').onclick = () => { TL.desc = !TL.desc; activeSi = -1; activeY = null; build(); };
        el.querySelectorAll('.tl-ty').forEach(b => b.onclick = () => { TL.type = b.dataset.ty; activeSi = -1; activeY = null; build(); });
        closers.tlModal = () => { if (io) io.disconnect(); };
        build();
    };

    /* ======================= MAP ======================= */
    let leafletP = null;
    function loadLeaflet() {
        if (window.L) return Promise.resolve();
        if (leafletP) return leafletP;
        leafletP = new Promise((res, rej) => {
            const css = document.createElement('link');
            css.rel = 'stylesheet'; css.href = 'assets/vendor/leaflet/leaflet.css?v=7';
            document.head.appendChild(css);
            const s = document.createElement('script');
            s.src = 'assets/vendor/leaflet/leaflet.js?v=7';
            s.onload = () => res(); s.onerror = () => { leafletP = null; rej(new Error('leaflet')); };
            document.head.appendChild(s);
        });
        return leafletP;
    }
    window.openMap = async function () {
        closeSidebarMobile();
        const gestureItems = allItems().filter(x => x.m.local && x.m.gpsChecked !== 1);
        const asks = askRoots(gestureItems);                         // inside the click
        const el = panel('mapModal', 'რუკა', 'fa-map-location-dot', '<span id="mapStat" class="text-xs text-slate-500 truncate"></span>');
        const body = el.querySelector('.pn-body');
        body.innerHTML = `<div id="mapEl" class="absolute inset-0 bg-slate-200 dark:bg-slate-800"></div>
            <div id="mapNote" class="absolute left-2 bottom-2 right-2 sm:right-auto sm:max-w-md z-[500] text-[11px] text-slate-600 dark:text-slate-300 bg-white/90 dark:bg-slate-900/90 rounded-xl px-3 py-2 shadow">რუკის ფონი იტვირთება ინტერნეტიდან (CARTO / OpenStreetMap) (ითხოვება მხოლოდ ნანახი არეალის ფილები; შენი ფოტოები და კოორდინატები არსად იგზავნება). ინტერნეტის გარეშე წერტილები მაინც ჩანს.</div>
            <div id="mapSide" class="hidden absolute z-[600] bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-2xl flex-col inset-x-0 bottom-0 max-h-[55%] border-t rounded-t-2xl sm:inset-x-auto sm:right-0 sm:top-0 sm:bottom-0 sm:w-80 sm:max-h-none sm:border-l sm:border-t-0 sm:rounded-none"></div>`;
        const stat = $('mapStat');
        let stop = false, map = null, layer = null, pts = [], tileOk = false, tileErr = 0;
        closers.mapModal = () => { stop = true; if (map) { try { map.remove(); } catch (e) {} } };
        try { await loadLeaflet(); } catch (e) { body.innerHTML = '<div class="h-full flex items-center justify-center text-sm text-slate-500 p-6 text-center">რუკის ბიბლიოთეკა ვერ ჩაიტვირთა (assets/vendor/leaflet)</div>'; return; }
        if (!$('mapEl')) return;
        await asks;
        map = L.map('mapEl', { preferCanvas: true, worldCopyJump: true, zoomControl: true }).setView([30, 10], 2);
        // OpenStreetMap's own servers reject requests without a Referer (pages opened from a file), so the first choice is CARTO, then Esri, then OSM
        const PROV = [
            ['https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 19, attribution: '© OpenStreetMap, © CARTO' }],
            ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri' }],
            ['https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }]
        ];
        let pi = 0, tiles = null;
        const useProv = () => {
            if (tiles) map.removeLayer(tiles);
            tileOk = false; tileErr = 0;
            tiles = L.tileLayer(PROV[pi][0], PROV[pi][1]).addTo(map);
            tiles.on('tileload', () => { tileOk = true; });
            tiles.on('tileerror', () => {
                if (tileOk || ++tileErr < 4) return;
                if (pi < PROV.length - 1) { pi++; useProv(); }
                else { const n = $('mapNote'); if (n) n.textContent = 'რუკის ფონი ვერ ჩაიტვირთა (ინტერნეტი არ არის?). ფოტოების წერტილები მაინც ჩანს.'; }
            });
        };
        useProv();
        layer = L.layerGroup().addTo(map);

        function collect() { pts = allItems().filter(x => Array.isArray(x.m.gps)); }
        function cluster() {
            layer.clearLayers();
            const z = map.getZoom(), cells = new Map(), R = 56;
            pts.forEach(x => {
                const p = map.project(L.latLng(x.m.gps[0], x.m.gps[1]), z);
                const k = Math.floor(p.x / R) + ':' + Math.floor(p.y / R);
                let c = cells.get(k);
                if (!c) { c = { items: [], lat: 0, lon: 0 }; cells.set(k, c); }
                c.items.push(x); c.lat += x.m.gps[0]; c.lon += x.m.gps[1];
            });
            cells.forEach(c => {
                const n = c.items.length;
                const sz = n > 99 ? 46 : n > 9 ? 40 : 34;
                const icon = L.divIcon({ className: '', iconSize: [sz, sz], html: `<div style="width:${sz}px;height:${sz}px" class="rounded-full bg-indigo-600 text-white border-2 border-white shadow-lg flex items-center justify-center text-xs font-bold">${n}</div>` });
                const mk = L.marker([c.lat / n, c.lon / n], { icon }).addTo(layer);
                mk.on('click', () => {
                    const b = L.latLngBounds(c.items.map(x => x.m.gps));
                    const same = b.getSouthWest().distanceTo(b.getNorthEast()) < 5;
                    if (n > 1 && !same && map.getZoom() < 18) { map.fitBounds(b.pad(0.25), { maxZoom: 18 }); return; }
                    side(c.items);
                });
            });
        }
        function side(items) {
            const s = $('mapSide');
            items = items.slice().sort((a, b) => fileDateMs(b.m) - fileDateMs(a.m));
            s.classList.remove('hidden'); s.classList.add('flex');
            s.innerHTML = `<div class="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800"><div class="text-sm font-semibold">${items.length} ფაილი<div class="text-[11px] font-normal text-slate-400">${items[0].m.gps[0]}, ${items[0].m.gps[1]}</div></div><button type="button" id="mapSideX" class="w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"><i class="fa-solid fa-xmark"></i></button></div>
                <div class="overflow-y-auto p-3 grid grid-cols-3 gap-2">${items.slice(0, 300).map((x, n) => `<button type="button" data-n="${n}" title="${escH(x.m.name)}" class="relative aspect-square rounded-lg overflow-hidden bg-slate-200 dark:bg-slate-800 cursor-pointer">${thumbCell(x)}</button>`).join('')}</div>`;
            observeLazy(s);
            $('mapSideX').onclick = () => { s.classList.add('hidden'); s.classList.remove('flex'); };
            s.querySelector('.grid').onclick = (e) => { const b = e.target.closest('button[data-n]'); if (b) { const x = items[+b.dataset.n]; openGalleryModalAtIndex(x.f.id, x.i); } };
        }
        function fitAll() {
            if (!pts.length) return;
            map.fitBounds(L.latLngBounds(pts.map(x => x.m.gps)).pad(0.15), { maxZoom: 15 });
        }
        map.on('zoomend', cluster);
        collect(); cluster(); fitAll();
        const left = allItems().filter(x => x.m.local && x.m.gpsChecked !== 1).length;
        stat.textContent = pts.length ? `${pts.length} ფაილი რუკაზე` : (left ? '' : 'GPS-ის მქონე ფაილები არ მოიძებნა');
        if (left) {
            stat.textContent = 'GPS-ის წაკითხვა...';
            const r = await gpsScan((d, t, f) => { if (!stop) stat.textContent = `GPS-ის წაკითხვა: ${d} / ${t}`; }, () => stop);
            if (stop) return;
            collect(); cluster();
            if (!pts.length) { stat.textContent = 'GPS-ის მქონე ფაილები არ მოიძებნა'; toast('GPS-ის მქონე ფაილები არ მოიძებნა. (ფოტოები, სადაც ლოკაცია ჩართული იყო, JPEG/MP4)', 5000); }
            else { stat.textContent = `${pts.length} ფაილი რუკაზე`; fitAll(); }
        }
        setTimeout(() => map && map.invalidateSize(), 200);
    };

    /* ======================= SIMILAR PHOTOS ======================= */
    const SIM = { groups: [], chosen: new Set(), shown: 40, running: false, cancel: false, t: 8 };
    async function dhash(file) {
        const bmp = await createImageBitmap(file, { resizeWidth: 72, resizeHeight: 64, resizeQuality: 'high' });
        const c = document.createElement('canvas'); c.width = 9; c.height = 8;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.imageSmoothingQuality = 'high';
        g.drawImage(bmp, 0, 0, 9, 8);
        if (bmp.close) bmp.close();
        const d = g.getImageData(0, 0, 9, 8).data;
        let hi = 0, lo = 0;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            const a = (y * 9 + x) * 4, b = a + 4;
            const l1 = d[a] * 0.299 + d[a + 1] * 0.587 + d[a + 2] * 0.114, l2 = d[b] * 0.299 + d[b + 1] * 0.587 + d[b + 2] * 0.114;
            const bit = l1 > l2 ? 1 : 0, n = y * 8 + x;
            if (n < 32) hi = (hi * 2 + bit) >>> 0; else lo = (lo * 2 + bit) >>> 0;
        }
        return [hi >>> 0, lo >>> 0];
    }
    const pop = (v) => { v = v - ((v >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; };
    const ham = (a, b) => pop((a[0] ^ b[0]) >>> 0) + pop((a[1] ^ b[1]) >>> 0);
    const hexH = (h) => h[0].toString(16).padStart(8, '0') + h[1].toString(16).padStart(8, '0');
    const unhex = (s) => [parseInt(s.slice(0, 8), 16) >>> 0, parseInt(s.slice(8), 16) >>> 0];
    const simBody = () => $('simBody'), simFoot = () => $('simFoot');

    window.openSimilar = function () {
        closeSidebarMobile();
        const el = panel('simModal', 'მსგავსი ფოტოები', 'fa-layer-group');
        el.querySelector('.pn-body').innerHTML = `<div id="simBody" class="absolute inset-0 overflow-y-auto p-4 sm:p-6 pb-24"></div>
            <div id="simFoot" class="hidden absolute bottom-0 inset-x-0 px-4 py-3 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 items-center justify-between gap-2"></div>`;
        closers.simModal = () => { SIM.cancel = true; };
        if (!SIM.running) simIntro();
    };
    function simIntro() {
        SIM.groups = []; SIM.chosen.clear(); simFoot().classList.add('hidden'); simFoot().classList.remove('flex');
        const imgs = allItems().filter(x => x.m.type === 'image' && x.m.local && x.m.path);
        simBody().innerHTML = `<div class="max-w-xl">
            <p class="text-sm text-slate-600 dark:text-slate-300">აპი ადარებს ფოტოების <b>შინაარსს</b> (არა სახელს და არა ბაიტებს) და აჯგუფებს ერთმანეთთან მსგავსს: სერიულ კადრებს, ოდნავ სხვა ხედს, მცირედ შეცვლილ ასლს. ჯგუფიდან შეგიძლია დატოვო საუკეთესო და დანარჩენი ამოიღო ბიბლიოთეკიდან.</p>
            <div class="mt-4 p-4 rounded-xl bg-slate-100 dark:bg-slate-800/60 text-sm">ფოტო შესადარებლად: <b>${imgs.length}</b> <span class="text-slate-500 text-xs">(ვიდეო არ მონაწილეობს)</span></div>
            <label class="block mt-4 text-sm font-medium">სიმკაცრე
                <select id="simLevel" class="mt-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-xl px-3 py-2.5 text-sm outline-none cursor-pointer">
                    <option value="4">ძალიან მსგავსი (თითქმის ერთნაირი)</option>
                    <option value="8" selected>მსგავსი (სერიული კადრები)</option>
                    <option value="12">თავისუფალი (მეტი შედეგი, შეიძლება შეცდომებიც)</option>
                </select></label>
            <p class="mt-3 text-xs text-slate-500">დისკზე არაფერი იშლება. ამოშლა მხოლოდ ბიბლიოთეკიდანაა და უკან დაბრუნებადია. პირველი გაშვება ნელია, შემდეგ ანაბეჭდები ინახება.</p>
            <button type="button" id="simGo" class="mt-4 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium cursor-pointer ${imgs.length > 1 ? '' : 'opacity-50 pointer-events-none'}"><i class="fa-solid fa-magnifying-glass mr-2"></i>ძებნის დაწყება</button></div>`;
        $('simGo').onclick = () => simRun(+$('simLevel').value);
    }
    async function simRun(T) {
        const items = allItems().filter(x => x.m.type === 'image' && x.m.local && x.m.path);
        const asks = askRoots(items);
        SIM.running = true; SIM.cancel = false; SIM.t = T;
        simBody().innerHTML = `<div class="py-10 text-center"><div class="text-sm mb-3" id="simStat">მზადდება...</div><div class="w-full max-w-sm mx-auto h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden"><div id="simBar" class="h-full bg-indigo-600 transition-all" style="width:0"></div></div><button type="button" id="simStop" class="mt-5 px-4 py-2 rounded-xl text-sm bg-slate-100 dark:bg-slate-800 cursor-pointer">გაჩერება</button></div>`;
        $('simStop').onclick = () => { SIM.cancel = true; };
        await asks;
        let i = 0, done = 0, skipped = 0, newly = 0;
        const hs = new Map();
        const worker = async () => {
            while (i < items.length && !SIM.cancel) {
                const it = items[i++], m = it.m;
                try {
                    if (m.dh && m.dhs === m.size) hs.set(it, unhex(m.dh));
                    else {
                        const f = await resolveFile(it.f, m);
                        const h = await dhash(f);
                        m.dh = hexH(h); m.dhs = m.size; newly++;
                        hs.set(it, h);
                    }
                } catch (e) { skipped++; }
                done++;
                const st = $('simStat'), bar = $('simBar');
                if (st) st.textContent = `ანალიზი: ${done} / ${items.length}`;
                if (bar) bar.style.width = Math.round(done / items.length * 100) + '%';
            }
        };
        await Promise.all(Array.from({ length: IS_TOUCH ? 2 : 4 }, worker));
        SIM.running = false;
        if (newly) persistData();
        if (SIM.cancel) { SIM.cancel = false; if ($('simBody')) simIntro(); return; }
        if (!$('simBody')) return;
        // bucket by bands (pigeonhole: T+1 bands guarantee that every pair within T bits shares one band)
        const arr = [...hs.entries()];
        const nb = T + 1, bl = Math.floor(64 / nb);
        const buckets = new Map();
        arr.forEach(([it, h], idx) => {
            const big = (BigInt(h[0]) << 32n) | BigInt(h[1]);
            for (let b = 0; b < nb; b++) {
                const sh = BigInt(b * bl), mask = (1n << BigInt(b === nb - 1 ? 64 - b * bl : bl)) - 1n;
                const k = b + ':' + ((big >> sh) & mask).toString(36);
                let l = buckets.get(k); if (!l) buckets.set(k, l = []);
                l.push(idx);
            }
        });
        const par = arr.map((_, k) => k);
        const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
        buckets.forEach(l => {
            if (l.length < 2 || l.length > 500) return;
            for (let a = 0; a < l.length; a++) for (let b = a + 1; b < l.length; b++) {
                if (find(l[a]) !== find(l[b]) && ham(arr[l[a]][1], arr[l[b]][1]) <= T) par[find(l[a])] = find(l[b]);
            }
        });
        const gm = new Map();
        arr.forEach(([it], idx) => { const r = find(idx); if (!gm.has(r)) gm.set(r, []); gm.get(r).push(it); });
        SIM.skipped = skipped;
        SIM.groups = [...gm.values()].filter(g => g.length > 1).map(g => {
            g.sort((a, b) => (fileDateMs(a.m) || 0) - (fileDateMs(b.m) || 0));
            const ts = g.map(x => fileDateMs(x.m)).filter(Boolean);
            const span = ts.length > 1 ? Math.max(...ts) - Math.min(...ts) : Infinity;
            const best = g.reduce((p, c) => ((c.m.w || 0) * (c.m.h || 0) > (p.m.w || 0) * (p.m.h || 0) || ((c.m.w || 0) * (c.m.h || 0) === (p.m.w || 0) * (p.m.h || 0) && (c.m.size || 0) > (p.m.size || 0))) ? c : p, g[0]);
            return { items: g, best, serial: span <= 60000 };
        }).sort((a, b) => b.items.length - a.items.length);
        SIM.chosen.clear(); SIM.shown = 40;
        simResults();
    }
    function simResults() {
        const body = simBody();
        if (!SIM.groups.length) {
            simFoot().classList.add('hidden'); simFoot().classList.remove('flex');
            body.innerHTML = `<div class="py-10 text-center"><div class="w-14 h-14 mx-auto mb-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-500 flex items-center justify-center text-xl"><i class="fa-solid fa-check"></i></div><div class="font-semibold">მსგავსი ფოტოები არ მოიძებნა</div><button type="button" id="simBack" class="mt-4 px-4 py-2 rounded-xl text-sm bg-slate-100 dark:bg-slate-800 cursor-pointer">სიმკაცრის შეცვლა</button></div>`;
            $('simBack').onclick = simIntro; return;
        }
        const total = SIM.groups.reduce((n, g) => n + g.items.length, 0);
        const parts = [`<div class="text-sm mb-3 flex items-center gap-3 flex-wrap"><span class="font-semibold">ჯგუფი: ${SIM.groups.length} · ფოტო: ${total}</span>${SIM.skipped ? `<span class="text-slate-500">ვერ წაიკითხა: ${SIM.skipped}</span>` : ''}<button type="button" id="simBack" class="px-3 py-1.5 rounded-lg text-xs bg-slate-100 dark:bg-slate-800 cursor-pointer">სიმკაცრის შეცვლა</button><button type="button" id="simAllBest" class="px-3 py-1.5 rounded-lg text-xs bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-300 cursor-pointer">ყველგან საუკეთესოს დატოვება</button></div>`];
        SIM.groups.slice(0, SIM.shown).forEach((g, gi) => {
            parts.push(`<div class="mb-4 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900"><div class="px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800/60 text-slate-500 flex items-center justify-between gap-2"><span>${g.items.length} ფოტო${g.serial ? ' · <span class="text-indigo-600 dark:text-indigo-300 font-semibold">სერიული კადრები</span>' : ''}</span><button type="button" data-g="${gi}" class="sim-best px-2.5 py-1 rounded-lg bg-white dark:bg-slate-800 text-[11px] cursor-pointer">საუკეთესოს დატოვება</button></div>
                <div class="p-2 grid gap-2" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))">${g.items.map((it, ii) => `<div class="relative"><button type="button" data-g="${gi}" data-i="${ii}" class="sim-open block w-full aspect-square rounded-lg overflow-hidden bg-slate-200 dark:bg-slate-800 cursor-pointer">${thumbCell(it)}</button>
                    <input type="checkbox" data-g="${gi}" data-i="${ii}" class="sim-ck absolute top-1.5 left-1.5 w-5 h-5 accent-rose-600 cursor-pointer" ${SIM.chosen.has(it) ? 'checked' : ''}>
                    ${it === g.best ? '<span class="absolute top-1.5 right-1.5 bg-emerald-600 text-white text-[9px] px-1.5 py-0.5 rounded-md font-semibold">საუკეთესო</span>' : ''}
                    <div class="text-[10px] text-slate-500 truncate mt-1" title="${escH(it.m.name)}">${escH(it.m.name)}</div><div class="text-[10px] text-slate-400 truncate">${it.m.w ? it.m.w + '×' + it.m.h + ' · ' : ''}${fmtSize(it.m.size)}</div></div>`).join('')}</div></div>`);
        });
        if (SIM.groups.length > SIM.shown) parts.push(`<div class="text-center py-2"><button type="button" id="simMore" class="px-4 py-2 rounded-xl text-sm text-indigo-600 bg-indigo-50 dark:bg-indigo-950/50 cursor-pointer">მეტის ჩვენება (${SIM.groups.length - SIM.shown})</button></div>`);
        body.innerHTML = parts.join('');
        observeLazy(body);
        $('simBack').onclick = simIntro;
        $('simAllBest').onclick = () => { SIM.groups.forEach(g => g.items.forEach(it => { if (it !== g.best) SIM.chosen.add(it); else SIM.chosen.delete(it); })); const y = body.scrollTop; simResults(); body.scrollTop = y; };
        body.querySelectorAll('.sim-best').forEach(b => b.onclick = () => { const g = SIM.groups[+b.dataset.g]; g.items.forEach(it => { if (it !== g.best) SIM.chosen.add(it); else SIM.chosen.delete(it); }); const y = body.scrollTop; simResults(); body.scrollTop = y; });
        body.querySelectorAll('.sim-ck').forEach(ck => ck.onchange = () => {
            const g = SIM.groups[+ck.dataset.g], it = g.items[+ck.dataset.i];
            if (ck.checked) {
                if (g.items.every(x => x === it || SIM.chosen.has(x))) { ck.checked = false; toast('ერთი ფოტო უნდა დარჩეს', 1800); return; }
                SIM.chosen.add(it);
            } else SIM.chosen.delete(it);
            simFooter();
        });
        body.querySelectorAll('.sim-open').forEach(b => b.onclick = () => { const it = SIM.groups[+b.dataset.g].items[+b.dataset.i]; openGalleryModalAtIndex(it.f.id, it.i); });
        const more = $('simMore');
        if (more) more.onclick = () => { SIM.shown += 40; const y = body.scrollTop; simResults(); body.scrollTop = y; };
        simFooter();
    }
    function simFooter() {
        const f = simFoot(), n = SIM.chosen.size;
        const sz = [...SIM.chosen].reduce((a, it) => a + (it.m.size || 0), 0);
        f.classList.remove('hidden'); f.classList.add('flex');
        f.innerHTML = `<span class="text-sm">ამოსაღები: <b>${n}</b> · ${fmtSize(sz) || '0 B'}</span><button type="button" id="simRm" class="px-4 py-2 rounded-xl text-sm font-medium bg-rose-600 hover:bg-rose-700 text-white cursor-pointer ${n ? '' : 'opacity-50 pointer-events-none'}"><i class="fa-solid fa-trash-can mr-2"></i>ბიბლიოთეკიდან ამოღება</button>`;
        $('simRm').onclick = simRemove;
    }
    function simRemove() {
        if (!SIM.chosen.size) return;
        const byFolder = new Map();
        SIM.chosen.forEach(it => {
            const idx = it.f.mediaFiles.indexOf(it.m);
            if (idx < 0) return;
            if (!byFolder.has(it.f)) byFolder.set(it.f, []);
            byFolder.get(it.f).push({ idx, m: it.m });
        });
        let total = 0; const removed = [];
        byFolder.forEach((arr, f) => {
            arr.sort((a, b) => a.idx - b.idx);
            const set = new Set(arr.map(x => x.m));
            f.mediaFiles = f.mediaFiles.filter(m => !set.has(m));
            recountFolder(f);
            removed.push({ f, arr }); total += arr.length;
        });
        if (!total) return;
        SIM.groups = []; SIM.chosen.clear();
        closePanel('simModal');
        persistData(); renderFolders();
        pushUndo(`ბიბლიოთეკიდან ამოიღო მსგავსი ფოტო: ${total} (დისკზე არ წაშლილა)`, () => {
            removed.forEach(({ f, arr }) => {
                if (!folders.includes(f)) return;
                arr.forEach(({ idx, m }) => f.mediaFiles.splice(Math.min(idx, f.mediaFiles.length), 0, m));
                recountFolder(f);
            });
        });
    }

    /* ======================= EXPORT: ZIP / PDF from the selection ======================= */
    const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    async function crc32(file, onChunk) {
        let c = 0xFFFFFFFF;
        const CH = 4 * 1024 * 1024;
        for (let o = 0; o < file.size; o += CH) {
            const u = new Uint8Array(await file.slice(o, o + CH).arrayBuffer());
            for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8);
            if (onChunk) onChunk(u.length);
        }
        return (c ^ 0xFFFFFFFF) >>> 0;
    }
    function dosDT(ms) {
        const d = new Date(ms || Date.now());
        const y = Math.max(1980, d.getFullYear());
        return { t: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), d: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
    }
    function uniqueNames(list) {
        const used = new Set();
        return list.map(it => {
            let n = it.m.name || 'file', base = n, ext = '';
            const dot = n.lastIndexOf('.');
            if (dot > 0) { base = n.slice(0, dot); ext = n.slice(dot); }
            let k = 1, out = n;
            while (used.has(out.toLowerCase())) out = `${base} (${++k})${ext}`;
            used.add(out.toLowerCase());
            return out;
        });
    }
    async function buildZip(list, prog, cancelled) {
        const enc = new TextEncoder(), parts = [], central = [];
        const names = uniqueNames(list);
        let off = 0, okN = 0, total = list.reduce((a, it) => a + (it.file.size || 0), 0) || 1, doneB = 0;
        for (let i = 0; i < list.length; i++) {
            if (cancelled()) return null;
            const { file, m } = list[i];
            if (file.size >= 0xFFFFFFFF) continue;
            const nb = enc.encode(names[i]);
            const crc = await crc32(file, (n) => { doneB += n / 2; prog(doneB / total / 1); });
            const { t, d } = dosDT(m.taken || m.mtime);
            const lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
            lh.setUint16(10, t, true); lh.setUint16(12, d, true); lh.setUint32(14, crc, true); lh.setUint32(18, file.size, true); lh.setUint32(22, file.size, true);
            lh.setUint16(26, nb.length, true); lh.setUint16(28, 0, true);
            parts.push(lh.buffer, nb, file);
            const ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
            ch.setUint16(12, t, true); ch.setUint16(14, d, true); ch.setUint32(16, crc, true); ch.setUint32(20, file.size, true); ch.setUint32(24, file.size, true);
            ch.setUint16(28, nb.length, true); ch.setUint32(42, off, true);
            central.push(ch.buffer, nb);
            off += 30 + nb.length + file.size; okN++;
            doneB += (file.size || 0) / 2; prog(doneB / total);
        }
        let cs = 0; central.forEach(b => { cs += b.byteLength !== undefined ? b.byteLength : b.length; });
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true); end.setUint16(8, okN, true); end.setUint16(10, okN, true); end.setUint32(12, cs, true); end.setUint32(16, off, true);
        if (off + cs > 0xFFFFFFFE) throw new Error('ZIP > 4 GB');
        return { blob: new Blob([...parts, ...central, end.buffer], { type: 'application/zip' }), count: okN };
    }
    // ---- PDF (pages are drawn on a canvas, then embedded as JPEG) ----
    function fitText(g, text, maxW) {
        if (g.measureText(text).width <= maxW) return text;
        let s = text;
        while (s.length > 1 && g.measureText(s + '…').width > maxW) s = s.slice(0, -1);
        return s + '…';
    }
    async function bitmapFor(it, w) {
        if (it.m.type === 'video') {
            const b = await makeThumbBlob(it.file, 'video', w);
            if (!b) throw new Error('frame');
            return createImageBitmap(b);
        }
        return createImageBitmap(it.file, { resizeWidth: w, resizeQuality: 'high' });
    }
    async function buildPdf(list, o, prog, cancelled) {
        const land = o.land, PW = land ? 1754 : 1240, PH = land ? 1240 : 1754;      // A4 at 150 dpi
        const cols = o.cols, rows = o.rows, per = cols * rows;
        const M = 70, topH = o.title ? 110 : 0, foot = 50, capH = o.caps ? 44 : 0, gap = 26;
        const cw = Math.floor((PW - 2 * M - gap * (cols - 1)) / cols);
        const ch = Math.floor((PH - 2 * M - topH - foot - gap * (rows - 1)) / rows);
        const pages = [];
        const c = document.createElement('canvas'); c.width = PW; c.height = PH;
        const g = c.getContext('2d');
        const nPages = Math.ceil(list.length / per);
        for (let p = 0; p < nPages; p++) {
            if (cancelled()) return null;
            g.fillStyle = '#fff'; g.fillRect(0, 0, PW, PH);
            g.textBaseline = 'alphabetic';
            if (o.title) { g.fillStyle = '#0f172a'; g.font = '700 46px Inter, sans-serif'; g.fillText(fitText(g, o.title, PW - 2 * M), M, M + 40); }
            for (let k = 0; k < per; k++) {
                const idx = p * per + k;
                if (idx >= list.length) break;
                const it = list[idx];
                const x = M + (k % cols) * (cw + gap), y = M + topH + Math.floor(k / cols) * (ch + gap);
                g.fillStyle = '#f1f5f9'; g.fillRect(x, y, cw, ch - capH);
                try {
                    const bmp = await bitmapFor(it, Math.min(2400, cw * 2));
                    const s = Math.min(cw / bmp.width, (ch - capH) / bmp.height);
                    const w = bmp.width * s, h = bmp.height * s;
                    g.imageSmoothingQuality = 'high';
                    g.drawImage(bmp, x + (cw - w) / 2, y + (ch - capH - h) / 2, w, h);
                    if (bmp.close) bmp.close();
                } catch (e) { g.fillStyle = '#94a3b8'; g.font = '24px Inter, sans-serif'; g.fillText('—', x + cw / 2 - 8, y + (ch - capH) / 2); }
                if (o.caps) { g.fillStyle = '#334155'; g.font = '500 22px Inter, sans-serif'; g.fillText(fitText(g, it.m.name || '', cw), x, y + ch - 14); }
                prog((idx + 1) / list.length);
            }
            g.fillStyle = '#94a3b8'; g.font = '20px Inter, sans-serif';
            g.fillText(`${p + 1} / ${nPages}`, PW - M - 80, PH - M + 10);
            g.fillText('AvmaDrive', M, PH - M + 10);
            const jb = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
            pages.push(new Uint8Array(await jb.arrayBuffer()));
            await new Promise(r => setTimeout(r, 0));
        }
        // minimal PDF writer
        const enc = new TextEncoder(), out = [], offs = [];
        let pos = 0;
        const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; out.push(b); pos += b.length; };
        const obj = (n, fn) => { offs[n] = pos; push(`${n} 0 obj\n`); fn(); push('endobj\n'); };
        push('%PDF-1.4\n'); push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
        const wpt = land ? 841.89 : 595.28, hpt = land ? 595.28 : 841.89;
        obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>\n'));
        obj(2, () => push(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] >>\n`));
        pages.forEach((jpg, i) => {
            const pn = 3 + i * 3;
            obj(pn, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wpt} ${hpt}] /Resources << /XObject << /Im0 ${pn + 2} 0 R >> >> /Contents ${pn + 1} 0 R >>\n`));
            const cs = `q ${wpt} 0 0 ${hpt} 0 0 cm /Im0 Do Q\n`;
            obj(pn + 1, () => { push(`<< /Length ${cs.length} >>\nstream\n${cs}endstream\n`); });
            obj(pn + 2, () => { push(`<< /Type /XObject /Subtype /Image /Width ${PW} /Height ${PH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`); push(jpg); push('\nendstream\n'); });
        });
        const N = 3 + pages.length * 3, xr = pos;
        let x = `xref\n0 ${N}\n0000000000 65535 f \n`;
        for (let n = 1; n < N; n++) x += String(offs[n]).padStart(10, '0') + ' 00000 n \n';
        push(x + `trailer\n<< /Size ${N} /Root 1 0 R >>\nstartxref\n${xr}\n%%EOF\n`);
        return { blob: new Blob(out, { type: 'application/pdf' }), count: list.length, pages: pages.length };
    }
    async function saveBlob(blob, name, mime, ext) {
        if (window.showSaveFilePicker) {
            try {
                const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: name, accept: { [mime]: [ext] } }] });
                const w = await h.createWritable(); await w.write(blob); await w.close();
                return true;
            } catch (e) { if (e && e.name === 'AbortError') return false; }
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 20000);
        return true;
    }
    function selectedItems() {
        return [...selected].map(k => {
            const [fid, idx] = k.split('|');
            const f = folders.find(x => x.id === fid);
            const m = f && f.mediaFiles && f.mediaFiles[+idx];
            return m ? { f, m, i: +idx } : null;
        }).filter(Boolean);
    }
    window.openExport = function () {
        const items = selectedItems();
        if (!items.length) return;
        const asks = askRoots(items);
        let el = $('exportModal'); if (el) el.remove();
        el = document.createElement('div');
        el.id = 'exportModal';
        el.className = 'fixed inset-0 z-[60] bg-slate-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4';
        const canShare = !!(navigator.canShare && navigator.share);
        el.innerHTML = `<div class="bg-white dark:bg-slate-900 rounded-t-2xl sm:rounded-xl border border-slate-200 dark:border-slate-800 w-full max-w-md shadow-2xl overflow-hidden">
            <div class="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between"><h3 class="font-bold text-slate-900 dark:text-white text-lg">ექსპორტი — ${items.length} ფაილი</h3><button type="button" id="exX" class="text-slate-400 hover:text-slate-600 cursor-pointer"><i class="fa-solid fa-xmark text-lg"></i></button></div>
            <div class="p-5 space-y-4" id="exBody">
                <div class="grid grid-cols-2 gap-2">
                    <button type="button" data-fmt="zip" class="ex-fmt p-3 rounded-xl border-2 text-left cursor-pointer"><i class="fa-solid fa-file-zipper text-indigo-500 text-lg"></i><div class="text-sm font-semibold mt-1">ZIP არქივი</div><div class="text-[11px] text-slate-500">ორიგინალი ფაილები, შეუცვლელად</div></button>
                    <button type="button" data-fmt="pdf" class="ex-fmt p-3 rounded-xl border-2 text-left cursor-pointer"><i class="fa-solid fa-file-pdf text-rose-500 text-lg"></i><div class="text-sm font-semibold mt-1">PDF კოლაჟი</div><div class="text-[11px] text-slate-500">საბეჭდი ფურცლები მინიატურებით</div></button>
                </div>
                <div id="exPdf" class="hidden space-y-3 text-sm">
                    <label class="block">სათაური (არასავალდებულო)<input id="exTitle" maxlength="80" class="mt-1 w-full bg-slate-100 dark:bg-slate-800 rounded-xl px-3 py-2 outline-none" placeholder="მაგ.: ზაფხული 2024"></label>
                    <div class="grid grid-cols-2 gap-2">
                        <label class="block">ფოტო ფურცელზე<select id="exGrid" class="mt-1 w-full bg-slate-100 dark:bg-slate-800 rounded-xl px-3 py-2 outline-none cursor-pointer"><option value="1x1">1</option><option value="2x2">4 (2×2)</option><option value="3x3" selected>9 (3×3)</option><option value="4x5">20 (4×5)</option></select></label>
                        <label class="block">ფურცელი<select id="exLand" class="mt-1 w-full bg-slate-100 dark:bg-slate-800 rounded-xl px-3 py-2 outline-none cursor-pointer"><option value="0">A4 ვერტიკალური</option><option value="1">A4 ჰორიზონტალური</option></select></label>
                    </div>
                    <label class="flex items-center gap-2"><input type="checkbox" id="exCaps" checked class="w-4 h-4 accent-indigo-600"> ფაილის სახელები ქვემოთ</label>
                </div>
                <div id="exProg" class="hidden"><div class="text-sm mb-2" id="exStat"></div><div class="h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden"><div id="exBar" class="h-full bg-indigo-600 transition-all" style="width:0"></div></div></div>
            </div>
            <div class="px-5 py-4 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2" id="exFoot">
                <button type="button" id="exCancel" class="px-4 py-2 rounded-xl text-sm bg-slate-100 dark:bg-slate-800 cursor-pointer">გაუქმება</button>
                ${canShare ? '<button type="button" id="exShare" class="px-4 py-2 rounded-xl text-sm bg-slate-100 dark:bg-slate-800 cursor-pointer"><i class="fa-solid fa-share-nodes mr-1.5"></i>გაზიარება</button>' : ''}
                <button type="button" id="exGo" class="px-5 py-2 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"><i class="fa-solid fa-download mr-1.5"></i>შენახვა</button>
            </div>
        </div>`;
        document.body.appendChild(el);
        let fmt = 'zip', busy = false, cancel = false;
        const close = () => { cancel = true; el.remove(); };
        $('exX').onclick = $('exCancel').onclick = close;
        el.onclick = (e) => { if (e.target === el && !busy) close(); };
        const paint = () => {
            el.querySelectorAll('.ex-fmt').forEach(b => { const on = b.dataset.fmt === fmt; b.className = 'ex-fmt p-3 rounded-xl border-2 text-left cursor-pointer ' + (on ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40' : 'border-slate-200 dark:border-slate-700'); });
            $('exPdf').classList.toggle('hidden', fmt !== 'pdf');
        };
        el.querySelectorAll('.ex-fmt').forEach(b => b.onclick = () => { if (!busy) { fmt = b.dataset.fmt; paint(); } });
        paint();
        const run = async (share) => {
            if (busy) return;
            busy = true; cancel = false;
            $('exProg').classList.remove('hidden');
            $('exGo').classList.add('opacity-50', 'pointer-events-none');
            const sh = $('exShare'); if (sh) sh.classList.add('opacity-50', 'pointer-events-none');
            const stat = $('exStat'), bar = $('exBar');
            const prog = (r) => { if (bar) bar.style.width = Math.round(Math.min(1, r) * 100) + '%'; };
            try {
                await asks;
                stat.textContent = 'ფაილების გახსნა...';
                const list = []; let skipped = 0;
                for (const it of items) {
                    try { list.push({ ...it, file: await resolveFile(it.f, it.m) }); } catch (e) { skipped++; }
                }
                if (!list.length) { toast('ფაილები ვერ გაიხსნა. შეამოწმე წვდომა დისკთან', 5000); busy = false; el.remove(); return; }
                const stamp = new Date().toISOString().slice(0, 10);
                stat.textContent = fmt === 'zip' ? 'ZIP-ის მომზადება...' : 'PDF-ის მომზადება...';
                let res, name, mime, ext;
                if (fmt === 'zip') { res = await buildZip(list, prog, () => cancel); name = `AvmaDrive-${stamp}.zip`; mime = 'application/zip'; ext = '.zip'; }
                else {
                    const [cols, rows] = $('exGrid').value.split('x').map(Number);
                    list.sort((a, b) => fileDateMs(a.m) - fileDateMs(b.m));
                    res = await buildPdf(list, { cols, rows, land: $('exLand').value === '1', caps: $('exCaps').checked, title: $('exTitle').value.trim() }, prog, () => cancel);
                    name = `AvmaDrive-${stamp}.pdf`; mime = 'application/pdf'; ext = '.pdf';
                }
                if (!res || cancel) { return; }
                let ok = true;
                if (share) {
                    const file = new File([res.blob], name, { type: mime });
                    if (navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); } catch (e) { ok = false; } }
                    else ok = await saveBlob(res.blob, name, mime, ext);
                } else ok = await saveBlob(res.blob, name, mime, ext);
                busy = false; el.remove();
                if (ok) toast(`მზადაა: ${res.count} ფაილი${skipped ? ` (ვერ გაიხსნა: ${skipped})` : ''}`, 4000);
            } catch (e) {
                busy = false; el.remove();
                toast('ექსპორტი ვერ მოხერხდა: ' + (e && e.message ? e.message : e), 6000);
            }
        };
        $('exGo').onclick = () => run(false);
        if ($('exShare')) $('exShare').onclick = () => run(true);
    };

    /* ======================= VIDEO HOVER SCRUB ======================= */
    (function () {
        const c = $('foldersContainer');
        if (!c) return;
        let cur = null, timer = null;
        function stop() {
            clearTimeout(timer); timer = null;
            if (!cur) return;
            try { cur.v.pause(); cur.v.removeAttribute('src'); cur.v.load(); } catch (e) {}
            if (cur.url) URL.revokeObjectURL(cur.url);
            cur.wrap.remove(); cur = null;
        }
        function seekTo(e) {
            if (!cur) return;
            const r = cur.box.getBoundingClientRect();
            cur.p = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
            cur.bar.style.width = (cur.p * 100) + '%';
            if (cur.v.duration && !cur.v.seeking) { try { cur.v.currentTime = cur.p * cur.v.duration; } catch (x) {} }
        }
        async function start(card, e) {
            const [fid, idxS] = card.dataset.sel.split('|');
            const f = folders.find(x => x.id === fid), m = f && f.mediaFiles && f.mediaFiles[+idxS];
            if (!m || m.type !== 'video') return;
            const im = card.querySelector('img, video');
            const box = im && im.parentElement;
            if (!box) return;
            let src, url = null;
            try {
                if (m.local) { const file = await resolveFile(f, m); url = URL.createObjectURL(file); src = url; }
                else src = m.url;
            } catch (x) { return; }
            if (!src) return;
            if (!card.matches(':hover')) { if (url) URL.revokeObjectURL(url); return; }
            stop();
            const wrap = document.createElement('div');
            wrap.className = 'absolute inset-0 pointer-events-none opacity-0 transition-opacity';
            const v = document.createElement('video');
            v.muted = true; v.playsInline = true; v.preload = 'auto'; v.className = 'w-full h-full object-cover';
            const bar = document.createElement('div');
            bar.className = 'absolute bottom-0 left-0 h-1 bg-indigo-500'; bar.style.width = '0';
            wrap.append(v, bar); box.appendChild(wrap);
            cur = { v, wrap, bar, box, url, p: 0 };
            v.addEventListener('loadedmetadata', () => { if (cur && cur.v === v) { try { v.currentTime = cur.p * (v.duration || 0); } catch (x) {} } });
            v.addEventListener('seeked', () => { if (cur && cur.v === v) { wrap.style.opacity = '1'; if (v.duration && Math.abs(v.currentTime - cur.p * v.duration) > 0.3 && !v.seeking) { try { v.currentTime = cur.p * v.duration; } catch (x) {} } } });
            v.src = src;
            seekTo(e);
        }
        c.addEventListener('mouseover', (e) => {
            if (!HOVER()) return;
            const card = e.target.closest('[data-sel]');
            if (!card || (cur && cur.wrap.parentElement && card.contains(cur.wrap))) return;
            stop();
            const ev = { clientX: e.clientX };
            timer = setTimeout(() => start(card, ev), 280);
        });
        c.addEventListener('mousemove', (e) => { if (cur) seekTo(e); });
        c.addEventListener('mouseout', (e) => {
            const card = e.target.closest('[data-sel]');
            if (card && !card.contains(e.relatedTarget)) stop();
        });
        c.addEventListener('click', stop, true);
        window.addEventListener('blur', stop);
        const _rf2 = renderFolders;
        renderFolders = function () { stop(); _rf2(); };
    })();
})();
