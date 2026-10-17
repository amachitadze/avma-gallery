/* AvmaDrive extras: settings window, slideshow, duplicate finder.
   Classic script, loaded after app.js (shares its globals). */
(function () {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const lsg = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const lss = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

    /* ---------------- Settings window ---------------- */
    window.openSettings = function () {
        const m = $('settingsModal');
        const rel = $('setRelink');
        if (rel) rel.classList.toggle('hidden', !(typeof FSA !== 'undefined' && FSA));
        const bp = getBasePath();
        const d = $('setBaseDesc');
        if (d) d.textContent = bp ? 'საბაზო საქაღალდე: ' + bp + ' · აირჩიე მშობელი საქაღალდე და აპი გაწყვეტილ ლინკებს თავისით დააკავშირებს' : 'აირჩიე მშობელი საქაღალდე და აპი გაწყვეტილ ლინკებს თავისით დააკავშირებს';
        $('ssInterval').value = String(SS.cfg.interval);
        $('ssShuffle').checked = !!SS.cfg.shuffle;
        $('ssFull').checked = !!SS.cfg.fs;
        if ($('langSel')) $('langSel').value = (window.LANG || 'ka');
        updateInstallBtn();
        m.classList.remove('hidden'); m.classList.add('flex');
    };
    window.closeSettings = function () {
        const m = $('settingsModal');
        m.classList.add('hidden'); m.classList.remove('flex');
    };
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const dm = $('dupModal');
        if (dm && !dm.classList.contains('hidden') && !document.querySelector('.fixed.z-\\[80\\]')) { e.preventDefault(); closeDupes(); return; }
        const m = $('settingsModal');
        if (m && !m.classList.contains('hidden')) { e.preventDefault(); closeSettings(); }
    });

    /* ---------------- Slideshow ---------------- */
    const SS = { on: false, timer: null, idleT: null, seen: new Set(), cfg: { interval: 5, shuffle: false, fs: true } };
    window.SS = SS;
    try { Object.assign(SS.cfg, JSON.parse(lsg('avma_ss') || '{}')); } catch (e) {}
    window.ssCfgChanged = function () {
        SS.cfg.interval = +$('ssInterval').value || 5;
        SS.cfg.shuffle = $('ssShuffle').checked;
        SS.cfg.fs = $('ssFull').checked;
        lss('avma_ss', JSON.stringify(SS.cfg));
        if (SS.on) ssArm();
    };
    function ssUi() {
        const b = $('slideshowBtn');
        if (b) {
            const i = b.querySelector('i');
            if (i) i.className = 'fa-solid ' + (SS.on ? 'fa-pause' : 'fa-play');
            b.setAttribute('data-gtip', SS.on ? 'სლაიდშოუს გაჩერება' : 'სლაიდშოუ');
            const sp = b.querySelector('span');
            if (sp) sp.textContent = SS.on ? 'გაჩერება' : 'სლაიდშოუ';
        }
        const gm = $('galleryModal');
        if (gm) { gm.classList.toggle('ss-on', SS.on); if (!SS.on) gm.classList.remove('ss-idle'); setTimeout(() => window.dispatchEvent(new Event('resize')), 50); }
    }
    function ssNext() {
        const f = folders.find(x => x.id === activeGalleryFolderId);
        if (!f || !(f.mediaFiles || []).length) { ssStop(); return; }
        const ord = galleryOrder(f);
        if (SS.cfg.shuffle && ord.length > 1) {
            SS.seen.add(currentGalleryIndex);
            let pool = ord.filter(i => !SS.seen.has(i));
            if (!pool.length) { SS.seen.clear(); SS.seen.add(currentGalleryIndex); pool = ord.filter(i => i !== currentGalleryIndex); }
            currentGalleryIndex = pool[Math.floor(Math.random() * pool.length)];
            renderGalleryViewer();
        } else {
            galleryStep(1);
        }
    }
    function ssArm() {
        clearTimeout(SS.timer);
        if (!SS.on) return;
        const tok = galleryToken;
        let tries = 0;
        const check = () => {
            if (!SS.on || tok !== galleryToken) return;
            const area = $('galleryDisplayArea');
            const v = area.querySelector('video');
            const img = area.querySelector('img');
            if (v) { v.onended = () => { if (SS.on && tok === galleryToken) ssNext(); }; return; }
            if (img && img.complete) {
                SS.timer = setTimeout(() => { if (SS.on && tok === galleryToken) ssNext(); }, SS.cfg.interval * 1000);
                return;
            }
            if (tries++ > 40) { ssNext(); return; }      // could not be shown: move on
            SS.timer = setTimeout(check, 250);
        };
        check();
    }
    function ssWake() {
        const gm = $('galleryModal');
        if (!gm) return;
        gm.classList.remove('ss-idle');
        clearTimeout(SS.idleT);
        if (SS.on) SS.idleT = setTimeout(() => { if (SS.on) gm.classList.add('ss-idle'); }, 2800);
    }
    function ssStart() {
        SS.on = true; SS.seen.clear();
        if (SS.cfg.fs && !isFullscreen()) toggleFullscreen();
        ssUi(); ssWake(); ssArm();
    }
    function ssStop() {
        SS.on = false;
        clearTimeout(SS.timer); clearTimeout(SS.idleT);
        ssUi();
    }
    window.toggleSlideshow = function () { SS.on ? ssStop() : ssStart(); };
    window.startFolderSlideshow = function () {
        const f = folders.find(x => x.id === currentParentId);
        if (!f || !(f.mediaFiles || []).length) return;
        const ord = galleryOrder(f);
        const first = SS.cfg.shuffle ? ord[Math.floor(Math.random() * ord.length)] : ord[0];
        openGalleryModalAtIndex(f.id, first);
        ssStart();
    };
    ['pointermove', 'pointerdown', 'keydown', 'touchstart'].forEach(t => {
        const gm = $('galleryModal');
        if (gm) gm.addEventListener(t, ssWake, true);
    });
    document.addEventListener('keydown', (e) => {
        const gm = $('galleryModal');
        if (!gm || gm.classList.contains('hidden') || e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (!$('tagModal').classList.contains('hidden')) return;
        const hasVideo = !!gm.querySelector('#galleryDisplayArea video');
        if (e.code === 'KeyP' || (e.code === 'Space' && !hasVideo)) { e.preventDefault(); e.stopImmediatePropagation(); toggleSlideshow(); }
    }, true);

    // hooks into app.js functions
    const _rgv = renderGalleryViewer;
    renderGalleryViewer = function () { _rgv(); if (SS.on) ssArm(); ssUi(); };
    const _cgm = closeGalleryModal;
    closeGalleryModal = function () { ssStop(); _cgm(); };
    function ssFolderBtn() {
        const b = $('ssFolderBtn');
        if (!b) return;
        const f = currentParentId ? folders.find(x => x.id === currentParentId) : null;
        const show = !!(f && (f.mediaFiles || []).length > 1 && !isSearchActive());
        b.classList.toggle('hidden', !show); b.classList.toggle('flex', show);
    }
    const _rf = renderFolders;
    renderFolders = function () { _rf(); ssFolderBtn(); };

    /* ---------------- Duplicate finder ---------------- */
    const D = { running: false, cancel: false, groups: [], skipped: 0, chosen: new Set(), shown: 60 };
    const dupBody = () => $('dupBody');
    const dupFoot = () => $('dupFoot');
    const escH = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    window.openDupes = function () {
        const m = $('dupModal');
        m.classList.remove('hidden'); m.classList.add('flex');
        if (!D.running) dupIntro();
    };
    window.closeDupes = function () {
        if (D.running) D.cancel = true;
        const m = $('dupModal');
        m.classList.add('hidden'); m.classList.remove('flex');
    };
    function candidates() {
        const bySize = new Map();
        let total = 0;
        folders.forEach(f => (f.mediaFiles || []).forEach(m => {
            if (!m.local || !m.path || !m.size) return;
            total++;
            const k = m.type + ':' + m.size;
            if (!bySize.has(k)) bySize.set(k, []);
            bySize.get(k).push({ f, m });
        }));
        const groups = [...bySize.values()].filter(g => g.length > 1);
        return { groups, total, files: groups.reduce((n, g) => n + g.length, 0) };
    }
    function dupIntro() {
        D.groups = []; D.chosen.clear(); dupFoot().classList.add('hidden');
        const c = candidates();
        dupBody().innerHTML = `
            <p class="text-sm text-slate-600 dark:text-slate-300">აპი ეძებს ფაილებს, რომლებიც <b>ბაიტ-ბაიტ ერთნაირია</b>, სახელის მიუხედავად. ჯერ ზომით ირჩევს კანდიდატებს, მერე მხოლოდ მათ კითხულობს და ადარებს.</p>
            <div class="mt-4 p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 text-sm">
                <div>ბიბლიოთეკაში ფაილი: <b>${c.total}</b></div>
                <div>ერთნაირი ზომის კანდიდატი: <b>${c.files}</b> (${c.groups.length} ჯგუფი)</div>
            </div>
            <p class="mt-3 text-xs text-slate-500 dark:text-slate-400">დისკზე არაფერი იშლება. ამოშლა მხოლოდ ბიბლიოთეკიდანაა და უკან დაბრუნებადია. დისკზე წასაშლელად ჩამოტვირთე ბილიკების სია და წაშალე ხელით. სკანირების ახალი განახლება ამოშლილ ფაილებს ისევ დააბრუნებს, თუ დისკზე დარჩნენ.</p>
            <button type="button" id="dupGo" class="mt-4 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium transition cursor-pointer ${c.files ? '' : 'opacity-50 pointer-events-none'}"><i class="fa-solid fa-magnifying-glass mr-2 text-xs"></i>დაწყება</button>
            ${c.files ? '' : '<p class="mt-3 text-sm text-slate-500">ერთნაირი ზომის ფაილები არ მოიძებნა. თუ ფაილის ზომა ჯერ არ ჩანს, დაელოდე მონაცემების განახლებას.</p>'}`;
        const go = $('dupGo');
        if (go) go.onclick = () => dupRun(c);
    }
    const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    const BIG = 32 * 1024 * 1024, CH = 2 * 1024 * 1024;
    async function hashFile(file) {
        if (file.size <= BIG) return hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())) + ':' + file.size;
        const mid = Math.floor(file.size / 2);
        const parts = await Promise.all([file.slice(0, CH), file.slice(mid, mid + CH), file.slice(file.size - CH)].map(b => b.arrayBuffer()));
        const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
        let o = 0; parts.forEach(p => { all.set(new Uint8Array(p), o); o += p.byteLength; });
        return hex(await crypto.subtle.digest('SHA-256', all)) + '~' + file.size;     // "~": large file, compared by start / middle / end
    }
    async function dupRun(c) {
        if (!(window.crypto && crypto.subtle)) { toast('ამ ბრაუზერში შედარება მიუწვდომელია (საჭიროა localhost ან HTTPS)'); return; }
        // permission prompts must start inside the click
        const roots = [...new Set(c.groups.flat().map(x => x.f.rootId).filter(r => r && rootHandles.has(r) && !accessGranted.has(r)))];
        const asks = roots.map(r => requestAccess(r).then(ok => { if (ok) accessGranted.add(r); }));
        D.running = true; D.cancel = false; D.skipped = 0;
        dupFoot().classList.add('hidden');
        dupBody().innerHTML = `<div class="py-10 text-center"><div class="text-sm mb-3" id="dupStat">მზადდება...</div><div class="w-full max-w-sm mx-auto h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden"><div id="dupBar" class="h-full bg-indigo-600 transition-all" style="width:0%"></div></div><button type="button" id="dupStop" class="mt-5 px-4 py-2 rounded-xl text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">შეჩერება</button></div>`;
        $('dupStop').onclick = () => { D.cancel = true; };
        await Promise.all(asks);
        const items = c.groups.flat();
        let i = 0, done = 0;
        const hashes = new Map();                   // item -> hash
        const worker = async () => {
            while (i < items.length && !D.cancel) {
                const it = items[i++];
                try {
                    const file = await resolveFile(it.f, it.m);
                    hashes.set(it, await hashFile(file));
                } catch (e) { D.skipped++; }
                done++;
                const st = $('dupStat'), bar = $('dupBar');
                if (st) st.textContent = `შედარება: ${done} / ${items.length}`;
                if (bar) bar.style.width = Math.round(done / items.length * 100) + '%';
            }
        };
        await Promise.all(Array.from({ length: IS_TOUCH ? 2 : 4 }, worker));
        D.running = false;
        if (D.cancel) { D.cancel = false; if (!$('dupModal').classList.contains('hidden')) dupIntro(); return; }
        const byHash = new Map();
        hashes.forEach((h, it) => { if (!byHash.has(h)) byHash.set(h, []); byHash.get(h).push(it); });
        D.groups = [...byHash.entries()].filter(([, g]) => g.length > 1).map(([h, g]) => {
            g.sort((a, b) => (fileDateMs(a.m) || Infinity) - (fileDateMs(b.m) || Infinity) || a.m.path.join('/').length - b.m.path.join('/').length);
            return { h, approx: h.includes('~'), items: g };
        }).sort((a, b) => b.items.length * b.items[0].m.size - a.items.length * a.items[0].m.size);
        D.chosen.clear(); D.shown = 60;
        D.groups.forEach(g => g.items.slice(1).forEach(it => D.chosen.add(it)));      // keep the oldest one by default
        dupResults();
    }
    function dupPathText(it) {
        let n = [], cur = it.f, g = 0;
        while (cur && g++ < 50) { n.unshift(cur.name); cur = cur.parentId ? folders.find(x => x.id === cur.parentId) : null; }
        return n.join(' / ');
    }
    function dupResults() {
        const body = dupBody();
        if (!D.groups.length) {
            dupFoot().classList.add('hidden');
            body.innerHTML = `<div class="py-10 text-center"><div class="w-14 h-14 mx-auto mb-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-500 flex items-center justify-center text-xl"><i class="fa-solid fa-check"></i></div><div class="font-semibold">დუბლიკატები ვერ მოიძებნა</div>${D.skipped ? `<div class="text-xs text-slate-500 mt-2">${D.skipped} ფაილი ვერ წაიკითხა (წვდომა ან გაწყვეტილი ლინკი)</div>` : ''}<button type="button" class="mt-5 px-4 py-2 rounded-xl text-sm text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 cursor-pointer" onclick="openDupes()">ახლიდან</button></div>`;
            return;
        }
        const wasted = D.groups.reduce((n, g) => n + (g.items.length - 1) * g.items[0].m.size, 0);
        const parts = [`<div class="text-sm mb-3"><b>${D.groups.length}</b> ჯგუფი · ზედმეტი ადგილი: <b>${fmtSize(wasted)}</b>${D.skipped ? ` · <span class="text-slate-500">ვერ წაიკითხა: ${D.skipped}</span>` : ''}</div>`];
        D.groups.slice(0, D.shown).forEach((g, gi) => {
            parts.push(`<div class="mb-3 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden"><div class="px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800/60 text-slate-500 flex justify-between"><span>${g.items.length} ერთნაირი · ${fmtSize(g.items[0].m.size)}</span>${g.approx ? '<span title="დიდი ფაილი: შედარდა დასაწყისი, შუა და დასასრული">სავარაუდო</span>' : ''}</div>`);
            g.items.forEach((it, ii) => {
                const idx = it.f.mediaFiles.indexOf(it.m);
                parts.push(`<div class="flex items-center gap-3 px-3 py-2 border-t border-slate-100 dark:border-slate-800">
                    <input type="checkbox" data-g="${gi}" data-i="${ii}" class="dup-ck w-4 h-4 accent-rose-600 flex-shrink-0 cursor-pointer" ${D.chosen.has(it) ? 'checked' : ''}>
                    <button type="button" data-g="${gi}" data-i="${ii}" title="გახსნა და დათვალიერება" class="dup-open flex items-center gap-3 min-w-0 flex-1 text-left cursor-pointer group">
                        <span class="block w-12 h-12 rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-800 flex-shrink-0">${mediaThumbHtml(it.m, it.f.id, idx, 'w-full h-full object-cover')}</span>
                        <span class="min-w-0 flex-1 block"><span class="block text-sm font-medium truncate text-indigo-600 dark:text-indigo-400 group-hover:underline">${escH(it.m.name)}</span><span class="block text-[11px] text-slate-500 truncate">${escH(dupPathText(it))} · ${escH(fileDateStr(it.m))}</span></span>
                    </button>
                    <span class="dup-tag text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${D.chosen.has(it) ? 'bg-rose-100 text-rose-600 dark:bg-rose-950/50' : 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950/50'}">${D.chosen.has(it) ? 'ამოსაშლელი' : 'რჩება'}</span>
                </div>`);
            });
            parts.push('</div>');
        });
        if (D.groups.length > D.shown) parts.push(`<div class="text-center py-2"><button type="button" id="dupMore" class="px-4 py-2 rounded-xl text-sm text-indigo-600 bg-indigo-50 dark:bg-indigo-950/50 cursor-pointer">მეტის ჩვენება (${D.groups.length - D.shown})</button></div>`);
        body.innerHTML = parts.join('');
        observeLazy(body);
        body.querySelectorAll('.dup-ck').forEach(ck => ck.onchange = () => {
            const g = D.groups[+ck.dataset.g], it = g.items[+ck.dataset.i];
            if (ck.checked) {
                if (g.items.every(x => x === it || D.chosen.has(x))) { ck.checked = false; toast('ერთი ასლი უნდა დარჩეს', 1800); return; }   // never remove the last copy
                D.chosen.add(it);
            } else D.chosen.delete(it);
            dupPaintRow(ck.closest('div.flex'), ck.checked);
            dupFooter();
        });
        body.querySelectorAll('.dup-open').forEach(b => b.onclick = () => dupPreview(+b.dataset.g, +b.dataset.i));
        const more = $('dupMore');
        if (more) more.onclick = () => { D.shown += 60; const y = body.scrollTop; dupResults(); body.scrollTop = y; };
        dupFooter();
    }
    function dupPaintRow(row, on) {
        const tag = row.querySelector('.dup-tag');
        tag.textContent = on ? 'ამოსაშლელი' : 'რჩება';
        tag.className = 'dup-tag text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ' + (on ? 'bg-rose-100 text-rose-600 dark:bg-rose-950/50' : 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950/50');
        const ck = row.querySelector('.dup-ck'); if (ck) ck.checked = on;
    }
    // full-size look at a duplicate, with the neighbours of its group and the keep / remove choice
    let PV = null;
    function dupToggle(g, it) {
        if (D.chosen.has(it)) D.chosen.delete(it);
        else {
            if (g.items.every(x => x === it || D.chosen.has(x))) { toast('ერთი ასლი უნდა დარჩეს', 1800); return false; }
            D.chosen.add(it);
        }
        return true;
    }
    function dupPreviewClose() {
        if (!PV) return;
        if (PV.url) URL.revokeObjectURL(PV.url);
        PV.el.remove(); document.removeEventListener('keydown', PV.key, true); PV = null;
        dupResults();
    }
    async function dupPreviewShow() {
        const g = D.groups[PV.g], it = g.items[PV.i];
        const st = PV.el;
        st.querySelector('.pv-title').textContent = it.m.name;
        st.querySelector('.pv-meta').textContent = `${PV.i + 1} / ${g.items.length} · ${dupPathText(it)} · ${fileDateStr(it.m)} · ${fmtSize(it.m.size)}${it.m.w ? ' · ' + it.m.w + '×' + it.m.h : ''}`;
        const on = D.chosen.has(it);
        const tg = st.querySelector('.pv-toggle');
        tg.innerHTML = on ? '<i class="fa-solid fa-rotate-left mr-1.5"></i>დატოვება' : '<i class="fa-solid fa-trash-can mr-1.5"></i>ამოსაშლელად მონიშვნა';
        tg.className = 'pv-toggle px-3 py-2 rounded-xl text-xs font-medium text-white cursor-pointer ' + (on ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700');
        const box = st.querySelector('.pv-box');
        if (PV.url) { URL.revokeObjectURL(PV.url); PV.url = null; }
        box.innerHTML = '<div class="text-slate-400 text-sm">...</div>';
        const seq = ++PV.seq;
        try {
            const file = await resolveFile(it.f, it.m);
            if (!PV || seq !== PV.seq) return;
            PV.url = URL.createObjectURL(file);
            const el = document.createElement(it.m.type === 'video' ? 'video' : 'img');
            if (it.m.type === 'video') el.controls = true;
            el.src = PV.url; el.className = 'max-w-full max-h-full object-contain';
            box.innerHTML = ''; box.appendChild(el);
        } catch (e) { box.innerHTML = '<div class="text-slate-400 text-sm">ფაილი ვერ გაიხსნა</div>'; }
    }
    function dupPreview(gi, ii) {
        if (PV) return;
        const el = document.createElement('div');
        el.className = 'fixed inset-0 z-[70] bg-black/95 flex flex-col text-white';
        el.innerHTML = `<div class="flex items-center gap-3 px-3 sm:px-4 py-3"><div class="min-w-0 flex-1"><div class="pv-title text-sm font-semibold truncate"></div><div class="pv-meta text-[11px] text-slate-400 truncate"></div></div><button type="button" class="pv-toggle"></button><button type="button" class="pv-close w-9 h-9 text-xl text-slate-300 hover:text-white cursor-pointer" title="Esc"><i class="fa-solid fa-xmark"></i></button></div>
            <div class="relative flex-1 min-h-0"><div class="pv-box absolute inset-0 flex items-center justify-center p-2"></div>
                <button type="button" class="pv-prev absolute left-0 top-1/2 -translate-y-1/2 p-3 text-xl bg-black/40 rounded-xl text-white/80 hover:text-white cursor-pointer"><i class="fa-solid fa-chevron-left"></i></button>
                <button type="button" class="pv-next absolute right-0 top-1/2 -translate-y-1/2 p-3 text-xl bg-black/40 rounded-xl text-white/80 hover:text-white cursor-pointer"><i class="fa-solid fa-chevron-right"></i></button></div>
            <div class="px-4 py-2 text-center text-[11px] text-slate-500">← → · Space</div>`;
        document.body.appendChild(el);
        PV = { el, g: gi, i: ii, url: null, seq: 0 };
        const go = (d) => { const n = D.groups[PV.g].items.length; PV.i = (PV.i + d + n) % n; dupPreviewShow(); };
        el.querySelector('.pv-close').onclick = dupPreviewClose;
        el.querySelector('.pv-prev').onclick = () => go(-1);
        el.querySelector('.pv-next').onclick = () => go(1);
        el.querySelector('.pv-toggle').onclick = () => { const g = D.groups[PV.g]; if (dupToggle(g, g.items[PV.i])) dupPreviewShow(); };
        PV.key = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); dupPreviewClose(); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); go(1); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); go(-1); }
            else if (e.code === 'Space') { e.preventDefault(); e.stopImmediatePropagation(); const g = D.groups[PV.g]; if (dupToggle(g, g.items[PV.i])) dupPreviewShow(); }
        };
        document.addEventListener('keydown', PV.key, true);
        dupPreviewShow();
    }
    function dupFooter() {
        const f = dupFoot();
        const n = D.chosen.size;
        const sz = [...D.chosen].reduce((a, it) => a + (it.m.size || 0), 0);
        f.classList.remove('hidden'); f.classList.add('flex');
        f.innerHTML = `<span class="text-sm">ამოსაშლელი: <b>${n}</b> · ${fmtSize(sz) || '0 B'}</span><span class="flex gap-2"><button type="button" id="dupTxt" class="px-3 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer ${n ? '' : 'opacity-50 pointer-events-none'}"><i class="fa-solid fa-file-lines mr-1.5"></i>ბილიკების სია</button><button type="button" id="dupRm" class="px-4 py-2 rounded-xl text-xs font-medium text-white bg-rose-600 hover:bg-rose-700 cursor-pointer ${n ? '' : 'opacity-50 pointer-events-none'}"><i class="fa-solid fa-trash-can mr-1.5"></i>ბიბლიოთეკიდან ამოშლა</button></span>`;
        $('dupTxt').onclick = dupExportList;
        $('dupRm').onclick = dupRemove;
    }
    function dupExportList() {
        const lines = [...D.chosen].map(it => { try { return getLocalFilePath(it.f, it.m) || it.m.path.join('/'); } catch (e) { return it.m.path.join('/'); } });
        const blob = new Blob([lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'avmadrive-duplicates.txt';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    function dupRemove() {
        if (!D.chosen.size) return;
        const byFolder = new Map();
        D.chosen.forEach(it => {
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
        D.groups = []; D.chosen.clear();
        closeDupes();
        persistData(); renderFolders();
        pushUndo(`ბიბლიოთეკიდან ამოიშალა დუბლიკატი: ${total} ფაილი (დისკზე არ წაშლილა)`, () => {
            removed.forEach(({ f, arr }) => {
                if (!folders.includes(f)) return;
                arr.forEach(({ idx, m }) => f.mediaFiles.splice(Math.min(idx, f.mediaFiles.length), 0, m));
                recountFolder(f);
            });
        });
    }
})();
