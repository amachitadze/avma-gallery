/* AvmaDrive language support.
   Georgian is the source language. For other languages (now: Spanish) a dictionary
   (assets/lang/<code>.js) maps Georgian text -> translation; the page is translated in place
   and every later change of the page is translated by a MutationObserver. */
(function () {
    'use strict';
    var LANG = 'ka';
    try { LANG = localStorage.getItem('avma_lang') || 'ka'; } catch (e) {}
    var DICT = LANG === 'es' ? window.LANG_ES : null;
    if (!DICT) LANG = 'ka';
    window.LANG = LANG;
    window.setLang = function (v) {
        try { localStorage.setItem('avma_lang', v); } catch (e) {}
        location.reload();
    };
    document.documentElement.lang = LANG;
    if (!DICT) return;

    var geo = /[Ⴀ-ჿ]/;
    var norm = function (s) { return s.replace(/\s+/g, ' ').trim(); };
    var escRe = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
    var exact = new Map(), pats = [];
    Object.keys(DICT).forEach(function (k) {
        var v = DICT[k];
        if (!v) return;
        if (k.indexOf('{}') >= 0) pats.push({ len: k.length, re: new RegExp('^' + k.split('{}').map(escRe).join('(.+?)') + '$'), v: v });
        else exact.set(k, v);
    });
    pats.sort(function (a, b) { return b.len - a.len; });

    function trLine(text) {
        if (!geo.test(text)) return text;
        var lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
        var core = norm(text);
        var r = exact.get(core);
        if (r !== undefined) return lead + r + trail;
        for (var i = 0; i < pats.length; i++) {
            var m = core.match(pats[i].re);
            if (m) { var n = 0; return lead + pats[i].v.replace(/\{\}/g, function () { n++; return m[n] === undefined ? '' : m[n]; }) + trail; }
        }
        return text;
    }
    function tr(text) {
        if (!geo.test(text)) return text;
        var r = trLine(text);
        if (r !== text || text.indexOf('\n') < 0) return r;
        return text.split('\n').map(trLine).join('\n');       // multi-paragraph messages: line by line
    }
    window.trUi = tr;

    var ATTRS = ['title', 'placeholder', 'data-tip', 'data-gtip', 'data-gkeys', 'alt', 'aria-label'];
    function doNode(n) {
        if (n.nodeType === 3) {
            var t = n.data;
            if (geo.test(t)) { var r = tr(t); if (r !== t) n.data = r; }
        } else if (n.nodeType === 1) {
            var tag = n.nodeName;
            if (tag === 'SCRIPT' || tag === 'STYLE') return;
            for (var i = 0; i < ATTRS.length; i++) {
                var v = n.getAttribute(ATTRS[i]);
                if (v && geo.test(v)) { var r2 = tr(v); if (r2 !== v) n.setAttribute(ATTRS[i], r2); }
            }
        }
    }
    function walk(root) {
        doNode(root);
        if (root.nodeType !== 1 && root.nodeType !== 9) return;
        var w = document.createTreeWalker(root, 1 | 4);       // elements + text
        var n;
        while ((n = w.nextNode())) doNode(n);
    }
    walk(document.documentElement);
    new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
            var m = muts[i];
            if (m.type === 'childList') { for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]); }
            else doNode(m.target);
        }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });

    // native dialogs
    ['alert', 'confirm', 'prompt'].forEach(function (name) {
        var orig = window[name];
        window[name] = function (msg, d) { return orig.call(window, tr(String(msg == null ? '' : msg)), d); };
    });
})();
