// ==UserScript==
// @name         StreamFlow: Video Speed HUD, PiP & Background Keep-Alive
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Universal HTML5 video/audio speed controller ([ / ]), Picture-in-Picture hotkey (Alt+P), background playback keep-alive, telemetry blocker, and on-screen HUD for side-by-side note-taking: copy timestamps, grab frames, replay, A-B loop, frame step. Remembers speed per site; every shortcut is rebindable.
// @match        *://*/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
    'use strict';

    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const doc = win.document || document;
    const DocProto = (win.Document && win.Document.prototype) || Document.prototype;
    const EvtProto = (win.EventTarget && win.EventTarget.prototype) || EventTarget.prototype;

    // =========================================================================
    // 1. SIDE-BY-SIDE NOTE-TAKING KEEP-ALIVE
    // Prevents video players & lecture portals from auto-pausing or throttling
    // bitrate when you click into an external note-taking app (Obsidian/Word).
    // =========================================================================
    let onWindowBlurHook = null;

    const lockReadOnlyProp = (proto, prop, value) => {
        try {
            Object.defineProperty(proto, prop, {
                get: () => value,
                set: () => {},
                configurable: true
            });
        } catch (e) {}
    };

    lockReadOnlyProp(DocProto, 'hidden', false);
    lockReadOnlyProp(DocProto, 'webkitHidden', false);
    lockReadOnlyProp(DocProto, 'visibilityState', 'visible');
    DocProto.hasFocus = () => true;

    const origAddEvent = EvtProto.addEventListener;
    const backgroundPauseEvents = new Set([
        'visibilitychange', 'webkitvisibilitychange', 'blur', 'focusout', 'pagehide'
    ]);

    // Block sites from registering tab-switch/blur listeners that pause media
    EvtProto.addEventListener = function (type, listener, options) {
        if (backgroundPauseEvents.has(type)) {
            return;
        }
        return origAddEvent.call(this, type, listener, options);
    };

    win.addEventListener = EvtProto.addEventListener;
    doc.addEventListener = EvtProto.addEventListener;

    // Swallow focus-loss events in capture phase
    backgroundPauseEvents.forEach(evt => {
        origAddEvent.call(win, evt, (e) => {
            if (evt === 'blur' && typeof onWindowBlurHook === 'function') {
                onWindowBlurHook();
            }
            e.stopImmediatePropagation();
        }, true);
        origAddEvent.call(doc, evt, (e) => e.stopImmediatePropagation(), true);
    });

    // =========================================================================
    // 2. CLEAN COPY & CONTEXT MENU UNLOCKER (For clean research/lecture notes)
    // Prevents sites from injecting tracking URLs on copy or locking right-click
    // =========================================================================
    ['contextmenu', 'copy', 'cut', 'selectstart'].forEach(evt => {
        origAddEvent.call(win, evt, (e) => e.stopImmediatePropagation(), true);
    });

    // =========================================================================
    // 3. STREAMING TELEMETRY & AD-SIGNAL BLOCKER
    // Drops background analytics/signal pings to save bandwidth while streaming
    // =========================================================================
    const telemetryEndpoints = ['/telemetry', '/analytics', '/signals', '/beacon', '/collect'];

    if (win.fetch) {
        const origFetch = win.fetch.bind(win);
        win.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) ? input.url : '';
            if (telemetryEndpoints.some(ep => url.includes(ep))) {
                return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
            }
            return origFetch(input, init);
        };
    }

    if (win.WebSocket && win.WebSocket.prototype) {
        const origWSSend = win.WebSocket.prototype.send;
        win.WebSocket.prototype.send = function (data) {
            if (typeof data === 'string' && (data.includes('"telemetry"') || data.includes('"signals"') || data.includes('"fullscreen"'))) {
                return;
            }
            return origWSSend.apply(this, arguments);
        };
    }

    // =========================================================================
    // 4. UNIVERSAL VIDEO SPEED CONTROLLER & PICTURE-IN-PICTURE HUD
    // Default keys (all rebindable in Settings):
    //   '[' (-0.25x) | ']' (+0.25x) | '\' (Reset 1.0x) | 'Alt + P' (PiP)
    //   'Alt + R' toggle 1x <-> last speed   | hold '`' temporary boost
    //   'Alt + C' copy timestamp             | 'Alt + L' copy timestamped Markdown link
    //   'Alt + G' grab frame (screenshot)    | 'Alt + A' A-B loop (start -> end -> clear)
    //   'Alt + Z' replay last few seconds    | 'Alt + X' skip forward
    //   'Alt + ,' previous frame             | 'Alt + .' next frame
    //   'Alt + /' open settings
    // On a Mac, Alt is the Option key.
    // If the player lives in an iframe, click it once so it has keyboard focus.
    // =========================================================================

    const VERSION = '3.0';
    const MIN_RATE = 0.1;          // lowest speed the step keys will go to
    const MAX_RATE = 16;           // browser limit for playbackRate
    const REASSERT_WINDOW = 3000;  // ms after a video loads in which a site reset is undone
    const MAX_REASSERTS = 5;       // per load, so a stubborn site can't cause a tug-of-war
    const HOST = location.hostname || 'local-file';

    const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(
        (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || ''
    );
    const IS_TOP = (() => {
        try { return window.top === window.self; } catch (err) { return false; }
    })();
    // The page the user is actually on (differs from HOST inside embedded players).
    const TOP_HOST = (() => {
        if (IS_TOP) return HOST;
        try { return window.top.location.hostname || HOST; } catch (err) { /* cross-origin */ }
        try {
            const origins = location.ancestorOrigins;
            if (origins && origins.length) return new URL(origins[origins.length - 1]).hostname;
        } catch (err) { /* not supported */ }
        try { if (document.referrer) return new URL(document.referrer).hostname; } catch (err) { /* ignore */ }
        return HOST;
    })();

    // -------------------------------------------------------------------------
    // Storage (userscript-manager storage, with a localStorage fallback)
    // -------------------------------------------------------------------------
    const HAS_GM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    const LS_PREFIX = 'streamflow:';
    const store = {
        get(key, fallback) {
            try {
                if (HAS_GM) {
                    const value = GM_getValue(key);
                    return value === undefined || value === null ? fallback : value;
                }
                const raw = localStorage.getItem(LS_PREFIX + key);
                return raw === null ? fallback : JSON.parse(raw);
            } catch (err) {
                return fallback;
            }
        },
        set(key, value) {
            try {
                if (HAS_GM) GM_setValue(key, value);
                else localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
            } catch (err) { /* storage unavailable */ }
        },
        del(key) {
            try {
                if (HAS_GM && typeof GM_deleteValue === 'function') GM_deleteValue(key);
                else if (HAS_GM) GM_setValue(key, null);
                else localStorage.removeItem(LS_PREFIX + key);
            } catch (err) { /* storage unavailable */ }
        },
        // Calls fn(newValue) when another tab or frame changes the value.
        watch(key, fn) {
            try {
                if (typeof GM_addValueChangeListener === 'function') {
                    GM_addValueChangeListener(key, (name, oldValue, newValue, remote) => {
                        if (remote) fn(newValue);
                    });
                }
            } catch (err) { /* not supported */ }
        }
    };

    // -------------------------------------------------------------------------
    // Shortcuts
    //   'char'  bindings match the character you type ('[' works on any layout,
    //           even where it needs AltGr or Option).
    //   'combo' bindings match a key plus an exact set of modifiers.
    // -------------------------------------------------------------------------
    const combo = (id, mods) => Object.assign({ type: 'combo', id, alt: false, ctrl: false, meta: false, shift: false }, mods || {});
    const char = (key) => ({ type: 'char', key });
    const ALT = { alt: true };

    const ACTIONS = [
        { id: 'slower',     label: 'Slower',                           def: char('[') },
        { id: 'faster',     label: 'Faster',                           def: char(']') },
        { id: 'reset',      label: 'Reset to 1.00x',                   def: char('\\') },
        { id: 'toggle',     label: 'Toggle 1x and last speed',         def: combo('KeyR', ALT) },
        { id: 'boost',      label: 'Boost while held',                 def: combo('Backquote') },
        { id: 'pip',        label: 'Picture-in-Picture',               def: combo('KeyP', ALT) },
        { id: 'copyTime',   label: 'Copy timestamp',                   def: combo('KeyC', ALT) },
        { id: 'copyLink',   label: 'Copy timestamped Markdown link',   def: combo('KeyL', ALT) },
        { id: 'screenshot', label: 'Screenshot current frame',         def: combo('KeyG', ALT) },
        { id: 'replay',     label: 'Replay (jump back)',               def: combo('KeyZ', ALT) },
        { id: 'skip',       label: 'Skip forward',                     def: combo('KeyX', ALT) },
        { id: 'loop',       label: 'A-B loop (start, end, clear)',     def: combo('KeyA', ALT) },
        { id: 'framePrev',  label: 'Previous frame',                   def: combo('Comma', ALT) },
        { id: 'frameNext',  label: 'Next frame',                       def: combo('Period', ALT) },
        { id: 'settings',   label: 'Open settings',                    def: combo('Slash', ALT) }
    ];

    const CHAR_TO_ID = {
        ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash', '`': 'Backquote',
        '[': 'BracketLeft', ']': 'BracketRight', ';': 'Semicolon', "'": 'Quote',
        '-': 'Minus', '=': 'Equal', ' ': 'Space'
    };
    const ID_TO_LABEL = {
        Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
        BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=',
        Space: 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down'
    };
    const MODIFIER_KEYS = /^(Shift|Control|Alt|Meta|AltGraph|CapsLock|NumLock|ScrollLock|Fn|FnLock|OS|Hyper|Super|Symbol|SymbolLock)$/;

    // AltGr (Windows/Linux) types characters; it must not count as Ctrl+Alt.
    const isAltGraph = (e) => !IS_MAC && typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');

    // Identify a key by what is printed on it when that is a plain ASCII
    // character, otherwise by its physical position (Option+P types "π" on a Mac).
    function keyId(e) {
        const k = e.key || '';
        if (k.length === 1) {
            if (/[a-z]/i.test(k)) return 'Key' + k.toUpperCase();
            if (/[0-9]/.test(k)) return 'Digit' + k;
            if (CHAR_TO_ID[k]) return CHAR_TO_ID[k];
        }
        return e.code || k;
    }

    function bindingFromEvent(e) {
        const k = e.key || '';
        const printable = k.length === 1 && k !== ' ';
        const alnum = printable && /[a-z0-9]/i.test(k);
        const hasMod = e.ctrlKey || e.altKey || e.metaKey;
        if (printable && (isAltGraph(e) || (!hasMod && !alnum))) return char(k);
        return combo(keyId(e), { alt: !!e.altKey, ctrl: !!e.ctrlKey, meta: !!e.metaKey, shift: !!e.shiftKey });
    }

    function bindingLabel(b) {
        if (!b) return 'Not set';
        if (b.type === 'char') return b.key;
        const parts = [];
        if (b.ctrl) parts.push('Ctrl');
        if (b.alt) parts.push(IS_MAC ? 'Option' : 'Alt');
        if (b.shift) parts.push('Shift');
        if (b.meta) parts.push(IS_MAC ? 'Cmd' : 'Win');
        let name = b.id;
        if (/^Key[A-Z]$/.test(name)) name = name.slice(3);
        else if (/^Digit\d$/.test(name)) name = name.slice(5);
        else if (/^Numpad/.test(name)) name = 'Num ' + name.slice(6);
        else if (ID_TO_LABEL[name]) name = ID_TO_LABEL[name];
        parts.push(name);
        return parts.join('+');
    }

    function bindingsClash(a, b) {
        if (!a || !b) return false;
        if (a.type === 'char' && b.type === 'char') return a.key === b.key;
        if (a.type === 'combo' && b.type === 'combo') {
            return a.id === b.id && a.alt === b.alt && a.ctrl === b.ctrl && a.meta === b.meta && a.shift === b.shift;
        }
        const c = a.type === 'char' ? a : b;
        const k = a.type === 'combo' ? a : b;
        return !k.alt && !k.ctrl && !k.meta && !k.shift && CHAR_TO_ID[c.key] === k.id;
    }

    function sanitizeBinding(b) {
        if (!b || typeof b !== 'object') return null;
        if (b.type === 'char' && typeof b.key === 'string' && b.key.length === 1) return char(b.key);
        if (b.type === 'combo' && typeof b.id === 'string' && b.id) {
            return combo(b.id, { alt: !!b.alt, ctrl: !!b.ctrl, meta: !!b.meta, shift: !!b.shift });
        }
        return null;
    }

    function matchAction(e) {
        const bindings = settings.bindings;
        const altGraph = isAltGraph(e);
        if (!altGraph) {
            const id = keyId(e);
            for (const a of ACTIONS) {
                const b = bindings[a.id];
                if (b && b.type === 'combo' && b.id === id && e.altKey === b.alt && e.ctrlKey === b.ctrl &&
                    e.metaKey === b.meta && e.shiftKey === b.shift) return a.id;
            }
        }
        // Plain characters: ignore them when Ctrl or Cmd is held (Cmd+[ is "Back").
        if (!e.metaKey && (!e.ctrlKey || altGraph)) {
            for (const a of ACTIONS) {
                const b = bindings[a.id];
                if (b && b.type === 'char' && b.key === e.key) return a.id;
            }
        }
        return null;
    }

    // -------------------------------------------------------------------------
    // Settings
    // -------------------------------------------------------------------------
    const DEFAULTS = {
        step: 0.25,             // speed change per key press
        boostSpeed: 2,          // speed while the boost key is held
        replaySeconds: 5,
        skipSeconds: 10,
        fps: 30,                // assumed frame rate for frame stepping
        rememberSpeed: true,
        showRemaining: true,
        downloadShots: false
    };
    const LIMITS = {
        step: [0.05, 2], boostSpeed: [0.25, MAX_RATE], replaySeconds: [1, 600], skipSeconds: [1, 600], fps: [1, 240]
    };

    const round2 = (n) => Math.round(n * 100) / 100;
    const clampNum = (n, min, max) => Math.min(max, Math.max(min, n));
    const validRate = (v) => typeof v === 'number' && isFinite(v) && v >= 0.0625 && v <= MAX_RATE;

    function loadSettings() {
        const raw = store.get('settings', null) || {};
        const s = {};
        Object.keys(DEFAULTS).forEach((key) => {
            s[key] = typeof raw[key] === typeof DEFAULTS[key] ? raw[key] : DEFAULTS[key];
            if (LIMITS[key]) s[key] = isFinite(s[key]) ? clampNum(s[key], LIMITS[key][0], LIMITS[key][1]) : DEFAULTS[key];
        });
        const saved = raw.bindings && typeof raw.bindings === 'object' ? raw.bindings : {};
        s.bindings = {};
        ACTIONS.forEach((a) => {
            // A saved null means "deliberately unassigned"; a missing key gets the default.
            s.bindings[a.id] = Object.prototype.hasOwnProperty.call(saved, a.id) ? sanitizeBinding(saved[a.id]) : a.def;
        });
        return s;
    }

    function saveSettings() {
        store.set('settings', JSON.parse(JSON.stringify(settings)));
    }

    const readSiteRate = () => {
        const v = store.get('speed:' + HOST, null);
        return validRate(v) ? v : null;
    };
    const computeSiteOff = () => store.get('off:' + HOST, false) === true || store.get('off:' + TOP_HOST, false) === true;

    let settings = loadSettings();
    let siteRate = readSiteRate();   // speed remembered for this site, or null
    let siteOff = computeSiteOff();  // true when StreamFlow is disabled on this site

    // -------------------------------------------------------------------------
    // HUD toast
    // -------------------------------------------------------------------------
    let hudTimeout = null;
    let toastEl = null;

    const shadowOf = (el) => (el && (el.openOrClosedShadowRoot || el.shadowRoot)) || null;
    const NO_CHILDREN = /^(VIDEO|AUDIO|IFRAME|IMG|CANVAS|EMBED|OBJECT)$/;

    // Where to attach UI so it stays visible: inside the fullscreen element when
    // there is one (anything outside it is not drawn), otherwise the page body.
    // A <video> that is itself fullscreen can't hold children, so the HUD can't
    // show there; players that fullscreen their own container are fine.
    function uiParent() {
        let fs = document.fullscreenElement || document.webkitFullscreenElement || null;
        while (fs && shadowOf(fs) && shadowOf(fs).fullscreenElement) fs = shadowOf(fs).fullscreenElement;
        if (fs && fs !== document.documentElement && fs !== document.body && !NO_CHILDREN.test(fs.tagName)) {
            return shadowOf(fs) || fs;
        }
        return document.body || document.documentElement;
    }

    const showToast = (text, duration) => {
        let toast = toastEl;
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'streamflow-hud-toast';
            Object.assign(toast.style, {
                position: 'fixed',
                top: '24px',
                right: '24px',
                zIndex: '2147483647',
                background: 'rgba(15, 23, 42, 0.88)',
                color: '#38bdf8',
                padding: '10px 16px',
                borderRadius: '8px',
                fontFamily: 'system-ui, -apple-system, sans-serif',
                fontSize: '14px',
                fontWeight: '600',
                lineHeight: '1.4',
                maxWidth: 'min(420px, calc(100vw - 48px))',
                boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
                border: '1px solid rgba(56, 189, 248, 0.3)',
                pointerEvents: 'none',
                transition: 'opacity 0.2s ease',
                opacity: '0'
            });
            toastEl = toast;
        }
        const parent = uiParent();
        if (parent && toast.parentNode !== parent) parent.appendChild(toast);
        toast.textContent = text;
        toast.style.opacity = '1';
        clearTimeout(hudTimeout);
        hudTimeout = setTimeout(() => {
            if (toast) toast.style.opacity = '0';
        }, duration || 1400);
    };

    function reparentUi() {
        const parent = uiParent();
        if (!parent) return;
        if (toastEl && toastEl.parentNode && toastEl.parentNode !== parent) parent.appendChild(toastEl);
        if (panel.host && panel.host.parentNode !== parent) parent.appendChild(panel.host);
    }

    // -------------------------------------------------------------------------
    // Finding media (video and audio, including inside open shadow DOM)
    // -------------------------------------------------------------------------
    const MEDIA_EVENTS = ['loadedmetadata', 'emptied', 'play', 'ratechange', 'ended'];
    const shadowMedia = new Set();
    const wired = new WeakSet();
    let lastActive = null;
    let lastDeepScan = 0;
    let deepScanQueued = false;

    const isMedia = (n) => !!n && (n.tagName === 'VIDEO' || n.tagName === 'AUDIO');
    const isVideo = (n) => !!n && n.tagName === 'VIDEO';

    // Media events don't cross shadow boundaries, so shadow-DOM players get
    // their own listeners when they are discovered.
    function wireShadowMedia(media) {
        shadowMedia.add(media);
        if (wired.has(media)) return;
        wired.add(media);
        MEDIA_EVENTS.forEach((type) => media.addEventListener(type, onMediaEvent));
        if (media.readyState >= 1) onLoaded(media);
    }

    function deepScan() {
        lastDeepScan = Date.now();
        const visit = (root, depth) => {
            if (depth > 8) return;
            let all;
            try { all = root.querySelectorAll('*'); } catch (err) { return; }
            for (let i = 0; i < all.length; i++) {
                const sr = shadowOf(all[i]);
                if (!sr) continue;
                sr.querySelectorAll('video, audio').forEach(wireShadowMedia);
                visit(sr, depth + 1);
            }
        };
        visit(document, 0);
    }

    function scheduleDeepScan() {
        if (siteOff || deepScanQueued || Date.now() - lastDeepScan < 3000) return;
        deepScanQueued = true;
        const run = () => { deepScanQueued = false; deepScan(); };
        if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 1500 });
        else setTimeout(run, 300);
    }

    function findMedia() {
        const found = new Set(document.querySelectorAll('video, audio'));
        const age = Date.now() - lastDeepScan;
        if ((!found.size && age > 1000) || age > 15000) deepScan();
        shadowMedia.forEach((m) => {
            if (m.isConnected) found.add(m);
            else shadowMedia.delete(m);
        });
        return Array.from(found);
    }

    function visibleArea(media) {
        if (!isVideo(media)) return 0;
        const r = media.getBoundingClientRect();
        const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
        const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
        return w > 0 && h > 0 ? w * h : 0;
    }

    // Playing media wins; with several candidates, the biggest one on screen
    // (or the one you last played) is used.
    const getActiveVideo = () => {
        const all = findMedia();
        if (!all.length) return null;
        const playing = all.filter((m) => !m.paused && m.readyState > 0);
        const pool = playing.length ? playing : all;
        if (pool.length === 1) return pool[0];
        if (!playing.length && lastActive && pool.indexOf(lastActive) !== -1) return lastActive;
        let best = pool[0];
        let bestScore = -1;
        pool.forEach((m) => {
            const score = visibleArea(m) + (m === lastActive ? 0.5 : 0);
            if (score > bestScore) { bestScore = score; best = m; }
        });
        return best;
    };

    // -------------------------------------------------------------------------
    // Speed: setting, remembering per site, toggling, boosting
    // -------------------------------------------------------------------------
    const metaMap = new WeakMap();
    const metaOf = (media) => {
        let m = metaMap.get(media);
        if (!m) {
            m = { expect: null, loadTs: 0, reasserts: 0, played: false };
            metaMap.set(media, m);
        }
        return m;
    };
    const boost = { active: false, media: null, prev: 1, code: '' };

    function setRate(media, rate) {
        const m = metaOf(media);
        m.expect = rate;
        try {
            media.playbackRate = rate;
            return true;
        } catch (err) {
            m.expect = null;
            return false;
        }
    }

    function canAutoApply(media) {
        if (siteOff || !settings.rememberSpeed || siteRate === null) return false;
        if (boost.active && boost.media === media) return false;
        const d = media.duration;
        if (d === Infinity) return false;                           // live stream: speeding up just stalls
        if (!isVideo(media) && isFinite(d) && d < 10) return false; // short sound effects
        return true;
    }

    function applyRemembered(media) {
        if (!canAutoApply(media)) return;
        if (Math.abs(media.playbackRate - siteRate) < 0.001) return;
        setRate(media, siteRate);
    }

    function onLoaded(media) {
        const m = metaOf(media);
        m.loadTs = Date.now();
        m.reasserts = 0;
        m.played = false;
        applyRemembered(media);
    }

    // Sites often reset the speed when the next video loads. A reset right after
    // a load is undone; a change later on (for example from the site's own speed
    // menu) is left alone.
    function onRateChange(media) {
        const m = metaOf(media);
        if (m.expect !== null && Math.abs(media.playbackRate - m.expect) < 0.001) return; // our own change
        m.expect = null;
        if (!canAutoApply(media)) return;
        if (Date.now() - m.loadTs > REASSERT_WINDOW || m.reasserts >= MAX_REASSERTS) return;
        m.reasserts++;
        setRate(media, siteRate);
    }

    function onMediaEvent(e) {
        const media = e.target;
        if (!isMedia(media)) return;
        switch (e.type) {
            case 'loadedmetadata':
                onLoaded(media);
                break;
            case 'emptied':
                clearLoop(media);
                break;
            case 'play': {
                lastActive = media;
                const m = metaOf(media);
                if (!m.played) {
                    m.played = true;
                    m.loadTs = Date.now();
                    m.reasserts = 0;
                    applyRemembered(media);
                }
                break;
            }
            case 'ratechange':
                onRateChange(media);
                break;
            case 'ended': {
                const lp = loops.get(media);
                if (lp && lp.b !== null) {
                    media.currentTime = lp.a;
                    const p = media.play();
                    if (p && p.catch) p.catch(() => {});
                }
                break;
            }
        }
    }

    const pad2 = (n) => String(n).padStart(2, '0');
    function fmtTime(sec, withMs) {
        if (!isFinite(sec) || sec < 0) sec = 0;
        const whole = Math.floor(sec);
        const h = Math.floor(whole / 3600);
        const m = Math.floor((whole % 3600) / 60);
        const s = whole % 60;
        let out = h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
        if (withMs) out += '.' + String(Math.floor((sec - whole) * 1000)).padStart(3, '0');
        return out;
    }

    function remainingSuffix(media, rate) {
        if (!settings.showRemaining) return '';
        const d = media.duration;
        if (!isFinite(d) || d <= 0 || !(rate > 0)) return '';
        return ` · ${fmtTime(Math.max(0, d - media.currentTime) / rate)} left`;
    }

    function saveSiteRate(rate) {
        if (!settings.rememberSpeed) return;
        if (Math.abs(rate - 1) < 0.001) {
            siteRate = null;
            store.del('speed:' + HOST);
        } else {
            siteRate = rate;
            store.set('speed:' + HOST, rate);
        }
    }

    function saveToggleRate(rate) {
        if (!validRate(rate) || Math.abs(rate - 1) < 0.001) return;
        store.set('toggle:' + HOST, rate);
        store.set('toggle:*', rate);
    }

    function readToggleRate() {
        let v = store.get('toggle:' + HOST, null);
        if (!validRate(v)) v = store.get('toggle:*', null);
        return validRate(v) ? v : 1.5;
    }

    // A speed chosen by the user with a StreamFlow key.
    function userSetRate(media, rate) {
        const prev = media.playbackRate;
        if (!setRate(media, rate)) {
            showToast('⚠️ This speed is not supported here');
            return false;
        }
        if (Math.abs(rate - 1) < 0.001) saveToggleRate(prev);
        else saveToggleRate(rate);
        saveSiteRate(rate);
        return true;
    }

    function stepSpeed(media, dir) {
        const step = settings.step;
        const floor = Math.max(MIN_RATE, Math.min(0.25, step));
        const nextRate = Math.min(MAX_RATE, Math.max(floor, round2(media.playbackRate + dir * step)));
        if (userSetRate(media, nextRate)) showToast(`⚡ Speed: ${nextRate.toFixed(2)}x${remainingSuffix(media, nextRate)}`);
    }

    function resetSpeed(media) {
        if (userSetRate(media, 1.0)) showToast(`⚡ Speed: 1.00x (Reset)${remainingSuffix(media, 1)}`);
    }

    function toggleSpeed(media) {
        const target = Math.abs(media.playbackRate - 1) < 0.001 ? readToggleRate() : 1;
        if (userSetRate(media, target)) showToast(`⚡ Speed: ${target.toFixed(2)}x${remainingSuffix(media, target)}`);
    }

    function startBoost(media, e) {
        if (boost.active) return;
        const rate = clampNum(settings.boostSpeed, 0.25, MAX_RATE);
        const prev = media.playbackRate;
        if (!setRate(media, rate)) {
            showToast('⚠️ This speed is not supported here');
            return;
        }
        boost.active = true;
        boost.media = media;
        boost.prev = prev;
        boost.code = e.code;
        showToast(`⏩ Boost: ${rate.toFixed(2)}x (hold)`, 600000);
    }

    function endBoost() {
        if (!boost.active) return;
        const media = boost.media;
        const prev = boost.prev;
        boost.active = false;
        boost.media = null;
        if (media) setRate(media, prev);
        showToast(`⚡ Speed: ${prev.toFixed(2)}x`);
    }

    // -------------------------------------------------------------------------
    // Picture-in-Picture
    // -------------------------------------------------------------------------
    function togglePip(media) {
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture()
                .then(() => showToast('🖼️ Exited Picture-in-Picture'))
                .catch(() => showToast('⚠️ Could not exit Picture-in-Picture'));
            return;
        }
        if (!isVideo(media)) {
            showToast('⚠️ Picture-in-Picture needs a video');
            return;
        }
        if (!media.requestPictureInPicture) {
            showToast('⚠️ This browser has no Picture-in-Picture shortcut support', 2400);
            return;
        }
        if (media.disablePictureInPicture) {
            showToast('⚠️ This site has turned off Picture-in-Picture', 2400);
            return;
        }
        media.requestPictureInPicture()
            .then(() => showToast('🖼️ Picture-in-Picture Active'))
            .catch(() => showToast('⚠️ Picture-in-Picture was blocked on this page', 2400));
    }

    // -------------------------------------------------------------------------
    // Note-taking tools: timestamps, links, screenshots, seeking, loop, frames
    // -------------------------------------------------------------------------
    async function copyText(text) {
        try {
            if (typeof GM_setClipboard === 'function') {
                GM_setClipboard(text, 'text');
                return true;
            }
        } catch (err) { /* fall through */ }
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (err) { /* fall through */ }
        try {
            const area = document.createElement('textarea');
            area.value = text;
            Object.assign(area.style, { position: 'fixed', top: '0', left: '0', opacity: '0' });
            (document.body || document.documentElement).appendChild(area);
            area.select();
            const ok = document.execCommand('copy');
            area.remove();
            return ok;
        } catch (err) {
            return false;
        }
    }

    // "12m34s" / "1h2m3s" style used by Vimeo and Twitch.
    function hms(total, always) {
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (always || h > 0) return `${h}h${m}m${s}s`;
        return m > 0 ? `${m}m${s}s` : `${s}s`;
    }

    // A link that reopens the video at the current time, where the site has a
    // known format; elsewhere the page URL with a #t=seconds media fragment.
    function timestampUrl(sec) {
        const t = Math.max(0, Math.floor(sec));
        let url;
        try { url = new URL(location.href); } catch (err) { return location.href; }
        const host = url.hostname.replace(/^(www|m)\./, '');

        if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
            let id = url.pathname === '/watch' ? url.searchParams.get('v') : null;
            if (!id) {
                const match = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{6,})/);
                if (match) id = match[1];
            }
            if (id) {
                const base = host === 'music.youtube.com' ? 'https://music.youtube.com' : 'https://www.youtube.com';
                return `${base}/watch?v=${id}&t=${t}s`;
            }
        }
        if (host === 'vimeo.com' || host === 'player.vimeo.com') {
            const match = url.pathname.match(/(?:^|\/)(\d{6,})(?:\/|$)/);
            if (match) return `https://vimeo.com/${match[1]}#t=${hms(t, false)}`;
        }
        if (host === 'twitch.tv') {
            const match = url.pathname.match(/^\/videos\/(\d+)/);
            if (match) return `https://www.twitch.tv/videos/${match[1]}?t=${hms(t, true)}`;
        }
        if (!url.hash || /^#t=/.test(url.hash)) url.hash = `t=${t}`;
        return url.toString();
    }

    async function copyTimestamp(media) {
        const stamp = fmtTime(media.currentTime);
        const ok = await copyText(stamp);
        showToast(ok ? `📋 Copied ${stamp}` : '⚠️ Could not copy to the clipboard');
    }

    async function copyTimestampLink(media) {
        const stamp = fmtTime(media.currentTime);
        const url = timestampUrl(media.currentTime).replace(/\(/g, '%28').replace(/\)/g, '%29');
        const ok = await copyText(`[${stamp}](${url})`);
        showToast(ok ? `🔗 Copied link at ${stamp}` : '⚠️ Could not copy to the clipboard');
    }

    function downloadBlob(blob, name) {
        try {
            const href = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = href;
            a.download = name;
            a.style.display = 'none';
            (document.body || document.documentElement).appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(href), 15000);
            return true;
        } catch (err) {
            return false;
        }
    }

    async function screenshot(media) {
        const BLOCKED = '⚠️ This video can\'t be captured (protected or cross-origin)';
        if (!isVideo(media) || !media.videoWidth) {
            showToast('⚠️ No video frame to capture');
            return;
        }
        if (media.mediaKeys) {
            showToast(BLOCKED, 2600);
            return;
        }
        const stamp = fmtTime(media.currentTime);
        let blobPromise;
        try {
            const canvas = document.createElement('canvas');
            canvas.width = media.videoWidth;
            canvas.height = media.videoHeight;
            canvas.getContext('2d').drawImage(media, 0, 0, canvas.width, canvas.height);
            blobPromise = new Promise((resolve, reject) => {
                try {
                    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('empty frame'))), 'image/png');
                } catch (err) {
                    reject(err);
                }
            });
        } catch (err) {
            showToast(BLOCKED, 2600);
            return;
        }
        blobPromise.catch(() => {});

        const Item = window.ClipboardItem;
        const canWrite = !!(Item && navigator.clipboard && navigator.clipboard.write);
        let copied = false;
        if (canWrite) {
            // Passing the promise keeps the write inside the key press (needed by Safari).
            try {
                await navigator.clipboard.write([new Item({ 'image/png': blobPromise })]);
                copied = true;
            } catch (err) { /* retried below */ }
        }
        let blob;
        try {
            blob = await blobPromise;
        } catch (err) {
            showToast(BLOCKED, 2600);
            return;
        }
        if (!copied && canWrite) {
            try {
                await navigator.clipboard.write([new Item({ 'image/png': blob })]);
                copied = true;
            } catch (err) { /* fall back to a file */ }
        }
        let saved = false;
        if (!copied || settings.downloadShots) {
            const title = (document.title || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'video';
            saved = downloadBlob(blob, `${title} ${hms(Math.floor(media.currentTime), false)}.png`);
        }
        if (copied && saved) showToast(`📸 Frame at ${stamp} copied and saved`);
        else if (copied) showToast(`📸 Frame at ${stamp} copied`);
        else if (saved) showToast(`📸 Frame at ${stamp} saved as PNG`);
        else showToast('⚠️ Could not copy or save the frame');
    }

    function seekBy(media, delta) {
        const max = isFinite(media.duration) ? media.duration : Infinity;
        const t = clampNum(media.currentTime + delta, 0, max);
        media.currentTime = t;
        showToast(`${delta < 0 ? '⏪ −' : '⏩ +'}${Math.abs(delta)}s · ${fmtTime(t)}`);
    }

    function frameStep(media, dir) {
        if (!isVideo(media)) {
            showToast('⚠️ Frame step needs a video');
            return;
        }
        if (!media.paused) media.pause();
        const max = isFinite(media.duration) ? media.duration : Infinity;
        const t = clampNum(media.currentTime + dir / settings.fps, 0, max);
        media.currentTime = t;
        showToast(`${dir > 0 ? '⏭️ Next' : '⏮️ Previous'} frame · ${fmtTime(t, true)}`);
    }

    // A-B loop: first press marks the start, second marks the end and starts
    // looping, third clears it.
    const loops = new WeakMap();
    const activeLoops = new Set();
    let loopTimer = null;

    function loopTick() {
        activeLoops.forEach((media) => {
            const lp = loops.get(media);
            if (!lp || lp.b === null || !media.isConnected) {
                activeLoops.delete(media);
                return;
            }
            if (media.currentTime >= lp.b) media.currentTime = lp.a;
        });
        if (!activeLoops.size && loopTimer !== null) {
            clearInterval(loopTimer);
            loopTimer = null;
        }
    }

    function clearLoop(media) {
        const had = loops.has(media);
        loops.delete(media);
        activeLoops.delete(media);
        return had;
    }

    function loopAction(media) {
        const lp = loops.get(media);
        const now = media.currentTime;
        if (!lp) {
            loops.set(media, { a: now, b: null });
            showToast(`🔁 Loop start ${fmtTime(now)} · press again to set the end`, 2200);
            return;
        }
        if (lp.b === null) {
            const a = Math.min(lp.a, now);
            const b = Math.max(lp.a, now);
            if (b - a < 0.25) {
                showToast('🔁 Loop end is too close to the start · press again a bit later', 2200);
                return;
            }
            lp.a = a;
            lp.b = b;
            activeLoops.add(media);
            if (loopTimer === null) loopTimer = setInterval(loopTick, 50);
            media.currentTime = a;
            showToast(`🔁 Looping ${fmtTime(a)} → ${fmtTime(b)}`, 2200);
            return;
        }
        clearLoop(media);
        showToast('🔁 Loop cleared');
    }

    // -------------------------------------------------------------------------
    // Per-site enable / disable
    // -------------------------------------------------------------------------
    let siteMenuId = null;
    const CAN_UNREGISTER = typeof GM_unregisterMenuCommand === 'function';

    function registerSiteMenu() {
        if (!IS_TOP || typeof GM_registerMenuCommand === 'undefined') return;
        const off = store.get('off:' + HOST, false) === true;
        if (!CAN_UNREGISTER) {
            if (siteMenuId === null) {
                siteMenuId = GM_registerMenuCommand(`Turn StreamFlow on/off for ${HOST}`, () => {
                    setSiteOff(store.get('off:' + HOST, false) !== true);
                });
            }
            return;
        }
        try { if (siteMenuId !== null) GM_unregisterMenuCommand(siteMenuId); } catch (err) { /* ignore */ }
        siteMenuId = GM_registerMenuCommand(`${off ? 'Enable' : 'Disable'} StreamFlow on ${HOST}`, () => setSiteOff(!off));
    }

    function setSiteOff(off) {
        if (off) {
            endBoost();
            store.set('off:' + HOST, true);
        } else {
            store.del('off:' + HOST);
        }
        siteOff = computeSiteOff();
        showToast(off ? `⏸️ StreamFlow disabled on ${HOST}` : `▶️ StreamFlow enabled on ${HOST}`, 2000);
        registerSiteMenu();
        if (panel.host) renderPanel();
    }

    // -------------------------------------------------------------------------
    // Settings panel (inline styles inside a shadow root, so neither the site's
    // CSS nor its Content Security Policy can interfere)
    // -------------------------------------------------------------------------
    const panel = { host: null, root: null, recording: null, note: '', focus: null };
    const UI = { bg: '#0f172a', field: '#1e293b', line: '#334155', text: '#e2e8f0', dim: '#94a3b8', accent: '#38bdf8' };

    function h(tag, style, props, kids) {
        const node = document.createElement(tag);
        if (style) Object.assign(node.style, style);
        if (props) {
            Object.keys(props).forEach((key) => {
                if (key === 'text') node.textContent = props[key];
                else node[key] = props[key];
            });
        }
        if (kids) kids.forEach((kid) => { if (kid) node.appendChild(kid); });
        return node;
    }

    const fromPanel = (e) => {
        if (!panel.host) return false;
        const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
        return e.target === panel.host || path.indexOf(panel.host) !== -1;
    };

    function openPanel() {
        if (panel.host) return;
        const parent = uiParent();
        if (!parent) return;
        const host = document.createElement('div');
        host.id = 'streamflow-settings';
        host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 2147483647;';
        let root = host;
        try { if (host.attachShadow) root = host.attachShadow({ mode: 'closed' }); } catch (err) { root = host; }
        // Keep clicks and edits inside the panel from reaching the page's own handlers.
        ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel', 'contextmenu', 'input', 'change']
            .forEach((type) => host.addEventListener(type, (ev) => ev.stopPropagation(), { passive: true }));
        panel.host = host;
        panel.root = root;
        panel.recording = null;
        panel.note = '';
        panel.focus = null;
        parent.appendChild(host);
        renderPanel();
    }

    function closePanel() {
        if (panel.host && panel.host.parentNode) panel.host.parentNode.removeChild(panel.host);
        panel.host = null;
        panel.root = null;
        panel.recording = null;
    }

    function renderPanel() {
        const root = panel.root;
        if (!root) return;
        while (root.firstChild) root.removeChild(root.firstChild);

        const fieldStyle = {
            font: 'inherit', color: UI.text, background: UI.field, border: `1px solid ${UI.line}`,
            borderRadius: '6px', boxSizing: 'border-box'
        };
        const buttonStyle = Object.assign({}, fieldStyle, { padding: '5px 10px', cursor: 'pointer', minWidth: '104px', textAlign: 'center', flex: '0 0 auto' });

        const row = (label, control, sub) => h('div', {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '5px 0'
        }, null, [
            h('div', { flex: '1 1 auto', minWidth: '0' }, null, [
                h('div', null, { text: label }),
                sub ? h('div', { color: UI.dim, fontSize: '12px' }, { text: sub }) : null
            ]),
            control
        ]);

        const heading = (text) => h('div', {
            color: UI.accent, fontSize: '12px', fontWeight: '700', letterSpacing: '0.06em',
            textTransform: 'uppercase', margin: '16px 0 4px', paddingTop: '12px', borderTop: `1px solid ${UI.line}`
        }, { text });

        const numberInput = (key, step) => {
            const min = LIMITS[key][0];
            const max = LIMITS[key][1];
            const input = h('input', Object.assign({}, fieldStyle, { padding: '5px 8px', width: '84px', flex: '0 0 auto' }), {
                type: 'number', min: String(min), max: String(max), step: String(step), value: String(settings[key])
            });
            input.addEventListener('change', () => {
                let v = parseFloat(input.value);
                if (!isFinite(v)) v = DEFAULTS[key];
                v = clampNum(round2(v), min, max);
                settings[key] = v;
                input.value = String(v);
                saveSettings();
            });
            return input;
        };

        const checkbox = (checked, onChange) => {
            const box = h('input', { width: '18px', height: '18px', margin: '0', cursor: 'pointer', accentColor: UI.accent, flex: '0 0 auto' }, {
                type: 'checkbox', checked: !!checked
            });
            box.addEventListener('change', () => onChange(box.checked));
            return box;
        };

        const settingBox = (key) => checkbox(settings[key], (value) => {
            settings[key] = value;
            saveSettings();
        });

        // Header
        const closeBtn = h('button', Object.assign({}, buttonStyle, { minWidth: '0', padding: '4px 10px' }), {
            type: 'button', text: 'Close', title: 'Close (Esc)'
        });
        closeBtn.addEventListener('click', closePanel);
        const header = h('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }, null, [
            h('div', null, null, [
                h('div', { fontSize: '17px', fontWeight: '700', color: '#f8fafc' }, { text: 'StreamFlow settings' }),
                h('div', { color: UI.dim, fontSize: '12px' }, { text: 'Changes save as you make them and apply on every site.' })
            ]),
            closeBtn
        ]);

        // Shortcuts
        const bindButtons = {};
        const shortcutRows = ACTIONS.map((a) => {
            const recording = panel.recording === a.id;
            const b = settings.bindings[a.id];
            const style = Object.assign({}, buttonStyle);
            if (recording) Object.assign(style, { borderColor: UI.accent, color: UI.accent });
            else if (!b) style.color = UI.dim;
            const btn = h('button', style, {
                type: 'button', text: recording ? 'Press keys…' : bindingLabel(b), title: 'Click, then press the new shortcut'
            });
            btn.addEventListener('click', () => {
                panel.recording = recording ? null : a.id;
                panel.note = recording ? '' : 'Press the new shortcut. Esc cancels, Backspace clears it.';
                panel.focus = a.id;
                renderPanel();
            });
            bindButtons[a.id] = btn;
            return row(a.label, btn);
        });
        const note = h('div', { color: UI.accent, fontSize: '12px', minHeight: '17px', padding: '4px 0 0' }, { text: panel.note || '' });

        // Options
        const options = [
            row('Speed step', numberInput('step', 0.05), 'How much the slower and faster keys change the speed'),
            row('Boost speed', numberInput('boostSpeed', 0.25), 'Speed while the boost key is held down'),
            row('Replay jump (seconds)', numberInput('replaySeconds', 1)),
            row('Skip jump (seconds)', numberInput('skipSeconds', 1)),
            row('Frame rate for frame step', numberInput('fps', 1), 'Match the video\'s FPS to move exactly one frame'),
            row('Remember speed per site', settingBox('rememberSpeed'), 'Reapplies your speed when the next video loads'),
            row('Show time remaining in the HUD', settingBox('showRemaining')),
            row('Also save screenshots as PNG files', settingBox('downloadShots'), 'Screenshots are copied to the clipboard whenever the browser allows it')
        ];

        // This site
        const ownOff = store.get('off:' + HOST, false) === true;
        const siteRows = [row(`Enabled on ${HOST}`, checkbox(!ownOff, (value) => setSiteOff(!value)))];
        if (siteRate !== null) {
            const forget = h('button', buttonStyle, { type: 'button', text: 'Forget' });
            forget.addEventListener('click', () => {
                siteRate = null;
                store.del('speed:' + HOST);
                renderPanel();
            });
            siteRows.push(row(`Saved speed: ${siteRate.toFixed(2)}x`, forget));
        } else {
            siteRows.push(h('div', { color: UI.dim, padding: '5px 0' }, { text: 'No saved speed for this site yet.' }));
        }

        // Footer
        const restore = h('button', buttonStyle, { type: 'button', text: 'Restore defaults' });
        restore.addEventListener('click', () => {
            settings = Object.assign({}, DEFAULTS, { bindings: {} });
            ACTIONS.forEach((a) => { settings.bindings[a.id] = a.def; });
            saveSettings();
            panel.recording = null;
            panel.note = 'Defaults restored.';
            renderPanel();
        });
        const footer = h('div', {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
            marginTop: '16px', paddingTop: '12px', borderTop: `1px solid ${UI.line}`
        }, null, [
            h('div', { color: UI.dim, fontSize: '12px' }, { text: `StreamFlow v${VERSION}` }),
            restore
        ]);

        const card = h('div', {
            background: UI.bg, color: UI.text, border: '1px solid rgba(56, 189, 248, 0.3)', borderRadius: '12px',
            boxShadow: '0 12px 40px rgba(0,0,0,0.5)', width: 'min(540px, calc(100vw - 32px))',
            maxHeight: 'calc(100vh - 48px)', overflowY: 'auto', padding: '18px 20px', boxSizing: 'border-box',
            colorScheme: 'dark'
        }, null, [header, heading('Shortcuts')].concat(shortcutRows, [note, heading('Options')], options, [heading('This site')], siteRows, [footer]));

        const backdrop = h('div', {
            position: 'absolute', top: '0', left: '0', right: '0', bottom: '0', display: 'flex',
            alignItems: 'center', justifyContent: 'center', background: 'rgba(2, 6, 23, 0.6)',
            fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: '14px', lineHeight: '1.4', color: UI.text
        }, null, [card]);
        backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) closePanel(); });
        root.appendChild(backdrop);

        const target = (panel.focus && bindButtons[panel.focus]) || closeBtn;
        try { target.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
        panel.focus = null;
    }

    // A key pressed while a shortcut button is waiting for input.
    function recordKey(e) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.isComposing || MODIFIER_KEYS.test(e.key || '')) return;
        const id = panel.recording;
        panel.recording = null;
        panel.focus = id;
        panel.note = '';
        if (e.key === 'Escape') {
            renderPanel();
            return;
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
            settings.bindings[id] = null;
            saveSettings();
            renderPanel();
            return;
        }
        const b = bindingFromEvent(e);
        if (b.type === 'combo' && !b.id) {
            panel.note = 'That key can\'t be used as a shortcut.';
            renderPanel();
            return;
        }
        const bumped = [];
        ACTIONS.forEach((a) => {
            if (a.id !== id && bindingsClash(settings.bindings[a.id], b)) {
                settings.bindings[a.id] = null;
                bumped.push(a.label);
            }
        });
        settings.bindings[id] = b;
        if (bumped.length) panel.note = `That shortcut was used by "${bumped.join('", "')}", which is now unassigned.`;
        saveSettings();
        renderPanel();
    }

    // -------------------------------------------------------------------------
    // Keyboard handling
    // -------------------------------------------------------------------------
    function isTyping(e) {
        // composedPath sees through shadow DOM, where e.target is only the host.
        const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
        const el = path.length && path[0] && path[0].nodeType === 1 ? path[0] : e.target;
        if (!el || el.nodeType !== 1) return false;
        const tag = el.tagName ? el.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        if (el.isContentEditable) return true;
        const role = el.getAttribute ? el.getAttribute('role') : null;
        if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
        return document.designMode === 'on';
    }

    function runAction(action, media, e) {
        const once = !e.repeat; // actions that should not fire again while a key is held
        switch (action) {
            case 'faster': stepSpeed(media, 1); break;
            case 'slower': stepSpeed(media, -1); break;
            case 'reset': resetSpeed(media); break;
            case 'toggle': if (once) toggleSpeed(media); break;
            case 'boost': if (once) startBoost(media, e); break;
            case 'pip': if (once) togglePip(media); break;
            case 'copyTime': if (once) copyTimestamp(media); break;
            case 'copyLink': if (once) copyTimestampLink(media); break;
            case 'screenshot': if (once) screenshot(media); break;
            case 'replay': seekBy(media, -settings.replaySeconds); break;
            case 'skip': seekBy(media, settings.skipSeconds); break;
            case 'loop': if (once) loopAction(media); break;
            case 'framePrev': frameStep(media, -1); break;
            case 'frameNext': frameStep(media, 1); break;
            case 'settings': if (once) openPanel(); break;
        }
    }

    window.addEventListener('keydown', (e) => {
        if (panel.host) {
            if (panel.recording) {
                recordKey(e);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closePanel();
                return;
            }
            if (fromPanel(e)) {
                e.stopPropagation(); // typing in the panel must not trigger the site's hotkeys
                return;
            }
        }
        if (siteOff || e.isComposing) return;
        if (isTyping(e)) return;

        const action = matchAction(e);
        if (!action) return;

        const video = getActiveVideo();
        if (!video) return;

        e.preventDefault();
        e.stopPropagation();
        lastActive = video;
        runAction(action, video, e);
    }, true);

    window.addEventListener('keyup', (e) => {
        if (fromPanel(e)) {
            e.stopPropagation();
            return;
        }
        if (boost.active && e.code === boost.code) {
            e.preventDefault();
            e.stopPropagation();
            endBoost();
        }
    }, true);

    window.addEventListener('keypress', (e) => {
        if (fromPanel(e)) e.stopPropagation();
    }, true);

    // Release temporary boost key if focus leaves the window (hooked into Module 1)
    onWindowBlurHook = endBoost;

    // -------------------------------------------------------------------------
    // Wiring
    // -------------------------------------------------------------------------
    MEDIA_EVENTS.forEach((type) => document.addEventListener(type, onMediaEvent, true));
    document.addEventListener('fullscreenchange', reparentUi);
    document.addEventListener('webkitfullscreenchange', reparentUi);
    window.addEventListener('pointerdown', scheduleDeepScan, { capture: true, passive: true });

    store.watch('settings', () => {
        settings = loadSettings();
        if (panel.host && !panel.recording) renderPanel();
    });
    store.watch('speed:' + HOST, (value) => { siteRate = validRate(value) ? value : null; });
    const refreshSiteOff = () => {
        siteOff = computeSiteOff();
        if (siteOff) endBoost();
        registerSiteMenu();
    };
    store.watch('off:' + HOST, refreshSiteOff);
    if (TOP_HOST !== HOST) store.watch('off:' + TOP_HOST, refreshSiteOff);

    if (typeof GM_registerMenuCommand !== 'undefined' && IS_TOP) {
        GM_registerMenuCommand('Test HUD Notification', () => showToast('⚡ StreamFlow Active (1.00x)'));
        GM_registerMenuCommand('StreamFlow Settings', openPanel);
        registerSiteMenu();
    }

    // Media that loaded before or after document-start.
    const initScan = () => {
        document.querySelectorAll('video, audio').forEach((media) => {
            if (media.readyState >= 1) onLoaded(media);
        });
        deepScan();
        setTimeout(deepScan, 2500);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initScan, { once: true });
    } else {
        initScan();
    }
})();