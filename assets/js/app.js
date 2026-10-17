const defaultCategories = [
            { id: 'work', name: 'სამუშაო (Work)', icon: 'fa-briefcase', color: '#6366f1' },
            { id: 'personal', name: 'პირადი (Personal)', icon: 'fa-user', color: '#10b981' },
            { id: 'media', name: 'ფოტოები / მედია', icon: 'fa-images', color: '#f59e0b' }
        ];

        let defaultInitialFolders = [
            {
                id: '1',
                parentId: null,
                name: 'დიზაინ პროექტები',
                link: 'D:\\Designs',
                image: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=600&q=80',
                category: 'work',
                photosCount: 3,
                videosCount: 1,
                mediaFiles: [
                    { type: 'image', url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1200&q=80', name: 'Design_Abstract_1.jpg', date: '2026-03-12 14:20', tags: ['ნინო', 'საბა'] },
                    { type: 'image', url: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=1200&q=80', name: 'Cyberpunk_UI.jpg', date: '2026-02-18 09:15', tags: ['საბა'] },
                    { type: 'image', url: 'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?auto=format&fit=crop&w=1200&q=80', name: 'Minimalist_Desk.jpg', date: '2026-01-05 18:40', tags: [] },
                    { type: 'video', url: 'https://assets.mixkit.co/videos/preview/mixkit-digital-animation-of-screens-and-lights-31952-large.mp4', name: 'Animation_Showreel.mp4', date: '2026-03-01 11:10', tags: ['ნინო'] }
                ]
            }
        ];

        let categories = defaultCategories.map(c => ({ ...c }));
        let folders = [];

        /* ====================================================================
           STORAGE LAYER
           - metadata (folders / categories / tags) -> IndexedDB (no 5MB limit)
           - directory handles (File System Access API) -> IndexedDB, so the
             link to the real folder survives reloads
           - no blob: URLs are ever persisted
           ==================================================================== */
        const FSA = typeof window.showDirectoryPicker === 'function';
        const rootHandles = new Map();     // rootId -> FileSystemDirectoryHandle
        const accessGranted = new Set();   // rootIds with read permission in this session
        const sessionFiles = new Map();    // fallback (no FSA): "rootId|path" -> File
        const thumbCache = new Map();      // "rootId|path" -> object URL of a small thumbnail (LRU)
        const thumbInflight = new Map();
        const THUMB_CACHE_MAX = 600;
        let idbOk = true;
        let galleryToken = 0;
        let galleryObjUrl = null;

        const IS_TOUCH = !!(window.matchMedia && matchMedia('(hover: none)').matches);
        const isNarrow = () => !!(window.matchMedia && matchMedia('(max-width: 767px)').matches);
        const PAGE_SIZE = IS_TOUCH ? 36 : 90;
        const THUMB_W = 288;
        const STALE = { stale: true };

        let _dbPromise = null;
        function openDB() {
            if (_dbPromise) return _dbPromise;
            _dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open('avma_drive_db', 2);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
                    if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
                    if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs').createIndex('t', 't');
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            return _dbPromise;
        }
        function idbTx(store, mode, fn) {
            return openDB().then(db => new Promise((resolve, reject) => {
                const t = db.transaction(store, mode);
                const req = fn(t.objectStore(store));
                t.oncomplete = () => resolve(req ? req.result : undefined);
                t.onerror = () => reject(t.error);
                t.onabort = () => reject(t.error);
            }));
        }
        const idbGet = (s, k) => idbTx(s, 'readonly', o => o.get(k));
        const idbSet = (s, k, v) => idbTx(s, 'readwrite', o => o.put(v, k));
        const idbDel = (s, k) => idbTx(s, 'readwrite', o => o.delete(k));
        async function idbAll(store) {
            const db = await openDB();
            return new Promise((resolve, reject) => {
                const out = [];
                const req = db.transaction(store, 'readonly').objectStore(store).openCursor();
                req.onsuccess = () => {
                    const c = req.result;
                    if (c) { out.push({ key: c.key, value: c.value }); c.continue(); } else resolve(out);
                };
                req.onerror = () => reject(req.error);
            });
        }

        function persistData() {
            if (typeof scheduleBackup === 'function') scheduleBackup();
            if (!idbOk) {
                try {
                    localStorage.setItem('avma_drive_folders', JSON.stringify(folders));
                    localStorage.setItem('avma_drive_categories', JSON.stringify(categories));
                    return Promise.resolve(true);
                } catch (e) { console.error('Storage limit exceeded', e); return Promise.resolve(false); }
            }
            return idbSet('kv', 'state', { folders, categories }).then(() => true).catch(e => {
                console.error('Storage error', e);
                toast('მონაცემების შენახვა ვერ მოხერხდა');
                return false;
            });
        }

        // One-time migration from the old localStorage format (dead blob: URLs are dropped, tags are kept)
        function migrateLegacy() {
            let cats = [], fl = [];
            try { cats = JSON.parse(localStorage.getItem('avma_drive_categories')) || []; } catch (e) {}
            try { fl = JSON.parse(localStorage.getItem('avma_drive_folders')) || []; } catch (e) {}
            if (!Array.isArray(cats)) cats = [];
            if (!Array.isArray(fl)) fl = [];
            const isBlob = u => typeof u === 'string' && u.startsWith('blob:');
            fl.forEach(f => {
                if (isBlob(f.image)) f.image = '';
                if (Array.isArray(f.mediaFiles)) {
                    const legacyTags = [];
                    f.mediaFiles = f.mediaFiles.filter(m => {
                        if (!isBlob(m.url)) return true;
                        if (m.tags && m.tags.length) legacyTags.push({ name: m.name, tags: m.tags });
                        return false;
                    });
                    if (legacyTags.length) f.legacyTags = legacyTags;
                }
            });
            return { folders: fl, categories: cats };
        }

        let _purged = false;
        async function initData() {
            let state = null;
            try {
                await openDB();
                state = await idbGet('kv', 'state');
            } catch (e) {
                idbOk = false;
                console.warn('IndexedDB unavailable, falling back to localStorage', e);
            }
            let migrated = false;
            if (!state) { state = migrateLegacy(); migrated = true; }
            categories = (state.categories && state.categories.length) ? state.categories : defaultCategories.map(c => ({ ...c }));
            folders = (state.folders && state.folders.length) ? state.folders : defaultInitialFolders;
            categories.forEach((c, i) => { if (!c.color) c.color = ['#6366f1', '#10b981', '#f59e0b', '#0ea5e9', '#f43f5e', '#8b5cf6'][i % 6]; });
            // hidden Android files imported earlier (.trashed-*, .pending-*) are dropped
            const dirty = [];
            folders.forEach(f => {
                const a = f.mediaFiles || [];
                const b = a.filter(m => !(m && m.name && m.name.charAt(0) === '.'));
                if (b.length !== a.length) { f.mediaFiles = b; dirty.push(f); }
            });
            if (dirty.length) { dirty.forEach(f => recountFolder(f)); _purged = true; }
            // a subfolder always shares its root's category
            const byId = new Map(folders.map(f => [f.id, f]));
            folders.forEach(f => {
                let cur = f, guard = 0;
                while (cur.parentId && byId.has(cur.parentId) && guard++ < 50) cur = byId.get(cur.parentId);
                if (cur !== f) f.category = cur.category;
            });

            if (idbOk) {
                try {
                    (await idbAll('handles')).forEach(({ key, value }) => rootHandles.set(key, value));
                } catch (e) { console.warn(e); }
                for (const id of [...rootHandles.keys()]) {
                    if (!folders.some(f => f.rootId === id)) { rootHandles.delete(id); idbDel('handles', id).catch(() => {}); }
                }
                for (const [id, h] of rootHandles) {
                    try { if ((await h.queryPermission({ mode: 'read' })) === 'granted') accessGranted.add(id); } catch (e) {}
                }
                if (migrated) {
                    const ok = await persistData();
                    if (ok) {
                        try { localStorage.removeItem('avma_drive_folders'); localStorage.removeItem('avma_drive_categories'); } catch (e) {}
                    }
                }
                if (_purged) persistData();
                if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
                setTimeout(thumbPrune, 4000);
            }
        }

        function toast(msg, ms = 3500) {
            let el = document.getElementById('avmaToast');
            if (!el) {
                el = document.createElement('div');
                el.id = 'avmaToast';
                el.className = 'fixed bottom-5 left-1/2 -translate-x-1/2 z-[100] bg-slate-900 text-white text-sm px-4 py-2.5 rounded-xl shadow-xl pointer-events-none transition-opacity duration-300';
                document.body.appendChild(el);
            }
            el.textContent = msg;
            el.style.opacity = '1';
            clearTimeout(el._t);
            if (ms) el._t = setTimeout(() => { el.style.opacity = '0'; }, ms);
        }

        /* ---------- Access to real files ---------- */
        function requestAccess(rootId) {
            // must be called synchronously from a user gesture (click)
            const h = rootHandles.get(rootId);
            if (!h) return Promise.resolve(false);
            try {
                return h.requestPermission({ mode: 'read' }).then(r => r === 'granted').catch(() => false);
            } catch (e) { return Promise.resolve(false); }
        }
        function ensureAccessFor(folderId) {
            if (!folderId) return;
            const f = folders.find(x => x.id === folderId);
            if (!f || !f.rootId || !rootHandles.has(f.rootId) || accessGranted.has(f.rootId)) return;
            requestAccess(f.rootId).then(ok => {
                if (ok) { accessGranted.add(f.rootId); renderFolders(); }
            });
        }
        function reauthorize(folderId) {
            const f = folders.find(x => x.id === folderId);
            if (!f || !f.rootId) return;
            requestAccess(f.rootId).then(ok => {
                if (!ok) return;
                accessGranted.add(f.rootId);
                if (activeGalleryFolderId) renderGalleryViewer();
                renderFolders();
            });
        }
        async function resolveFile(folder, file) {
            const key = folder.rootId + '|' + file.path.join('/');
            if (sessionFiles.has(key)) return sessionFiles.get(key);
            const root = rootHandles.get(folder.rootId);
            if (!root) throw new Error('no-handle');
            let dir = root;
            for (let i = 0; i < file.path.length - 1; i++) dir = await dir.getDirectoryHandle(file.path[i]);
            const fh = await dir.getFileHandle(file.path[file.path.length - 1]);
            return fh.getFile();
        }
        function forgetHandles(ids) {
            ids.forEach(id => {
                if (rootHandles.has(id)) {
                    rootHandles.delete(id);
                    accessGranted.delete(id);
                    if (idbOk) idbDel('handles', id).catch(() => {});
                }
                const prefix = id + '|';
                for (const [k, u] of thumbCache) if (k.startsWith(prefix)) { URL.revokeObjectURL(u); thumbCache.delete(k); }
                if (idbOk) openDB().then(db => { db.transaction('thumbs', 'readwrite').objectStore('thumbs').delete(IDBKeyRange.bound(prefix, prefix + '\uffff')); }).catch(() => {});
                for (const k of sessionFiles.keys()) if (k.startsWith(prefix)) sessionFiles.delete(k);
            });
        }
        function collectTreeIds(id) {
            const ids = [id];
            const walk = pid => folders.filter(f => f.parentId === pid).forEach(s => { ids.push(s.id); walk(s.id); });
            walk(id);
            return ids;
        }

        /* ---------- Thumbnails: small, lazy, throttled ---------- */
        const _queue = [];
        let _active = 0;
        function schedule(job) {
            return new Promise((resolve, reject) => {
                _queue.push({ job, resolve, reject });
                pump();
            });
        }
        // persistent thumbnail cache (IndexedDB): after the first visit thumbnails need no disk reads at all
        function thumbGet(key) {
            if (!idbOk) return Promise.resolve(null);
            return idbTx('thumbs', 'readonly', st => st.get(key)).catch(() => null);
        }
        function thumbPut(key, blob, size, mtime) {
            if (!idbOk) return;
            idbTx('thumbs', 'readwrite', st => st.put({ b: blob, s: size || 0, m: mtime || 0, t: Date.now() }, key)).catch(() => {});
        }
        function thumbPrune() {
            if (!idbOk) return;
            openDB().then(db => {
                const st = db.transaction('thumbs', 'readonly').objectStore('thumbs');
                st.count().onsuccess = (ev) => {
                    let extra = ev.target.result - 12000;
                    if (extra < 3000) return;
                    const tx = db.transaction('thumbs', 'readwrite');
                    tx.objectStore('thumbs').index('t').openCursor().onsuccess = (e2) => {
                        const c = e2.target.result;
                        if (c && extra-- > 0) { c.delete(); c.continue(); }
                    };
                };
            }).catch(() => {});
        }
        function pump() {
            // newest request first: what is on screen now beats what was scrolled past
            while (_active < (IS_TOUCH ? 2 : 3) && _queue.length) {
                const t = _queue.pop();
                _active++;
                t.job().then(t.resolve, t.reject).finally(() => { _active--; pump(); });
            }
        }
        async function makeThumbBlob(file, type, maxW) {
            try {
                let source, w, h, cleanup = () => {};
                if (type === 'video') {
                    const url = URL.createObjectURL(file);
                    const v = document.createElement('video');
                    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = url;
                    await new Promise((res, rej) => {
                        const t = setTimeout(() => rej(new Error('timeout')), 10000);
                        v.onloadeddata = () => { clearTimeout(t); res(); };
                        v.onerror = () => { clearTimeout(t); rej(new Error('video')); };
                    });
                    try {
                        v.currentTime = Math.min(1, (v.duration || 2) / 4);
                        await new Promise(res => { v.onseeked = res; setTimeout(res, 3000); });
                    } catch (e) {}
                    source = v; w = v.videoWidth; h = v.videoHeight;
                    cleanup = () => { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); };
                } else {
                    try { source = await createImageBitmap(file, { resizeWidth: maxW, resizeQuality: 'medium' }); }
                    catch (e) { source = await createImageBitmap(file); }
                    w = source.width; h = source.height;
                    cleanup = () => { if (source.close) source.close(); };
                }
                const scale = Math.min(1, maxW / w);
                const cw = Math.max(1, Math.round(w * scale));
                const ch = Math.max(1, Math.round(h * scale));
                const c = document.createElement('canvas');
                c.width = cw; c.height = ch;
                c.getContext('2d').drawImage(source, 0, 0, cw, ch);
                cleanup();
                return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.78));
            } catch (e) { return null; }
        }
        function blobToDataUrl(blob) {
            return new Promise((res, rej) => {
                const r = new FileReader();
                r.onload = () => res(r.result);
                r.onerror = () => rej(r.error);
                r.readAsDataURL(blob);
            });
        }
        function thumbKey(folder, file) { return folder.rootId + '|' + file.path.join('/'); }
        function trimThumbCache() {
            while (thumbCache.size > THUMB_CACHE_MAX) {
                const [k, u] = thumbCache.entries().next().value;
                URL.revokeObjectURL(u);
                thumbCache.delete(k);
            }
        }
        function getThumbUrl(folder, file, alive) {
            const key = thumbKey(folder, file);
            if (thumbCache.has(key)) {
                const u = thumbCache.get(key);
                thumbCache.delete(key); thumbCache.set(key, u);
                return Promise.resolve(u);
            }
            if (thumbInflight.has(key)) return thumbInflight.get(key);
            const remember = (blob) => {
                const url = URL.createObjectURL(blob);
                thumbCache.set(key, url);
                trimThumbCache();
                return url;
            };
            const p = (async () => {
                const rec = await thumbGet(key);
                if (rec && rec.b && (rec.s || 0) === (file.size || 0) && (rec.m || 0) === (file.mtime || 0)) return remember(rec.b);
                return schedule(async () => {
                    if (alive && !alive()) return STALE;
                    const f = await resolveFile(folder, file);
                    const blob = await makeThumbBlob(f, file.type, THUMB_W);
                    if (!blob) return null;
                    thumbPut(key, blob, file.size, file.mtime);
                    return remember(blob);
                });
            })().finally(() => thumbInflight.delete(key));
            thumbInflight.set(key, p);
            return p;
        }
        const lazyObserver = new IntersectionObserver(entries => {
            entries.forEach(en => {
                const el = en.target;
                el._vis = en.isIntersecting;
                if (en.isIntersecting && !el._busy) hydrateThumb(el);
            });
        }, { rootMargin: '300px' });
        function observeLazy(scope) {
            if (!scope) return;
            scope.querySelectorAll('img[data-lf]:not([data-done])').forEach(el => lazyObserver.observe(el));
        }
        async function hydrateThumb(el) {
            const [fid, idx] = el.dataset.lf.split('|');
            const folder = folders.find(f => f.id === fid);
            const file = folder && folder.mediaFiles && folder.mediaFiles[+idx];
            if (!file) { lazyObserver.unobserve(el); return; }
            el._busy = true;
            try {
                const url = await getThumbUrl(folder, file, () => el.isConnected && el._vis);
                if (url === STALE) {
                    if (el.isConnected && el._vis) setTimeout(() => hydrateThumb(el), 150);   // a shared request was dropped; retry
                } else {
                    if (url && el.isConnected) { el.src = url; el.dataset.done = '1'; }
                    lazyObserver.unobserve(el);
                }
            } catch (e) { lazyObserver.unobserve(el); /* no access / file missing: placeholder stays */ }
            finally { el._busy = false; }
        }
        // Markup for a media tile. Local files are loaded lazily as small thumbnails; remote URLs work as before.
        function mediaThumbHtml(file, folderId, idx, cls) {
            if (file.local) {
                const f = folders.find(x => x.id === folderId);
                const cached = f && thumbCache.get(thumbKey(f, file));
                if (cached) return `<img src="${cached}" data-done="1" alt="" decoding="async" class="${cls}">`;
                return `<img data-lf="${folderId}|${idx}" alt="" decoding="async" class="${cls}">`;
            }
            if (file.type === 'video') return `<video src="${file.url}" preload="metadata" class="${cls}"></video>`;
            return `<img src="${file.url}" loading="lazy" decoding="async" class="${cls}">`;
        }

        /* ---------- Gallery (full-size file, one object URL at a time) ---------- */
        function clearGalleryMedia() {
            gz.el = null;
            const area = document.getElementById('galleryDisplayArea');
            if (area) {
                area.querySelectorAll('video').forEach(v => { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} });
                area.innerHTML = '';
            }
            if (galleryObjUrl) { URL.revokeObjectURL(galleryObjUrl); galleryObjUrl = null; }
        }
        function galleryErrorHtml(folder, e) {
            let msg, btn = '';
            if (e && e.message === 'no-handle') {
                msg = 'ეს საქაღალდე დისკთან დაკავშირებული არ არის (მაგალითად, მონაცემები იმპორტით ჩაიტვირთა).';
                btn = `<button onclick="relinkFolder('${folder.id}')" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium transition cursor-pointer">საქაღალდის დაკავშირება</button>`;
            } else if (e && e.name === 'NotFoundError') {
                msg = 'ფაილი დისკზე ვერ მოიძებნა (გადატანილია ან წაშლილია).';
            } else {
                msg = 'საქაღალდეზე წვდომა გადატვირთვის შემდეგ უნდა დადასტურდეს.';
                btn = `<button onclick="reauthorize('${folder.id}')" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium transition cursor-pointer">წვდომის აღდგენა</button>`;
            }
            return `<div class="text-center text-white/80 text-sm space-y-3"><p>${msg}</p>${btn}</div>`;
        }
        async function loadLocalIntoGallery(folder, item, area, token) {
            try {
                const f = await resolveFile(folder, item);
                if (token !== galleryToken) return;
                galleryObjUrl = URL.createObjectURL(f);
                let el;
                if (item.type === 'video') { el = document.createElement('video'); el.controls = true; el.autoplay = true; }
                else { el = document.createElement('img'); el.alt = item.name; }
                el.src = galleryObjUrl;
                el.className = 'w-full h-full object-contain';
                area.appendChild(el);
                if (item.type !== 'video') gzAttach(el);
            } catch (e) {
                if (token !== galleryToken) return;
                area.innerHTML = galleryErrorHtml(folder, e);
            }
        }

        /* ---------- Import ---------- */
        function mediaType(name) {
            const l = name.toLowerCase();
            if (l.charAt(0) === '.') return null;   // Android .trashed-*, .pending-*, .thumbnails and similar hidden files
            if (/\.(jpg|jpeg|png|webp)$/.test(l)) return 'image';
            if (/\.(mp4|mov|avi|webm)$/.test(l)) return 'video';
            return null;
        }
        function findImportedRoot(name) {
            return folders.find(f => f.parentId === null && String(f.id).startsWith('dir_') && f.name === name) || null;
        }
        function collectTags(root) {
            const map = new Map();
            const add = (sub, m) => { if (m.tags && m.tags.length) map.set(sub + '/' + m.name, m.tags.slice()); };
            const addFolder = (f, sub) => { (f.mediaFiles || []).forEach(m => add(sub, m)); (f.legacyTags || []).forEach(m => add(sub, m)); };
            addFolder(root, '');
            folders.filter(f => f.parentId === root.id).forEach(s => addFolder(s, s.name));
            return map;
        }
        function collectFavs(root) {
            const set = new Set();
            const addFolder = (f, sub) => (f.mediaFiles || []).forEach(m => { if (m.fav) set.add(sub + '/' + m.name); });
            addFolder(root, '');
            folders.filter(f => f.parentId === root.id).forEach(s => addFolder(s, s.name));
            return set;
        }
        function collectNotes(root) {
            const map = new Map();
            const addFolder = (f, sub) => (f.mediaFiles || []).forEach(m => { if (m.note) map.set(sub + '/' + m.name, m.note); });
            addFolder(root, '');
            folders.filter(f => f.parentId === root.id).forEach(s => addFolder(s, s.name));
            return map;
        }
        function confirmReplace(name) {
            const old = findImportedRoot(name);
            if (old && !confirm(`„${name}“ უკვე დამატებულია. განვაახლო? (ტეგები შენარჩუნდება)`)) return false;
            return old || null;
        }
        function startFolderImport() {
            if (FSA) importWithPicker();
            else document.getElementById('folderImportInput').click();
        }
        async function walkDir(dir, prefix, out) {
            try {
                for await (const [name, h] of dir.entries()) {
                    if (h.kind === 'directory') {
                        if (name.charAt(0) === '.') continue;   // .thumbnails, .trash ...
                        await walkDir(h, prefix.concat(name), out);
                    } else {
                        const t = mediaType(name);
                        if (t) {
                            let size = 0, mtime = 0;
                            try { const f0 = await h.getFile(); size = f0.size; mtime = f0.lastModified; } catch (e) { /* unreadable: keep zeros */ }
                            out.push({ path: prefix.concat(name), type: t, size, mtime, getFile: () => h.getFile() });
                        }
                    }
                }
            } catch (e) {
                console.warn('skipped', prefix.join('/'), e);
                out.failed = (out.failed || 0) + 1;
                (out.failedPaths = out.failedPaths || []).push(prefix.join('/') || '/');
            }
            if (prefix.length <= 1) toast(`სკანირება... ${out.length}`, 0);
        }
        // Opens the picker inside the already-known gallery root, so the user picks sub-folders directly
        async function pickDir() {
            const known = [...rootHandles.values()].pop();
            const base = { mode: 'read' };
            try {
                return await window.showDirectoryPicker(known ? { ...base, startIn: known } : { ...base, id: 'avma-gallery' });
            } catch (e) {
                if (e && e.name === 'TypeError') return window.showDirectoryPicker({ ...base, id: 'avma-gallery' });
                throw e;
            }
        }
        // If the chosen folder lies inside an already imported root, its real path = root link + relative path
        async function detectLinkFor(handle) {
            let best = null;
            for (const [rid, rh] of rootHandles) {
                const rf = folders.find(f => f.id === rid);
                if (!rf || !rf.link || !rh || typeof rh.resolve !== 'function') continue;
                try {
                    const rel = await rh.resolve(handle);
                    if (rel && (!best || rel.length < best.rel.length)) best = { rel, base: normalizeLinkBase(rf.link) };
                } catch (e) { /* no access to this root */ }
            }
            return best ? best.rel.reduce((acc, n) => joinPath(acc, n), best.base) : '';
        }

        async function importWithPicker() {
            let handle;
            try {
                handle = await pickDir();
            } catch (e) {
                if (e && e.name === 'AbortError') return;
                console.warn(e);
                document.getElementById('folderImportInput').click();
                return;
            }
            const old = confirmReplace(handle.name);
            if (old === false) return;
            try {
                toast('სკანირება...', 0);
                const entries = [];
                await walkDir(handle, [], entries);
                entries.sort((a, b) => a.path.join('/').localeCompare(b.path.join('/'), undefined, { numeric: true }));
                const detected = await detectLinkFor(handle);
                await runImport(handle.name, entries, handle, old, detected ? { link: detected } : {});
            } catch (e) {
                console.error(e);
                toast('იმპორტი ვერ მოხერხდა: ' + (e.message || e.name));
            }
        }
        // Fallback for browsers without File System Access API (files live only until the page is reloaded)
        async function handleFolderImport(event) {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            if (files.length === 0) return;
            let rootName = 'Scanned Folder';
            const entries = [];
            for (const file of files) {
                const rel = file.webkitRelativePath;
                if (!rel) continue;
                const parts = rel.split('/');
                if (rootName === 'Scanned Folder') rootName = parts[0];
                const t = mediaType(file.name);
                if (!t || parts.length < 2 || parts.some(x => x.charAt(0) === '.')) continue;
                entries.push({ path: parts.slice(1), type: t, file, size: file.size, mtime: file.lastModified, getFile: async () => file });
            }
            const old = confirmReplace(rootName);
            if (old === false) return;
            try {
                await runImport(rootName, entries, null, old);
                toast('ეს ბრაუზერი ფოლდერზე მუდმივ წვდომას ვერ ინახავს — გამოიყენეთ Chrome ან Edge', 6000);
            } catch (e) {
                console.error(e);
                toast('იმპორტი ვერ მოხერხდა: ' + (e.message || e.name));
            }
        }
        async function makeCover(entry) {
            if (!entry) return '';
            try {
                const f = await entry.getFile();
                const blob = await makeThumbBlob(f, 'image', 480);
                return blob ? await blobToDataUrl(blob) : '';
            } catch (e) { return ''; }
        }
        async function runImport(rootName, entries, rootHandle, old, opts = {}) {
            if (entries.length === 0) { toast('მედია ფაილები ვერ მოიძებნა'); return; }

            const nowStr = new Date().toISOString().slice(0, 16).replace('T', ' ');
            const rootId = 'dir_' + Date.now();
            const keepTags = old ? collectTags(old) : new Map();
            const keepFav = old ? collectFavs(old) : new Set();
            const keepNote = old ? collectNotes(old) : new Map();
            const mainCategory = opts.category || (old ? (old.category || 'work') : (currentFilter === 'all' ? 'work' : currentFilter));

            const rootMedia = [];
            const subs = new Map();
            let rootPhotos = 0, rootVideos = 0, rootFirst = null;

            for (const e of entries) {
                const name = e.path[e.path.length - 1];
                const tagKey = (e.path.length === 1 ? '' : e.path[0]) + '/' + name;
                const meta = { type: e.type, name, date: e.mtime ? fmtDate(e.mtime) : nowStr, mtime: e.mtime || 0, size: e.size || 0, tags: (keepTags.get(tagKey) || []).slice(), local: true, path: e.path };
                if (keepFav.has(tagKey)) meta.fav = true;
                if (keepNote.has(tagKey)) meta.note = keepNote.get(tagKey);
                if (!rootHandle && e.file) sessionFiles.set(rootId + '|' + e.path.join('/'), e.file);

                if (e.path.length === 1) {
                    rootMedia.push(meta);
                    if (e.type === 'image') { rootPhotos++; if (!rootFirst) rootFirst = e; } else rootVideos++;
                } else {
                    const sn = e.path[0];
                    if (!subs.has(sn)) subs.set(sn, { name: sn, photos: 0, videos: 0, first: null, media: [] });
                    const s = subs.get(sn);
                    s.media.push(meta);
                    if (e.type === 'image') { s.photos++; rootPhotos++; if (!s.first) s.first = e; } else { s.videos++; rootVideos++; }
                }
            }

            toast('ქავერების მომზადება...', 0);
            const rootCover = opts.image ? '' : await makeCover(rootFirst);
            const subCovers = new Map();
            let i = 0;
            for (const [sn, s] of subs) {
                subCovers.set(sn, await makeCover(s.first));
                if (++i % 5 === 0) toast(`ქავერების მომზადება... ${i}/${subs.size}`, 0);
            }

            if (rootHandle) {
                rootHandles.set(rootId, rootHandle);
                accessGranted.add(rootId);
                if (idbOk) await idbSet('handles', rootId, rootHandle);
            }

            if (old) {
                const ids = collectTreeIds(old.id);
                folders = folders.filter(f => !ids.includes(f.id));
                const inUse = new Set(folders.map(f => f.rootId).filter(Boolean));
                forgetHandles(ids.filter(i => !inUse.has(i)));
            }

            const customPath = opts.link || (old && old.link) || `D:\\${rootName}`;
            folders.push({
                id: rootId, rootId, parentId: opts.parentId || null, name: opts.name || rootName, link: customPath,
                image: opts.image || rootCover || '',
                category: mainCategory, photosCount: rootPhotos, videosCount: rootVideos, mediaFiles: rootMedia
            });
            for (const [sn, s] of subs) {
                folders.push({
                    id: rootId + '_' + Math.random().toString(36).substr(2, 5), rootId, parentId: rootId,
                    name: s.name, subKey: sn, link: joinPath(customPath, s.name),
                    image: subCovers.get(sn) || '',
                    category: mainCategory, photosCount: s.photos, videosCount: s.videos, mediaFiles: s.media
                });
            }

            await persistData();
            renderFolders();
            toast(`დაემატა: ${rootPhotos} ფოტო, ${rootVideos} ვიდეო`, 4000);
        }

        let currentFilter = 'all';
        let currentParentId = null;
        let currentSearchQuery = '';
        let viewMode = 'grid'; // 'grid', 'compact', 'list'
        
        let activeGalleryFolderId = null;
        let currentGalleryIndex = 0;
        let activeTaggingFolderId = null;
        let activeTaggingFileIndex = null;

        function getTagCounts() {
            const counts = new Map();
            folders.forEach(f => {
                (f.mediaFiles || []).forEach(file => {
                    if (!Array.isArray(file.tags)) return;
                    new Set(file.tags.map(t => t.trim()).filter(Boolean)).forEach(t => counts.set(t, (counts.get(t) || 0) + 1));
                });
            });
            return counts;
        }

        function getAllUniqueTags() {
            const tagsSet = new Set();
            folders.forEach(f => {
                if (f.mediaFiles) {
                    f.mediaFiles.forEach(file => {
                        if (file.tags && Array.isArray(file.tags)) {
                            file.tags.forEach(t => {
                                if (t.trim()) tagsSet.add(t.trim());
                            });
                        }
                    });
                }
            });
            return Array.from(tagsSet);
        }

        function renderSidebar() {
            const catListContainer = document.getElementById('categoriesListContainer');
            catListContainer.innerHTML = '';

            categories.forEach(cat => {
                const count = folders.filter(f => f.category === cat.id && f.parentId === null).length;
                const item = document.createElement('a');
                item.href = "#";
                item.dataset.tip = `${cat.name} · ${count}`;
                item.onclick = (e) => filterCategory(cat.id, e);
                item.className = `flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium transition ${currentFilter === cat.id && currentParentId === null && !isSearchActive() ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/55 dark:text-indigo-400' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60'}`;
                
                item.innerHTML = `
                    <div class="flex items-center space-x-3">
                        <i class="fa-solid ${cat.icon || 'fa-folder'} w-5" style="${cat.color ? 'color:' + cat.color : ''}"></i>
                        <span>${cat.name}</span>
                    </div>
                    <span class="text-xs bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-xl text-slate-500">${count}</span>
                `;
                catListContainer.appendChild(item);
            });

            const tagsContainer = document.getElementById('tagsListContainer');
            tagsContainer.innerHTML = '';
            const sortedTags = getSortedTags();
            if (sortedTags.length === 0) {
                tagsContainer.innerHTML = '<div class="text-xs text-slate-400 px-3 py-1">ტეგები არ არის</div>';
            } else {
                const TOP = 5;
                const shown = sortedTags.slice(0, TOP);
                const activeTags = getCrit().tag.map(t => t.toLowerCase());
                sortedTags.slice(TOP).forEach(t => { if (activeTags.includes(t.tag.toLowerCase())) shown.push(t); });
                shown.forEach(({ tag, count }) => {
                    const active = activeTags.includes(tag.toLowerCase());
                    const tagItem = document.createElement('a');
                    tagItem.href = "#";
                    tagItem.onclick = (e) => filterByTag(tag, e);
                    tagItem.className = `flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition ${active ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/55 dark:text-indigo-400' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60'}`;
                    tagItem.innerHTML = `
                        <div class="flex items-center space-x-2 min-w-0">
                            <i class="fa-solid fa-tag w-4 text-indigo-500"></i>
                            <span class="truncate">${esc(tag)}</span>
                        </div>
                        <span class="text-xs bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-xl text-slate-500">${count}</span>
                    `;
                    tagsContainer.appendChild(tagItem);
                });
                const rest = sortedTags.length - shown.length;
                if (rest > 0) {
                    const more = document.createElement('a');
                    more.href = "#";
                    more.onclick = (e) => { e.preventDefault(); openTagsModal(); };
                    more.className = "flex items-center space-x-2 px-3 py-2 rounded-xl text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition";
                    more.innerHTML = `<i class="fa-solid fa-ellipsis w-4"></i><span>მეტი ტეგის ნახვა (${rest})</span>`;
                    tagsContainer.appendChild(more);
                }
            }

            const selectEl = document.getElementById('formCategory');
            selectEl.innerHTML = '';
            categories.forEach(cat => {
                const opt = document.createElement('option');
                opt.value = cat.id;
                opt.innerText = cat.name;
                selectEl.appendChild(opt);
            });
        }

        function filterByTag(tag, e) {
            if (e) e.preventDefault();
            closeTagsModal();
            currentParentId = null;
            setSearchInput(buildSearch({ words: [], folder: [], name: [], tag: [tag], type: '', cat: '' }));
            runSearchNow();
            if (window.innerWidth < 768 && !document.getElementById('sidebar').classList.contains('-translate-x-full')) toggleMobileSidebar();
        }

        /* ====================================================================
           SEARCH  (Gmail-style: free words + operators, global, with filter panel)
           operators: tag: folder:/in: name:/file: type: cat:   (also Georgian: ტეგი: საქაღალდე: სახელი: ტიპი: კატეგორია:)
           ==================================================================== */
        const SEARCH_PAGE = 200;
        let searchLimit = SEARCH_PAGE;
        let searchTimer = null;
        let _critQ = null, _crit = null;

        function esc(t) {
            return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }
        const lc = (v) => String(v == null ? '' : v).toLocaleLowerCase();

        const OP_ALIASES = {
            tag: 'tag', 'ტეგი': 'tag',
            folder: 'folder', in: 'folder', 'საქაღალდე': 'folder',
            name: 'name', file: 'name', 'სახელი': 'name', 'ფაილი': 'name',
            type: 'type', 'ტიპი': 'type',
            cat: 'cat', category: 'cat', 'კატეგორია': 'cat',
            is: 'is', 'ფავორიტი': 'fav'
        };
        const OP_NAMES = Object.keys(OP_ALIASES);

        function parseSearch(q) {
            const out = { words: [], folder: [], name: [], tag: [], type: '', cat: '', fav: false };
            const re = /(?:^|\s)(?:([^\s:"]+):)?(?:"([^"]*)"|(\S+))/g;
            let m;
            while ((m = re.exec(q || '')) !== null) {
                let op = m[1] ? OP_ALIASES[m[1].toLowerCase()] : null;
                let val = (m[2] !== undefined ? m[2] : m[3]) || '';
                if (m[1] && !op) { val = m[1] + ':' + val; op = null; }   // "abc:def" is just text
                val = val.trim();
                if (!val) continue;
                if (!op) {
                    if (/^[^\s:]+:$/.test(val) && OP_ALIASES[val.slice(0, -1).toLowerCase()]) continue; // "tag:" being typed
                    out.words.push(val);
                } else if (op === 'type') {
                    const v = lc(val);
                    out.type = (/^(image|photo|ფოტო|სურათი)$/.test(v)) ? 'image' : (/^(video|ვიდეო)$/.test(v) ? 'video' : '');
                } else if (op === 'cat') {
                    out.cat = val;
                } else if (op === 'is') {
                    if (/^(fav|favorite|favourite|star|starred|ფავორიტი|ფავორიტები)$/i.test(val)) out.fav = true; else out.words.push(m[1] + ':' + val);
                } else if (op === 'fav') {
                    out.fav = true;
                } else {
                    out[op].push(val);
                }
            }
            return out;
        }
        function getCrit() {
            if (_critQ !== currentSearchQuery) { _critQ = currentSearchQuery; _crit = parseSearch(_critQ); }
            return _crit;
        }
        function isSearchActive() {
            const c = getCrit();
            return !!(c.words.length || c.folder.length || c.name.length || c.tag.length || c.type || c.cat || c.fav);
        }
        function quoteVal(v) {
            v = String(v).replace(/"/g, '').trim();
            return /\s/.test(v) ? `"${v}"` : v;
        }
        function buildSearch(c) {
            const parts = [];
            c.words.forEach(w => parts.push(quoteVal(w)));
            c.folder.forEach(v => parts.push('folder:' + quoteVal(v)));
            c.name.forEach(v => parts.push('name:' + quoteVal(v)));
            c.tag.forEach(v => parts.push('tag:' + quoteVal(v)));
            if (c.type) parts.push('type:' + c.type);
            if (c.cat) parts.push('cat:' + quoteVal(c.cat));
            if (c.fav) parts.push('is:fav');
            return parts.join(' ');
        }
        function setSearchInput(q) {
            document.getElementById('searchInput').value = q;
            currentSearchQuery = q;
        }
        function handleSearch(query) {
            currentSearchQuery = query;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => { searchLimit = SEARCH_PAGE; onSearchChanged(); }, 150);
        }
        function runSearchNow() {
            clearTimeout(searchTimer);
            searchLimit = SEARCH_PAGE;
            onSearchChanged();
        }
        function onSearchChanged() {
            renderFolders();
            if (!isSearchActive()) updateSectionHeader();
        }
        function updateSearchUi() {
            const ic = document.getElementById('searchOptionsIcon');
            if (ic) ic.classList.toggle('text-indigo-600', isSearchActive());
        }
        function updateSectionHeader() {
            const t = document.getElementById('sectionTitle');
            const d = document.getElementById('sectionDesc');
            if (currentParentId !== null) {
                const f = folders.find(x => x.id === currentParentId);
                if (f) { t.innerText = f.name; d.innerHTML = folderHeaderDesc(f); return; }
            }
            if (currentFilter !== 'all') {
                const cat = categories.find(c => c.id === currentFilter);
                t.innerText = cat ? cat.name : 'კატეგორია';
                d.innerText = 'კატეგორიის მიხედვით დაჯგუფებული საქაღალდეები.';
                return;
            }
            t.innerText = 'ყველა საქაღალდე';
            d.innerText = 'თქვენი ლოკალური ფოლდერების არქივი და ჰიერარქიული მედია კონტენტი.';
        }

        function resolveCatIds(val) {
            const v = lc(val);
            const exact = categories.filter(c => lc(c.id) === v || lc(c.name) === v);
            if (exact.length) return new Set(exact.map(c => c.id));
            return new Set(categories.filter(c => lc(c.name).includes(v)).map(c => c.id));
        }
        function folderPathNames(f, byId) {
            const names = [];
            let cur = f, guard = 0;
            while (cur && guard++ < 50) { names.push(lc(cur.name)); cur = cur.parentId ? byId.get(cur.parentId) : null; }
            return names;
        }
        function runSearch(c) {
            const byId = new Map(folders.map(f => [f.id, f]));
            const words = c.words.map(lc);
            const fq = c.folder.map(lc);
            const nq = c.name.map(lc);
            const tq = c.tag.map(lc);
            const catIds = c.cat ? resolveCatIds(c.cat) : null;
            const fileCrit = !!(nq.length || tq.length || c.type || c.fav);

            const pathCache = new Map();
            const pathOf = (f) => { let p = pathCache.get(f.id); if (!p) { p = folderPathNames(f, byId); pathCache.set(f.id, p); } return p; };
            const folderOk = (f) => {
                if (catIds && !catIds.has(f.category)) return false;
                if (fq.length) { const p = pathOf(f); if (!fq.every(q => p.some(n => n.includes(q)))) return false; }
                return true;
            };

            const out = { folders: [], files: [] };
            const showFolders = !fileCrit && (words.length || fq.length || catIds);
            const showFiles = fileCrit || words.length > 0;

            if (showFolders) {
                const onlyCat = !words.length && !fq.length;
                folders.forEach(f => {
                    if (onlyCat && f.parentId) return;
                    if (!folderOk(f)) return;
                    const n = lc(f.name);
                    if (words.every(w => n.includes(w))) out.folders.push(f);
                });
            }
            if (showFiles) {
                folders.forEach(f => {
                    if (!f.mediaFiles || !f.mediaFiles.length || !folderOk(f)) return;
                    f.mediaFiles.forEach((file, idx) => {
                        if (c.type && file.type !== c.type) return;
                        if (c.fav && !file.fav) return;
                        const name = lc(file.name);
                        const tags = (file.tags || []).map(lc);
                        if (nq.length && !nq.every(q => name.includes(q))) return;
                        if (tq.length && !tq.every(q => tags.includes(q))) return;
                        const note = lc(file.note || '');
                        if (words.length && !words.every(w => name.includes(w) || note.includes(w) || tags.some(t => t.includes(w)))) return;
                        out.files.push({ file, folder: f, index: idx });
                    });
                });
            }
            return out;
        }

        function searchChips(c) {
            const chips = [];
            c.words.forEach((v, i) => chips.push({ k: 'words', i, label: `„${v}“` }));
            c.folder.forEach((v, i) => chips.push({ k: 'folder', i, label: `საქაღალდე: ${v}` }));
            c.name.forEach((v, i) => chips.push({ k: 'name', i, label: `ფაილი: ${v}` }));
            c.tag.forEach((v, i) => chips.push({ k: 'tag', i, label: `ტეგი: ${v}` }));
            if (c.fav) chips.push({ k: 'fav', i: 0, label: '★ ფავორიტები' });
            if (c.type) chips.push({ k: 'type', i: 0, label: `ტიპი: ${c.type === 'image' ? 'ფოტო' : 'ვიდეო'}` });
            if (c.cat) {
                const ids = resolveCatIds(c.cat);
                const cat = categories.find(x => ids.has(x.id));
                chips.push({ k: 'cat', i: 0, label: `კატეგორია: ${cat ? cat.name : c.cat}` });
            }
            return chips;
        }
        function removeSearchCriterion(k, i) {
            const c = parseSearch(currentSearchQuery);
            if (Array.isArray(c[k])) c[k].splice(i, 1); else c[k] = '';
            setSearchInput(buildSearch(c));
            runSearchNow();
        }

        function renderSearchResults(container, emptyState) {
            const c = getCrit();
            const res = runSearch(c);
            if (sortMode !== 'natural') { const cmp = fileComparator(); res.files.sort((x, y) => cmp(x.file, y.file)); }
            document.getElementById('sectionTitle').innerText = 'ძიების შედეგები';
            const chipsHtml = searchChips(c).map(ch => `<span class="inline-flex items-center gap-1.5 bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-300 text-xs px-2.5 py-1 rounded-xl mr-1.5 mt-1.5">${esc(ch.label)}<button type="button" class="hover:text-rose-500 cursor-pointer" onclick="removeSearchCriterion('${ch.k}',${ch.i})"><i class="fa-solid fa-xmark text-[10px]"></i></button></span>`).join('');
            document.getElementById('sectionDesc').innerHTML = `საქაღალდე: <b>${res.folders.length}</b> · ფაილი: <b>${res.files.length}</b><div>${chipsHtml}</div>`;

            if (res.folders.length === 0 && res.files.length === 0) {
                container.innerHTML = '';
                emptyState.classList.remove('hidden'); emptyState.classList.add('flex');
                return;
            }
            emptyState.classList.remove('flex'); emptyState.classList.add('hidden');

            container.className = viewMode === 'grid' ? "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4" : (viewMode === 'compact' ? "grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3" : "flex flex-col space-y-2");
            const heading = (txt) => {
                const h = document.createElement('div');
                h.className = 'col-span-full text-[11px] font-semibold uppercase tracking-wider text-slate-400 mt-1';
                h.textContent = txt;
                container.appendChild(h);
            };
            const byId = new Map(folders.map(f => [f.id, f]));
            const pathText = (f) => {
                const names = []; let cur = f.parentId ? byId.get(f.parentId) : null, g = 0;
                while (cur && g++ < 50) { names.unshift(cur.name); cur = cur.parentId ? byId.get(cur.parentId) : null; }
                return names.join(' / ');
            };

            if (res.folders.length) {
                heading(`საქაღალდეები (${res.folders.length})`);
                res.folders.forEach(f => {
                    const fb = folderFallbackImg(f.name, 600, 400);
                    const img = f.image || fb;
                    const card = document.createElement('div');
                    card.onclick = () => navigateToFolder(f.id);
                    if (viewMode === 'list') {
                        card.className = "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 flex items-center justify-between shadow-sm hover:border-indigo-500/50 transition cursor-pointer";
                        card.innerHTML = `
                            <div class="flex items-center space-x-3 min-w-0">
                                <img src="${esc(img)}" data-fb="${fb}" onerror="this.onerror=null;this.src=this.dataset.fb" class="w-12 h-12 rounded-xl object-cover bg-slate-100 dark:bg-slate-800 flex-shrink-0">
                                <div class="min-w-0">
                                    <span class="font-medium text-sm text-slate-800 dark:text-slate-200 truncate block">${esc(f.name)}</span>
                                    <span class="text-xs text-slate-400 truncate block">${esc(pathText(f)) || 'საქაღალდე'}</span>
                                </div>
                            </div>
                            <div class="text-xs text-slate-500 flex-shrink-0"><i class="fa-solid fa-image text-indigo-500 mr-1"></i>${f.photosCount || 0} <i class="fa-solid fa-video text-rose-500 ml-2 mr-1"></i>${f.videosCount || 0}</div>`;
                    } else {
                        card.className = "group bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-all flex flex-col cursor-pointer";
                        card.innerHTML = `
                            <div class="relative ${viewMode === 'compact' ? 'h-24 sm:h-28' : 'h-32 sm:h-40'} overflow-hidden bg-slate-100 dark:bg-slate-800">
                                <img src="${esc(img)}" data-fb="${fb}" onerror="this.onerror=null;this.src=this.dataset.fb" class="w-full h-full object-cover group-hover:scale-105 transition duration-500">
                                <span class="absolute top-2 right-2 bg-slate-900/80 backdrop-blur-md text-white w-6 h-6 rounded-xl flex items-center justify-center text-[10px]"><i class="fa-solid fa-folder text-indigo-400"></i></span>
                            </div>
                            <div class="p-3">
                                <h3 class="font-semibold text-slate-900 dark:text-white text-sm truncate">${esc(f.name)}</h3>
                                <p class="text-xs text-slate-400 truncate">${esc(pathText(f)) || '&nbsp;'}</p>
                            </div>`;
                    }
                    container.appendChild(card);
                });
            }

            if (res.files.length) {
                heading(`ფაილები (${res.files.length})`);
                res.files.slice(0, searchLimit).forEach(({ file, folder, index }) => {
                    const card = document.createElement('div');
                    card.dataset.sel = folder.id + '|' + index;
                    card.onclick = () => openGalleryModalAtIndex(folder.id, index);
                    if (viewMode === 'list') {
                        card.className = "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 flex items-center justify-between shadow-sm hover:border-indigo-500/50 transition cursor-pointer";
                        const tagsHtml = (file.tags || []).map(t => `<span class="text-xs bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-300 px-2.5 py-1 rounded-xl"><i class="fa-solid fa-tag mr-1"></i>${esc(t)}</span>`).join('');
                        card.innerHTML = `
                            <div class="flex items-center space-x-3 min-w-0 flex-1">
                                <div class="w-12 h-12 rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800 flex items-center justify-center relative flex-shrink-0">
                                    ${mediaThumbHtml(file, folder.id, index, 'w-full h-full object-cover')}
                                </div>
                                <div class="min-w-0">
                                    <span class="font-medium text-sm text-slate-800 dark:text-slate-200 truncate block">${esc(file.name)}</span>
                                    <span class="text-xs text-indigo-500 truncate block">საქაღალდე: ${esc(folder.name)}</span>
                                </div>
                            </div>
                            <div class="flex items-center gap-2 flex-shrink-0"><span class="hidden sm:flex items-center gap-2 flex-wrap justify-end">${tagsHtml}<span class="text-xs text-slate-400">${fileDateStr(file)}${file.size ? ' · ' + fmtSize(file.size) : ''}</span></span></div>`;
                    } else {
                        const isVid = file.type === 'video';
                        card.className = "group bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-all flex flex-col cursor-pointer relative";
                        card.innerHTML = `
                            <div class="relative ${viewMode === 'compact' ? 'h-24 sm:h-28' : 'h-32 sm:h-40'} overflow-hidden bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                                ${mediaThumbHtml(file, folder.id, index, 'w-full h-full object-cover group-hover:scale-105 transition duration-500')}
                                <span class="absolute top-2 right-2 bg-slate-900/80 backdrop-blur-md text-white w-6 h-6 rounded-xl flex items-center justify-center text-[10px]">
                                    <i class="fa-solid ${isVid ? 'fa-video text-rose-400' : 'fa-image text-indigo-400'}"></i>
                                </span>
                                <span class="absolute bottom-2 left-2 right-2 bg-slate-900/85 backdrop-blur-md text-white text-[10px] px-2 py-0.5 rounded-xl truncate"><i class="fa-solid fa-folder text-[9px] mr-1 text-indigo-400"></i>${esc(folder.name)}</span>
                            </div>
                            <div class="px-2.5 py-2 text-xs text-slate-700 dark:text-slate-300 truncate" title="${esc(file.name)}">${esc(file.name)}</div>`;
                    }
                    container.appendChild(card);
                });
                if (res.files.length > searchLimit) {
                    const wrap = document.createElement('div');
                    wrap.className = 'col-span-full flex justify-center py-3';
                    wrap.innerHTML = `<button type="button" class="px-5 py-2 rounded-xl text-sm font-medium bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 transition cursor-pointer">მეტის ჩვენება (${res.files.length - searchLimit})</button>`;
                    wrap.firstChild.onclick = () => { searchLimit += SEARCH_PAGE; renderFolders(); };
                    container.appendChild(wrap);
                }
            }
        }

        /* ---------- Filter panel ---------- */
        function searchPanelEl() { return document.getElementById('searchPanel'); }
        function toggleSearchPanel() { searchPanelEl().classList.contains('hidden') ? openSearchPanel() : closeSearchPanel(); }
        function closeSearchPanel() { searchPanelEl().classList.add('hidden'); }
        function openSearchPanel() {
            const c = parseSearch(currentSearchQuery);
            document.getElementById('sfText').value = c.words.map(quoteVal).join(' ');
            document.getElementById('sfFolder').value = c.folder.join(', ');
            document.getElementById('sfName').value = c.name.join(', ');
            document.getElementById('sfTag').value = c.tag.join(', ');
            document.getElementById('sfType').value = c.type;
            document.getElementById('sfFav').checked = !!c.fav;
            const sel = document.getElementById('sfCat');
            sel.innerHTML = '<option value="">ყველა</option>';
            categories.forEach(cat => { const o = document.createElement('option'); o.value = cat.id; o.textContent = cat.name; sel.appendChild(o); });
            const ids = c.cat ? resolveCatIds(c.cat) : null;
            sel.value = ids && ids.size ? [...ids][0] : '';
            const dl = document.getElementById('searchTagList');
            dl.innerHTML = '';
            getSortedTags().forEach(({ tag }) => { const o = document.createElement('option'); o.value = tag; dl.appendChild(o); });
            searchPanelEl().classList.remove('hidden');
            document.getElementById('sfText').focus();
        }
        function applySearchPanel() {
            const list = (id) => document.getElementById(id).value.split(',').map(v => v.trim()).filter(Boolean);
            const text = parseSearch(document.getElementById('sfText').value);   // operators typed in this field also work
            const c = {
                words: text.words,
                folder: text.folder.concat(list('sfFolder')),
                name: text.name.concat(list('sfName')),
                tag: text.tag.concat(list('sfTag')),
                type: document.getElementById('sfType').value || text.type,
                cat: document.getElementById('sfCat').value || text.cat,
                fav: document.getElementById('sfFav').checked || text.fav
            };
            setSearchInput(buildSearch(c));
            closeSearchPanel();
            runSearchNow();
        }
        function clearSearchPanel() {
            setSearchInput('');
            closeSearchPanel();
            runSearchNow();
        }
        document.addEventListener('click', (e) => {
            const panel = searchPanelEl();
            if (panel.classList.contains('hidden')) return;
            if (panel.contains(e.target) || e.target.closest('#searchOptionsBtn') || e.target.id === 'searchInput') return;
            closeSearchPanel();
        });
        document.getElementById('searchInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { closeSearchPanel(); runSearchNow(); }
        });

        /* ---------- Tags: sorted list + popup ---------- */
        function getSortedTags() {
            return [...getTagCounts().entries()]
                .map(([tag, count]) => ({ tag, count }))
                .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ka'));
        }
        function openTagsModal() {
            document.getElementById('tagsModalFilter').value = '';
            renderTagsModal();
            const m = document.getElementById('tagsModal');
            m.classList.remove('hidden'); m.classList.add('flex');
            document.getElementById('tagsModalFilter').focus();
        }
        function closeTagsModal() {
            const m = document.getElementById('tagsModal');
            m.classList.remove('flex'); m.classList.add('hidden');
        }
        function renderTagsModal() {
            const q = lc(document.getElementById('tagsModalFilter').value.trim());
            const all = getSortedTags();
            const list = q ? all.filter(t => lc(t.tag).includes(q)) : all;
            document.getElementById('tagsModalCount').textContent = `(${all.length})`;
            const box = document.getElementById('tagsModalList');
            box.innerHTML = '';
            if (!list.length) { box.innerHTML = '<div class="text-sm text-slate-400">ტეგი ვერ მოიძებნა</div>'; return; }
            list.forEach(({ tag, count }) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'inline-flex items-center gap-2 bg-indigo-50 dark:bg-indigo-950 hover:bg-indigo-100 dark:hover:bg-indigo-900 text-indigo-600 dark:text-indigo-300 text-sm px-3 py-1.5 rounded-xl transition cursor-pointer';
                b.innerHTML = '<i class="fa-solid fa-tag text-[11px]"></i><span></span><span class="text-xs bg-white/70 dark:bg-slate-800 px-1.5 py-0.5 rounded-lg text-slate-500"></span>';
                b.children[1].textContent = tag;
                b.children[2].textContent = count;
                b.onclick = () => filterByTag(tag);
                box.appendChild(b);
            });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const tm = document.getElementById('tagsModal');
            if (!tm.classList.contains('hidden')) { closeTagsModal(); return; }
            if (!searchPanelEl().classList.contains('hidden')) closeSearchPanel();
        });

        /* ---------- Folder cover fallback (Georgian-safe, no external service) ---------- */
        function folderFallbackImg(name, w, h) {
            const text = String(name || '').trim();
            const esc2 = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const font = "'Noto Sans Georgian','Sylfaen','Segoe UI',Arial,sans-serif";
            let body;
            if (w <= 120) {
                const initials = Array.from(text.split(/\s+/).filter(Boolean).slice(0, 2).map(x => Array.from(x)[0] || '').join('') || '?').join('');
                body = `<text x="${w / 2}" y="${h / 2}" dy=".35em" text-anchor="middle" fill="#fff" font-family="${font}" font-size="${Math.round(h * 0.42)}" font-weight="700">${esc2(initials)}</text>`;
            } else {
                const maxChars = 16;
                const lines = [];
                let cur = '';
                text.split(/\s+/).filter(Boolean).forEach(word => {
                    let wd = Array.from(word);
                    while (wd.length > maxChars) { if (cur) { lines.push(cur); cur = ''; } lines.push(wd.slice(0, maxChars).join('')); wd = wd.slice(maxChars); }
                    word = wd.join('');
                    if (!cur) cur = word;
                    else if (Array.from(cur + ' ' + word).length <= maxChars) cur += ' ' + word;
                    else { lines.push(cur); cur = word; }
                });
                if (cur) lines.push(cur);
                let shown = lines.slice(0, 3);
                if (lines.length > 3) shown[2] = Array.from(shown[2]).slice(0, maxChars - 1).join('') + '…';
                if (!shown.length) shown = ['?'];
                const fs = shown.length === 1 ? 52 : (shown.length === 2 ? 46 : 38);
                const lh = fs * 1.25;
                const y0 = h / 2 - ((shown.length - 1) * lh) / 2;
                body = shown.map((ln, i) => `<text x="${w / 2}" y="${y0 + i * lh}" dy=".35em" text-anchor="middle" fill="#fff" font-family="${font}" font-size="${fs}" font-weight="600">${esc2(ln)}</text>`).join('');
            }
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f46e5"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>${body}</svg>`;
            return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg).replace(/'/g, '%27');
        }

        function renderBreadcrumb() {
            const nav = document.getElementById('breadcrumbNav');
            if (currentParentId === null || isSearchActive()) {
                nav.classList.add('hidden');
                return;
            }
            nav.classList.remove('hidden');

            nav.innerHTML = `
                <span class="hover:text-indigo-600 cursor-pointer" onclick="navigateToFolder(null)"><i class="fa-solid fa-house mr-1"></i> მთავარი</span>
                <span>/</span>
            `;

            let path = [];
            let curr = folders.find(f => f.id === currentParentId);
            while (curr) {
                path.unshift(curr);
                curr = folders.find(f => f.id === curr.parentId);
            }

            path.forEach((folder, idx) => {
                if (idx === path.length - 1) {
                    nav.innerHTML += `<span class="text-slate-800 dark:text-slate-100 font-semibold">${folder.name}</span>`;
                } else {
                    nav.innerHTML += `<span class="hover:text-indigo-600 cursor-pointer" onclick="navigateToFolder('${folder.id}')">${folder.name}</span><span>/</span>`;
                }
            });
        }

        function renderFolders() {
            _renderFoldersInner();
            updateSortUi();
            decorateSelectable();
            decorateFav(); decorateNotes();
            updateFavNav();
            observeLazy(document.getElementById('foldersContainer'));
            scheduleBackfill();
        }

        // Long lists are drawn in pages; the next page is added when the end gets close
        let _pagerObs = null, _pagerState = { ctx: '', n: 0 }, _pagerAll = null;
        function stopPager() { if (_pagerObs) { _pagerObs.disconnect(); _pagerObs = null; } _pagerAll = null; }
        function afterCardsAdded() {
            const c = document.getElementById('foldersContainer');
            decorateSelectable(); decorateFav(); decorateNotes(); observeLazy(c);
        }
        function pageCards(container, list, make, ctx) {
            stopPager();
            let n = 0;
            const sentinel = document.createElement('div');
            sentinel.className = 'col-span-full';
            sentinel.style.height = '1px';
            container.appendChild(sentinel);
            const more = (count, initial) => {
                const end = Math.min(list.length, n + count);
                if (end > n) {
                    const frag = document.createDocumentFragment();
                    for (; n < end; n++) frag.appendChild(make(list[n]));
                    container.insertBefore(frag, sentinel);
                }
                _pagerState = { ctx, n };
                if (n >= list.length) { sentinel.remove(); stopPager(); }
                if (!initial) afterCardsAdded();
            };
            more(_pagerState.ctx === ctx ? Math.max(PAGE_SIZE, _pagerState.n) : PAGE_SIZE, true);
            if (n < list.length) {
                _pagerAll = () => more(Infinity);
                _pagerObs = new IntersectionObserver(es => {
                    if (!es.some(e => e.isIntersecting)) return;
                    more(PAGE_SIZE);
                    if (_pagerObs && sentinel.isConnected) { _pagerObs.unobserve(sentinel); _pagerObs.observe(sentinel); }
                }, { rootMargin: '900px' });
                _pagerObs.observe(sentinel);
            }
        }

        function _renderFoldersInner() {
            stopPager();
            renderSidebar();
            renderBreadcrumb();

            const container = document.getElementById('foldersContainer');
            const emptyState = document.getElementById('emptyState');
            const badge = document.getElementById('folder-count-badge');
            const storageBar = document.getElementById('storageBar');
            
            badge.innerText = folders.length;
            storageBar.style.width = Math.min(100, (folders.length * 15)) + '%';

            container.innerHTML = '';

            updateSearchUi();
            if (isSearchActive()) { renderSearchResults(container, emptyState); return; }

            if (currentParentId !== null) {
                const currentFolder = folders.find(f => f.id === currentParentId);
                const subfolders = folders.filter(f => f.parentId === currentParentId);
                
                if (currentFolder) {
                    document.getElementById('sectionTitle').innerText = currentFolder.name;
                    document.getElementById('sectionDesc').innerHTML = folderHeaderDesc(currentFolder);
                }

                let mediaList = (currentFolder && currentFolder.mediaFiles) ? [...currentFolder.mediaFiles] : [];
                if (mediaList.length > 1) sortFiles(mediaList);

                let hasItems = subfolders.length > 0 || mediaList.length > 0;

                if (!hasItems) {
                    emptyState.classList.remove('hidden');
                    emptyState.classList.add('flex');
                    return;
                } else {
                    emptyState.classList.remove('flex');
                    emptyState.classList.add('hidden');
                }

                // Render Subfolders first
                subfolders.forEach(folder => {
                    const card = document.createElement('div');
                    card.className = "group bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm hover:shadow-xl transition-all flex flex-col cursor-pointer relative";
                    card.onclick = () => navigateToFolder(folder.id);
                    
                    const fallbackImg = folderFallbackImg(folder.name, 600, 400);
                    const imgUrl = folder.image ? folder.image : fallbackImg;

                    card.innerHTML = `
                        <div class="relative h-32 sm:h-40 overflow-hidden bg-slate-100 dark:bg-slate-800">
                            <img src="${imgUrl}" alt="${folder.name}" data-fb="${fallbackImg}" onerror="this.onerror=null;this.src=this.dataset.fb" class="w-full h-full object-cover group-hover:scale-105 transition duration-500">
                            <div class="absolute top-2 right-2 flex items-center space-x-1 bg-slate-900/80 backdrop-blur-md p-1 rounded-xl shadow" onclick="event.stopPropagation()">
                                ${folder.rootId && !folder.parentId ? `<button onclick="refreshFolder('${folder.id}')" class="p-1.5 text-white/80 hover:text-white transition cursor-pointer" title="განახლება დისკიდან"><i class="fa-solid fa-rotate text-xs"></i></button>` : ''}<button onclick="openModalForSub('${folder.id}')" class="p-1.5 text-white/80 hover:text-white transition cursor-pointer" title="ქვესაქაღალდე"><i class="fa-solid fa-folder-plus text-xs"></i></button>
                                <button onclick="editFolder('${folder.id}')" class="p-1.5 text-white/80 hover:text-white transition cursor-pointer" title="რედაქტირება"><i class="fa-solid fa-pen-to-square text-xs"></i></button>
                            </div>
                        </div>
                        <div class="p-3.5 flex-1 flex flex-col justify-between">
                            <h3 class="font-semibold text-slate-900 dark:text-white text-sm truncate">${folder.name}</h3>
                        </div>
                    `;
                    container.appendChild(card);
                });

                // Render Media Files
                if (mediaList.length > 0) {
                    if (viewMode === 'grid') {
                        container.className = "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4";
                    } else if (viewMode === 'compact') {
                        container.className = "grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3";
                    } else {
                        container.className = "flex flex-col space-y-2";
                    }

                    const idxMap = new Map(currentFolder.mediaFiles.map((m, i) => [m, i]));
                    const makeMediaCard = (file) => {
                        const originalIndex = idxMap.get(file);
                        const card = document.createElement('div');
                        card.className = "group bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-all flex flex-col cursor-pointer relative";
                        card.dataset.sel = currentParentId + '|' + originalIndex;
                        card.onclick = () => openGalleryModalAtIndex(currentParentId, originalIndex);

                        if (viewMode === 'list') {
                            card.className = "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 sm:p-3 flex items-center justify-between gap-2 shadow-sm hover:border-indigo-500/50 transition cursor-pointer";
                            let tagsHtml = (file.tags || []).map(t => `<span class="hidden sm:inline-block text-xs bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-300 px-2.5 py-1 rounded-xl cursor-pointer hover:bg-indigo-100" onclick="event.stopPropagation(); filterByTag('${t}')"><i class="fa-solid fa-tag mr-1"></i>${t}</span>`).join('');
                            const meta = `${fileDateStr(file)}${file.size ? ' · ' + fmtSize(file.size) : ''}`;
                            const tagLine = (file.tags || []).length ? ` · <i class="fa-solid fa-tag text-[9px]"></i> ${esc(file.tags.join(', '))}` : '';
                            card.innerHTML = `
                                <div class="flex items-center gap-2.5 min-w-0 flex-1">
                                    <div class="w-12 h-12 rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800 flex items-center justify-center relative flex-shrink-0">
                                        ${mediaThumbHtml(file, currentParentId, originalIndex, 'w-full h-full object-cover')}
                                    </div>
                                    <div class="min-w-0 flex-1">
                                        <span class="font-medium text-sm text-slate-800 dark:text-slate-200 truncate block">${esc(file.name)}</span>
                                        <span class="sm:hidden text-[11px] text-slate-400 truncate block">${meta}${tagLine}</span>
                                    </div>
                                </div>
                                <div class="flex items-center gap-2 flex-shrink-0">
                                    ${tagsHtml}
                                    <span class="hidden sm:inline text-xs text-slate-400">${meta}</span>
                                </div>
                            `;
                        } else {
                            const isVid = file.type === 'video';
                            let firstTag = (file.tags && file.tags.length > 0) ? file.tags[0] : '';
                            card.innerHTML = `
                                <div class="relative ${viewMode === 'compact' ? 'h-24 sm:h-28' : 'h-32 sm:h-40'} overflow-hidden bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                                    ${mediaThumbHtml(file, currentParentId, originalIndex, 'w-full h-full object-cover group-hover:scale-105 transition duration-500')}
                                    <span class="absolute top-2 right-2 bg-slate-900/80 backdrop-blur-md text-white w-6 h-6 rounded-xl flex items-center justify-center text-[10px]">
                                        <i class="fa-solid ${isVid ? 'fa-video text-rose-400' : 'fa-image text-indigo-400'}"></i>
                                    </span>
                                    ${firstTag ? `<span class="absolute bottom-2 left-2 bg-slate-900/85 backdrop-blur-md text-white text-[10px] px-2 py-0.5 rounded-xl"><i class="fa-solid fa-tag text-[9px] mr-1 text-indigo-400"></i>${firstTag} ${file.tags.length > 1 ? `(+${file.tags.length - 1})` : ''}</span>` : ''}
                                </div>
                            `;
                        }
                        return card;
                    };
                    pageCards(container, mediaList, makeMediaCard, [currentParentId, viewMode, sortMode].join('|'));
                }
                return;
            }

            const filtered = folders.filter(f => {
                return f.parentId === null && (currentFilter === 'all' || f.category === currentFilter);
            });

            if (filtered.length === 0) {
                emptyState.classList.remove('hidden');
                emptyState.classList.add('flex');
                return;
            } else {
                emptyState.classList.remove('flex');
                emptyState.classList.add('hidden');
            }

            if (viewMode === 'grid' || viewMode === 'compact') {
                container.className = viewMode === 'grid' ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6" : "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 gap-4";
                filtered.forEach(folder => {
                    const card = document.createElement('div');
                    card.className = "group bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm hover:shadow-xl hover:border-indigo-500/50 transition-all duration-300 flex flex-col relative";
                    
                    const fallbackImg = folderFallbackImg(folder.name, 600, 400);
                    const imgUrl = folder.image ? folder.image : fallbackImg;
                    const subCount = folders.filter(sub => sub.parentId === folder.id).length;

                    card.innerHTML = `
                        <div class="relative ${viewMode === 'compact' ? 'h-28 sm:h-32' : 'h-36 sm:h-44'} overflow-hidden bg-slate-100 dark:bg-slate-800 cursor-pointer" onclick="navigateToFolder('${folder.id}')">
                            <img src="${imgUrl}" alt="${folder.name}" data-fb="${fallbackImg}" onerror="this.onerror=null;this.src=this.dataset.fb" class="w-full h-full object-cover group-hover:scale-105 transition duration-500">
                            <div class="absolute inset-0 bg-gradient-to-t from-slate-950/60 via-transparent to-transparent opacity-60"></div>
                            
                            <div class="absolute top-2 right-2 flex items-center space-x-1 bg-slate-900/80 backdrop-blur-md p-1 rounded-xl shadow" onclick="event.stopPropagation()">
                                ${folder.rootId && !folder.parentId ? `<button onclick="refreshFolder('${folder.id}')" class="p-1.5 text-white/80 hover:text-white transition cursor-pointer" title="განახლება დისკიდან"><i class="fa-solid fa-rotate text-xs"></i></button>` : ''}<button onclick="openModalForSub('${folder.id}')" class="p-1.5 text-white/80 hover:text-white transition cursor-pointer" title="ქვესაქაღალდე"><i class="fa-solid fa-folder-plus text-xs"></i></button>
                                <button onclick="editFolder('${folder.id}')" class="p-1.5 text-white/80 hover:text-white transition cursor-pointer" title="რედაქტირება"><i class="fa-solid fa-pen-to-square text-xs"></i></button>
                            </div>

                            <div class="absolute bottom-2 left-2 flex items-center space-x-1.5">
                                <span class="bg-slate-900/80 backdrop-blur-md text-white text-[10px] font-medium px-2 py-0.5 rounded-xl flex items-center space-x-1">
                                    <i class="fa-solid fa-image text-[9px] text-indigo-400"></i> <span>${folder.photosCount || 0}</span>
                                </span>
                                <span class="bg-slate-900/80 backdrop-blur-md text-white text-[10px] font-medium px-2 py-0.5 rounded-xl flex items-center space-x-1">
                                    <i class="fa-solid fa-video text-[9px] text-rose-400"></i> <span>${folder.videosCount || 0}</span>
                                </span>
                            </div>

                            ${subCount > 0 ? `<span class="absolute top-2 left-2 bg-indigo-600 text-white text-[10px] font-semibold px-2 py-0.5 rounded-xl shadow">${subCount} ქვესაქაღალდე</span>` : ''}
                        </div>
                        <div class="p-3.5 flex-1 flex flex-col justify-between">
                            <div>
                                <h3 onclick="navigateToFolder('${folder.id}')" class="font-semibold text-slate-900 dark:text-white text-sm truncate mb-1 cursor-pointer hover:text-indigo-600 transition" title="${folder.name}">${folder.name}</h3>
                            </div>
                        </div>
                    `;
                    container.appendChild(card);
                });
            } else {
                container.className = "flex flex-col space-y-3";
                filtered.forEach(folder => {
                    const row = document.createElement('div');
                    row.className = "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 sm:p-4 flex items-center justify-between gap-2 shadow-sm hover:border-indigo-500/50 transition";
                    
                    const fallbackImg = folderFallbackImg(folder.name, 100, 100);
                    const imgUrl = folder.image ? folder.image : fallbackImg;
                    const subCount = folders.filter(sub => sub.parentId === folder.id).length;

                    row.innerHTML = `
                        <div class="flex items-center gap-3 cursor-pointer min-w-0 flex-1" onclick="navigateToFolder('${folder.id}')">
                            <img src="${imgUrl}" alt="${folder.name}" data-fb="${fallbackImg}" onerror="this.onerror=null;this.src=this.dataset.fb" class="w-12 h-12 rounded-xl object-cover bg-slate-100 dark:bg-slate-800 flex-shrink-0">
                            <div class="min-w-0">
                                <h3 class="font-semibold text-slate-900 dark:text-white text-sm mb-0.5 hover:text-indigo-600 truncate">${folder.name} ${subCount > 0 ? `<span class="text-xs text-indigo-500 ml-1">(${subCount} ქვესაქაღალდე)</span>` : ''}</h3>
                                <p class="text-xs text-slate-400">მედია ფაილების მენეჯერი</p>
                            </div>
                        </div>
                        <div class="flex items-center gap-2 sm:gap-3 flex-shrink-0">
                            <div class="hidden md:flex items-center space-x-2 text-xs text-slate-500">
                                <span class="bg-slate-100 dark:bg-slate-800 px-2.5 py-1 rounded-xl"><i class="fa-solid fa-image text-indigo-500 mr-1"></i> ${folder.photosCount || 0}</span>
                                <span class="bg-slate-100 dark:bg-slate-800 px-2.5 py-1 rounded-xl"><i class="fa-solid fa-video text-rose-500 mr-1"></i> ${folder.videosCount || 0}</span>
                            </div>
                            <button onclick="navigateToFolder('${folder.id}')" class="inline-flex items-center space-x-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-3.5 py-2 rounded-xl shadow-md transition cursor-pointer">
                                <i class="fa-solid fa-folder-open"></i>
                                <span class="hidden sm:inline">გახსნა</span>
                            </button>
                            <div class="flex items-center border-l border-slate-200 dark:border-slate-800 pl-1 sm:pl-2">
                                ${folder.rootId && !folder.parentId ? `<button onclick="refreshFolder('${folder.id}')" class="p-2 text-slate-400 hover:text-indigo-600 transition cursor-pointer" title="განახლება დისკიდან"><i class="fa-solid fa-rotate text-xs"></i></button>` : ''}<button onclick="openModalForSub('${folder.id}')" class="p-2 text-slate-400 hover:text-indigo-600 transition cursor-pointer" title="ქვესაქაღალდე"><i class="fa-solid fa-folder-plus text-xs"></i></button>
                                <button onclick="editFolder('${folder.id}')" class="p-2 text-slate-400 hover:text-indigo-600 transition cursor-pointer" title="რედაქტირება"><i class="fa-solid fa-pen-to-square text-xs"></i></button>
                            </div>
                        </div>
                    `;
                    container.appendChild(row);
                });
            }
        }

        function navigateToFolder(folderId) {
            ensureAccessFor(folderId);
            currentParentId = folderId;
            currentFilter = 'all';
            document.getElementById('searchInput').value = '';
            currentSearchQuery = '';
            if (folderId === null) {
                document.getElementById('sectionTitle').innerText = 'ყველა საქაღალდე';
                document.getElementById('sectionDesc').innerText = 'თქვენი ლოკალური ფოლდერების არქივი და ჰიერარქიული მედია კონტენტი.';
            }
            renderFolders();
        }

        function filterCategory(cat, e) {
            if (e) e.preventDefault();
            currentFilter = cat;
            currentParentId = null;
            document.getElementById('searchInput').value = '';
            currentSearchQuery = '';

            const foundCat = categories.find(c => c.id === cat);
            document.getElementById('sectionTitle').innerText = foundCat ? foundCat.name : 'კატეგორია';
            document.getElementById('sectionDesc').innerText = 'კატეგორიის მიხედვით დაჯგუფებული საქაღალდეები.';

            renderFolders();
            if (window.innerWidth < 768) toggleMobileSidebar();
        }


        function setViewMode(mode) {
            viewMode = mode;
            const gridBtn = document.getElementById('gridBtn');
            const compactBtn = document.getElementById('compactBtn');
            const listBtn = document.getElementById('listBtn');

            gridBtn.className = mode === 'grid' ? "px-3 py-1.5 rounded-xl text-xs font-medium bg-white dark:bg-slate-700 text-slate-900 dark:text-white transition" : "px-3 py-1.5 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-400 transition";
            compactBtn.className = mode === 'compact' ? "px-3 py-1.5 rounded-xl text-xs font-medium bg-white dark:bg-slate-700 text-slate-900 dark:text-white transition" : "px-3 py-1.5 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-400 transition";
            listBtn.className = mode === 'list' ? "px-3 py-1.5 rounded-xl text-xs font-medium bg-white dark:bg-slate-700 text-slate-900 dark:text-white transition" : "px-3 py-1.5 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-400 transition";

            renderFolders();
        }

        let modalPick = null; // { name, entries, handle, autoName, autoLink }

        function resetModalPick() {
            modalPick = null;
            const st = document.getElementById('modalPickStatus');
            if (st) st.textContent = 'აირჩიეთ საქაღალდე დისკიდან';
        }

        function presetModalCategory(parentId) {
            const sel = document.getElementById('formCategory');
            const parent = parentId ? folders.find(f => f.id === parentId) : null;
            const want = parent ? parent.category : (currentFilter !== 'all' ? currentFilter : null);
            if (want && categories.some(c => c.id === want)) sel.value = want;
        }

        function openModal() {
            document.getElementById('folderModal').classList.remove('hidden');
            document.getElementById('folderModal').classList.add('flex');
            document.getElementById('modalTitle').innerText = 'ახალი საქაღალდის დამატება';
            document.getElementById('folderForm').reset();
            document.getElementById('folderId').value = '';
            document.getElementById('parentFolderId').value = currentParentId || '';
            document.getElementById('modalDeleteBtn').classList.add('hidden');
            document.getElementById('modalPickerRow').classList.remove('hidden');
            resetModalPick();
            presetModalCategory(currentParentId);
        }

        function openModalForSub(parentId) {
            openModal();
            document.getElementById('parentFolderId').value = parentId;
            presetModalCategory(parentId);
            const parentFolder = folders.find(f => f.id === parentId);
            document.getElementById('modalTitle').innerText = parentFolder ? `ქვესაქაღალდის დამატება: "${parentFolder.name}"` : 'ქვესაქაღალდის დამატება';
            document.getElementById('modalDeleteBtn').classList.add('hidden');
        }

        function closeModal() {
            document.getElementById('folderModal').classList.remove('flex');
            document.getElementById('folderModal').classList.add('hidden');
        }

        async function applyModalPick(name, entries, handle) {
            if (!entries.length) { toast('მედია ფაილები ვერ მოიძებნა'); return; }
            const prev = modalPick;
            const nameEl = document.getElementById('formName');
            const linkEl = document.getElementById('formLink');
            const parentId = document.getElementById('parentFolderId').value;
            const parentFolder = parentId ? folders.find(f => f.id === parentId) : null;
            const base = getBasePath();
            const detected = handle ? await detectLinkFor(handle) : '';
            const autoLink = detected || (parentFolder && parentFolder.link ? joinPath(parentFolder.link, name) : (base ? joinPath(base, name) : `D:\\${name}`));
            if (!nameEl.value.trim() || (prev && nameEl.value === prev.autoName)) nameEl.value = name;
            if (!linkEl.value.trim() || (prev && linkEl.value === prev.autoLink)) linkEl.value = autoLink;
            modalPick = { name, entries, handle, autoName: name, autoLink, detected: !!detected };
            const photos = entries.filter(e => e.type === 'image').length;
            const videos = entries.length - photos;
            document.getElementById('modalPickStatus').textContent = `„${name}“ — ${photos} ფოტო, ${videos} ვიდეო`;
            toast(detected ? `ნაპოვნია: ${photos} ფოტო, ${videos} ვიდეო. ლინკი ავტომატურად განისაზღვრა` : `ნაპოვნია: ${photos} ფოტო, ${videos} ვიდეო. ჩაწერეთ საქაღალდის სრული მისამართი დისკზე`, 6000);
            linkEl.focus();
        }

        async function pickFolderForModal() {
            if (!FSA) { document.getElementById('modalFolderInput').click(); return; }
            let handle;
            try {
                handle = await pickDir();
            } catch (e) {
                if (e && e.name === 'AbortError') return;
                document.getElementById('modalFolderInput').click();
                return;
            }
            try {
                toast('სკანირება...', 0);
                const entries = [];
                await walkDir(handle, [], entries);
                entries.sort((a, b) => a.path.join('/').localeCompare(b.path.join('/'), undefined, { numeric: true }));
                await applyModalPick(handle.name, entries, handle);
            } catch (e) {
                console.error(e);
                toast('სკანირება ვერ მოხერხდა: ' + (e.message || e.name));
            }
        }

        function handleModalFolderInput(event) {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            if (!files.length) return;
            let rootName = 'Scanned Folder';
            const entries = [];
            for (const file of files) {
                const rel = file.webkitRelativePath;
                if (!rel) continue;
                const parts = rel.split('/');
                if (rootName === 'Scanned Folder') rootName = parts[0];
                const t = mediaType(file.name);
                if (!t || parts.length < 2 || parts.some(x => x.charAt(0) === '.')) continue;
                entries.push({ path: parts.slice(1), type: t, file, size: file.size, mtime: file.lastModified, getFile: async () => file });
            }
            applyModalPick(rootName, entries, null);
        }

        async function saveFolder(e) {
            e.preventDefault();
            const id = document.getElementById('folderId').value;
            let parentId = document.getElementById('parentFolderId').value || null;
            const name = document.getElementById('formName').value;
            const link = document.getElementById('formLink').value;
            const image = document.getElementById('formImage').value;
            const category = document.getElementById('formCategory').value;
            const catName = () => (categories.find(c => c.id === category) || {}).name || category;

            if (id) {
                const existing = folders.find(f => f.id === id);
                if (!existing) { closeModal(); return; }
                const parent = existing.parentId ? folders.find(f => f.id === existing.parentId) : null;
                const baseCat = parent ? parent.category : existing.category;
                const oldLink = existing.link || '';
                existing.name = name; existing.link = link; existing.image = image;
                if (oldLink && link !== oldLink) {
                    collectTreeIds(id).forEach(fid => {
                        const f = folders.find(x => x.id === fid);
                        if (f && f !== existing && typeof f.link === 'string' && f.link.startsWith(oldLink)) f.link = link + f.link.slice(oldLink.length);
                    });
                    if (!existing.parentId) learnBasePath(link);
                }
                if (category !== baseCat) {
                    // category change: whole subtree follows; a subfolder leaves its parent and becomes a top-level folder of the new category
                    collectTreeIds(id).forEach(fid => { const f = folders.find(x => x.id === fid); if (f) f.category = category; });
                    if (parent) {
                        existing.parentId = null;
                        toast(`„${name}“ გადავიდა კატეგორიაში: ${catName()}`, 4500);
                    }
                }
            } else {
                const parent = parentId ? folders.find(f => f.id === parentId) : null;
                if (parent && category !== parent.category) {
                    parentId = null;
                    toast(`„${name}“ დაემატა კატეგორიაში: ${catName()}`, 4500);
                }

                if (modalPick) {
                    const pick = modalPick;
                    if (!parentId) learnBasePath(link);
                    let old = null;
                    if (!parentId) {
                        old = confirmReplace(name);
                        if (old === false) return;
                    }
                    modalPick = null;
                    closeModal();
                    try {
                        await runImport(pick.name, pick.entries, pick.handle, old, { name, link, image, category, parentId });
                        if (!pick.handle) toast('ეს ბრაუზერი ფოლდერზე მუდმივ წვდომას ვერ ინახავს — გამოიყენეთ Chrome ან Edge', 6000);
                    } catch (err) {
                        console.error(err);
                        toast('იმპორტი ვერ მოხერხდა: ' + (err.message || err.name));
                    }
                    return;
                }

                folders.push({
                    id: Date.now().toString(),
                    parentId,
                    name,
                    link,
                    image,
                    category,
                    photosCount: 1,
                    videosCount: 0,
                    mediaFiles: [
                        { type: 'image', url: image || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1200&q=80', name: 'Sample_Photo.jpg', date: '2026-06-01 10:00', tags: [] }
                    ]
                });
                setTimeout(() => toast('საქაღალდე დაემატა, მაგრამ ფაილები არ ჩატვირთულა. გამოიყენეთ „არჩევა“ ღილაკი მონაცემების წასაკითხად', 6000), 50);
            }

            persistData();
            renderFolders();
            closeModal();
        }

        function editFolder(id) {
            const folder = folders.find(f => f.id === id);
            if (!folder) return;

            document.getElementById('modalTitle').innerText = 'საქაღალდის რედაქტირება';
            document.getElementById('folderId').value = folder.id;
            document.getElementById('parentFolderId').value = folder.parentId || '';
            document.getElementById('formName').value = folder.name;
            document.getElementById('formLink').value = folder.link;
            document.getElementById('formImage').value = folder.image || '';
            const parent = folder.parentId ? folders.find(f => f.id === folder.parentId) : null;
            document.getElementById('formCategory').value = parent ? parent.category : folder.category;

            document.getElementById('modalDeleteBtn').classList.remove('hidden');
            document.getElementById('modalPickerRow').classList.add('hidden');
            resetModalPick();

            document.getElementById('folderModal').classList.remove('hidden');
            document.getElementById('folderModal').classList.add('flex');
        }

        function deleteCurrentEditingFolder() {
            const id = document.getElementById('folderId').value;
            if (id) {
                closeModal();
                deleteFolder(id);
            }
        }

        function deleteFolder(id) {
            const ids = collectTreeIds(id);
            const delSet = new Set(ids);
            const prev = folders.slice();
            const top = folders.find(f => f.id === id);
            folders = folders.filter(f => !delSet.has(f.id));
            if (delSet.has(currentParentId)) currentParentId = top ? top.parentId : null;
            persistData();
            renderFolders();
            pushUndo(`საქაღალდე „${top ? top.name : ''}“ წაიშალა`,
                () => {
                    const cur = new Set(folders);
                    folders = prev.filter(f => delSet.has(f.id) || cur.has(f));
                },
                () => {
                    const still = new Set(folders.map(f => f.rootId).filter(Boolean));
                    forgetHandles(ids.filter(i => !still.has(i)));
                });
        }

        /* ---------- Undo ---------- */
        const undoStack = [];
        let undoHideT = null;
        function pushUndo(label, undo, commit) {
            const e = { label, undo, commit };
            e.t = setTimeout(() => finishUndo(e), 120000);
            undoStack.push(e);
            showUndoToast(e);
        }
        function finishUndo(e) {
            const i = undoStack.indexOf(e);
            if (i < 0) return;
            undoStack.splice(i, 1);
            clearTimeout(e.t);
            try { if (e.commit) e.commit(); } catch (err) { console.warn(err); }
        }
        function hideUndoToast() {
            const el = document.getElementById('undoToast');
            if (el) { el.style.opacity = '0'; el.style.pointerEvents = 'none'; }
        }
        function showUndoToast(e) {
            let el = document.getElementById('undoToast');
            if (!el) {
                el = document.createElement('div');
                el.id = 'undoToast';
                el.className = 'fixed bottom-5 left-1/2 -translate-x-1/2 z-[100] bg-slate-900 text-white text-sm pl-4 pr-2 py-2 rounded-xl shadow-xl flex items-center gap-3 transition-opacity duration-300 max-w-[calc(100vw-1rem)]';
                el.innerHTML = '<span class="undo-text"></span><button type="button" class="undo-btn px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-indigo-300 font-medium text-xs whitespace-nowrap cursor-pointer" onclick="undoLast()"><i class="fa-solid fa-rotate-left mr-1.5"></i>დაბრუნება <span class="text-slate-400 ml-1">Ctrl+Z</span></button>';
                document.body.appendChild(el);
            }
            el.querySelector('.undo-text').textContent = e.label;
            el.style.opacity = '1'; el.style.pointerEvents = 'auto';
            clearTimeout(undoHideT);
            undoHideT = setTimeout(hideUndoToast, 10000);
        }
        async function undoLast() {
            const e = undoStack.pop();
            if (!e) { toast('გასაუქმებელი მოქმედება არ არის'); return; }
            clearTimeout(e.t);
            hideUndoToast();
            try { e.undo(); } catch (err) { console.warn(err); }
            await persistData();
            renderFolders();
            toast('დაბრუნდა: ' + e.label, 2500);
        }
        document.addEventListener('keydown', (e) => {
            const tag = (e.target && e.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
            const anyModal = [...document.querySelectorAll('.fixed.inset-0')].some(m => !m.classList.contains('hidden') && m.id !== 'galleryModal' && getComputedStyle(m).display !== 'none') || !document.getElementById('galleryModal').classList.contains('hidden');
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyZ') {
                if (anyModal || !undoStack.length) return;
                e.preventDefault(); undoLast();
            } else if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey && selected.size && !anyModal) {
                e.preventDefault(); deleteSelected();
            }
        });

        function recountFolder(f) {   // a folder's counters include its subfolders; update it and all its ancestors
            let cur = f, guard = 0;
            while (cur && guard++ < 50) {
                const ids = new Set(collectTreeIds(cur.id));
                let ph = 0, vi = 0;
                folders.forEach(x => { if (ids.has(x.id)) (x.mediaFiles || []).forEach(m => { if (m.type === 'image') ph++; else if (m.type === 'video') vi++; }); });
                cur.photosCount = ph; cur.videosCount = vi;
                cur = cur.parentId ? folders.find(x => x.id === cur.parentId) : null;
            }
        }
        function deleteSelected() {
            if (!selected.size) return;
            const byFolder = new Map();
            selected.forEach(k => {
                const { fid, idx } = selKeyParts(k);
                const f = folders.find(x => String(x.id) === fid);
                const m = f && f.mediaFiles && f.mediaFiles[idx];
                if (!m) return;
                if (!byFolder.has(f)) byFolder.set(f, []);
                byFolder.get(f).push({ idx, m });
            });
            let total = 0;
            const removed = [];
            byFolder.forEach((arr, f) => {
                arr.sort((a, b) => a.idx - b.idx);
                const set = new Set(arr.map(x => x.m));
                f.mediaFiles = f.mediaFiles.filter(m => !set.has(m));
                recountFolder(f);
                removed.push({ f, arr });
                total += arr.length;
            });
            if (!total) return;
            clearSelection();
            persistData();
            renderFolders();
            pushUndo(`ბიბლიოთეკიდან წაიშალა: ${total} ფაილი (დისკზე არ წაშლილა)`, () => {
                removed.forEach(({ f, arr }) => {
                    if (!folders.includes(f)) return;
                    arr.forEach(({ idx, m }) => f.mediaFiles.splice(Math.min(idx, f.mediaFiles.length), 0, m));
                    recountFolder(f);
                });
            });
        }

        const CAT_COLORS = ['#6366f1', '#0ea5e9', '#14b8a6', '#10b981', '#f59e0b', '#f97316', '#f43f5e', '#ec4899', '#8b5cf6', '#64748b'];
        let newCatColor = CAT_COLORS[0];

        function renderCatColorPicker() {
            const box = document.getElementById('newCategoryColors');
            box.innerHTML = '';
            CAT_COLORS.forEach(c => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'w-7 h-7 rounded-xl flex items-center justify-center cursor-pointer transition ' + (c === newCatColor ? 'ring-2 ring-offset-2 ring-slate-400 dark:ring-offset-slate-900' : 'hover:scale-110');
                b.style.background = c;
                b.innerHTML = c === newCatColor ? '<i class="fa-solid fa-check text-white text-xs"></i>' : '';
                b.onclick = () => { newCatColor = c; renderCatColorPicker(); };
                box.appendChild(b);
            });
        }

        let editingCatId = null;

        function syncCategoryForm() {
            document.getElementById('catSubmitBtn').textContent = editingCatId ? 'შენახვა' : 'დამატება';
            document.getElementById('catCancelBtn').classList.toggle('hidden', !editingCatId);
        }

        function openCategoryModal() {
            document.getElementById('categoryModal').classList.remove('hidden');
            document.getElementById('categoryModal').classList.add('flex');
            cancelEditCategory();
            renderManageCategoriesList();
        }

        function closeCategoryModal() {
            document.getElementById('categoryModal').classList.remove('flex');
            document.getElementById('categoryModal').classList.add('hidden');
        }

        function startEditCategory(catId) {
            const cat = categories.find(c => c.id === catId);
            if (!cat) return;
            editingCatId = catId;
            document.getElementById('newCategoryInput').value = cat.name;
            newCatColor = cat.color || CAT_COLORS[0];
            syncCategoryForm();
            renderCatColorPicker();
            renderManageCategoriesList();
            document.getElementById('newCategoryInput').focus();
        }

        function cancelEditCategory() {
            editingCatId = null;
            document.getElementById('newCategoryInput').value = '';
            newCatColor = CAT_COLORS[0];
            syncCategoryForm();
            renderCatColorPicker();
            renderManageCategoriesList();
        }

        function renderManageCategoriesList() {
            const list = document.getElementById('manageCategoriesList');
            list.innerHTML = '';
            categories.forEach(cat => {
                const row = document.createElement('div');
                row.className = "flex items-center justify-between px-3 py-2 rounded-xl text-sm " + (cat.id === editingCatId ? 'bg-indigo-50 dark:bg-indigo-950/40 ring-1 ring-indigo-300 dark:ring-indigo-800' : 'bg-slate-50 dark:bg-slate-800');
                row.innerHTML = `
                    <span class="flex items-center gap-2.5 min-w-0">
                        <i class="fa-solid fa-folder" style="color:${cat.color || '#64748b'}"></i>
                        <span class="font-medium text-slate-800 dark:text-slate-200 truncate">${esc(cat.name)}</span>
                    </span>
                    <span class="flex items-center gap-3 flex-shrink-0">
                        <button onclick="startEditCategory('${cat.id}')" title="რედაქტირება" class="text-slate-400 hover:text-indigo-600 text-xs cursor-pointer"><i class="fa-solid fa-pen-to-square"></i></button>
                        ${categories.length > 1 ? `<button onclick="deleteCategory('${cat.id}')" title="წაშლა" class="text-rose-500 hover:text-rose-700 text-xs cursor-pointer"><i class="fa-solid fa-trash"></i></button>` : ''}
                    </span>
                `;
                list.appendChild(row);
            });
        }

        function addNewCategory() {
            const input = document.getElementById('newCategoryInput');
            const name = input.value.trim();
            if (!name) return;

            if (editingCatId) {
                const cat = categories.find(c => c.id === editingCatId);
                if (cat) { cat.name = name; cat.color = newCatColor; }
                persistData();
                cancelEditCategory();
                renderFolders();
                updateSectionHeader();
                return;
            }

            const id = name.toLowerCase().replace(/\s+/g, '_') + '_' + Date.now().toString().slice(-4);
            categories.push({ id, name, icon: 'fa-folder', color: newCatColor });
            input.value = '';
            persistData();
            renderManageCategoriesList();
            renderFolders();
        }

        function deleteCategory(catId) {
            if (editingCatId === catId) editingCatId = null, syncCategoryForm();
            categories = categories.filter(c => c.id !== catId);
            persistData();
            renderManageCategoriesList();
            renderFolders();
        }

        function openGalleryModalAtIndex(folderId, index) {
            ensureAccessFor(folderId);
            activeGalleryFolderId = folderId;
            currentGalleryIndex = index;

            document.getElementById('galleryModal').classList.remove('hidden');
            document.getElementById('galleryModal').classList.add('flex');
            renderGalleryViewer();
        }

        function closeGalleryModal() {
            document.getElementById('galleryModal').classList.remove('flex');
            document.getElementById('galleryModal').classList.add('hidden');
            closeFileMenu();
            gzReset(); gz.key = '';
            activeGalleryFolderId = null;
            galleryToken++;
            clearGalleryMedia();
            renderFolders();
        }

        function renderGalleryViewer() {
            _renderGalleryViewerInner();
            observeLazy(document.getElementById('thumbnailStrip'));
            updateGalleryFavBtn();
            noteRefresh(true);
        }

        function _renderGalleryViewerInner() {
            const folder = folders.find(f => f.id === activeGalleryFolderId);
            if (!folder || !folder.mediaFiles || folder.mediaFiles.length === 0) return;

            const files = folder.mediaFiles;
            if (currentGalleryIndex >= files.length) currentGalleryIndex = files.length - 1;
            if (currentGalleryIndex < 0) currentGalleryIndex = files.length - 1;

            const currentItem = files[currentGalleryIndex];
            const ord = galleryOrder(folder);
            document.getElementById('galleryCounter').innerText = `${ord.indexOf(currentGalleryIndex) + 1} / ${files.length}`;
            closeFileMenu();
            setGalleryTitle(currentItem.name || 'მედია ფაილი');
            document.getElementById('galleryItemDate').innerText = galleryInfoText(currentItem);
            
            const tagsContainer = document.getElementById('galleryItemTagsContainer');
            tagsContainer.innerHTML = '';
            if (currentItem.tags && Array.isArray(currentItem.tags)) {
                currentItem.tags.forEach(t => {
                    const tagBadge = document.createElement('span');
                    tagBadge.className = "text-xs bg-indigo-600/60 hover:bg-indigo-600 px-2 py-0.5 rounded-xl text-white cursor-pointer transition";
                    tagBadge.innerHTML = `<i class="fa-solid fa-tag mr-1"></i>${t}`;
                    tagBadge.onclick = () => {
                        closeGalleryModal();
                        filterByTag(t);
                    };
                    tagsContainer.appendChild(tagBadge);
                });
            }

            const displayArea = document.getElementById('galleryDisplayArea');
            clearGalleryMedia();
            galleryToken++;
            gzPrepare(currentItem);

            if (currentItem.local) {
                loadLocalIntoGallery(folder, currentItem, displayArea, galleryToken);
            } else if (currentItem.type === 'video') {
                const video = document.createElement('video');
                video.src = currentItem.url;
                video.controls = true;
                video.autoplay = true;
                video.className = "w-full h-full object-contain";
                displayArea.appendChild(video);
            } else {
                const img = document.createElement('img');
                img.src = currentItem.url;
                img.alt = currentItem.name;
                img.className = "w-full h-full object-contain";
                displayArea.appendChild(img);
                gzAttach(img);
            }

            const thumbStrip = document.getElementById('thumbnailStrip');
            thumbStrip.innerHTML = '';
            const n = files.length;
            const pos = ord.indexOf(currentGalleryIndex);
            const prevIdx = ord[(pos - 1 + n) % n];
            const nextIdx = ord[(pos + 1) % n];
            // only the neighbourhood of the current item is built; spacers keep the strip's real width
            const D = isNarrow() ? { w: 48, h: 44, gap: 8 } : { w: 64, h: 56, gap: 12 };
            const WIN = 24;
            const from = Math.max(0, pos - WIN), to = Math.min(n, pos + WIN + 1);
            thumbStrip.style.gap = D.gap + 'px';
            const spacer = (cnt) => { const d = document.createElement('div'); d.className = 'flex-shrink-0'; d.style.width = (cnt * (D.w + D.gap) - D.gap) + 'px'; d.style.height = '1px'; return d; };
            if (from > 0) thumbStrip.appendChild(spacer(from));
            for (let p = from; p < to; p++) {
                const idx = ord[p];
                const file = files[idx];
                const isCur = idx === currentGalleryIndex;
                const thumb = document.createElement('div');
                thumb.className = `relative flex-shrink-0 rounded-xl overflow-hidden cursor-pointer transition-all duration-300 transform hover:scale-125 ${isCur ? 'ring-2 ring-indigo-500 scale-110 opacity-100' : 'opacity-60 hover:opacity-100'}`;
                thumb.style.width = D.w + 'px'; thumb.style.height = D.h + 'px';
                thumb.title = `${p + 1} / ${n} · ${file.name || ''}`;
                thumb.onclick = () => {
                    currentGalleryIndex = idx;
                    renderGalleryViewer();
                };
                let badges = '';
                if (n > 1 && !isCur) {
                    if (idx === prevIdx) badges += `<span class="absolute top-0.5 left-0.5 bg-indigo-600 text-white w-4 h-4 rounded-md flex items-center justify-center text-[9px] pointer-events-none"><i class="fa-solid fa-chevron-left"></i></span>`;
                    if (idx === nextIdx) badges += `<span class="absolute top-0.5 right-0.5 bg-indigo-600 text-white w-4 h-4 rounded-md flex items-center justify-center text-[9px] pointer-events-none"><i class="fa-solid fa-chevron-right"></i></span>`;
                }
                if (file.type === 'video') badges += `<span class="absolute bottom-0.5 right-0.5 bg-slate-900/80 text-white w-4 h-4 rounded-md flex items-center justify-center text-[8px] pointer-events-none"><i class="fa-solid fa-play"></i></span>`;
                thumb.innerHTML = mediaThumbHtml(file, activeGalleryFolderId, idx, 'w-full h-full object-cover rounded-xl') + badges;
                thumbStrip.appendChild(thumb);
            }
            if (to < n) thumbStrip.appendChild(spacer(n - to));
            const activeThumb = thumbStrip.children[pos - from + (from > 0 ? 1 : 0)];
            if (activeThumb && activeThumb.scrollIntoView) activeThumb.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
        }

        function galleryLength() {
            const f = folders.find(x => x.id === activeGalleryFolderId);
            return (f && f.mediaFiles) ? f.mediaFiles.length : 0;
        }
        // display order of the opened folder = the active sort (indexes into folder.mediaFiles)
        function galleryOrder(folder) {
            const files = folder.mediaFiles || [];
            const idx = files.map((_, i) => i);
            if (idx.length < 2) return idx;
            const cmp = fileComparator();
            return idx.sort((a, b) => cmp(files[a], files[b]) || a - b);
        }
        function galleryGo(pos) {
            const f = folders.find(x => x.id === activeGalleryFolderId);
            if (!f || !(f.mediaFiles || []).length) return;
            const ord = galleryOrder(f);
            const n = ord.length;
            currentGalleryIndex = ord[((pos % n) + n) % n];
            renderGalleryViewer();
        }
        function galleryStep(d) {
            const f = folders.find(x => x.id === activeGalleryFolderId);
            if (!f || !(f.mediaFiles || []).length) return;
            const ord = galleryOrder(f);
            galleryGo(ord.indexOf(currentGalleryIndex) + d);
        }
        function nextGalleryItem() { galleryStep(1); }
        function prevGalleryItem() { galleryStep(-1); }

        function openTagModalForCurrentItem() {
            const folder = folders.find(f => f.id === activeGalleryFolderId);
            if (!folder || !folder.mediaFiles) return;
            const currentItem = folder.mediaFiles[currentGalleryIndex];
            
            activeTaggingFolderId = activeGalleryFolderId;
            activeTaggingFileIndex = currentGalleryIndex;

            document.getElementById('tagInput').value = (currentItem.tags && Array.isArray(currentItem.tags)) ? currentItem.tags.join(', ') : '';
            document.getElementById('tagModal').classList.remove('hidden');
            document.getElementById('tagModal').classList.add('flex');
        }

        function closeTagModal() {
            document.getElementById('tagModal').classList.remove('flex');
            document.getElementById('tagModal').classList.add('hidden');
            document.getElementById('tagAutocompleteDropdown').classList.add('hidden');
        }

        function handleTagAutocomplete(val) {
            const dropdown = document.getElementById('tagAutocompleteDropdown');
            const allTags = getAllUniqueTags();
            const tagCounts = getTagCounts();
            // Get current typing part after comma
            const parts = val.split(',');
            const currentPart = parts[parts.length - 1].trim();

            const matched = allTags.filter(t => t.toLowerCase().includes(currentPart.toLowerCase()) && !parts.slice(0, -1).map(p => p.trim()).includes(t));

            if (matched.length === 0 || !currentPart) {
                dropdown.classList.add('hidden');
                return;
            }

            dropdown.innerHTML = '';
            matched.forEach(t => {
                const item = document.createElement('div');
                item.className = "px-4 py-2 hover:bg-slate-100 dark:hover:bg-slate-700 text-sm cursor-pointer text-slate-800 dark:text-slate-100 flex items-center justify-between";
                item.innerHTML = `<span></span><span class="text-xs text-slate-400"></span>`;
                item.firstChild.textContent = t;
                item.lastChild.textContent = tagCounts.get(t) || 0;
                item.onclick = () => {
                    parts[parts.length - 1] = ' ' + t;
                    document.getElementById('tagInput').value = parts.join(',').replace(/^,/, '').trim() + ', ';
                    dropdown.classList.add('hidden');
                    document.getElementById('tagInput').focus();
                };
                dropdown.appendChild(item);
            });
            dropdown.classList.remove('hidden');
        }

        function saveCurrentItemTag() {
            if (!activeTaggingFolderId && activeTaggingFolderId !== 0) return;
            const folder = folders.find(f => f.id === activeTaggingFolderId);
            if (!folder || !folder.mediaFiles) return;

            const rawInput = document.getElementById('tagInput').value;
            const tagsArray = rawInput.split(',').map(t => t.trim()).filter(t => t.length > 0);

            folder.mediaFiles[activeTaggingFileIndex].tags = tagsArray;

            persistData();
            closeTagModal();
            renderGalleryViewer();
            renderSidebar();
        }

        function setSidebarCollapsed(on) {
            document.getElementById('sidebar').classList.toggle('collapsed', on);
            try { localStorage.setItem('avma_sidebar_collapsed', on ? '1' : '0'); } catch (e) {}
        }
        function toggleSidebarCollapse() {
            if (window.innerWidth < 768) { toggleMobileSidebar(); return; }
            setSidebarCollapsed(!document.getElementById('sidebar').classList.contains('collapsed'));
        }
        try { if (localStorage.getItem('avma_sidebar_collapsed') === '1') document.getElementById('sidebar').classList.add('collapsed'); } catch (e) {}

        function toggleMobileSidebar() {
            const sidebar = document.getElementById('sidebar');
            sidebar.classList.toggle('-translate-x-full');
        }

        function toggleDarkMode() {
            const html = document.documentElement;
            const icon = document.getElementById('themeIcon');
            html.classList.toggle('dark');
            
            if (html.classList.contains('dark')) {
                localStorage.setItem('theme', 'dark');
                icon.className = "fa-solid fa-sun text-sm";
            } else {
                localStorage.setItem('theme', 'light');
                icon.className = "fa-solid fa-moon text-sm";
            }
        }

        /* ---------- Path helpers / remembered base folder ---------- */
        function pathSep(p) { return (p.includes('/') && !p.includes('\\')) ? '/' : '\\'; }
        function joinPath(base, name) {
            const b = String(base || '').replace(/[\\/]+$/, '');
            return b + pathSep(b) + name;
        }
        function dirName(p) { return normalizeLinkBase(p).replace(/[\\/][^\\/]*$/, ''); }
        function baseName(p) { const m = normalizeLinkBase(p).match(/[^\\/]+$/); return m ? m[0] : ''; }
        function getBasePath() { try { return localStorage.getItem('avma_base_path') || ''; } catch (e) { return ''; } }
        function setBasePath(v) { try { if (v) localStorage.setItem('avma_base_path', v); } catch (e) {} }
        function learnBasePath(link) {
            const d = dirName(link);
            if (d && /[\\/]/.test(normalizeLinkBase(link))) setBasePath(d);
        }

        /* ---------- Local address link + relinking ---------- */
        function localLinkHtml(f) {
            const raw = (f.link || '').trim();
            const base = normalizeLinkBase(raw);
            const href = /^https?:\/\//i.test(raw) ? raw : (base ? pathToFileUrl(base) : '#');
            return `ლოკალური მისამართი: <a href="${esc(href)}" target="_blank" rel="noopener" onclick="return openLocalLink(event,'${esc(f.id)}')" class="text-indigo-600 dark:text-indigo-400 underline">${esc(raw)}</a>`;
        }
        function needsRelink(f) {
            return !!(f && f.rootId && FSA && !rootHandles.has(f.rootId));
        }
        function folderHeaderDesc(f) {
            let html = localLinkHtml(f);
            if (f.rootId && FSA && !needsRelink(f)) {
                html += ` <button type="button" onclick="refreshFolder('${esc(f.id)}')" title="ძირითადი საქაღალდის ხელახლა სკანირება დისკიდან" class="ml-3 px-3 py-1 rounded-xl text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition cursor-pointer"><i class="fa-solid fa-rotate mr-1"></i>განახლება</button>`;
            }
            if (needsRelink(f)) {
                html += ` <button type="button" onclick="relinkFolder('${esc(f.id)}')" class="ml-3 px-3 py-1 rounded-xl text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white transition cursor-pointer"><i class="fa-solid fa-link mr-1"></i>დაკავშირება დისკთან</button>`;
            }
            return html;
        }
        function openLocalLink(e, id) {
            const f = folders.find(x => x.id === id);
            if (!f) return true;
            if (/^https?:\/\//i.test((f.link || '').trim()) || location.protocol === 'file:') return true;
            e.preventDefault();
            const path = normalizeLinkBase(f.link) || f.link;
            copyText(path).then(() => toast('გვერდი file:// ით არ არის გახსნილი, ამიტომ მისამართი დაკოპირდა — ჩასვით Explorer-ში', 6000));
            return false;
        }
        async function relinkFolder(folderId) {
            const f = folders.find(x => x.id === folderId);
            if (!f || !f.rootId) return;
            if (!FSA) { toast('დაკავშირება მხოლოდ Chrome ან Edge-შია შესაძლებელი'); return; }
            let h;
            try { h = await window.showDirectoryPicker({ id: 'avma-gallery', mode: 'read' }); }
            catch (e) { return; }
            rootHandles.set(f.rootId, h);
            accessGranted.add(f.rootId);
            if (idbOk) { try { await idbSet('handles', f.rootId, h); } catch (e) { console.warn(e); } }
            const prefix = f.rootId + '|';
            for (const [k, u] of thumbCache) if (k.startsWith(prefix)) { URL.revokeObjectURL(u); thumbCache.delete(k); }
            toast(`დაკავშირებულია: ${h.name}`);
            renderFolders();
            if (activeGalleryFolderId) renderGalleryViewer();
        }

        async function relinkAllFromParent() {
            let h;
            try { h = await window.showDirectoryPicker({ id: 'avma-gallery', mode: 'read' }); } catch (e) { return; }
            const ids = [...new Set(folders.filter(f => f.rootId && !rootHandles.has(f.rootId)).map(f => f.rootId))];
            let linked = 0;
            for (const id of ids) {
                const rf = folders.find(f => f.id === id);
                if (!rf) continue;
                const names = [baseName(rf.link), rf.name].filter(Boolean);
                let found = null;
                for (const n of names) {
                    if (h.name === n) { found = h; break; }
                    try { found = await h.getDirectoryHandle(n); break; } catch (e) { /* not here */ }
                }
                if (!found) continue;
                rootHandles.set(id, found);
                accessGranted.add(id);
                if (idbOk) { try { await idbSet('handles', id, found); } catch (e) { console.warn(e); } }
                linked++;
            }
            thumbCache.forEach(u => URL.revokeObjectURL(u));
            thumbCache.clear();
            renderFolders();
            toast(`დაკავშირდა ${linked} / ${ids.length} საქაღალდე` + (linked < ids.length ? ' — დანარჩენი ხელით დააკავშირეთ' : ''), 6000);
        }

        /* ---------- Data export / import (JSON) ---------- */
        function buildExport() {
            return { app: 'AvmaDrive', version: 1, exportedAt: new Date().toISOString(), basePath: getBasePath(), categories, folders };
        }
        /* ---------- Automatic JSON backup into one chosen file ---------- */
        let backupHandle = null, backupTimer = null, backupBusy = false, backupAgain = false, backupNeedsPerm = false, backupError = '', backupLast = 0, backupPermArmed = false;
        const backupSupported = () => !!(window.showSaveFilePicker && idbOk);
        function backupTimeStr(t) { return t ? new Date(t).toLocaleString((window.LANG === 'es' ? 'es-ES' : 'ka-GE'), { dateStyle: 'short', timeStyle: 'short' }) : '—'; }
        function updateBackupUi() {
            const ind = document.getElementById('backupInd');
            const sup = backupSupported();
            const state = !sup ? 'na' : (!backupHandle ? 'off' : (backupError ? 'err' : (backupNeedsPerm ? 'perm' : 'on')));
            if (ind) {
                const cls = { na: 'bg-slate-400', off: 'bg-slate-400', on: 'bg-emerald-500', perm: 'bg-amber-500', err: 'bg-rose-500' }[state];
                ind.className = 'absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full ring-2 ring-white dark:ring-slate-900 cursor-pointer z-[1] ' + cls;
                ind.setAttribute('data-tip', {
                    na: 'ავტო-ბექაპი ამ ბრაუზერში მიუწვდომელია\n(მუშაობს Chrome-სა და Edge-ში)',
                    off: 'ავტო-ბექაპი გამორთულია\nდააჭირე ჩასართავად',
                    on: `ავტო-ბექაპი ჩართულია\nფაილი: ${backupHandle && backupHandle.name}\nბოლო ჩაწერა: ${backupTimeStr(backupLast)}`,
                    perm: 'ბექაპს წვდომის დადასტურება სჭირდება\nდააჭირე დასადასტურებლად',
                    err: 'ბექაპის შეცდომა: ' + backupError + '\nდააჭირე დეტალებისთვის'
                }[state]);
            }
            const b = document.getElementById('backupBtn');
            if (!b) return;
            if (!sup) { b.classList.add('hidden'); b.classList.remove('flex'); return; }
            b.classList.remove('hidden'); b.classList.add('flex');
            const dot = document.getElementById('backupDot');
            dot.className = 'w-2 h-2 rounded-full ' + ({ off: 'bg-slate-300 dark:bg-slate-600', on: 'bg-emerald-500', perm: 'bg-amber-500', err: 'bg-rose-500' })[state];
            const tip = { off: 'ავტომატური ბექაპი (გამორთულია)', on: `ბექაპი ჩართულია · ბოლო ჩაწერა: ${backupTimeStr(backupLast)}`, perm: 'ბექაპს წვდომის დადასტურება სჭირდება', err: 'ბექაპის შეცდომა: ' + backupError }[state];
            b.setAttribute('data-tip', tip);
        }
        async function initBackup() {
            if (backupSupported()) {
                try { backupHandle = (await idbGet('kv', 'backupHandle')) || null; } catch (e) { backupHandle = null; }
                backupLast = +lsGet('avma_backup_last') || 0;
                if (backupHandle) {
                    try { backupNeedsPerm = (await backupHandle.queryPermission({ mode: 'readwrite' })) !== 'granted'; } catch (e) { backupNeedsPerm = true; }
                    if (backupNeedsPerm) armBackupPerm();
                }
            }
            updateBackupUi();
        }
        function armBackupPerm() {
            if (backupPermArmed || !backupHandle) return;
            backupPermArmed = true;
            toast('ბექაპის გასაგრძელებლად დააჭირე ნებისმიერ ადგილას და დაადასტურე წვდომა', 5000);
            document.addEventListener('pointerdown', async () => {
                backupPermArmed = false;
                try {
                    if ((await backupHandle.requestPermission({ mode: 'readwrite' })) === 'granted') { backupNeedsPerm = false; await writeBackup(); }
                    else armBackupPerm();
                } catch (e) { console.warn(e); }
                updateBackupUi();
            }, { once: true, capture: true });
        }
        function scheduleBackup() {
            if (!backupHandle) return;
            clearTimeout(backupTimer);
            backupTimer = setTimeout(writeBackup, 4000);
        }
        async function writeBackup() {
            clearTimeout(backupTimer);
            if (!backupHandle) return false;
            if (backupBusy) { backupAgain = true; return false; }
            backupBusy = true;
            let ok = false;
            try {
                if ((await backupHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
                    backupNeedsPerm = true; armBackupPerm();
                } else {
                    const w = await backupHandle.createWritable();
                    await w.write(JSON.stringify(buildExport()));
                    await w.close();
                    backupLast = Date.now(); lsSet('avma_backup_last', String(backupLast));
                    backupNeedsPerm = false; backupError = ''; ok = true;
                }
            } catch (e) {
                console.warn(e);
                backupError = (e && e.name === 'NotFoundError') ? 'ფაილი ვეღარ მოიძებნა' : ((e && e.message) || 'ჩაწერა ვერ მოხერხდა');
            } finally {
                backupBusy = false;
                updateBackupUi();
                if (backupAgain) { backupAgain = false; scheduleBackup(); }
            }
            return ok;
        }
        async function chooseBackupFile() {
            try {
                const h = await window.showSaveFilePicker({ suggestedName: 'AvmaDrive-backup.json', types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] });
                await idbSet('kv', 'backupHandle', h);
                backupHandle = h; backupError = ''; backupNeedsPerm = false;
                const ok = await writeBackup();
                toast(ok ? `ბექაპი ჩართულია: ${h.name}` : 'ბექაპის ფაილი არჩეულია, მაგრამ ჩაწერა ვერ მოხერხდა');
            } catch (e) {
                if (e && e.name === 'AbortError') return;
                console.error(e); toast('ბექაპის ფაილის არჩევა ვერ მოხერხდა');
            }
            updateBackupUi();
        }
        async function openBackupDialog() {
            if (!backupSupported()) { toast('ავტომატური ბექაპი მხოლოდ Chrome-სა და Edge-ში მუშაობს'); return; }
            const note = 'ბრაუზერის გასუფთავების შემდეგ ფაილი დისკზე დარჩება. აღსადგენად გამოიყენე „იმპორტი“.';
            if (!backupHandle) {
                const go = await choiceDialog('ავტომატური ბექაპი',
                    'აირჩიე ფაილი ერთხელ. ყოველი ცვლილების შემდეგ აპი თავისით განაახლებს მასში შენს ტეგებს, კატეგორიებს, ფავორიტებს და ქავერებს.\n\n' + note,
                    [{ label: 'გაუქმება', value: false }, { label: 'ფაილის არჩევა', value: true, primary: true }]);
                if (go) await chooseBackupFile();
                return;
            }
            const status = backupError ? 'შეცდომა: ' + backupError : (backupNeedsPerm ? 'საჭიროა წვდომის დადასტურება' : 'მუშაობს');
            const act = await choiceDialog('ავტომატური ბექაპი',
                `ფაილი: ${backupHandle.name}\nსტატუსი: ${status}\nბოლო ჩაწერა: ${backupTimeStr(backupLast)}\n\n` + note,
                [{ label: 'გამორთვა', value: 'off' }, { label: 'ფაილის შეცვლა', value: 'change' }, { label: 'ჩაწერა ახლავე', value: 'now', primary: true }]);
            if (act === 'off') {
                try { await idbDel('kv', 'backupHandle'); } catch (e) {}
                backupHandle = null; backupError = ''; backupNeedsPerm = false; clearTimeout(backupTimer);
                toast('ავტომატური ბექაპი გამორთულია');
            } else if (act === 'change') {
                await chooseBackupFile();
            } else if (act === 'now') {
                if (backupNeedsPerm) {
                    try { if ((await backupHandle.requestPermission({ mode: 'readwrite' })) === 'granted') backupNeedsPerm = false; } catch (e) {}
                }
                const ok = await writeBackup();
                toast(ok ? 'ბექაპი ჩაიწერა' : 'ბექაპი ვერ ჩაიწერა');
            }
            updateBackupUi();
        }
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && backupTimer) writeBackup(); });

        async function exportData() {
            const json = JSON.stringify(buildExport());
            const name = `avmadrive-data-${new Date().toISOString().slice(0, 10)}.json`;
            try {
                if (window.showSaveFilePicker) {
                    const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] });
                    const w = await h.createWritable();
                    await w.write(json);
                    await w.close();
                } else {
                    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
                    const a = document.createElement('a');
                    a.href = url; a.download = name;
                    document.body.appendChild(a); a.click(); a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 60000);
                }
                toast(`ექსპორტი დასრულდა: ${folders.length} საქაღალდე, ${categories.length} კატეგორია`);
            } catch (e) {
                if (e && e.name === 'AbortError') return;
                console.error(e);
                toast('ექსპორტი ვერ მოხერხდა: ' + (e.message || e.name));
            }
        }
        function sanitizeImported(data) {
            const isBlob = u => typeof u === 'string' && u.startsWith('blob:');
            const cats = data.categories.filter(c => c && typeof c.id === 'string' && typeof c.name === 'string')
                .map(c => ({ id: c.id, name: c.name, icon: c.icon || 'fa-folder', color: c.color || '' }));
            const fl = data.folders.filter(f => f && typeof f.id === 'string' && typeof f.name === 'string').map(f => {
                const g = { ...f };
                if (isBlob(g.image)) g.image = '';
                g.parentId = g.parentId || null;
                g.link = g.link || '';
                g.mediaFiles = Array.isArray(g.mediaFiles) ? g.mediaFiles.filter(m => m && !isBlob(m.url)).map(m => ({ ...m, tags: Array.isArray(m.tags) ? m.tags : [] })) : [];
                return g;
            });
            return { categories: cats, folders: fl };
        }
        function choiceDialog(title, text, buttons) {
            return new Promise(resolve => {
                const ov = document.createElement('div');
                ov.className = 'fixed inset-0 z-[80] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4';
                ov.innerHTML = `<div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 w-full max-w-md shadow-2xl p-6 space-y-4">
                    <h3 class="font-bold text-slate-900 dark:text-white text-lg"></h3>
                    <p class="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-line"></p>
                    <div class="flex flex-wrap justify-end gap-2 pt-2"></div></div>`;
                ov.querySelector('h3').textContent = title;
                ov.querySelector('p').textContent = text;
                const row = ov.querySelector('.justify-end');
                buttons.forEach(b => {
                    const el = document.createElement('button');
                    el.type = 'button';
                    el.className = b.primary ? 'px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium transition cursor-pointer' : 'px-4 py-2 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer';
                    el.textContent = b.label;
                    el.onclick = () => { ov.remove(); resolve(b.value); };
                    row.appendChild(el);
                });
                document.body.appendChild(ov);
            });
        }
        function normalizeCategoryTree() {
            const byId = new Map(folders.map(f => [f.id, f]));
            folders.forEach(f => {
                let cur = f, guard = 0;
                while (cur.parentId && byId.has(cur.parentId) && guard++ < 50) cur = byId.get(cur.parentId);
                if (cur !== f) f.category = cur.category;
            });
            categories.forEach((c, i) => { if (!c.color) c.color = CAT_COLORS[i % CAT_COLORS.length]; });
        }
        async function handleDataImport(event) {
            const file = event.target.files && event.target.files[0];
            event.target.value = '';
            if (!file) return;
            let data;
            try {
                data = JSON.parse(await file.text());
                if (!data || !Array.isArray(data.folders) || !Array.isArray(data.categories)) throw new Error('format');
            } catch (e) {
                toast('ფაილი არასწორია — საჭიროა AvmaDrive-ის JSON ექსპორტი', 5000);
                return;
            }
            const imp = sanitizeImported(data);
            if (typeof data.basePath === 'string') setBasePath(data.basePath);
            const mode = await choiceDialog('მონაცემების იმპორტი',
                `„${file.name}“: ${imp.folders.length} საქაღალდე, ${imp.categories.length} კატეგორია. ჩანაცვლებისას ახლანდელი მონაცემები წაიშლება, გაერთიანებისას კი დაემატება/განახლდება იგივე ID-ის ჩანაწერები.`,
                [{ label: 'გაუქმება', value: null }, { label: 'გაერთიანება', value: 'merge' }, { label: 'ჩანაცვლება', value: 'replace', primary: true }]);
            if (!mode) return;

            if (mode === 'replace') {
                folders = imp.folders;
                categories = imp.categories.length ? imp.categories : defaultCategories.map(c => ({ ...c }));
                const keep = new Set(folders.map(f => f.rootId).filter(Boolean));
                forgetHandles([...rootHandles.keys()].filter(id => !keep.has(id)));
            } else {
                const fById = new Map(folders.map(f => [f.id, f]));
                imp.folders.forEach(f => { if (fById.has(f.id)) folders[folders.indexOf(fById.get(f.id))] = f; else folders.push(f); });
                imp.categories.forEach(c => { const i = categories.findIndex(x => x.id === c.id); if (i >= 0) categories[i] = c; else categories.push(c); });
            }
            normalizeCategoryTree();
            currentParentId = null;
            currentFilter = 'all';
            setSearchInput('');
            await persistData();
            renderFolders();
            updateSectionHeader();
            const unlinked = folders.filter(f => f.rootId && f.parentId === null && !rootHandles.has(f.rootId)).length;
            if (unlinked && FSA) {
                const go = await choiceDialog('დისკთან დაკავშირება',
                    `${unlinked} საქაღალდე დისკთან დაკავშირებული არ არის. აირჩიეთ მშობელი საქაღალდე (მაგ. D:\\გალერეა) და ყველა საქაღალდე, რომელიც მის შიგნითაა, ავტომატურად დაუკავშირდება.`,
                    [{ label: 'მოგვიანებით', value: false }, { label: 'არჩევა', value: true, primary: true }]);
                if (go) await relinkAllFromParent();
                else toast('საქაღალდეში შესვლისას დააჭირეთ „დაკავშირება დისკთან“', 6000);
            } else toast('იმპორტი დასრულდა');
        }

        /* ---------- Sidebar tooltip (site style) ---------- */
        (function () {
            const sb = document.getElementById('sidebar');
            const tip = document.getElementById('sbTip');
            sb.addEventListener('mouseover', (e) => {
                const el = e.target.closest('[data-tip]');
                if (!el) return;
                const collapsed = sb.classList.contains('collapsed') && window.innerWidth >= 768;
                if (!collapsed && !el.hasAttribute('data-tip-always')) return;
                tip.textContent = el.id === 'sidebarToggleLogo' ? (collapsed ? 'მენიუს გაშლა' : 'მენიუს დაკეცვა') : el.dataset.tip;
                tip.classList.remove('hidden');
                const r = el.getBoundingClientRect();
                if (collapsed && el.id !== 'sidebarToggleLogo' && !el.closest('.sb-actions')) {
                    tip.style.left = (r.right + 10) + 'px';
                    tip.style.top = (r.top + r.height / 2 - tip.offsetHeight / 2) + 'px';
                } else if (collapsed) {
                    tip.style.left = (r.right + 10) + 'px';
                    tip.style.top = (r.top + r.height / 2 - tip.offsetHeight / 2) + 'px';
                } else {
                    const below = r.top < window.innerHeight / 2;
                    tip.style.left = Math.max(8, r.left) + 'px';
                    tip.style.top = (below ? r.bottom + 8 : r.top - tip.offsetHeight - 8) + 'px';
                }
            });
            sb.addEventListener('mouseout', (e) => {
                const el = e.target.closest('[data-tip]');
                if (el && !el.contains(e.relatedTarget)) tip.classList.add('hidden');
            });
            sb.addEventListener('click', () => tip.classList.add('hidden'));
        })();

        /* ====================================================================
           GALLERY ZOOM / PAN / ROTATE  (images only; the file itself is never modified)
           ==================================================================== */
        const gz = { s: 1, tx: 0, ty: 0, rot: 0, key: '', el: null, nw: 0, nh: 0 };
        const GZ_MAX = 8;
        let gzDragging = false, gzIdleTimer = null;
        const gzPtrs = new Map();
        let gzPinch = null;

        function gzReset() { gz.s = 1; gz.tx = 0; gz.ty = 0; gz.rot = 0; }
        function gzArea() { return document.getElementById('galleryDisplayArea'); }
        function gzDims() {
            const r = ((gz.rot % 180) + 180) % 180 !== 0;
            const nwv = r ? gz.nh : gz.nw, nhv = r ? gz.nw : gz.nh;
            const a = gzArea();
            const cw = a.clientWidth, ch = a.clientHeight;
            const fit = (nwv && nhv && cw && ch) ? Math.min(cw / nwv, ch / nhv) : 0;
            return { cw, ch, nwv, nhv, fit, r };
        }
        function gzClamp() {
            const d = gzDims();
            if (!d.fit) { gz.tx = 0; gz.ty = 0; return; }
            const mx = Math.max(0, (d.nwv * d.fit * gz.s - d.cw) / 2);
            const my = Math.max(0, (d.nhv * d.fit * gz.s - d.ch) / 2);
            gz.tx = Math.min(mx, Math.max(-mx, gz.tx));
            gz.ty = Math.min(my, Math.max(-my, gz.ty));
        }
        function gzApply(animate) {
            const label = document.getElementById('galleryZoomLabel');
            const el = gz.el;
            if (!el || !el.isConnected) return;
            const d = gzDims();
            el.style.width = (d.r ? d.ch : d.cw) + 'px';
            el.style.height = (d.r ? d.cw : d.ch) + 'px';
            gzClamp();
            el.style.transition = animate ? 'transform .15s ease-out' : 'none';
            el.style.transform = `translate(${gz.tx}px, ${gz.ty}px) rotate(${gz.rot}deg) scale(${gz.s})`;
            el.style.cursor = gz.s > 1.001 ? (gzDragging ? 'grabbing' : 'grab') : 'default';
            if (label) label.textContent = Math.round((d.fit || 1) * gz.s * 100) + '%';
        }
        function gzAttach(el) {
            const key = activeGalleryFolderId + '|' + currentGalleryIndex;
            if (gz.key !== key) { gzReset(); gz.key = key; gz.nw = 0; gz.nh = 0; }
            gz.el = el;
            el.draggable = false;
            el.ondragstart = () => false;
            el.style.flex = 'none';
            el.style.maxWidth = 'none';
            el.style.userSelect = 'none';
            const onLoad = () => { gz.nw = el.naturalWidth; gz.nh = el.naturalHeight; gzApply(false); };
            el.addEventListener('load', onLoad);
            if (el.complete && el.naturalWidth) onLoad(); else gzApply(false);
        }
        // called on every render of the viewer: tools only for images
        function gzPrepare(item) {
            document.getElementById('galleryTools').classList.toggle('hidden', item.type === 'video');
            gzShowTools();
        }
        function gzSetScale(ns, px, py, animate) {
            if (!gz.el) return;
            ns = Math.min(GZ_MAX, Math.max(1, ns));
            const k = ns / gz.s;
            gz.tx = px - (px - gz.tx) * k;
            gz.ty = py - (py - gz.ty) * k;
            gz.s = ns;
            if (ns <= 1.0001) { gz.s = 1; gz.tx = 0; gz.ty = 0; }
            gzApply(animate);
        }
        function gzPoint(e) {
            const r = gzArea().getBoundingClientRect();
            return { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) };
        }
        function gzStep(dir) { gzSetScale(gz.s * (dir > 0 ? 1.25 : 0.8), 0, 0, true); }
        function gzFitView() { if (!gz.el) return; gz.s = 1; gz.tx = 0; gz.ty = 0; gzApply(true); }
        function gzActual() {
            if (!gz.el) return;
            const d = gzDims();
            if (!d.fit) return;
            const actual = Math.max(1, 1 / d.fit);
            if (Math.abs(gz.s - actual) < 0.02) gzFitView(); else gzSetScale(actual, 0, 0, true);
        }
        function gzRotate(dir) {
            if (!gz.el) return;
            gz.rot = (((gz.rot + dir * 90) % 360) + 360) % 360;
            gz.tx = 0; gz.ty = 0;
            gzApply(true);
        }
        function gzPan(dx, dy) { gz.tx += dx; gz.ty += dy; gzApply(true); }

        function gzShowTools() {
            const t = document.getElementById('galleryTools');
            t.classList.remove('opacity-0', 'pointer-events-none');
            clearTimeout(gzIdleTimer);
            gzIdleTimer = setTimeout(() => {
                if (!t.matches(':hover')) t.classList.add('opacity-0', 'pointer-events-none');
            }, 2500);
        }

        (function initGalleryZoom() {
            const area = gzArea();
            const modal = document.getElementById('galleryModal');
            modal.addEventListener('mousemove', gzShowTools);
            area.addEventListener('wheel', (e) => {
                if (!gz.el) return;
                e.preventDefault();
                const pt = gzPoint(e);
                const f = Math.min(1.4, Math.max(0.7, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018))));
                gzSetScale(gz.s * f, pt.x, pt.y, false);
            }, { passive: false });
            area.addEventListener('dblclick', (e) => {
                if (!gz.el || e.target !== gz.el) return;
                if (gz.s > 1.01) gzFitView();
                else { const pt = gzPoint(e); gzSetScale(2.5, pt.x, pt.y, true); }
            });
            area.addEventListener('pointerdown', (e) => {
                if (!gz.el || e.target !== gz.el) return;
                gzPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
                try { area.setPointerCapture(e.pointerId); } catch (_) {}
                if (gzPtrs.size === 2) {
                    const [a, b] = [...gzPtrs.values()];
                    gzPinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: gz.s };
                }
                gzDragging = gz.s > 1.001;
                gzApply(false);
            });
            area.addEventListener('pointermove', (e) => {
                const prev = gzPtrs.get(e.pointerId);
                if (!prev || !gz.el) return;
                const cur = { x: e.clientX, y: e.clientY };
                gzPtrs.set(e.pointerId, cur);
                if (gzPtrs.size === 2 && gzPinch) {
                    const [a, b] = [...gzPtrs.values()];
                    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
                    const r = area.getBoundingClientRect();
                    const mx = (a.x + b.x) / 2 - (r.left + r.width / 2), my = (a.y + b.y) / 2 - (r.top + r.height / 2);
                    gzSetScale(gzPinch.s * dist / gzPinch.d, mx, my, false);
                } else if (gzDragging) {
                    gz.tx += cur.x - prev.x; gz.ty += cur.y - prev.y;
                    gzApply(false);
                }
            });
            const end = (e) => {
                gzPtrs.delete(e.pointerId);
                if (gzPtrs.size < 2) gzPinch = null;
                if (gzPtrs.size === 0) { gzDragging = false; gzApply(false); }
            };
            area.addEventListener('pointerup', end);
            area.addEventListener('pointercancel', end);
            window.addEventListener('resize', () => gzApply(false));
            document.addEventListener('fullscreenchange', () => setTimeout(() => gzApply(false), 120));
            document.addEventListener('webkitfullscreenchange', () => setTimeout(() => gzApply(false), 120));

            ['load', 'loadedmetadata'].forEach(evn => area.addEventListener(evn, (e) => {
                const cur = currentGalleryItem();
                const t = e.target;
                if (!cur || !t || !t.tagName) return;
                if (t.tagName === 'IMG' && t.naturalWidth) { cur.item.w = t.naturalWidth; cur.item.h = t.naturalHeight; }
                else if (t.tagName === 'VIDEO' && t.videoWidth) { cur.item.w = t.videoWidth; cur.item.h = t.videoHeight; cur.item.dur = t.duration; }
                else return;
                document.getElementById('galleryItemDate').innerText = galleryInfoText(cur.item);
                persistSoon();
            }, true));

            // hotkey tooltips (site style)
            const tip = document.getElementById('gTip');
            modal.addEventListener('mouseover', (e) => {
                const el = e.target.closest('[data-gtip]');
                if (!el) return;
                tip.innerHTML = '<div class="font-medium"></div><div class="text-slate-400 mt-0.5"></div>';
                tip.firstChild.textContent = el.dataset.gtip;
                tip.lastChild.textContent = el.dataset.gkeys || '';
                tip.classList.remove('hidden');
                const r = el.getBoundingClientRect();
                const pos = el.dataset.gpos || 'below';
                let left, top;
                if (pos === 'left') { left = r.left - tip.offsetWidth - 10; top = r.top + r.height / 2 - tip.offsetHeight / 2; }
                else if (pos === 'right') { left = r.right + 10; top = r.top + r.height / 2 - tip.offsetHeight / 2; }
                else { left = r.left + r.width / 2 - tip.offsetWidth / 2; top = r.bottom + 8; }
                tip.style.left = Math.max(8, Math.min(left, window.innerWidth - tip.offsetWidth - 8)) + 'px';
                tip.style.top = Math.max(8, top) + 'px';
            });
            modal.addEventListener('mouseout', (e) => {
                const el = e.target.closest('[data-gtip]');
                if (el && !el.contains(e.relatedTarget)) tip.classList.add('hidden');
            });
            modal.addEventListener('click', () => tip.classList.add('hidden'));
        })();

        /* ====================================================================
           MULTI-SELECT + BULK TAGGING
           ==================================================================== */
        const selected = new Set();          // keys "folderId|index"
        let selAnchor = null;
        let selContext = '';
        let bulkMode = 'add';
        const bulkPick = new Set();          // tags picked as chips (lower-case keyed)

        function selKeyParts(key) { const i = key.lastIndexOf('|'); return { fid: key.slice(0, i), idx: +key.slice(i + 1) }; }
        function selFile(key) {
            const { fid, idx } = selKeyParts(key);
            const f = folders.find(x => String(x.id) === fid);
            return f && f.mediaFiles ? f.mediaFiles[idx] : null;
        }
        function selCards() { return [...document.querySelectorAll('#foldersContainer [data-sel]')]; }

        function refreshSelectionUi() {
            const n = selected.size;
            document.body.classList.toggle('sel-active', n > 0);
            selCards().forEach(card => {
                const on = selected.has(card.dataset.sel);
                card.classList.toggle('ring-2', on);
                card.classList.toggle('ring-indigo-500', on);
                const box = card.querySelector('.sel-box');
                if (box) {
                    box.classList.toggle('is-on', on);
                    box.classList.toggle('bg-indigo-600', on);
                    box.classList.toggle('bg-slate-900/70', !on);
                    box.firstElementChild.classList.toggle('hidden', !on);
                }
            });
            const bar = document.getElementById('selBar');
            bar.classList.toggle('hidden', n === 0);
            bar.classList.toggle('flex', n > 0);
            document.getElementById('selCount').textContent = `${n} მონიშნული`;
        }
        function clearSelection() { selected.clear(); selAnchor = null; refreshSelectionUi(); }
        function selectAllVisible() {
            if (_pagerAll) _pagerAll();
            selCards().forEach(c => selected.add(c.dataset.sel));
            refreshSelectionUi();
        }
        function toggleSelection(key, shift) {
            if (shift && selAnchor && selAnchor !== key) {
                const keys = selCards().map(c => c.dataset.sel);
                const a = keys.indexOf(selAnchor), b = keys.indexOf(key);
                if (a >= 0 && b >= 0) {
                    const [lo, hi] = a < b ? [a, b] : [b, a];
                    for (let i = lo; i <= hi; i++) selected.add(keys[i]);
                    selAnchor = key;
                    refreshSelectionUi();
                    return;
                }
            }
            if (selected.has(key)) selected.delete(key); else selected.add(key);
            selAnchor = key;
            refreshSelectionUi();
        }

        /* ---------- Favorites ---------- */
        function favCount() { let n = 0; folders.forEach(f => (f.mediaFiles || []).forEach(m => { if (m.fav) n++; })); return n; }
        function updateFavNav() {
            const el = document.getElementById('favNavCount');
            if (el) el.textContent = favCount();
            const a = document.getElementById('favNavLink');
            if (a) { const on = getCrit().fav && isSearchActive(); a.classList.toggle('text-indigo-600', !!on); }
        }
        function showFavorites(e) {
            if (e) e.preventDefault();
            currentParentId = null;
            setSearchInput('is:fav');
            runSearchNow();
            if (window.innerWidth < 768 && !document.getElementById('sidebar').classList.contains('-translate-x-full')) toggleMobileSidebar();
        }
        function favBtnClass(on, list) {
            return 'fav-btn flex-shrink-0 w-6 h-6 rounded-lg flex items-center justify-center text-[11px] cursor-pointer ' +
                (list ? 'bg-transparent mr-1 ' : 'bg-slate-900/70 absolute bottom-2 right-2 z-[1] ') + (on ? 'text-amber-400' : (list ? 'text-slate-300 dark:text-slate-600' : 'text-white/70'));
        }
        function paintFavButtons(key, on) {
            document.querySelectorAll('#foldersContainer .fav-btn').forEach(b => {
                if (b.dataset.key !== key) return;
                const list = b.dataset.list === '1';
                b.className = favBtnClass(on, list);
                b.title = on ? 'ფავორიტებიდან მოხსნა' : 'ფავორიტებში დამატება';
            });
        }
        async function toggleFavItem(folderId, idx) {
            const f = folders.find(x => x.id === folderId);
            const m = f && f.mediaFiles && f.mediaFiles[idx];
            if (!m) return;
            if (m.fav) delete m.fav; else m.fav = true;
            paintFavButtons(folderId + '|' + idx, !!m.fav);
            updateFavNav();
            updateGalleryFavBtn();
            await persistData();
            toast(m.fav ? 'დაემატა ფავორიტებში' : 'მოიხსნა ფავორიტებიდან', 1500);
        }
        function toggleFavCurrent() {
            const cur = currentGalleryItem();
            if (cur) toggleFavItem(cur.folder.id, currentGalleryIndex);
        }
        function updateGalleryFavBtn() {
            const b = document.getElementById('galleryFavBtn');
            if (!b) return;
            const cur = currentGalleryItem();
            const on = !!(cur && cur.item.fav);
            const i = b.querySelector('i');
            if (i) i.className = 'fa-solid fa-star' + (on ? ' text-amber-400' : '');
            const sp = b.querySelector('span');
            if (sp) sp.textContent = on ? 'ფავორიტია' : 'ფავორიტი';
        }

        /* ---------- notes (m.note): gallery button + hover card, shown on tiles, searchable ---------- */
        const NOTE = { editing: false, pinned: false, t: null };
        const noteEl = (id) => document.getElementById(id);
        const noteOpen = () => !noteEl('notePop').classList.contains('hidden');
        function noteCur() { const c = currentGalleryItem(); return c ? c.item : null; }
        function noteShow() {
            const it = noteCur(); if (!it) return;
            clearTimeout(NOTE.t);
            noteEl('noteText').textContent = it.note || '';
            noteEl('noteView').classList.toggle('hidden', NOTE.editing);
            noteEl('noteEditBox').classList.toggle('hidden', !NOTE.editing);
            noteEl('notePop').classList.remove('hidden');
        }
        function noteClose() { clearTimeout(NOTE.t); NOTE.editing = false; NOTE.pinned = false; noteEl('notePop').classList.add('hidden'); }
        function noteRefresh(reset) {
            if (reset) noteClose();
            const it = noteCur(); const b = noteEl('noteBtn'); if (!b) return;
            const has = !!(it && it.note);
            const i = b.querySelector('i'); if (i) i.className = 'fa-solid fa-note-sticky' + (has ? ' text-amber-300' : '');
            const sp = b.querySelector('span'); if (sp) sp.textContent = has ? 'ნოუთი ✓' : 'ნოუთი';
            if (has) b.removeAttribute('data-gtip'); else b.setAttribute('data-gtip', 'ნოუთის დაწერა');
        }
        function noteEdit() {
            const it = noteCur(); if (!it) return;
            NOTE.editing = true; noteShow();
            const ta = noteEl('noteInput'); ta.value = it.note || ''; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
        }
        function noteBtnClick() {
            const it = noteCur(); if (!it) return;
            if (!it.note) { noteEdit(); return; }
            if (noteOpen() && NOTE.pinned) { noteClose(); return; }
            NOTE.pinned = true; noteShow();
        }
        function noteCancel() { noteClose(); }
        async function noteSave() {
            const it = noteCur(); if (!it) return;
            const v = noteEl('noteInput').value.trim();
            if (v) it.note = v; else delete it.note;
            noteClose(); noteRefresh(); await persistData(); toast(v ? 'ნოუთი შენახულია' : 'ნოუთი წაიშალა', 1500);
        }
        function noteDelete() {
            const it = noteCur(); if (!it || !it.note) return;
            const old = it.note; delete it.note; noteClose(); noteRefresh(); persistData();
            pushUndo('ნოუთი წაიშალა', () => { it.note = old; noteRefresh(); });
        }
        (function () {
            const w = noteEl('noteWrap'); if (!w) return;
            w.addEventListener('mouseenter', () => { const it = noteCur(); if (it && it.note && !NOTE.editing && window.matchMedia('(hover:hover)').matches) noteShow(); });
            w.addEventListener('mouseleave', () => { if (NOTE.editing || NOTE.pinned) return; clearTimeout(NOTE.t); NOTE.t = setTimeout(() => { if (!NOTE.editing && !NOTE.pinned) noteEl('notePop').classList.add('hidden'); }, 250); });
            noteEl('noteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); noteSave(); } });
            document.addEventListener('mousedown', (e) => { if (noteOpen() && !NOTE.editing && !w.contains(e.target)) noteClose(); });
        })();
        // small note badge on tiles; its tooltip is the note itself
        function decorateNotes() {
            selCards().forEach(card => {
                const [fid, idxS] = card.dataset.sel.split('|');
                const f = folders.find(x => x.id === fid);
                const m = f && f.mediaFiles && f.mediaFiles[+idxS];
                let b = card.querySelector('.note-badge');
                if (!m || !m.note) { if (b) b.remove(); return; }
                const list = !card.classList.contains('flex-col');
                if (!b) {
                    b = document.createElement('span');
                    b.className = 'note-badge flex-shrink-0 w-6 h-6 rounded-lg flex items-center justify-center text-[11px] ' + (list ? 'text-amber-500 mr-1' : 'bg-slate-900/70 text-amber-300 absolute bottom-2 right-10 z-[1]');
                    b.innerHTML = '<i class="fa-solid fa-note-sticky"></i>';
                    if (list) card.lastElementChild.prepend(b); else (card.firstElementChild || card).appendChild(b);
                }
                b.title = m.note;
            });
        }
        function decorateFav() {
            selCards().forEach(card => {
                if (card.querySelector('.fav-btn')) return;
                const [fid, idxS] = card.dataset.sel.split('|');
                const f = folders.find(x => x.id === fid);
                const m = f && f.mediaFiles && f.mediaFiles[+idxS];
                if (!m) return;
                const list = !card.classList.contains('flex-col');
                const b = document.createElement('button');
                b.type = 'button';
                b.dataset.key = card.dataset.sel; b.dataset.list = list ? '1' : '0';
                b.className = favBtnClass(!!m.fav, list);
                b.title = m.fav ? 'ფავორიტებიდან მოხსნა' : 'ფავორიტებში დამატება';
                b.innerHTML = '<i class="fa-solid fa-star"></i>';
                b.onclick = (ev) => { ev.stopPropagation(); toggleFavItem(fid, +idxS); };
                if (list) card.lastElementChild.prepend(b);
                else (card.firstElementChild || card).appendChild(b);
            });
        }

        // called after every render: add checkboxes, reset selection when the view changes
        function decorateSelectable() {
            const ctx = [currentParentId, currentFilter, currentSearchQuery, sortMode].join('¦');
            if (ctx !== selContext) { selContext = ctx; selected.clear(); selAnchor = null; }
            const present = new Set();
            selCards().forEach(card => {
                present.add(card.dataset.sel);
                if (card.querySelector('.sel-box')) return;
                card.classList.add('sel-card');
                const box = document.createElement('button');
                box.type = 'button';
                box.title = 'მონიშვნა (Shift — დიაპაზონი)';
                const list = !card.classList.contains('flex-col');
                box.className = 'sel-box flex-shrink-0 w-6 h-6 rounded-lg border border-white/70 text-white flex items-center justify-center text-[11px] cursor-pointer bg-slate-900/70 ' + (list ? 'mr-1' : 'absolute top-2 left-2 z-[1]');
                box.innerHTML = '<i class="fa-solid fa-check hidden"></i>';
                if (list) {
                    box.classList.add('border-slate-300', 'dark:border-slate-600');
                    card.firstElementChild.prepend(box);
                } else {
                    card.classList.add('relative');
                    card.appendChild(box);
                }
            });
            [...selected].forEach(k => { if (!present.has(k)) selected.delete(k); });
            refreshSelectionUi();
        }
        // touch: press and hold a tile to start selecting
        (function () {
            const c = document.getElementById('foldersContainer');
            let timer = null, sx = 0, sy = 0, fired = false;
            const cancel = () => clearTimeout(timer);
            c.addEventListener('pointerdown', (e) => {
                if (e.pointerType === 'mouse') return;
                const card = e.target.closest('[data-sel]');
                if (!card || e.target.closest('button:not(.sel-box), a, input')) return;
                fired = false; sx = e.clientX; sy = e.clientY; cancel();
                timer = setTimeout(() => { fired = true; toggleSelection(card.dataset.sel, false); if (navigator.vibrate) { try { navigator.vibrate(15); } catch (x) {} } }, 420);
            });
            c.addEventListener('pointermove', (e) => { if (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8) cancel(); });
            ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => c.addEventListener(t, cancel));
            c.addEventListener('click', (e) => { if (fired) { fired = false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
            c.addEventListener('contextmenu', (e) => { if (IS_TOUCH && e.target.closest('[data-sel]')) e.preventDefault(); });
        })();
        document.getElementById('foldersContainer').addEventListener('click', (e) => {
            const card = e.target.closest('[data-sel]');
            if (!card) return;
            const onBox = e.target.closest('.sel-box');
            if (onBox || selected.size > 0 || e.ctrlKey || e.metaKey || e.shiftKey) {
                if (e.target.closest('button:not(.sel-box), a, input')) return;
                e.preventDefault();
                e.stopPropagation();
                toggleSelection(card.dataset.sel, e.shiftKey);
                if (e.shiftKey) { const sl = window.getSelection && window.getSelection(); if (sl) sl.removeAllRanges(); }
            }
        }, true);
        document.addEventListener('keydown', (e) => {
            const open = (id) => { const m = document.getElementById(id); return m && !m.classList.contains('hidden'); };
            if (open('galleryModal') || open('tagModal') || open('bulkTagModal') || open('folderModal') || open('categoryModal') || open('tagsModal')) return;
            const tag = (e.target && e.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (e.key === 'Escape' && selected.size) { e.preventDefault(); clearSelection(); }
            else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA' && selCards().length) { e.preventDefault(); selectAllVisible(); }
        });

        /* ---------- bulk tag dialog ---------- */
        function bulkInputTags() {
            return document.getElementById('bulkTagInput').value.split(',').map(t => t.trim()).filter(Boolean);
        }
        function openBulkTag(mode) {
            if (!selected.size) return;
            bulkMode = mode;
            bulkPick.clear();
            const n = selected.size;
            document.getElementById('bulkTagTitle').textContent = mode === 'add' ? `ტეგის დამატება — ${n} ფაილი` : `ტეგის მოხსნა — ${n} ფაილი`;
            document.getElementById('bulkTagInputWrap').classList.toggle('hidden', mode !== 'add');
            document.getElementById('bulkTagInput').value = '';
            const ap = document.getElementById('bulkTagApply');
            ap.textContent = mode === 'add' ? 'დამატება' : 'მოხსნა';
            ap.className = 'px-5 py-2 text-white rounded-xl text-sm font-medium transition cursor-pointer ' + (mode === 'add' ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-rose-600 hover:bg-rose-700');
            renderBulkChips();
            const m = document.getElementById('bulkTagModal');
            m.classList.remove('hidden'); m.classList.add('flex');
            if (mode === 'add') document.getElementById('bulkTagInput').focus();
        }
        function closeBulkTag() {
            const m = document.getElementById('bulkTagModal');
            m.classList.remove('flex'); m.classList.add('hidden');
        }
        function renderBulkChips() {
            const box = document.getElementById('bulkChips');
            const label = document.getElementById('bulkChipsLabel');
            box.innerHTML = '';
            let list;
            if (bulkMode === 'add') {
                label.textContent = 'არსებული ტეგები — დააჭირეთ დასამატებლად';
                list = getSortedTags().map(t => ({ tag: t.tag, info: String(t.count) }));
            } else {
                label.textContent = 'მონიშნულ ფაილებზე არსებული ტეგები — აირჩიეთ მოსახსნელი';
                const counts = new Map();
                selected.forEach(k => {
                    const f = selFile(k);
                    new Set((f && f.tags || []).map(t => t.trim()).filter(Boolean)).forEach(t => counts.set(t, (counts.get(t) || 0) + 1));
                });
                list = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ka')).map(([tag, c]) => ({ tag, info: `${c}/${selected.size}` }));
            }
            if (!list.length) { box.innerHTML = '<div class="text-sm text-slate-400">ტეგები არ არის</div>'; return; }
            const inInput = new Set(bulkInputTags().map(t => t.toLowerCase()));
            list.forEach(({ tag, info }) => {
                const on = bulkMode === 'add' ? inInput.has(tag.toLowerCase()) : bulkPick.has(tag.toLowerCase());
                const b = document.createElement('button');
                b.type = 'button';
                const color = on ? (bulkMode === 'add' ? 'bg-indigo-600 text-white' : 'bg-rose-600 text-white') : 'bg-indigo-50 dark:bg-indigo-950 hover:bg-indigo-100 dark:hover:bg-indigo-900 text-indigo-600 dark:text-indigo-300';
                b.className = 'inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-xl transition cursor-pointer ' + color;
                b.innerHTML = '<i class="fa-solid fa-tag text-[11px]"></i><span></span><span class="text-xs opacity-70"></span>';
                b.children[1].textContent = tag;
                b.children[2].textContent = info;
                b.onclick = () => {
                    if (bulkMode === 'add') {
                        const cur = bulkInputTags();
                        const i = cur.findIndex(t => t.toLowerCase() === tag.toLowerCase());
                        if (i >= 0) cur.splice(i, 1); else cur.push(tag);
                        document.getElementById('bulkTagInput').value = cur.join(', ');
                    } else {
                        const k = tag.toLowerCase();
                        if (bulkPick.has(k)) bulkPick.delete(k); else bulkPick.add(k);
                    }
                    renderBulkChips();
                };
                box.appendChild(b);
            });
        }
        function syncBulkChips() { if (bulkMode === 'add') renderBulkChips(); }
        function applyBulkTag() {
            const keys = [...selected];
            let changed = 0, tags;
            if (bulkMode === 'add') {
                tags = bulkInputTags();
                if (!tags.length) { toast('ჩაწერეთ ტეგი'); return; }
                keys.forEach(k => {
                    const f = selFile(k);
                    if (!f) return;
                    f.tags = Array.isArray(f.tags) ? f.tags : [];
                    const have = new Set(f.tags.map(t => t.toLowerCase()));
                    let touched = false;
                    tags.forEach(t => { if (!have.has(t.toLowerCase())) { f.tags.push(t); have.add(t.toLowerCase()); touched = true; } });
                    if (touched) changed++;
                });
            } else {
                if (!bulkPick.size) { toast('აირჩიეთ მოსახსნელი ტეგი'); return; }
                keys.forEach(k => {
                    const f = selFile(k);
                    if (!f || !Array.isArray(f.tags)) return;
                    const before = f.tags.length;
                    f.tags = f.tags.filter(t => !bulkPick.has(t.trim().toLowerCase()));
                    if (f.tags.length !== before) changed++;
                });
            }
            closeBulkTag();
            persistData();
            renderFolders();
            toast(bulkMode === 'add' ? `ტეგი დაემატა ${changed} ფაილს (${keys.length}-დან)` : `ტეგი მოიხსნა ${changed} ფაილიდან (${keys.length}-დან)`);
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !document.getElementById('bulkTagModal').classList.contains('hidden')) { e.preventDefault(); closeBulkTag(); }
        });

        /* ====================================================================
           FILE DATE / SIZE / SORTING / INFO
           ==================================================================== */
        function fmtDate(ms) {
            const d = new Date(ms);
            if (!ms || isNaN(d)) return '';
            const p = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
        }
        function fmtSize(b) {
            if (!b) return '';
            const u = ['B', 'KB', 'MB', 'GB'];
            let i = 0, v = b;
            while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
            return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + u[i];
        }
        function fmtDur(sec) {
            if (!sec || !isFinite(sec)) return '';
            const t = Math.round(sec), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s2 = t % 60;
            const p = n => String(n).padStart(2, '0');
            return h ? `${h}:${p(m)}:${p(s2)}` : `${m}:${p(s2)}`;
        }
        function fileDateMs(f) {
            if (f.taken) return f.taken;
            if (f.mtime) return f.mtime;
            const t = Date.parse(String(f.date || '').replace(' ', 'T'));
            return isNaN(t) ? 0 : t;
        }
        function fileDateStr(f) { return f.taken ? fmtDate(f.taken) : (f.mtime ? fmtDate(f.mtime) : (f.date || '')); }
        function galleryInfoText(f) {
            const parts = [];
            const d = fileDateStr(f);
            if (d) parts.push(f.taken ? 'გადაღება ' + d : d);
            if (f.size) parts.push(fmtSize(f.size));
            if (f.w && f.h) parts.push(`${f.w}×${f.h}`);
            if (f.type === 'video' && f.dur) parts.push(fmtDur(f.dur));
            return parts.join(' · ');
        }
        let _persistTimer = null;
        function persistSoon() { clearTimeout(_persistTimer); _persistTimer = setTimeout(() => persistData(), 1500); }

        let sortMode = 'natural';
        try { sortMode = localStorage.getItem('avma_sort') || 'natural'; } catch (e) {}
        const _nameCmp = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ka', { numeric: true, sensitivity: 'base' });
        function fileComparator() {
            switch (sortMode) {
                case 'name-asc': return _nameCmp;
                case 'name-desc': return (a, b) => _nameCmp(b, a);
                case 'date-desc': return (a, b) => fileDateMs(b) - fileDateMs(a) || _nameCmp(a, b);
                case 'date-asc': return (a, b) => fileDateMs(a) - fileDateMs(b) || _nameCmp(a, b);
                case 'size-desc': return (a, b) => (b.size || 0) - (a.size || 0) || _nameCmp(a, b);
                case 'size-asc': return (a, b) => (a.size || 0) - (b.size || 0) || _nameCmp(a, b);
                case 'type': return (a, b) => String(a.type).localeCompare(String(b.type)) || _nameCmp(a, b);
                default: return (a, b) => (a.path && b.path) ? a.path.join('/').localeCompare(b.path.join('/'), undefined, { numeric: true }) : 0;
            }
        }
        function sortFiles(arr) { arr.sort(fileComparator()); return arr; }
        function setSortMode(v) {
            sortMode = v;
            try { localStorage.setItem('avma_sort', v); } catch (e) {}
            renderFolders();
        }
        function updateSortUi() {
            const sel = document.getElementById('sortSelect');
            if (!sel) return;
            sel.value = sortMode;
            sel.classList.toggle('hidden', !(currentParentId !== null || isSearchActive()));
        }

        /* ====================================================================
           RESCAN: refresh an imported folder from disk (keeps tags, adds new, drops missing)
           ==================================================================== */
        /* ---------- capture date: EXIF (JPEG / PNG / WebP) and MP4 / MOV creation time ---------- */
        const TAKEN_MIN = Date.UTC(1995, 0, 1);
        function takenOk(ms) { return ms >= TAKEN_MIN && ms <= Date.now() + 864e5; }
        function exifStrToMs(str) {
            const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str || '');
            if (!m || m[1] === '0000') return 0;
            const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
            return takenOk(ms) ? ms : 0;
        }
        // DateTimeOriginal (0x9003) > DateTimeDigitized (0x9004) > DateTime (0x0132)
        function tiffTakenDate(dv, base) {
            if (base < 0 || base + 8 > dv.byteLength) return 0;
            const bo = dv.getUint16(base);
            const le = bo === 0x4949;
            if (!le && bo !== 0x4D4D) return 0;
            const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
            if (u16(base + 2) !== 42) return 0;
            const str = (e) => {
                const type = u16(e + 2), cnt = u32(e + 4);
                if (type !== 2 || cnt < 19 || cnt > 64) return '';
                const vo = cnt > 4 ? base + u32(e + 8) : e + 8;
                if (vo < 0 || vo + cnt > dv.byteLength) return '';
                let t = '';
                for (let i = 0; i < cnt; i++) { const c = dv.getUint8(vo + i); if (!c) break; t += String.fromCharCode(c); }
                return t;
            };
            const scan = (ifdOff, wanted) => {
                const out = {};
                const o = base + ifdOff;
                if (ifdOff < 8 || o + 2 > dv.byteLength) return out;
                const n = u16(o);
                for (let i = 0; i < n && i < 300; i++) {
                    const e = o + 2 + i * 12;
                    if (e + 12 > dv.byteLength) break;
                    const tag = u16(e);
                    if (wanted.includes(tag)) out[tag] = e;
                }
                return out;
            };
            const ifd0 = scan(u32(base + 4), [0x0132, 0x8769]);
            let ms = 0;
            if (ifd0[0x8769]) {
                const sub = scan(u32(ifd0[0x8769] + 8), [0x9003, 0x9004]);
                if (sub[0x9003]) ms = exifStrToMs(str(sub[0x9003]));
                if (!ms && sub[0x9004]) ms = exifStrToMs(str(sub[0x9004]));
            }
            if (!ms && ifd0[0x0132]) ms = exifStrToMs(str(ifd0[0x0132]));
            return ms;
        }
        async function mp4TakenDate(file) {
            const size = file.size;
            let o = 0;
            for (let i = 0; i < 64 && o + 8 <= size; i++) {
                const h = new DataView(await file.slice(o, o + 16).arrayBuffer());
                if (h.byteLength < 8) return 0;
                let bs = h.getUint32(0);
                const type = h.getUint32(4);
                let hdr = 8;
                if (bs === 1) { if (h.byteLength < 16) return 0; bs = h.getUint32(8) * 4294967296 + h.getUint32(12); hdr = 16; }
                else if (bs === 0) bs = size - o;
                if (bs < hdr) return 0;
                if (type === 0x6D6F6F76) {                       // 'moov'
                    const len = Math.min(bs - hdr, 4 * 1024 * 1024);
                    const dv = new DataView(await file.slice(o + hdr, o + hdr + len).arrayBuffer());
                    let p = 0;
                    while (p + 8 <= dv.byteLength) {
                        const cs = dv.getUint32(p), ct = dv.getUint32(p + 4);
                        if (cs < 8) break;
                        if (ct === 0x6D766864) {                 // 'mvhd'
                            const ver = dv.getUint8(p + 8);
                            const secs = ver === 1 ? dv.getUint32(p + 12) * 4294967296 + dv.getUint32(p + 16) : dv.getUint32(p + 12);
                            if (!secs) return 0;
                            const ms = (secs - 2082844800) * 1000;   // 1904 -> 1970 epoch
                            return takenOk(ms) ? ms : 0;
                        }
                        p += cs;
                    }
                    return 0;
                }
                o += bs;
            }
            return 0;
        }
        async function readExifWith(file, type, name, parse) {
            try {
                if (type === 'video') return 0;
                const head = new DataView(await file.slice(0, 262144).arrayBuffer());
                const len = head.byteLength;
                if (len < 12) return 0;
                if (head.getUint16(0) === 0xFFD8) {                                   // JPEG: APP1 "Exif"
                    let o = 2;
                    while (o + 4 <= len) {
                        const mk = head.getUint16(o);
                        if ((mk & 0xFF00) !== 0xFF00 || mk === 0xFFDA || mk === 0xFFD9) break;
                        if (mk === 0xFFD8 || (mk >= 0xFFD0 && mk <= 0xFFD7) || mk === 0xFF01) { o += 2; continue; }
                        if (mk === 0xFFE1 && o + 10 <= len && head.getUint32(o + 4) === 0x45786966) return parse(head, o + 10);
                        o += 2 + head.getUint16(o + 2);
                    }
                    return 0;
                }
                if (head.getUint32(0) === 0x89504E47) {                               // PNG: eXIf chunk before the image data
                    let o = 8;
                    while (o + 12 <= len) {
                        const cl = head.getUint32(o), ct = head.getUint32(o + 4);
                        if (ct === 0x65584966) { const b = o + 8; return b + cl <= len ? parse(head, b) : 0; }
                        if (ct === 0x49444154) break;
                        o += 12 + cl;
                    }
                    return 0;
                }
                if (head.getUint32(0) === 0x52494646 && head.getUint32(8) === 0x57454250) {   // WebP: RIFF chunks, EXIF is usually after the image data
                    let o = 12;
                    for (let i = 0; i < 40 && o + 8 <= file.size; i++) {
                        const h = new DataView(await file.slice(o, o + 8).arrayBuffer());
                        const id = h.getUint32(0), sz = h.getUint32(4, true);
                        if (id === 0x45584946) {                                         // 'EXIF'
                            const dv = new DataView(await file.slice(o + 8, o + 8 + Math.min(sz, 65536)).arrayBuffer());
                            return parse(dv, dv.byteLength > 6 && dv.getUint32(0) === 0x45786966 ? 6 : 0);
                        }
                        o += 8 + sz + (sz & 1);
                    }
                }
                return 0;
            } catch (e) { return 0; }
        }
        async function readTakenDate(file, type, name) {
            if (type === 'video') { try { return /\.(mp4|mov)$/i.test(name || '') ? await mp4TakenDate(file) : 0; } catch (e) { return 0; } }
            return readExifWith(file, type, name, tiffTakenDate);
        }
        const exifCapable = (m) => (m.type === 'image' && /\.(jpe?g|webp|png)$/i.test(m.name || '')) || (m.type === 'video' && /\.(mp4|mov)$/i.test(m.name || ''));

        const backfillTried = new WeakSet();
        let backfillBusy = false, _bfTimer = null;
        function scheduleBackfill() { clearTimeout(_bfTimer); _bfTimer = setTimeout(backfillMeta, 700); }
        async function backfillMeta() {
            if (backfillBusy) return;
            if (_queue.length || _active) { clearTimeout(_bfTimer); _bfTimer = setTimeout(backfillMeta, 1500); return; }   // thumbnails first
            const jobs = [];
            folders.forEach(f => {
                if (!f.rootId) return;
                const live = rootHandles.has(f.rootId) && accessGranted.has(f.rootId);
                (f.mediaFiles || []).forEach(m => {
                    if (!m.local || !m.path || backfillTried.has(m)) return;
                    if (!(!m.mtime || ((m.exifChecked !== 1 || m.gpsChecked !== 1) && exifCapable(m)))) return;
                    if (!live && !sessionFiles.has(f.rootId + '|' + m.path.join('/'))) return;
                    jobs.push({ f, m });
                });
            });
            if (!jobs.length) return;
            backfillBusy = true;
            let i = 0, done = 0, withTaken = 0;
            const worker = async () => {
                while (i < jobs.length) {
                    const { f, m } = jobs[i++];
                    backfillTried.add(m);
                    try {
                        const file = await resolveFile(f, m);
                        if (!m.mtime) { m.mtime = file.lastModified; m.size = file.size; m.date = fmtDate(m.mtime) || m.date; }
                        if (m.exifChecked !== 1 && exifCapable(m)) {
                            const t = await readTakenDate(file, m.type, m.name);
                            if (t) { m.taken = t; withTaken++; } else delete m.taken;
                            m.exifChecked = 1;
                        }
                        if (m.gpsChecked !== 1 && exifCapable(m) && typeof window.readGps === 'function') {
                            const g = await window.readGps(file, m.type, m.name);
                            if (g) m.gps = g; else delete m.gps;
                            m.gpsChecked = 1;
                        }
                        done++;
                    } catch (e) { /* missing / no access: tried once per session */ }
                }
            };
            try { await Promise.all(Array.from({ length: IS_TOUCH ? 2 : 6 }, worker)); }
            finally { backfillBusy = false; }
            if (done) {
                await persistData();
                renderFolders();
                toast(`ფაილების მონაცემები განახლდა: ${done}` + (withTaken ? ` (გადაღების თარიღი: ${withTaken})` : ''), 4000);
            }
        }

        let rescanBusy = false;
        function refreshFolder(folderId) {
            const f = folders.find(x => x.id === folderId);
            if (!f || !f.rootId) return;
            if (!FSA) { toast('განახლება მხოლოდ Chrome ან Edge-შია შესაძლებელი'); return; }
            if (rescanBusy) return;
            const R = f.rootId;
            const h = rootHandles.get(R);
            if (!h) { relinkFolder(folderId); return; }
            rescanBusy = true;
            // must start inside the click so the permission prompt is allowed
            requestAccess(R).then(ok => {
                if (!ok) { toast('საქაღალდეზე წვდომა არ დადასტურდა'); return; }
                accessGranted.add(R);
                return rescanRoot(R, h);
            }).catch(e => {
                console.error(e);
                toast('განახლება ვერ მოხერხდა: ' + (e.message || e.name));
            }).finally(() => { rescanBusy = false; });
        }
        async function rescanRoot(R, handle) {
            const rootF = folders.find(f => f.id === R);
            if (!rootF) { toast('ძირითადი საქაღალდე ვერ მოიძებნა'); return; }
            toast('სკანირება...', 0);
            const entries = [];
            await walkDir(handle, [], entries);
            if (entries.failed) {
                toast(`სკანირება არასრულია („${entries.failedPaths[0]}“ ვერ წაიკითხა) — ცვლილება არ გამოყენებულა`, 8000);
                return;
            }

            const group = folders.filter(f => f.rootId === R);
            const segMap = new Map();      // first path segment -> folder
            group.forEach(f => {
                if (f === rootF) return;
                const first = (f.mediaFiles || []).find(m => m.path && m.path.length > 1);
                segMap.set(f.subKey || (first ? first.path[0] : f.name), f);
            });
            const existing = new Map();    // path key -> { folder, file }
            group.forEach(f => (f.mediaFiles || []).forEach(m => { if (m.local && m.path) existing.set(m.path.join('/'), { folder: f, file: m }); }));

            const seen = new Set(), added = [], entryByKey = new Map();
            let changed = 0;
            for (const e of entries) {
                const key = e.path.join('/');
                seen.add(key); entryByKey.set(key, e);
                const ex = existing.get(key);
                if (!ex) { added.push(e); continue; }
                const m = ex.file;
                if (m.mtime && (m.mtime !== e.mtime || m.size !== e.size)) { changed++; delete m.w; delete m.h; delete m.dur; delete m.taken; delete m.exifChecked; backfillTried.delete(m); }
                m.mtime = e.mtime; m.size = e.size; m.date = fmtDate(e.mtime) || m.date;
            }
            const removedKeys = [...existing.keys()].filter(k => !seen.has(k));

            if (removedKeys.length) {
                const withTags = removedKeys.filter(k => (existing.get(k).file.tags || []).length).length;
                const none = entries.length === 0 ? '\n\nსაქაღალდეში მედია ფაილი საერთოდ ვერ მოიძებნა — შეამოწმეთ, რომ სწორი დისკი/საქაღალდეა მიერთებული.' : '';
                const go = await choiceDialog('საქაღალდის განახლება',
                    `ახალი ფაილი: ${added.length}\nდისკზე ვეღარ მოიძებნა: ${removedKeys.length}` + (withTags ? ` (მათგან ${withTags}-ს ტეგი აქვს და ტეგები დაიკარგება)` : '') + none + '\n\nგავაგრძელო?',
                    [{ label: 'გაუქმება', value: false }, { label: 'განახლება', value: true, primary: true }]);
                if (!go) { toast('განახლება გაუქმდა'); return; }
            }

            // removals
            const dead = new Set(removedKeys.map(k => existing.get(k).file));
            group.forEach(f => { if (f.mediaFiles && f.mediaFiles.some(m => dead.has(m))) f.mediaFiles = f.mediaFiles.filter(m => !dead.has(m)); });

            // additions
            const nowStr = fmtDate(Date.now());
            const newSubs = [];
            for (const e of added) {
                const name = e.path[e.path.length - 1];
                const meta = { type: e.type, name, date: fmtDate(e.mtime) || nowStr, mtime: e.mtime || 0, size: e.size || 0, tags: [], local: true, path: e.path };
                let target = rootF;
                if (e.path.length > 1) {
                    const seg = e.path[0];
                    target = segMap.get(seg);
                    if (!target) {
                        target = {
                            id: R + '_' + Math.random().toString(36).substr(2, 5), rootId: R, parentId: R,
                            name: seg, subKey: seg, link: joinPath(rootF.link || '', seg), image: '',
                            category: rootF.category, photosCount: 0, videosCount: 0, mediaFiles: []
                        };
                        folders.push(target); segMap.set(seg, target); newSubs.push(target);
                    }
                }
                target.mediaFiles = target.mediaFiles || [];
                target.mediaFiles.push(meta);
            }

            // subfolders that lost all their files (and have no children of their own) are dropped
            const emptied = folders.filter(f => f.rootId === R && f !== rootF && f.parentId === R && !(f.mediaFiles || []).length && !folders.some(c => c.parentId === f.id));
            if (emptied.length) {
                const gone = new Set(emptied);
                folders = folders.filter(f => !gone.has(f));
                if (currentParentId && !folders.some(f => f.id === currentParentId)) currentParentId = null;
            }

            // counts
            const count = (list) => ({ ph: list.filter(m => m.type === 'image').length, vi: list.filter(m => m.type === 'video').length });
            let rp = 0, rv = 0;
            folders.filter(f => f.rootId === R).forEach(f => {
                const c = count(f.mediaFiles || []);
                f.photosCount = c.ph; f.videosCount = c.vi;
                if (f === rootF || f.parentId === R) { rp += c.ph; rv += c.vi; }
            });
            rootF.photosCount = rp; rootF.videosCount = rv;

            // covers for folders that have none yet
            const needCover = folders.filter(f => f.rootId === R && !f.image && (f.mediaFiles || []).some(m => m.type === 'image' && m.path));
            if (needCover.length) toast('ქავერების მომზადება...', 0);
            for (const f of needCover) {
                const first = f.mediaFiles.find(m => m.type === 'image' && m.path);
                const en = entryByKey.get(first.path.join('/'));
                if (en) f.image = await makeCover(en);
            }

            clearSelection();
            await persistData();
            renderFolders();
            if (!added.length && !removedKeys.length && !changed) toast('ცვლილება არ არის — ყველაფერი განახლებულია', 4000);
            else toast(`განახლდა: +${added.length} ახალი, −${removedKeys.length} წაშლილი` + (changed ? `, ${changed} შეცვლილი` : '') + (newSubs.length ? `, +${newSubs.length} ქვესაქაღალდე` : '') + (emptied.length ? `, −${emptied.length} ქვესაქაღალდე` : ''), 6000);
        }

        /* ---------- Fullscreen ---------- */
        function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
        function toggleFullscreen() {
            try {
                if (isFullscreen()) {
                    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
                } else {
                    const el = document.documentElement;
                    const req = el.requestFullscreen || el.webkitRequestFullscreen;
                    if (!req) { toast('ეს ბრაუზერი სრულ ეკრანს ვერ უჭერს მხარს'); return; }
                    const r = req.call(el);
                    if (r && r.catch) r.catch(err => toast('სრული ეკრანი ვერ ჩაირთო: ' + err.message));
                }
            } catch (e) { console.warn(e); }
        }
        function syncFullscreenUi() {
            const fs = isFullscreen();
            document.querySelectorAll('.fs-icon').forEach(i => {
                i.classList.toggle('fa-expand', !fs);
                i.classList.toggle('fa-compress', fs);
            });
            const gm = document.getElementById('galleryModal');
            if (gm) gm.classList.toggle('is-fs', fs);
        }
        document.addEventListener('fullscreenchange', syncFullscreenUi);
        document.addEventListener('webkitfullscreenchange', syncFullscreenUi);

        /* ---------- File actions menu (click on gallery title) ---------- */
        function setGalleryTitle(text) {
            const el = document.getElementById('galleryItemTitle');
            el.textContent = text;
            el.title = 'ფაილის მოქმედებები';
            el.classList.add('cursor-pointer', 'hover:underline', 'decoration-dotted', 'underline-offset-4');
            const caret = document.createElement('i');
            caret.className = 'fa-solid fa-chevron-down text-[10px] ml-2 text-slate-400';
            el.appendChild(caret);
        }
        function fileMenuEl() { return document.getElementById('fileMenu'); }
        function fileMenuOpen() { return !fileMenuEl().classList.contains('hidden'); }
        function closeFileMenu() { fileMenuEl().classList.add('hidden'); }

        function normalizeLinkBase(link) {
            let l = (link || '').trim();
            if (/^file:\/\//i.test(l)) {
                l = decodeURI(l.replace(/^file:\/\/\/?/i, ''));
                l = /^[A-Za-z]:/.test(l) ? l.replace(/\//g, '\\') : '/' + l;
            }
            return l.replace(/[\\/]+$/, '');
        }
        function getLocalFilePath(folder, file) {
            if (!file.local) return '';
            const root = folders.find(f => f.id === folder.rootId);
            const base = normalizeLinkBase((root || folder).link);
            if (!base) return '';
            const sep = (base.includes('/') && !base.includes('\\')) ? '/' : '\\';
            return base + sep + file.path.join(sep);
        }
        function pathToFileUrl(p) {
            const parts = p.replace(/\\/g, '/').split('/').map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg)) ? seg : encodeURIComponent(seg));
            const joined = parts.join('/');
            if (/^[A-Za-z]:/.test(p)) return 'file:///' + joined;
            if (joined.startsWith('//')) return 'file:' + joined;
            return 'file://' + joined;
        }
        async function copyText(t) {
            try { await navigator.clipboard.writeText(t); return true; }
            catch (e) {
                const ta = document.createElement('textarea');
                ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                let ok = false;
                try { ok = document.execCommand('copy'); } catch (_) {}
                ta.remove();
                return ok;
            }
        }
        async function fileToPngBlob(f) {
            if (f.type === 'image/png') return f;
            const bmp = await createImageBitmap(f);
            const c = document.createElement('canvas');
            c.width = bmp.width; c.height = bmp.height;
            c.getContext('2d').drawImage(bmp, 0, 0);
            if (bmp.close) bmp.close();
            return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('PNG')), 'image/png'));
        }
        function currentGalleryItem() {
            const folder = folders.find(f => f.id === activeGalleryFolderId);
            const item = folder && folder.mediaFiles && folder.mediaFiles[currentGalleryIndex];
            return item ? { folder, item } : null;
        }
        function actionError(folder, e) {
            if (e && e.name === 'AbortError') return;
            console.warn(e);
            if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
                toast('საქაღალდეზე წვდომა უნდა დადასტურდეს, შემდეგ ცადეთ ხელახლა');
                reauthorize(folder.id);
            } else if (e && e.name === 'NotFoundError') {
                toast('ფაილი დისკზე ვერ მოიძებნა');
            } else {
                toast('ვერ შესრულდა: ' + ((e && (e.message || e.name)) || 'შეცდომა'));
            }
        }

        async function setCoverFromGallery(toParent) {
            const cur = currentGalleryItem();
            if (!cur) return;
            const { folder, item } = cur;
            const target = toParent ? folders.find(f => f.id === folder.parentId) : folder;
            if (!target) return;
            if (!item.local && item.type !== 'image') { toast('ამ ფაილიდან ქავერის შექმნა შეუძლებელია'); return; }
            try {
                let img;
                if (item.local) {
                    toast('ქავერის მომზადება...', 4000);
                    const f = await resolveFile(folder, item);
                    const blob = await makeThumbBlob(f, item.type, 480);
                    if (!blob) throw new Error('კადრის წაკითხვა ვერ მოხერხდა');
                    img = await blobToDataUrl(blob);
                } else img = item.url;
                target.image = img;
                await persistData();
                renderFolders();
                toast(`ქავერი შეიცვალა: „${target.name}“`);
            } catch (e) { actionError(folder, e); }
        }

        const fileActions = {
            async openTab() {
                const { folder, item } = currentGalleryItem();
                if (!item.local) { window.open(item.url, '_blank', 'noopener'); return; }
                const win = window.open('about:blank', '_blank');
                try {
                    const f = await resolveFile(folder, item);
                    const url = URL.createObjectURL(f);
                    if (win) { win.location.href = url; setTimeout(() => URL.revokeObjectURL(url), 120000); }
                    else { URL.revokeObjectURL(url); toast('ბრაუზერმა ახალი ჩანართი დაბლოკა'); }
                } catch (e) { if (win) win.close(); actionError(folder, e); }
            },
            async openFolder() {
                const { folder, item } = currentGalleryItem();
                const full = getLocalFilePath(folder, item);
                if (!full) { toast('ლოკალური მისამართი არ არის მითითებული'); return; }
                const dir = full.replace(/[\\/][^\\/]*$/, '');
                if (location.protocol !== 'file:') {
                    await copyText(dir);
                    toast('საქაღალდის მისამართი დაკოპირდა — ჩასვით Explorer-ის მისამართის ველში', 6000);
                    return;
                }
                const a = document.createElement('a');
                a.href = pathToFileUrl(dir); a.target = '_blank'; a.rel = 'noopener';
                document.body.appendChild(a); a.click(); a.remove();
            },
            async copyPath() {
                const { folder, item } = currentGalleryItem();
                const text = item.local ? getLocalFilePath(folder, item) : item.url;
                toast((await copyText(text)) ? 'მისამართი დაკოპირდა' : 'კოპირება ვერ მოხერხდა');
            },
            copyImage() {
                const { folder, item } = currentGalleryItem();
                if (!navigator.clipboard || !window.ClipboardItem) { toast('ამ ბრაუზერში სურათის კოპირება მიუწვდომელია'); return; }
                const blobPromise = (async () => fileToPngBlob(await resolveFile(folder, item)))();
                navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })])
                    .then(() => toast('სურათი დაკოპირდა — ჩასვით სადაც გინდათ'))
                    .catch(e => actionError(folder, e));
            },
            async saveCopy() {
                const { folder, item } = currentGalleryItem();
                try {
                    if (window.showSaveFilePicker) {
                        const ext = (item.name.match(/\.[^.]+$/) || [''])[0];
                        const h = await window.showSaveFilePicker({ suggestedName: item.name });
                        const f = await resolveFile(folder, item);
                        const w = await h.createWritable();
                        await w.write(f);
                        await w.close();
                        toast('ასლი შენახულია');
                    } else {
                        const f = await resolveFile(folder, item);
                        const url = URL.createObjectURL(f);
                        const a = document.createElement('a');
                        a.href = url; a.download = item.name;
                        document.body.appendChild(a); a.click(); a.remove();
                        setTimeout(() => URL.revokeObjectURL(url), 60000);
                    }
                } catch (e) { actionError(folder, e); }
            },
            async share() {
                const { folder, item } = currentGalleryItem();
                if (!navigator.share) { toast('ამ ბრაუზერში გაზიარება მიუწვდომელია'); return; }
                try {
                    if (!item.local) { await navigator.share({ title: item.name, url: item.url }); return; }
                    const f = await resolveFile(folder, item);
                    const data = { files: [f], title: item.name };
                    if (navigator.canShare && !navigator.canShare(data)) { toast('ამ ტიპის ფაილის გაზიარება მიუწვდომელია'); return; }
                    await navigator.share(data);
                } catch (e) { actionError(folder, e); }
            }
        };

        function openFileMenu() {
            const cur = currentGalleryItem();
            if (!cur) return;
            const { folder, item } = cur;
            const menu = fileMenuEl();
            menu.innerHTML = '';

            const head = document.createElement('div');
            head.className = 'px-4 py-2 text-[11px] text-slate-400 break-all border-b border-white/10 mb-1';
            head.textContent = item.local ? (getLocalFilePath(folder, item) || item.name) : item.url;
            menu.appendChild(head);

            const add = (icon, label, fn) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/10 text-left transition cursor-pointer';
                b.innerHTML = `<i class="fa-solid ${icon} w-4 text-slate-400"></i><span></span>`;
                b.lastChild.textContent = label;
                b.onclick = () => { closeFileMenu(); fn(); };
                menu.appendChild(b);
            };
            add('fa-up-right-from-square', 'გახსნა ახალ ჩანართში', fileActions.openTab);
            if (item.local) add('fa-folder-open', 'საქაღალდის გახსნა დისკზე', fileActions.openFolder);
            add('fa-link', item.local ? 'ფაილის მისამართის კოპირება' : 'ლინკის კოპირება', fileActions.copyPath);
            if (item.local && item.type === 'image') add('fa-copy', 'სურათის კოპირება', fileActions.copyImage);
            if (item.local || item.type === 'image') add('fa-image', 'საქაღალდის ქავერად', () => setCoverFromGallery(false));
            if (folder.parentId && folders.some(f => f.id === folder.parentId)) add('fa-folder-tree', 'მშობელი საქაღალდის ქავერად', () => setCoverFromGallery(true));
            if (item.local) add('fa-floppy-disk', 'ასლის შენახვა…', fileActions.saveCopy);
            add('fa-share-nodes', 'გაზიარება…', fileActions.share);

            const r = document.getElementById('galleryItemTitle').getBoundingClientRect();
            menu.classList.remove('hidden');
            menu.style.top = Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 8) + 'px';
            menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
        }

        document.addEventListener('click', (e) => {
            const title = e.target.closest && e.target.closest('#galleryItemTitle');
            if (title) { e.stopPropagation(); fileMenuOpen() ? closeFileMenu() : openFileMenu(); return; }
            if (fileMenuOpen() && !fileMenuEl().contains(e.target)) closeFileMenu();
        });

        document.addEventListener('keydown', (e) => {
            const gm = document.getElementById('galleryModal');
            if (!gm || gm.classList.contains('hidden')) return;
            const tagOpen = !document.getElementById('tagModal').classList.contains('hidden');
            if (e.key === 'Escape') {
                e.preventDefault();
                if (noteOpen()) noteClose();
                else if (fileMenuOpen()) closeFileMenu();
                else if (tagOpen) closeTagModal();
                else closeGalleryModal();
                return;
            }
            if (tagOpen || e.ctrlKey || e.metaKey || e.altKey) return;
            const tag = (e.target && e.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            const zoomed = gz.el && gz.s > 1.001;
            const vid = gm.querySelector('#galleryDisplayArea video');
            if (e.code === 'KeyF') { e.preventDefault(); toggleFullscreen(); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); zoomed ? gzPan(-100, 0) : nextGalleryItem(); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); zoomed ? gzPan(100, 0) : prevGalleryItem(); }
            else if (e.key === 'ArrowUp') { if (zoomed) { e.preventDefault(); gzPan(0, 100); } }
            else if (e.key === 'ArrowDown') { if (zoomed) { e.preventDefault(); gzPan(0, -100); } }
            else if (e.key === 'PageDown') { e.preventDefault(); nextGalleryItem(); }
            else if (e.key === 'PageUp') { e.preventDefault(); prevGalleryItem(); }
            else if (e.key === 'Home') { e.preventDefault(); galleryGo(0); }
            else if (e.key === 'End') { e.preventDefault(); galleryGo(-1); }
            else if (gz.el && (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd')) { e.preventDefault(); gzStep(1); }
            else if (gz.el && (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract')) { e.preventDefault(); gzStep(-1); }
            else if (e.code === 'KeyS') { e.preventDefault(); toggleFavCurrent(); }
            else if (e.code === 'KeyN') { e.preventDefault(); noteBtnClick(); }
            else if (gz.el && (e.code === 'Digit0' || e.code === 'Numpad0')) { e.preventDefault(); gzFitView(); }
            else if (gz.el && (e.code === 'Digit1' || e.code === 'Numpad1')) { e.preventDefault(); gzActual(); }
            else if (gz.el && e.code === 'KeyR') { e.preventDefault(); gzRotate(e.shiftKey ? -1 : 1); }
            else if (vid && e.code === 'Space') { e.preventDefault(); vid.paused ? vid.play() : vid.pause(); }
            else if (vid && e.code === 'KeyM') { e.preventDefault(); vid.muted = !vid.muted; }
        }, true);


        /* ====================================================================
           PWA install (works when served over http(s)/localhost; file:// only supports "Create shortcut")
           ==================================================================== */
        let deferredInstall = null;
        const isStandalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
        function makeAppIcon(size) {
            const c = document.createElement('canvas'); c.width = c.height = size;
            const g = c.getContext('2d');
            const r = size * 0.22;
            g.fillStyle = '#4f46e5';
            g.beginPath(); g.moveTo(r, 0); g.arcTo(size, 0, size, size, r); g.arcTo(size, size, 0, size, r); g.arcTo(0, size, 0, 0, r); g.arcTo(0, 0, size, 0, r); g.fill();
            g.fillStyle = '#fff';
            const w = size * 0.56, h = size * 0.40, x = (size - w) / 2, y = size * 0.34, t = size * 0.08;
            g.beginPath(); g.moveTo(x, y); g.lineTo(x + w * 0.4, y); g.lineTo(x + w * 0.48, y + t); g.lineTo(x + w, y + t); g.lineTo(x + w, y + h); g.lineTo(x, y + h); g.closePath(); g.fill();
            return c.toDataURL('image/png');
        }
        async function setupManifest() {
            if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
            let served = false;
            try {
                const r = await fetch('manifest.webmanifest', { method: 'HEAD', cache: 'no-store' });
                served = r.ok && !/html/i.test(r.headers.get('content-type') || '');
            } catch (e) {}
            const link = document.createElement('link');
            link.rel = 'manifest';
            if (served) {
                link.href = 'manifest.webmanifest';
            } else {
                try {
                    const manifest = {
                        name: 'AvmaDrive', short_name: 'AvmaDrive', lang: 'ka',
                        start_url: location.href.split('#')[0], scope: location.href.split('#')[0].replace(/[^/]*$/, ''),
                        display: 'standalone', background_color: '#0f172a', theme_color: '#4f46e5',
                        icons: [{ src: makeAppIcon(192), sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: makeAppIcon(512), sizes: '512x512', type: 'image/png', purpose: 'any' }]
                    };
                    link.href = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }));
                } catch (e) { console.warn(e); return; }
            }
            document.head.appendChild(link);
            if (served && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
        }
        const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
        const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
        function updateInstallBtn() {
            const hide = isStandalone() || lsGet('avma_installed') === '1';
            document.querySelectorAll('[data-install]').forEach(el => el.classList.toggle('hidden', hide));
        }
        function hideInstallBanner() {
            const el = document.getElementById('installBanner');
            if (el) { el.style.opacity = '0'; el.style.pointerEvents = 'none'; setTimeout(() => el.remove(), 300); }
        }
        function showInstallBanner() {
            if (document.getElementById('installBanner') || isStandalone()) return;
            if (guideOpen()) { setTimeout(showInstallBanner, 4000); return; }
            const until = +lsGet('avma_install_later') || 0;
            if (Date.now() < until) return;
            const el = document.createElement('div');
            el.id = 'installBanner';
            el.className = 'fixed bottom-5 right-5 z-[90] w-[22rem] max-w-[calc(100vw-2.5rem)] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl p-4 transition-opacity duration-300';
            el.style.opacity = '0';
            el.innerHTML = `<div class="flex items-start space-x-3">
                <div class="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center flex-shrink-0"><i class="fa-solid fa-download"></i></div>
                <div class="min-w-0 flex-1">
                    <div class="font-semibold text-sm text-slate-900 dark:text-white">დააინსტალირე AvmaDrive</div>
                    <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">იხსნება ცალკე ფანჯარაში, მისამართის ზოლის გარეშე, ხატულით დესკტოპზე.</div>
                    <div class="flex items-center gap-2 mt-3">
                        <button type="button" data-act="go" class="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-medium transition cursor-pointer">დაინსტალირება</button>
                        <button type="button" data-act="later" class="px-3 py-1.5 rounded-xl text-xs font-medium text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer">მოგვიანებით</button>
                    </div>
                </div></div>`;
            el.querySelector('[data-act=go]').onclick = () => installApp();
            el.querySelector('[data-act=later]').onclick = () => { lsSet('avma_install_later', String(Date.now() + 14 * 864e5)); hideInstallBanner(); };
            document.body.appendChild(el);
            requestAnimationFrame(() => { el.style.opacity = '1'; });
        }
        function markInstalled() {
            deferredInstall = null;
            lsSet('avma_installed', '1');
            hideInstallBanner();
            updateInstallBtn();
        }
        async function installApp() {
            if (deferredInstall) {
                const p = deferredInstall; deferredInstall = null;
                try {
                    p.prompt();
                    const r = await p.userChoice;
                    if (r && r.outcome === 'accepted') { markInstalled(); toast('აპლიკაცია დაინსტალირდა'); }
                    else { deferredInstall = p; lsSet('avma_install_later', String(Date.now() + 14 * 864e5)); hideInstallBanner(); }
                } catch (e) { console.warn(e); }
                return;
            }
            if (isStandalone()) { toast('აპლიკაცია უკვე ინსტალირებულია'); return; }
            if (location.protocol === 'file:') {
                let up = false;
                try { await fetch('http://localhost:8765/manifest.webmanifest', { mode: 'no-cors', cache: 'no-store' }); up = true; } catch (e) {}
                if (up) {
                    const go = await choiceDialog('აპლიკაციად ინსტალაცია',
                        'ლოკალური სერვერი გაშვებულია. ინსტალაცია იქ გვერდზე ხდება, ერთი დაჭერით.\n\nშენიშვნა: იქ მონაცემები ცალკეა. ძველი მონაცემები გადაიტანე ექსპორტ/იმპორტით, საქაღალდეებს კი დისკთან ხელახლა დაუკავშირდები.',
                        [{ label: 'გაუქმება', value: false }, { label: 'გახსნა და ინსტალაცია', value: true, primary: true }]);
                    if (go) location.href = 'http://localhost:8765/';
                } else {
                    await choiceDialog('აპლიკაციად ინსტალაცია',
                        'ბრაუზერი ფაილად გახსნილ გვერდს ვერ დააინსტალირებს. გაუშვი AvmaDrive.bat (drive_manager.html-ის გვერდით). ის გვერდს ბრაუზერში გახსნის და ამ ღილაკით ინსტალაცია ერთი დაჭერით მოხდება.',
                        [{ label: 'გასაგებია', value: true, primary: true }]);
                }
                return;
            }
            await choiceDialog('აპლიკაციად ინსტალაცია',
                'ბრაუზერმა ინსტალაცია ჯერ არ შემოგვთავაზა. გახსენი გვერდი Chrome-ში ან Edge-ში და სცადე ცოტა ხანში, ან გამოიყენე ბრაუზერის მენიუს „Install app“.',
                [{ label: 'გასაგებია', value: true, primary: true }]);
        }
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredInstall = e;
            lsSet('avma_installed', null);   // the browser offers install again, so the app is not installed
            updateInstallBtn();
            setTimeout(showInstallBanner, 1500);
        });
        window.addEventListener('appinstalled', markInstalled);
        setupManifest();

        /* ====================================================================
           Built-in guide (first visit + "როგორ გამოვიყენო?" button)
           ==================================================================== */
        const GUIDE_IMGS = {"home": "assets/guide/home.webp", "folder": "assets/guide/folder.webp", "select": "assets/guide/select.webp", "search": "assets/guide/search.webp", "gallery": "assets/guide/gallery.webp", "install": "assets/guide/install.webp", "data": "assets/guide/data.webp"};
        const GUIDE_STEPS = [{"img": "home", "t": "კეთილი იყოს შენი მობრძანება AvmaDrive-ში", "b": "ეს არის შენი კომპიუტერის ფოტოებისა და ვიდეოების ორგანიზატორი ბრაუზერში. ფაილები არსად იტვირთება და დისკიდან არ გადაადგილდება, აპი მხოლოდ კითხულობს მათ."}, {"img": "folder", "t": "დაამატე საქაღალდე", "b": "დააჭირე „ფოლდერის სკანირებას“ და აირჩიე საქაღალდე. ქვესაქაღალდეები თავისით შემოვა. როცა დისკზე ცვლილებაა, დააჭირე „განახლებას“: ახალი ფაილები დაემატება, ტეგები დარჩება."}, {"img": "folder", "t": "მოაწესრიგე", "b": "კატეგორიები ფერადი ჯგუფებია საქაღალდეებისთვის. ტეგებით ნიშნავ ფაილებს, მაგალითად ადამიანების სახელებით. ★-ით ნიშნავ ფავორიტებს, ყველა ფავორიტი ერთ სიაშია მარცხენა მენიუში."}, {"img": "select", "t": "მონიშნე და მართე", "b": "მონიშნე რამდენიმე ფაილი (Shift-ით დიაპაზონი) და ქვედა პანელიდან დაამატე ან მოხსენი ტეგი. „წაშლა“ ფაილს მხოლოდ ბიბლიოთეკიდან ხსნის, დისკზე არაფერი იშლება. შეცდომა? დააჭირე Ctrl+Z."}, {"img": "search", "t": "იპოვე წამებში", "b": "ძიების ველში აკრიფე სიტყვა და იპოვის ფაილს, საქაღალდეს ან ტეგს. დასაზუსტებლად გამოიყენე tag:ზღვა, folder:ზაფხული, type:video, is:fav ან გახსენი ფილტრის პანელი."}, {"img": "gallery", "t": "უყურე კომფორტულად", "b": "ისრებით გადადიხარ წინა და შემდეგ ფაილზე, მაუსის ბორბლით ზუმავ, F არის სრული ეკრანი, R შემობრუნება, S ფავორიტი. სათაურზე დაჭერა ფაილის მენიუს ხსნის, „ქავერად“ კი საქაღალდეს ქავერს უცვლის."}, {"img": "install", "t": "დააინსტალირე აპად", "b": "Chrome-სა ან Edge-ში დააჭირე ბარათზე „დაინსტალირება“ ან ზედა მარჯვენა ხატულას. აპი ცალკე ფანჯარაში გაიხსნება, მისამართის ზოლის გარეშე, და ინტერნეტის გარეშეც იმუშავებს."}, {"img": "data", "t": "დაიცავი მონაცემები", "b": "ტეგები და კატეგორიები ინახება შენს ბრაუზერში. ჩართე „ავტო-ბექაპი“ ან გააკეთე ექსპორტი, რომ ბრაუზერის გასუფთავებამ არაფერი წაგართვას. უკეთ მუშაობს Chrome-სა და Edge-ში."}, {"img": "home", "t": "ღია კოდი და ლოკალური გაშვება", "b": "AvmaDrive ღია კოდის პროექტია. კოდი, ინსტრუქცია და ჩამოსატვირთი ვერსია GitHub-ზეა. კომპიუტერზე გასაშვებად ჩამოტვირთე საქაღალდე და Windows-ზე გახსენი AvmaDrive.bat (ან საქაღალდეში გაუშვი python3 -m http.server 8765 და გახსენი localhost:8765).", "link": "https://github.com/amachitadze/avma-gallery"}];
        let guideIdx = 0;
        const guideOpen = () => { const m = document.getElementById('guideModal'); return !!m && !m.classList.contains('hidden'); };
        function guideRender() {
            const st = GUIDE_STEPS[guideIdx];
            const img = document.getElementById('guideImg');
            img.src = GUIDE_IMGS[st.img];
            img.className = 'w-full h-full ' + (st.img === 'data' ? 'object-contain' : 'object-cover object-left-top');
            document.getElementById('guideStep').textContent = `ნაბიჯი ${guideIdx + 1} / ${GUIDE_STEPS.length}`;
            document.getElementById('guideTitle').textContent = st.t;
            const gt = document.getElementById('guideText');
            gt.textContent = st.b;
            if (st.link) {
                gt.appendChild(document.createElement('br'));
                const a = document.createElement('a');
                a.href = st.link; a.target = '_blank'; a.rel = 'noopener';
                a.className = 'text-indigo-600 dark:text-indigo-400 underline break-all';
                a.textContent = st.link;
                gt.appendChild(a);
            }
            document.getElementById('guidePrev').style.visibility = guideIdx === 0 ? 'hidden' : 'visible';
            document.getElementById('guideNext').textContent = guideIdx === GUIDE_STEPS.length - 1 ? 'დაწყება' : 'შემდეგი';
            const dots = document.getElementById('guideDots');
            dots.innerHTML = '';
            GUIDE_STEPS.forEach((_, i) => {
                const d = document.createElement('button');
                d.type = 'button';
                d.title = `ნაბიჯი ${i + 1}`;
                d.className = 'w-2 h-2 rounded-full cursor-pointer transition ' + (i === guideIdx ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-600');
                d.onclick = () => { guideIdx = i; guideRender(); };
                dots.appendChild(d);
            });
        }
        function openGuide(auto) {
            guideIdx = 0;
            document.getElementById('guideOff').checked = false;
            guideRender();
            const m = document.getElementById('guideModal');
            m.classList.remove('hidden'); m.classList.add('flex');
        }
        function closeGuide() {
            const m = document.getElementById('guideModal');
            m.classList.add('hidden'); m.classList.remove('flex');
            if (document.getElementById('guideOff').checked) lsSet('avma_guide_off', '1');
            document.getElementById('guideImg').removeAttribute('src');
        }
        function guideGo(d) {
            const n = guideIdx + d;
            if (n >= GUIDE_STEPS.length) { closeGuide(); return; }
            if (n < 0) return;
            guideIdx = n; guideRender();
        }
        document.addEventListener('keydown', (e) => {
            if (!guideOpen()) return;
            if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeGuide(); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); guideGo(1); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); guideGo(-1); }
        }, true);
        function maybeShowGuide() {
            if (lsGet('avma_guide_off') === '1') return;
            const shown = +lsGet('avma_guide_shown') || 0;
            if (shown >= 3) return;                                   // auto-open at most three times
            if (folders.some(f => f.rootId)) return;                  // returning user with real folders
            lsSet('avma_guide_shown', String(shown + 1));
            setTimeout(() => openGuide(true), 500);
        }

        window.onload = async function() {
            updateInstallBtn();
            const savedTheme = localStorage.getItem('theme');
            if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                document.documentElement.classList.add('dark');
                document.getElementById('themeIcon').className = "fa-solid fa-sun text-sm";
            }
            await initData();
            renderFolders();
            initBackup();
            maybeShowGuide();
        }
