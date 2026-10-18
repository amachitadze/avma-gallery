/* AvmaDrive: photo editor (saves edited COPIES, originals are never touched) and albums (virtual collections).
   Classic script, loaded after features.js (shares app.js globals). */
(function () {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const UI = window._ui;
    const escH = UI.escH;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    /* small input dialog (z above everything) */
    function askName(title, initial, okLabel) {
        return new Promise(resolve => {
            const ov = document.createElement('div');
            ov.id = 'albAsk';
            ov.className = 'fixed inset-0 z-[90] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4';
            ov.innerHTML = `<div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 w-full max-w-sm shadow-2xl p-5 space-y-4 text-slate-800 dark:text-slate-100">
                <h3 class="font-bold text-lg"></h3>
                <input type="text" maxlength="60" class="w-full px-3.5 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500">
                <div class="flex justify-end gap-2"><button type="button" class="no px-4 py-2 rounded-xl text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">გაუქმება</button><button type="button" class="ok px-5 py-2 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"></button></div></div>`;
            ov.querySelector('h3').textContent = title;
            ov.querySelector('.ok').textContent = okLabel || 'შენახვა';
            const inp = ov.querySelector('input'); inp.value = initial || '';
            const done = (v) => { document.removeEventListener('keydown', key, true); ov.remove(); resolve(v); };
            const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } else if (e.key === 'Enter' && e.target === inp) { e.preventDefault(); done(inp.value.trim() || null); } };
            document.addEventListener('keydown', key, true);
            ov.querySelector('.no').onclick = () => done(null);
            ov.querySelector('.ok').onclick = () => done(inp.value.trim() || null);
            ov.onclick = (e) => { if (e.target === ov) done(null); };
            document.body.appendChild(ov);
            inp.focus(); inp.select();
        });
    }

    /* ======================= ALBUMS ======================= */
    const AK = '\u0001';
    const rootNameOf = (f) => { const r = folders.find(x => x.id === f.rootId); return r ? r.name : ''; };
    const keyOf = (f, m) => (m.local && m.path) ? rootNameOf(f) + AK + m.path.join('/') : 'url:' + (m.url || m.name);
    function itemIndex() {
        const mp = new Map();
        folders.forEach(f => (f.mediaFiles || []).forEach((m, i) => mp.set(keyOf(f, m), { f, m, i })));
        return mp;
    }
    function resolveAlbum(a, mp) {
        const out = []; let missing = 0;
        (a.items || []).forEach(k => { const x = mp.get(k); if (x) out.push({ ...x, key: k }); else missing++; });
        return { items: out, missing };
    }
    const newId = () => 'alb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    window.albumCreate = async function () {
        const n = await askName('ახალი ალბომი', '', 'შექმნა');
        if (!n) return null;
        const a = { id: newId(), name: n, items: [] };
        albums.push(a);
        await persistData(); renderAlbumsNav();
        return a;
    };
    // items: [{ f: folder, m: file }]
    window.albumAddItems = function (items) {
        items = (items || []).filter(x => x && x.f && x.m);
        if (!items.length) return;
        if ($('albPick')) $('albPick').remove();
        const ov = document.createElement('div');
        ov.id = 'albPick';
        ov.className = 'fixed inset-0 z-[85] bg-slate-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4';
        const draw = () => {
            ov.innerHTML = `<div class="bg-white dark:bg-slate-900 rounded-t-2xl sm:rounded-xl border border-slate-200 dark:border-slate-800 w-full max-w-sm shadow-2xl overflow-hidden text-slate-800 dark:text-slate-100 flex flex-col max-h-[80vh]">
                <div class="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between"><h3 class="font-bold text-lg">ალბომში დამატება · ${items.length}</h3><button type="button" class="x text-slate-400 hover:text-slate-600 cursor-pointer"><i class="fa-solid fa-xmark text-lg"></i></button></div>
                <div class="overflow-y-auto p-2">${albums.length ? albums.map(a => `<button type="button" data-id="${escH(a.id)}" class="alb-row w-full flex items-center justify-between gap-3 px-3 py-3 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-left cursor-pointer"><span class="flex items-center gap-3 min-w-0"><i class="fa-solid fa-book-open text-pink-500 w-5"></i><span class="truncate text-sm font-medium">${escH(a.name)}</span></span><span class="text-xs text-slate-400">${(a.items || []).length}</span></button>`).join('') : '<div class="px-3 py-4 text-sm text-slate-500">ალბომი ჯერ არ გაქვს</div>'}</div>
                <div class="p-3 border-t border-slate-100 dark:border-slate-800"><button type="button" class="new w-full px-4 py-2.5 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"><i class="fa-solid fa-plus mr-2"></i>ახალი ალბომი</button></div></div>`;
            ov.querySelector('.x').onclick = () => ov.remove();
            ov.querySelector('.new').onclick = async () => {
                const a = await window.albumCreate();
                if (a) { add(a); }
            };
            ov.querySelectorAll('.alb-row').forEach(b => b.onclick = () => add(albums.find(a => a.id === b.dataset.id)));
        };
        const add = async (a) => {
            if (!a) return;
            const have = new Set(a.items || []);
            let n = 0, dup = 0;
            items.forEach(x => { const k = keyOf(x.f, x.m); if (have.has(k)) dup++; else { have.add(k); a.items.push(k); n++; } });
            ov.remove();
            await persistData(); renderAlbumsNav();
            toast(n ? `ალბომში „${a.name}“ დაემატა: ${n}` + (dup ? ` (უკვე იყო: ${dup})` : '') : `ყველა ფაილი უკვე არის ალბომში „${a.name}“`, 3500);
        };
        ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
        const key = (e) => { if (e.key === 'Escape' && $('albPick')) { e.preventDefault(); e.stopPropagation(); ov.remove(); document.removeEventListener('keydown', key, true); } };
        document.addEventListener('keydown', key, true);
        document.body.appendChild(ov);
        draw();
    };
    window.albumAddSelected = function () {
        const its = [...selected].map(k => { const [fid, idx] = k.split('|'); const f = folders.find(x => x.id === fid); const m = f && f.mediaFiles && f.mediaFiles[+idx]; return m ? { f, m } : null; }).filter(Boolean);
        window.albumAddItems(its);
    };

    function renderAlbumsNav() {
        const box = $('albumsListContainer');
        if (!box) return;
        box.innerHTML = '';
        if (!albums.length) { box.innerHTML = '<div class="text-xs text-slate-400 px-3 py-1">ალბომები არ არის</div>'; return; }
        const mp = itemIndex();
        albums.forEach(a => {
            const n = resolveAlbum(a, mp).items.length;
            const row = document.createElement('a');
            row.href = '#';
            row.dataset.tip = `${a.name} · ${n}`;
            row.onclick = (e) => { e.preventDefault(); window.openAlbums(a.id); };
            row.className = 'flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium transition text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800';
            row.innerHTML = `<div class="flex items-center space-x-3 min-w-0"><i class="fa-solid fa-book-open w-5" style="color:#ec4899"></i><span class="truncate"></span></div><span class="text-xs bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-xl text-slate-500"></span>`;
            row.querySelector('span.truncate').textContent = a.name;
            row.lastElementChild.textContent = n;
            box.appendChild(row);
        });
    }
    const _rfA = renderFolders;
    renderFolders = function () { _rfA(); renderAlbumsNav(); };

    const thumb = (x, cls) => mediaThumbHtml(x.m, x.f.id, x.i, cls || 'w-full h-full object-cover');
    window.openAlbums = function (id) {
        UI.closeSidebarMobile();
        const mp = itemIndex();
        const a = id ? albums.find(x => x.id === id) : null;
        if (id && !a) id = null;
        const head = a ? `<button type="button" id="albBack" class="px-3 py-2 rounded-xl text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer"><i class="fa-solid fa-arrow-left mr-1.5"></i>ყველა ალბომი</button>
            <button type="button" id="albRename" title="გადარქმევა" class="w-9 h-9 rounded-xl text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"><i class="fa-solid fa-pen"></i></button>
            <button type="button" id="albDelete" title="ალბომის წაშლა" class="w-9 h-9 rounded-xl text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer"><i class="fa-solid fa-trash-can"></i></button>`
            : `<button type="button" id="albNew" class="px-3 py-2 rounded-xl text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer whitespace-nowrap"><i class="fa-solid fa-plus mr-1.5"></i>ახალი ალბომი</button>`;
        const el = UI.panel('albModal', a ? a.name : 'ალბომები', 'fa-book-open', head);
        const body = el.querySelector('.pn-body');
        body.innerHTML = '<div id="albBody" class="absolute inset-0 overflow-y-auto p-4 sm:p-6"></div>';
        const bd = $('albBody');
        if (!a) {
            if ($('albNew')) $('albNew').onclick = async () => { const n = await window.albumCreate(); if (n) window.openAlbums(n.id); };
            if (!albums.length) {
                bd.innerHTML = `<div class="max-w-md mx-auto py-12 text-center text-slate-500"><div class="w-14 h-14 mx-auto mb-3 rounded-xl bg-pink-50 dark:bg-pink-950/30 text-pink-500 flex items-center justify-center text-xl"><i class="fa-solid fa-book-open"></i></div><div class="font-semibold text-slate-800 dark:text-slate-100">ალბომი ჯერ არ გაქვს</div><p class="text-sm mt-2">ალბომი არის ვირტუალური კოლექცია: ფოტოები რჩება თავის საქაღალდეებში, ფაილები არსად გადაიტანება. მონიშნე ფოტოები და დააჭირე „ალბომში“, ან გალერეაში ფაილის სახელზე დაჭერით აირჩიე „ალბომში დამატება“.</p></div>`;
                return;
            }
            bd.innerHTML = `<div class="grid gap-4" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr))">${albums.map(al => {
                const r = resolveAlbum(al, mp);
                const cov = r.items.filter(x => x.m.type === 'image').slice(0, 4);
                const cells = [0, 1, 2, 3].map(i => cov[i] ? `<div class="overflow-hidden bg-slate-200 dark:bg-slate-800">${thumb(cov[i])}</div>` : '<div class="bg-slate-100 dark:bg-slate-800/60"></div>').join('');
                return `<button type="button" data-id="${escH(al.id)}" class="alb-card text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition cursor-pointer"><div class="grid grid-cols-2 grid-rows-2 gap-0.5 h-32">${cells}</div><div class="p-3"><div class="font-semibold text-sm truncate">${escH(al.name)}</div><div class="text-xs text-slate-400">${r.items.length} ფაილი${r.missing ? ` · ${r.missing} ვერ მოიძებნა` : ''}</div></div></button>`;
            }).join('')}</div>`;
            observeLazy(bd);
            bd.querySelectorAll('.alb-card').forEach(b => b.onclick = () => window.openAlbums(b.dataset.id));
            return;
        }
        // single album
        $('albBack').onclick = () => window.openAlbums();
        $('albRename').onclick = async () => { const n = await askName('ალბომის გადარქმევა', a.name); if (n) { a.name = n; await persistData(); renderAlbumsNav(); window.openAlbums(a.id); } };
        $('albDelete').onclick = async () => {
            const go = await choiceDialog('ალბომის წაშლა', `ალბომი „${a.name}“ წაიშლება. ფოტოები საქაღალდეებში არ წაიშლება.`, [{ label: 'გაუქმება', value: false }, { label: 'წაშლა', value: true, primary: true }]);
            if (!go) return;
            albums = albums.filter(x => x !== a);
            await persistData(); renderAlbumsNav(); window.openAlbums();
        };
        const r = resolveAlbum(a, mp);
        r.items.sort((x, y) => fileDateMs(x.m) - fileDateMs(y.m));
        const parts = [`<div class="text-sm text-slate-500 mb-3">${r.items.length} ფაილი${r.missing ? ` · <span class="text-amber-600">${r.missing} ვერ მოიძებნა</span> <button type="button" id="albClean" class="underline cursor-pointer">გასუფთავება</button>` : ''}</div>`];
        if (!r.items.length) parts.push('<div class="py-12 text-center text-sm text-slate-500">ალბომი ცარიელია. მონიშნე ფოტოები და დააჭირე „ალბომში“.</div>');
        else parts.push(`<div class="grid gap-2" style="grid-template-columns:repeat(auto-fill,minmax(130px,1fr))">${r.items.map((x, n) => `<div class="relative group aspect-square rounded-lg overflow-hidden bg-slate-200 dark:bg-slate-800"><button type="button" data-n="${n}" class="alb-open block w-full h-full cursor-pointer">${thumb(x)}</button>${x.m.type === 'video' ? '<span class="absolute bottom-1 right-1 bg-slate-900/80 text-white text-[9px] px-1.5 py-0.5 rounded-md pointer-events-none"><i class="fa-solid fa-play"></i></span>' : ''}<button type="button" data-n="${n}" title="ალბომიდან ამოღება" class="alb-rm absolute top-1 right-1 w-6 h-6 rounded-lg bg-slate-900/75 text-white text-[11px] cursor-pointer opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"><i class="fa-solid fa-xmark"></i></button></div>`).join('')}</div>`);
        bd.innerHTML = parts.join('');
        observeLazy(bd);
        bd.querySelectorAll('.alb-open').forEach(b => b.onclick = () => { const x = r.items[+b.dataset.n]; openGalleryModalAtIndex(x.f.id, x.i); });
        bd.querySelectorAll('.alb-rm').forEach(b => b.onclick = async () => {
            const x = r.items[+b.dataset.n];
            a.items = a.items.filter(k => k !== x.key);
            await persistData(); renderAlbumsNav();
            const y = bd.scrollTop; window.openAlbums(a.id); const nb = $('albBody'); if (nb) nb.scrollTop = y;
        });
        if ($('albClean')) $('albClean').onclick = async () => { const ok = new Set(r.items.map(x => x.key)); a.items = a.items.filter(k => ok.has(k)); await persistData(); renderAlbumsNav(); window.openAlbums(a.id); };
    };

    /* ======================= PHOTO EDITOR ======================= */
    const ED = { open: false };
    const ASPECTS = [['თავისუფალი', 0], ['1:1', 1], ['4:3', 4 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9], ['3:4', 3 / 4], ['9:16', 9 / 16]];
    const mimeOf = (n) => { const e = (n.split('.').pop() || '').toLowerCase(); return e === 'png' ? ['image/png', 'png'] : e === 'webp' ? ['image/webp', 'webp'] : ['image/jpeg', e === 'jpeg' ? 'jpeg' : 'jpg']; };

    function editBtnUi() {
        const b = $('editBtn'); if (!b) return;
        const cur = currentGalleryItem();
        const ok = !!(cur && cur.item.type === 'image' && (cur.item.local));
        b.classList.toggle('hidden', !ok); b.classList.toggle('flex', ok);
    }
    const _rgvE = renderGalleryViewer;
    renderGalleryViewer = function () { _rgvE(); editBtnUi(); };

    const tdims = (bw, bh) => (ED.rot % 2 === 1 ? [bh, bw] : [bw, bh]);
    const filterStr = () => `brightness(${100 + ED.b}%) contrast(${100 + ED.c}%) saturate(${100 + ED.s}%)` + (ED.mode === 'bw' ? ' grayscale(1)' : '') + (ED.mode === 'sepia' ? ' sepia(0.85)' : '');
    function paint(ctx, bmp, ow, oh, cf) {
        const bw = bmp.width, bh = bmp.height, [tw, th] = tdims(bw, bh);
        ctx.save();
        ctx.filter = filterStr();
        ctx.scale(ow / (cf.w * tw), oh / (cf.h * th));
        ctx.translate(-cf.x * tw, -cf.y * th);
        ctx.translate(tw / 2, th / 2);
        ctx.rotate(ED.rot * Math.PI / 2);
        ctx.scale(ED.fx ? -1 : 1, ED.fy ? -1 : 1);
        ctx.drawImage(bmp, -bw / 2, -bh / 2);
        ctx.restore();
    }
    const FULL = { x: 0, y: 0, w: 1, h: 1 };

    function layout() {
        const st = $('edStage'); if (!st || !ED.prev) return;
        const [tw, th] = tdims(ED.prev.width, ED.prev.height);
        const aw = st.clientWidth - 24, ah = st.clientHeight - 24;
        const sc = Math.min(aw / tw, ah / th);
        const pw = Math.max(40, Math.floor(tw * sc)), ph = Math.max(40, Math.floor(th * sc));
        ED.pw = pw; ED.ph = ph;
        const w = $('edWrap'); w.style.width = pw + 'px'; w.style.height = ph + 'px';
        const c = $('edCanvas'); c.width = pw; c.height = ph;
        if (ED.crop) { ED.crop = clampRect(ED.crop); }
        draw();
    }
    function draw() {
        const c = $('edCanvas'); if (!c || !ED.prev) return;
        const g = c.getContext('2d');
        g.clearRect(0, 0, c.width, c.height);
        paint(g, ED.prev, c.width, c.height, FULL);
        cropUi();
    }
    function clampRect(r) {
        const w = clamp(r.w, 24, ED.pw), h = clamp(r.h, 24, ED.ph);
        return { x: clamp(r.x, 0, ED.pw - w), y: clamp(r.y, 0, ED.ph - h), w, h };
    }
    function fitAspect(r) {
        // largest rect of ratio r centred in the picture
        let w = ED.pw, h = w / r;
        if (h > ED.ph) { h = ED.ph; w = h * r; }
        return { x: (ED.pw - w) / 2, y: (ED.ph - h) / 2, w, h };
    }
    function cropUi() {
        const box = $('edCrop'); if (!box) return;
        const on = !!ED.crop;
        box.classList.toggle('hidden', !on);
        $('edCropBtn').classList.toggle('bg-indigo-600', on); $('edCropBtn').classList.toggle('bg-white/10', !on);
        $('edAspects').classList.toggle('hidden', !on);
        if (!on) return;
        const r = ED.crop;
        box.style.left = r.x + 'px'; box.style.top = r.y + 'px'; box.style.width = r.w + 'px'; box.style.height = r.h + 'px';
        const cf = cropFrac(); const [tw, th] = tdims(ED.bmp.width, ED.bmp.height);
        $('edCropInfo').textContent = `${Math.round(cf.w * tw)} × ${Math.round(cf.h * th)} px`;
    }
    function cropFrac() {
        if (!ED.crop) return FULL;
        const r = ED.crop;
        return { x: r.x / ED.pw, y: r.y / ED.ph, w: r.w / ED.pw, h: r.h / ED.ph };
    }
    function startCrop() {
        ED.crop = clampRect({ x: ED.pw * 0.08, y: ED.ph * 0.08, w: ED.pw * 0.84, h: ED.ph * 0.84 });
        ED.aspect = 0; paintAspects(); cropUi(); ED.dirty = true;
    }
    function paintAspects() {
        document.querySelectorAll('#edAspects [data-r]').forEach(b => { const on = +b.dataset.r === (ED.aspect || 0); b.className = 'px-2.5 py-1.5 rounded-lg text-xs cursor-pointer ' + (on ? 'bg-indigo-600 text-white' : 'bg-white/10 hover:bg-white/20'); });
    }
    function resetAdjust() { ED.b = 0; ED.c = 0; ED.s = 0; ED.mode = ''; syncControls(); }
    function syncControls() {
        ['b', 'c', 's'].forEach(k => { const i = $('ed_' + k); if (i) { i.value = ED[k]; $('ed_' + k + 'v').textContent = ED[k]; } });
        document.querySelectorAll('#edModes [data-m]').forEach(b => { const on = b.dataset.m === (ED.mode || ''); b.className = 'px-3 py-1.5 rounded-lg text-xs cursor-pointer ' + (on ? 'bg-indigo-600 text-white' : 'bg-white/10 hover:bg-white/20'); });
    }

    // crop dragging
    function bindCrop() {
        const box = $('edCrop');
        let drag = null;
        const MIN = 24;
        box.addEventListener('pointerdown', (e) => {
            const h = e.target.dataset.h || (e.target === box ? 'move' : null);
            if (!h) return;
            e.preventDefault(); box.setPointerCapture(e.pointerId);
            drag = { h, sx: e.clientX, sy: e.clientY, r: { ...ED.crop }, id: e.pointerId };
        });
        box.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy, s = drag.r, h = drag.h, r = ED.aspect;
            let n;
            if (h === 'move') n = { x: clamp(s.x + dx, 0, ED.pw - s.w), y: clamp(s.y + dy, 0, ED.ph - s.h), w: s.w, h: s.h };
            else if (!r) {
                let x1 = s.x, y1 = s.y, x2 = s.x + s.w, y2 = s.y + s.h;
                if (h.includes('w')) x1 = clamp(s.x + dx, 0, x2 - MIN);
                if (h.includes('e')) x2 = clamp(x2 + dx, x1 + MIN, ED.pw);
                if (h.includes('n')) y1 = clamp(s.y + dy, 0, y2 - MIN);
                if (h.includes('s')) y2 = clamp(y2 + dy, y1 + MIN, ED.ph);
                n = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
            } else if (h.length === 2) {
                const dirX = h.includes('e') ? 1 : -1, dirY = h.includes('s') ? 1 : -1;
                const ax = dirX > 0 ? s.x : s.x + s.w, ay = dirY > 0 ? s.y : s.y + s.h;
                const px = (dirX > 0 ? s.x + s.w : s.x) + dx, py = (dirY > 0 ? s.y + s.h : s.y) + dy;
                let w = Math.max(MIN, (px - ax) * dirX), hh = Math.max(MIN, (py - ay) * dirY);
                if (w / r > hh) hh = w / r; else w = hh * r;
                const sc = Math.min(1, (dirX > 0 ? ED.pw - ax : ax) / w, (dirY > 0 ? ED.ph - ay : ay) / hh);
                w *= sc; hh *= sc;
                n = { x: dirX > 0 ? ax : ax - w, y: dirY > 0 ? ay : ay - hh, w, h: hh };
            } else {
                let w, hh;
                const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
                if (h === 'e' || h === 'w') { w = Math.max(MIN, h === 'e' ? s.w + dx : s.w - dx); hh = w / r; }
                else { hh = Math.max(MIN, h === 's' ? s.h + dy : s.h - dy); w = hh * r; }
                const k = Math.min(1, ED.pw / w, ED.ph / hh); w *= k; hh *= k;
                let x = (h === 'e') ? s.x : (h === 'w') ? s.x + s.w - w : cx - w / 2;
                let y = (h === 's') ? s.y : (h === 'n') ? s.y + s.h - hh : cy - hh / 2;
                n = { x: clamp(x, 0, ED.pw - w), y: clamp(y, 0, ED.ph - hh), w, h: hh };
            }
            ED.crop = n; cropUi();
        });
        const end = () => { drag = null; };
        box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
    }

    async function pickedBitmap(folder, item) {
        const f = await resolveFile(folder, item);
        return { file: f, bmp: await createImageBitmap(f) };
    }
    window.openEditor = async function () {
        if (ED.open) return;
        const cur = currentGalleryItem();
        if (!cur || cur.item.type !== 'image' || !cur.item.local) return;
        if (window.SS && SS.on) toggleSlideshow();
        let r;
        try { r = await pickedBitmap(cur.folder, cur.item); }
        catch (e) { toast('ფოტოს გახსნა ვერ მოხერხდა: ' + (typeof explainError === 'function' ? explainError(e) : (e.message || e.name)), 6000); return; }
        Object.assign(ED, { open: true, folder: cur.folder, item: cur.item, idx: cur.folder.mediaFiles.indexOf(cur.item), file: r.file, bmp: r.bmp, rot: 0, fx: false, fy: false, b: 0, c: 0, s: 0, mode: '', crop: null, aspect: 0, dirty: false, max: 0, q: 92, keepGps: true, busy: false });
        // preview proxy (keeps sliders fast on big photos)
        const big = Math.max(r.bmp.width, r.bmp.height);
        ED.prev = big > 1800 ? await createImageBitmap(r.bmp, { resizeWidth: Math.round(r.bmp.width * 1800 / big), resizeHeight: Math.round(r.bmp.height * 1800 / big), resizeQuality: 'high' }) : r.bmp;
        const [mime] = mimeOf(cur.item.name);
        const el = document.createElement('div');
        el.id = 'editModal';
        el.className = 'fixed inset-0 z-[70] bg-slate-950 text-white flex flex-col md:flex-row';
        el.innerHTML = `
            <div id="edStage" class="flex-1 min-h-0 min-w-0 relative flex items-center justify-center p-3 overflow-hidden"><div id="edWrap" class="relative overflow-hidden" style="touch-action:none"><canvas id="edCanvas" class="block"></canvas>
                <div id="edCrop" class="hidden absolute border-2 border-white" style="box-shadow:0 0 0 9999px rgba(0,0,0,.6);touch-action:none;cursor:move;background-image:linear-gradient(rgba(255,255,255,.3) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.3) 1px,transparent 1px);background-size:33.333% 33.333%">
                    ${[['nw', 0, 0], ['n', 50, 0], ['ne', 100, 0], ['e', 100, 50], ['se', 100, 100], ['s', 50, 100], ['sw', 0, 100], ['w', 0, 50]].map(([h, x, y]) => `<span data-h="${h}" class="absolute w-5 h-5 bg-white rounded-md shadow" style="left:${x}%;top:${y}%;transform:translate(-50%,-50%);cursor:${h.length === 2 ? (h === 'nw' || h === 'se' ? 'nwse' : 'nesw') : (h === 'n' || h === 's' ? 'ns' : 'ew')}-resize"></span>`).join('')}
                </div></div></div>
            <div class="w-full md:w-80 max-h-[48%] md:max-h-none md:h-full flex-shrink-0 bg-slate-900 border-t md:border-t-0 md:border-l border-white/10 overflow-y-auto p-4 space-y-5 text-sm" style="padding-bottom:max(1rem,env(safe-area-inset-bottom))">
                <div class="flex items-center justify-between"><h3 class="font-bold text-base">ფოტოს ჩასწორება</h3><button type="button" id="edClose" class="w-9 h-9 rounded-xl text-slate-300 hover:bg-white/10 cursor-pointer" title="დახურვა (Esc)"><i class="fa-solid fa-xmark text-lg"></i></button></div>
                <div class="text-[11px] text-slate-400 break-all -mt-3">${escH(cur.item.name)} · ორიგინალი არ შეიცვლება, ინახება ახალი ასლი</div>
                <div><div class="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">შებრუნება</div><div class="flex gap-2">
                    <button type="button" data-t="l" title="მარცხნივ 90°" class="ed-t w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 cursor-pointer"><i class="fa-solid fa-rotate-left"></i></button>
                    <button type="button" data-t="r" title="მარჯვნივ 90°" class="ed-t w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 cursor-pointer"><i class="fa-solid fa-rotate-right"></i></button>
                    <button type="button" data-t="h" title="ჰორიზონტალური გადაბრუნება" class="ed-t w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 cursor-pointer"><i class="fa-solid fa-left-right"></i></button>
                    <button type="button" data-t="v" title="ვერტიკალური გადაბრუნება" class="ed-t w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 cursor-pointer"><i class="fa-solid fa-up-down"></i></button></div></div>
                <div><div class="flex items-center justify-between mb-2"><div class="text-[11px] font-semibold uppercase tracking-wider text-slate-400">მოჭრა</div><span id="edCropInfo" class="text-[11px] text-slate-400"></span></div>
                    <div class="flex gap-2 mb-2"><button type="button" id="edCropBtn" class="px-3 py-1.5 rounded-lg text-xs cursor-pointer bg-white/10"><i class="fa-solid fa-crop-simple mr-1.5"></i>მოჭრა</button><button type="button" id="edCropOff" class="px-3 py-1.5 rounded-lg text-xs cursor-pointer bg-white/10 hover:bg-white/20">გაუქმება</button></div>
                    <div id="edAspects" class="hidden flex flex-wrap gap-1.5">${ASPECTS.map(([l, r]) => `<button type="button" data-r="${r}" class="px-2.5 py-1.5 rounded-lg text-xs cursor-pointer bg-white/10">${l}</button>`).join('')}<button type="button" id="edSwap" title="ვერტიკალი/ჰორიზონტალი" class="px-2.5 py-1.5 rounded-lg text-xs cursor-pointer bg-white/10 hover:bg-white/20"><i class="fa-solid fa-arrows-rotate"></i></button></div></div>
                <div><div class="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">ფერი</div>
                    ${[['b', 'სიკაშკაშე'], ['c', 'კონტრასტი'], ['s', 'ფერადობა']].map(([k, l]) => `<label class="block mb-2"><div class="flex justify-between text-xs mb-1"><span>${l}</span><span id="ed_${k}v" class="text-slate-400">0</span></div><input id="ed_${k}" type="range" min="-100" max="100" value="0" class="w-full accent-indigo-500"></label>`).join('')}
                    <div id="edModes" class="flex gap-1.5 mt-1">${[['', 'ორიგინალი'], ['bw', 'შავ-თეთრი'], ['sepia', 'სეპია']].map(([m, l]) => `<button type="button" data-m="${m}" class="px-3 py-1.5 rounded-lg text-xs cursor-pointer bg-white/10">${l}</button>`).join('')}</div></div>
                <div><div class="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">შენახვა</div>
                    <label class="block mb-2 text-xs">ზომა<select id="edMax" class="mt-1 w-full bg-white/10 rounded-lg px-3 py-2 text-sm outline-none cursor-pointer text-white"><option value="0" class="text-slate-900">ორიგინალის ზომა</option><option value="3840" class="text-slate-900">მაქს. 3840 px</option><option value="2560" class="text-slate-900">მაქს. 2560 px</option><option value="1920" class="text-slate-900">მაქს. 1920 px</option><option value="1280" class="text-slate-900">მაქს. 1280 px</option><option value="800" class="text-slate-900">მაქს. 800 px</option></select></label>
                    <label id="edQRow" class="block mb-2 text-xs ${mime === 'image/png' ? 'hidden' : ''}"><div class="flex justify-between mb-1"><span>ხარისხი</span><span id="edQv" class="text-slate-400">92</span></div><input id="edQ" type="range" min="50" max="100" value="92" class="w-full accent-indigo-500"></label>
                    <label id="edGpsRow" class="flex items-center gap-2 text-xs ${mime === 'image/jpeg' ? '' : 'hidden'}"><input id="edGps" type="checkbox" checked class="w-4 h-4 accent-indigo-500"> მდებარეობის (GPS) შენარჩუნება</label>
                    <p class="text-[11px] text-slate-400 mt-2">გადაღების თარიღი და კამერის მონაცემები JPEG-ში გადადის. GPS-ის გამორთვით ასლში მდებარეობა წაიშლება.</p></div>
                <div class="flex flex-wrap gap-2 pt-1"><button type="button" id="edReset" class="px-3 py-2 rounded-xl text-xs bg-white/10 hover:bg-white/20 cursor-pointer"><i class="fa-solid fa-rotate-left mr-1.5"></i>თავიდან</button>
                    <button type="button" id="edDl" class="px-3 py-2 rounded-xl text-xs bg-white/10 hover:bg-white/20 cursor-pointer"><i class="fa-solid fa-download mr-1.5"></i>ჩამოტვირთვა</button>
                    <button type="button" id="edSave" class="flex-1 min-w-[9rem] px-4 py-2 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-700 cursor-pointer"><i class="fa-solid fa-floppy-disk mr-1.5"></i>ასლად შენახვა</button></div>
                <div id="edMsg" class="hidden text-xs rounded-xl p-3"></div>
            </div>`;
        document.body.appendChild(el);
        document.body.dataset.editing = '1';
        bindCrop(); syncControls(); paintAspects();
        const markDirty = () => { ED.dirty = true; };
        el.querySelectorAll('.ed-t').forEach(b => b.onclick = () => {
            const t = b.dataset.t;
            if (t === 'l') ED.rot = (ED.rot + 3) % 4; else if (t === 'r') ED.rot = (ED.rot + 1) % 4;
            else if (t === 'h') { if (ED.rot % 2) ED.fy = !ED.fy; else ED.fx = !ED.fx; }
            else { if (ED.rot % 2) ED.fx = !ED.fx; else ED.fy = !ED.fy; }
            ED.crop = null; ED.aspect = 0; markDirty(); layout();
        });
        $('edCropBtn').onclick = () => { if (ED.crop) { ED.crop = null; cropUi(); } else startCrop(); };
        $('edCropOff').onclick = () => { ED.crop = null; cropUi(); };
        el.querySelectorAll('#edAspects [data-r]').forEach(b => b.onclick = () => {
            ED.aspect = +b.dataset.r; paintAspects(); markDirty();
            if (ED.aspect) ED.crop = fitAspect(ED.aspect); cropUi();
        });
        $('edSwap').onclick = () => { if (ED.aspect) { ED.aspect = 1 / ED.aspect; ED.crop = fitAspect(ED.aspect); } else if (ED.crop) { const r = ED.crop; ED.crop = clampRect({ x: r.x + (r.w - r.h) / 2, y: r.y + (r.h - r.w) / 2, w: r.h, h: r.w }); } paintAspects(); cropUi(); };
        ['b', 'c', 's'].forEach(k => $('ed_' + k).oninput = (e) => { ED[k] = +e.target.value; $('ed_' + k + 'v').textContent = ED[k]; markDirty(); draw(); });
        el.querySelectorAll('#edModes [data-m]').forEach(b => b.onclick = () => { ED.mode = b.dataset.m; markDirty(); syncControls(); draw(); });
        $('edMax').onchange = (e) => { ED.max = +e.target.value; };
        $('edQ').oninput = (e) => { ED.q = +e.target.value; $('edQv').textContent = ED.q; };
        $('edGps').onchange = (e) => { ED.keepGps = e.target.checked; };
        $('edReset').onclick = () => { ED.rot = 0; ED.fx = false; ED.fy = false; ED.crop = null; ED.aspect = 0; resetAdjust(); ED.dirty = false; layout(); };
        $('edClose').onclick = closeEditor;
        $('edDl').onclick = () => finish(false);
        $('edSave').onclick = () => finish(true);
        if (!(rootHandles.get(cur.folder.rootId))) {
            const m = $('edMsg'); m.classList.remove('hidden'); m.className = 'text-xs rounded-xl p-3 bg-amber-500/15 text-amber-200';
            m.textContent = 'ეს საქაღალდე დისკთან დაკავშირებული არ არის, ამიტომ ასლის საქაღალდეში ჩაწერა შეუძლებელია. გამოიყენე „ჩამოტვირთვა“ ან დააკავშირე საქაღალდე.';
        }
        ED.onResize = () => layout();
        window.addEventListener('resize', ED.onResize);
        ED.key = (e) => {
            if (e.key === 'Escape') { if ($('albAsk')) return; e.preventDefault(); e.stopPropagation(); closeEditor(); }
            else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.stopPropagation(); }
        };
        window.addEventListener('keydown', ED.key, true);
        requestAnimationFrame(layout);
    };
    function closeEditor(force) {
        if (!ED.open) return;
        if (!force && ED.dirty && !confirm('ცვლილებები არ შეინახება. დახურვა?')) return;
        window.removeEventListener('resize', ED.onResize);
        window.removeEventListener('keydown', ED.key, true);
        const el = $('editModal'); if (el) el.remove();
        delete document.body.dataset.editing;
        try { if (ED.bmp && ED.bmp.close) ED.bmp.close(); if (ED.prev && ED.prev !== ED.bmp && ED.prev.close) ED.prev.close(); } catch (e) {}
        ED.open = false; ED.bmp = ED.prev = null;
    }

    /* ---- JPEG: carry the original EXIF over (orientation fixed, thumbnail dropped, GPS optional) ---- */
    async function origExif(file) {
        const head = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
        if (head[0] !== 0xFF || head[1] !== 0xD8) return null;
        let o = 2;
        while (o + 4 <= head.length && head[o] === 0xFF) {
            const mk = head[o + 1];
            if (mk === 0xDA || mk === 0xD9) break;
            const len = (head[o + 2] << 8) | head[o + 3];
            if (mk === 0xE1 && head[o + 4] === 0x45 && head[o + 5] === 0x78 && head[o + 6] === 0x69 && head[o + 7] === 0x66) return head.slice(o, o + 2 + len);
            o += 2 + len;
        }
        return null;
    }
    function patchExif(seg, keepGps, W, H) {
        const dv = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
        const B = 10, le = dv.getUint16(B) === 0x4949;
        const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
        const w16 = (o, v) => dv.setUint16(o, v, le), w32 = (o, v) => dv.setUint32(o, v, le);
        if (u16(B + 2) !== 42) return seg;
        const SZ = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
        const ifd0 = B + u32(B + 4);
        if (ifd0 + 2 > seg.length) return seg;
        const n0 = u16(ifd0);
        const setDim = (e, v) => { const t = u16(e + 2); if (t === 3) w16(e + 8, v); else if (t === 4) w32(e + 8, v); };
        for (let i = 0; i < n0; i++) {
            const e = ifd0 + 2 + i * 12; if (e + 12 > seg.length) break;
            const tag = u16(e);
            if (tag === 0x0112) w16(e + 8, 1);
            else if (tag === 0x8769) {
                const ei = B + u32(e + 8);
                if (ei + 2 <= seg.length) { const n = u16(ei); for (let k = 0; k < n; k++) { const ee = ei + 2 + k * 12; if (ee + 12 > seg.length) break; const t = u16(ee); if (t === 0xA002) setDim(ee, W); else if (t === 0xA003) setDim(ee, H); } }
            } else if (tag === 0x8825 && !keepGps) {
                const gi = B + u32(e + 8);
                if (gi + 2 <= seg.length) {
                    const n = u16(gi);
                    for (let k = 0; k < n; k++) {
                        const ee = gi + 2 + k * 12; if (ee + 12 > seg.length) break;
                        const bytes = u32(ee + 4) * (SZ[u16(ee + 2)] || 1);
                        if (bytes > 4) { const off = B + u32(ee + 8); if (off + bytes <= seg.length) seg.fill(0, off, off + bytes); }
                        seg.fill(0, ee, ee + 12);
                    }
                    w16(gi, 0);
                }
                w16(e, 0x9999);         // no longer a GPS pointer
                seg.fill(0, e + 2, e + 12);
            }
        }
        w32(ifd0 + 2 + n0 * 12, 0);      // no IFD1: the old thumbnail is not referenced any more
        return seg;
    }
    async function jpegWithExif(blob, file, keepGps, W, H) {
        const seg = await origExif(file);
        if (!seg) return blob;
        const patched = patchExif(seg.slice(), keepGps, W, H);
        const src = new Uint8Array(await blob.arrayBuffer());
        let o = 2;
        if (src[2] === 0xFF && src[3] === 0xE0) o = 4 + ((src[4] << 8) | src[5]);        // drop JFIF (EXIF goes first)
        return new Blob([src.subarray(0, 2), patched, src.subarray(o)], { type: 'image/jpeg' });
    }

    async function renderOut() {
        const [mime, ext] = mimeOf(ED.item.name);
        const [tw, th] = tdims(ED.bmp.width, ED.bmp.height);
        const cf = cropFrac();
        const cwpx = cf.w * tw, chpx = cf.h * th;
        const k = ED.max ? Math.min(1, ED.max / Math.max(cwpx, chpx)) : 1;
        const ow = Math.max(1, Math.round(cwpx * k)), oh = Math.max(1, Math.round(chpx * k));
        const c = document.createElement('canvas'); c.width = ow; c.height = oh;
        const g = c.getContext('2d');
        if (mime === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, ow, oh); }
        g.imageSmoothingQuality = 'high';
        paint(g, ED.bmp, ow, oh, cf);
        let blob = await new Promise(r => c.toBlob(r, mime, ED.q / 100));
        if (!blob) throw new Error('canvas');
        if (mime === 'image/jpeg') blob = await jpegWithExif(blob, ED.file, ED.keepGps, ow, oh);
        return { blob, ow, oh, mime, ext };
    }
    function msg(text, kind) {
        const m = $('edMsg'); if (!m) return;
        m.classList.remove('hidden');
        m.className = 'text-xs rounded-xl p-3 ' + (kind === 'err' ? 'bg-rose-500/15 text-rose-200' : kind === 'ok' ? 'bg-emerald-500/15 text-emerald-200' : 'bg-amber-500/15 text-amber-200');
        m.textContent = text;
    }
    function download(blob, name) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 20000);
    }
    function copyName(base, ext, taken) {
        let n = `${base}-edit.${ext}`, i = 2;
        while (taken.has(n.toLowerCase())) n = `${base}-edit${i++}.${ext}`;
        return n;
    }
    async function finish(toFolder) {
        if (ED.busy) return;
        ED.busy = true;
        const btn = toFolder ? $('edSave') : $('edDl');
        const old = btn.innerHTML; btn.classList.add('opacity-60', 'pointer-events-none'); btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>...';
        // the write permission prompt must start inside the click, before any await
        const root = toFolder ? rootHandles.get(ED.folder.rootId) : null;
        const permP = root && root.requestPermission ? root.requestPermission({ mode: 'readwrite' }).catch(() => 'denied') : null;
        try {
            const out = await renderOut();
            const base = ED.item.name.replace(/\.[^.]+$/, '');
            const dirPath = (ED.item.path || []).slice(0, -1);
            const lib = new Set((ED.folder.mediaFiles || []).filter(m => (m.path || []).slice(0, -1).join('/') === dirPath.join('/')).map(m => m.name.toLowerCase()));
            if (!toFolder) { download(out.blob, copyName(base, out.ext, lib)); msg('ფაილი ჩამოიტვირთა', 'ok'); return; }
            if (!root) { msg('საქაღალდე დისკთან დაკავშირებული არ არის: ჩაწერა შეუძლებელია. გამოიყენე „ჩამოტვირთვა“.', 'err'); return; }
            if ((await permP) !== 'granted') { msg('ჩაწერის ნებართვა არ დადასტურდა. ბრაუზერმა საქაღალდეში ჩაწერა უნდა დაგიშვას („Save changes / შენახვა“). სცადე ხელახლა ან გამოიყენე „ჩამოტვირთვა“.', 'err'); return; }
            let dir = root;
            for (const seg of dirPath) dir = await dir.getDirectoryHandle(seg);
            // also avoid names that already exist on disk but are not in the library
            let name = copyName(base, out.ext, lib);
            for (let i = 0; i < 50; i++) { try { await dir.getFileHandle(name); lib.add(name.toLowerCase()); name = copyName(base, out.ext, lib); } catch (e) { break; } }
            const fh = await dir.getFileHandle(name, { create: true });
            const w = await fh.createWritable(); await w.write(out.blob); await w.close();
            const now = Date.now();
            const it = ED.item;
            const meta = { type: 'image', name, date: fmtDate(now) || '', mtime: now, size: out.blob.size, tags: (it.tags || []).slice(), local: true, path: dirPath.concat(name), w: out.ow, h: out.oh, exifChecked: 1, gpsChecked: 1 };
            if (it.taken) meta.taken = it.taken;
            if (it.gps && ED.keepGps && out.mime === 'image/jpeg') meta.gps = it.gps;
            const folder = ED.folder;
            const at = folder.mediaFiles.indexOf(it);
            folder.mediaFiles.splice(at + 1, 0, meta);
            recountFolder(folder);
            await persistData();
            closeEditor(true);
            currentGalleryIndex = at + 1;
            renderFolders(); renderGalleryViewer();
            toast(`ასლი შენახულია: ${name}`, 5000);
        } catch (e) {
            console.error(e);
            msg('შენახვა ვერ მოხერხდა: ' + (typeof explainError === 'function' ? explainError(e) : (e.message || e.name)), 'err');
        } finally {
            ED.busy = false;
            if (btn.isConnected) { btn.classList.remove('opacity-60', 'pointer-events-none'); btn.innerHTML = old; }
        }
    }

    document.addEventListener('keydown', (e) => {
        if (e.code !== 'KeyE' || e.ctrlKey || e.metaKey || e.altKey || ED.open) return;
        const gm = $('galleryModal');
        if (!gm || gm.classList.contains('hidden')) return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (!$('tagModal').classList.contains('hidden')) return;
        e.preventDefault(); window.openEditor();
    });

    renderAlbumsNav();
})();
