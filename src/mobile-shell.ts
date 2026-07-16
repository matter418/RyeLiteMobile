// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// Mobile presentation shell for @ryelite/core's panel system.
//
// The core builds a RuneLite-style desktop sidebar: an icon strip
// (.highlite_bar) and a slide-out drawer (.highlite_bar_selected_content),
// both appended to the game's #main. This shell REPARENTS those two elements
// into a fullscreen overlay (bar → horizontal tab strip, drawer → body); all
// core click handlers keep working and plugins that add panels later just
// appear as new tabs.
//
// Entry points: (1) an "Open RyeLite Mobile Settings" link injected into
// the game's own settings menu (#hs-settings-menu), styled to match its
// native sections, placed above the Graphics section; (2) a ⚙️ gear
// top-left of the login screen (only the 📱 Mobile tab is offered there —
// core plugin settings are per-username and there's no username yet).

import './css/mobile-shell.css';
import { BackgroundMode } from './background-mode';
import { setTabBarHidden } from './native-bridge';
import { idleSettings, saveIdleSettings, playIdleChime } from './idle-watch';
import { touchSettings, saveTouchSettings } from './touch-input';
import {
    uiSettings,
    saveUiSettings,
    applyViewport,
    applyEdgeInset,
    applyElementScales,
    naturalWidth,
    shellScale,
} from './ui-scale';

// Register the shell's own "📱 Mobile" panel through the same core API
// plugins use, so it appears as a native tab in the overlay.
function buildMobilePanel(): void {
    const panelManager = (document as any).highlite?.managers?.PanelManager;
    if (!panelManager?.requestMenuItem) {
        console.warn('[RyeLite Mobile] PanelManager not available; Mobile panel skipped.');
        return;
    }

    let icon: HTMLElement;
    let page: HTMLElement;
    try {
        [icon, page] = panelManager.requestMenuItem('📱', 'Mobile');
    } catch {
        return; // already registered (e.g. re-init)
    }

    // Mobile settings are the panel users want most on a phone: move the tab
    // to the front of the bar (core appended it after Plugin Hub / Settings),
    // which also makes it the panel openOverlay lands on by default.
    icon.classList.add('rlm-mobile-tab');
    icon.parentElement?.prepend(icon);

    page.style.display = 'flex';
    page.style.flexDirection = 'column';
    page.style.gap = '14px';
    page.style.padding = '12px';
    page.style.background = 'var(--theme-background)';
    page.style.color = 'var(--theme-text-primary)';
    page.style.font = '14px Inter, system-ui, sans-serif';

    // Shown only pre-login (the overlay's .rlm-login-only mode) — tells the
    // user where to find these settings once they're in-game.
    const loginNote = document.createElement('div');
    loginNote.className = 'rlm-login-note';
    loginNote.textContent =
        'Once logged in, you can also open these settings from the ' +
        'HighSpell settings menu (⚙️ → "Open RyeLite Mobile Settings").';
    page.appendChild(loginNote);

    const row = (label: string, control: HTMLElement) => {
        const r = document.createElement('label');
        r.style.display = 'flex';
        r.style.alignItems = 'center';
        r.style.justifyContent = 'space-between';
        r.style.gap = '12px';
        // Cap the row width — full-bleed rows on a landscape phone put the
        // controls a whole screen away from their labels.
        r.style.maxWidth = '520px';
        r.style.boxSizing = 'border-box';
        r.style.padding = '10px 12px';
        r.style.background = 'var(--theme-background-mute)';
        r.style.borderRadius = '10px';
        const span = document.createElement('span');
        span.textContent = label;
        r.appendChild(span);
        r.appendChild(control);
        page.appendChild(r);
        return r;
    };

    // Tap & hold translation on/off
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = touchSettings.enabled;
    enabled.addEventListener('change', () => {
        touchSettings.enabled = enabled.checked;
        saveTouchSettings();
    });
    row('Tap = left click, hold = right click', enabled);

    // Long-press delay
    const delayWrap = document.createElement('div');
    delayWrap.style.display = 'flex';
    delayWrap.style.alignItems = 'center';
    delayWrap.style.gap = '8px';
    const delay = document.createElement('input');
    delay.type = 'range';
    delay.min = '200';
    delay.max = '800';
    delay.step = '50';
    delay.value = String(touchSettings.longPressMs);
    delay.style.width = '140px';
    const delayVal = document.createElement('span');
    delayVal.textContent = `${touchSettings.longPressMs}ms`;
    delayVal.style.minWidth = '52px';
    delayVal.style.textAlign = 'right';
    delay.addEventListener('input', () => {
        touchSettings.longPressMs = Number(delay.value);
        delayVal.textContent = `${delay.value}ms`;
        saveTouchSettings();
    });
    delayWrap.appendChild(delay);
    delayWrap.appendChild(delayVal);
    row('Hold delay', delayWrap);

    // Desktop UI size: percent of native scale; smaller % = wider virtual
    // viewport = more room for the desktop layout (and smaller game UI).
    const scaleWrap = document.createElement('div');
    scaleWrap.style.display = 'flex';
    scaleWrap.style.alignItems = 'center';
    scaleWrap.style.gap = '8px';
    const scale = document.createElement('input');
    scale.type = 'range';
    scale.min = '55';
    scale.max = '100';
    scale.step = '5';
    const currentPct = Math.round(
        (naturalWidth() / Math.max(uiSettings.viewportWidth, naturalWidth())) * 100
    );
    scale.value = String(currentPct);
    scale.style.width = '140px';
    const scaleVal = document.createElement('span');
    // read back from the input — the browser snaps the value to step=5
    scaleVal.textContent = `${scale.value}%`;
    scaleVal.style.minWidth = '52px';
    scaleVal.style.textAlign = 'right';
    scale.addEventListener('change', () => {
        const pct = Number(scale.value);
        scaleVal.textContent = `${pct}%`;
        uiSettings.viewportWidth =
            pct >= 100 ? 0 : Math.round((naturalWidth() * 100) / pct);
        saveUiSettings();
        applyViewport();
    });
    row('Game UI size', scaleWrap);
    scaleWrap.appendChild(scale);
    scaleWrap.appendChild(scaleVal);

    // Per-element scale sliders: the logout button, context menus, and the
    // chat input bar stay desktop-sized under the virtual viewport, so they
    // get their own enlargement (100% and up) independent of Game UI size.
    const elementScaleRow = (
        label: string,
        get: () => number,
        set: (pct: number) => void
    ) => {
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.alignItems = 'center';
        wrap.style.gap = '8px';
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '100';
        slider.max = '250';
        slider.step = '10';
        slider.value = String(get());
        slider.style.width = '140px';
        const val = document.createElement('span');
        // read back from the input — the browser snaps the value to the step
        val.textContent = `${slider.value}%`;
        val.style.minWidth = '52px';
        val.style.textAlign = 'right';
        slider.addEventListener('input', () => {
            set(Number(slider.value));
            val.textContent = `${slider.value}%`;
            saveUiSettings();
            applyElementScales();
        });
        wrap.appendChild(slider);
        wrap.appendChild(val);
        row(label, wrap);
    };
    elementScaleRow(
        'Logout button size',
        () => uiSettings.logoutScale,
        pct => (uiSettings.logoutScale = pct)
    );
    elementScaleRow(
        'Context menu size',
        () => uiSettings.contextMenuScale,
        pct => (uiSettings.contextMenuScale = pct)
    );
    elementScaleRow(
        'Chat bar size',
        () => uiSettings.chatInputScale,
        pct => (uiSettings.chatInputScale = pct)
    );

    // Screen edge margin: pulls the game in from curved screen edges so
    // corner buttons (logout, settings) stay tappable.
    const insetWrap = document.createElement('div');
    insetWrap.style.display = 'flex';
    insetWrap.style.alignItems = 'center';
    insetWrap.style.gap = '8px';
    const inset = document.createElement('input');
    inset.type = 'range';
    inset.min = '0';
    inset.max = '96';
    inset.step = '4';
    inset.value = String(uiSettings.edgeInset);
    inset.style.width = '140px';
    const insetVal = document.createElement('span');
    insetVal.textContent = `${inset.value}px`;
    insetVal.style.minWidth = '52px';
    insetVal.style.textAlign = 'right';
    inset.addEventListener('input', () => {
        uiSettings.edgeInset = Number(inset.value);
        insetVal.textContent = `${inset.value}px`;
        saveUiSettings();
        applyEdgeInset();
    });
    insetWrap.appendChild(inset);
    insetWrap.appendChild(insetVal);
    row('Screen edge margin', insetWrap);

    // Keep the game alive while in another app (Glimmer-style foreground
    // service; see background-mode.ts). Truth lives native-side, so the
    // checkbox is corrected asynchronously once the real value arrives.
    const keepAlive = document.createElement('input');
    keepAlive.type = 'checkbox';
    keepAlive.checked = true;
    BackgroundMode.getEnabled()
        .then(({ enabled }) => (keepAlive.checked = enabled))
        .catch(() => {});
    keepAlive.addEventListener('change', () => {
        BackgroundMode.setEnabled({ enabled: keepAlive.checked }).catch(() => {});
    });
    row('Keep game alive in background', keepAlive);

    // --- Idle alert (standalone; see idle-watch.ts) --------------------
    const idleEnabled = document.createElement('input');
    idleEnabled.type = 'checkbox';
    idleEnabled.checked = idleSettings.enabled;
    idleEnabled.addEventListener('change', () => {
        idleSettings.enabled = idleEnabled.checked;
        saveIdleSettings();
    });
    row('Idle alert', idleEnabled);

    const idleVolWrap = document.createElement('div');
    idleVolWrap.style.display = 'flex';
    idleVolWrap.style.alignItems = 'center';
    idleVolWrap.style.gap = '8px';
    const idleVol = document.createElement('input');
    idleVol.type = 'range';
    idleVol.min = '0';
    idleVol.max = '100';
    idleVol.step = '5';
    idleVol.value = String(idleSettings.volume);
    idleVol.style.width = '140px';
    const idleVolVal = document.createElement('span');
    idleVolVal.textContent = `${idleVol.value}%`;
    idleVolVal.style.minWidth = '52px';
    idleVolVal.style.textAlign = 'right';
    idleVol.addEventListener('input', () => {
        idleSettings.volume = Number(idleVol.value);
        idleVolVal.textContent = `${idleVol.value}%`;
        saveIdleSettings();
    });
    // Preview the chime at the chosen volume when the slider is released.
    idleVol.addEventListener('change', () => playIdleChime(idleSettings.volume));
    idleVolWrap.appendChild(idleVol);
    idleVolWrap.appendChild(idleVolVal);
    row('Idle alert volume', idleVolWrap);

    const idleOverlay = document.createElement('input');
    idleOverlay.type = 'checkbox';
    idleOverlay.checked = idleSettings.overlay;
    idleOverlay.addEventListener('change', () => {
        idleSettings.overlay = idleOverlay.checked;
        saveIdleSettings();
    });
    row('Idle alert red overlay', idleOverlay);

    const idleDelayWrap = document.createElement('div');
    idleDelayWrap.style.display = 'flex';
    idleDelayWrap.style.alignItems = 'center';
    idleDelayWrap.style.gap = '8px';
    const idleDelay = document.createElement('input');
    idleDelay.type = 'range';
    idleDelay.min = '3';
    idleDelay.max = '30';
    idleDelay.step = '1';
    idleDelay.value = String(idleSettings.delaySeconds);
    idleDelay.style.width = '140px';
    const idleDelayVal = document.createElement('span');
    idleDelayVal.textContent = `${idleDelay.value}s`;
    idleDelayVal.style.minWidth = '52px';
    idleDelayVal.style.textAlign = 'right';
    idleDelay.addEventListener('input', () => {
        idleSettings.delaySeconds = Number(idleDelay.value);
        idleDelayVal.textContent = `${idleDelay.value}s`;
        saveIdleSettings();
    });
    idleDelayWrap.appendChild(idleDelay);
    idleDelayWrap.appendChild(idleDelayVal);
    row('Idle alert delay', idleDelayWrap);

    const hint = document.createElement('div');
    hint.style.color = 'var(--theme-text-muted)';
    hint.style.fontSize = '12px';
    hint.style.maxWidth = '520px';
    hint.textContent =
        'Tap & hold applies to the 3D world and inventory items; drag rotates the camera and pinch zooms it. ' +
        'While "Keep game alive" is on, a silent notification appears whenever the app is in the background. ' +
        'Idle alert pings and flashes the tab number when a character finishes its action — including tabs you are not viewing. ' +
        'Disable the Idle Alert Hub plugin if you use it, or you will hear two sounds.';
    page.appendChild(hint);
}

export function initMobileShell(): void {
    buildMobilePanel();

    const bar = document.querySelector<HTMLElement>('.highlite_bar');
    const drawer = document.querySelector<HTMLElement>(
        '.highlite_bar_selected_content'
    );
    if (!bar || !drawer) {
        console.warn(
            '[RyeLite Mobile] Panel bar not found — is the core started? Shell not installed.'
        );
        return;
    }

    // ------------------------------------------------------------------
    // Overlay
    // ------------------------------------------------------------------

    const overlay = document.createElement('div');
    overlay.id = 'ryelite-mobile-overlay';

    const header = document.createElement('div');
    header.className = 'rlm-header';

    const closeBtn = document.createElement('div');
    closeBtn.className = 'rlm-close';
    closeBtn.textContent = '✕';

    // Close button on the LEFT: the far right edge is curved glass and hard
    // to hit (user report). The native tab bar that used to own the top-left
    // corner is hidden while the overlay is open, so the corner is free.
    header.appendChild(closeBtn);
    header.appendChild(bar); // reparent: icon strip -> tab strip
    overlay.appendChild(header);
    overlay.appendChild(drawer); // reparent: drawer -> overlay body

    const emptyHint = document.createElement('div');
    emptyHint.className = 'rlm-empty-hint';
    emptyHint.textContent = 'Select a panel above';
    overlay.appendChild(emptyHint);

    document.body.appendChild(overlay);

    // The game's global handlers must never see interactions inside the
    // overlay. Bubble phase — the core's own target-phase handlers (icon
    // onclick etc.) run first. No preventDefault, so text inputs still type.
    const SHIELDED_EVENTS = [
        'keydown',
        'keyup',
        'keypress',
        'pointerdown',
        'pointerup',
        'pointermove',
        'mousedown',
        'mouseup',
        'click',
        'contextmenu',
        'touchstart',
        'touchmove',
        'touchend',
        'wheel',
    ] as const;
    for (const type of SHIELDED_EVENTS) {
        overlay.addEventListener(type, e => e.stopPropagation());
    }

    // Reflect the active panel on the tab strip. The truth is core's
    // PanelManager.currentMenuItem (the icon string of the open panel; the
    // drawer keeps its content across overlay close/reopen, so deriving the
    // highlight from anything else drifts — reopening used to mark 📱 while
    // the drawer still showed another panel).
    function syncTabHighlight() {
        const current = (document as any).highlite?.managers?.PanelManager
            ?.currentMenuItem;
        const activated = drawer!.classList.contains('activated');
        bar!.querySelectorAll('.highlite_bar_item').forEach(item =>
            item.classList.toggle(
                'rlm-active',
                activated && item.innerHTML === current
            )
        );
        emptyHint.style.display = activated ? 'none' : '';
    }
    new MutationObserver(syncTabHighlight).observe(drawer, {
        attributes: true,
        attributeFilter: ['class'],
    });
    // Bubble phase: core's own onclick (on the item) has already updated
    // currentMenuItem by the time this runs. Needed because clicking between
    // tabs doesn't change the drawer's class, so the observer won't fire.
    bar.addEventListener('click', e => {
        syncTabHighlight();
        // The World Map plugin (Hub) hijacks its 🗺️ icon's onclick: instead
        // of opening a panel page it toggles a floating iframe window
        // (.highlite-map, z-index 1000) — far below this overlay, so the tap
        // looked like it did nothing. If the tap left the map visible, get
        // out of its way. (Toggled hidden → stay; scoped to the 🗺️ item so
        // a map left open behind the game never closes the overlay.)
        const item = (e.target as HTMLElement).closest('.highlite_bar_item');
        // Codepoint check, not string equality — the icon is registered with
        // a trailing variation selector (\u{1F5FA}️).
        if (item?.innerHTML.includes('\u{1F5FA}')) {
            const map = document.querySelector<HTMLElement>('.highlite-map');
            if (map && map.style.visibility !== 'hidden') closeOverlay();
        }
    });

    function selectTab(item: HTMLElement) {
        item.click();
        syncTabHighlight();
    }

    // The native multi-account tab bar lives in Android view space, above
    // ALL page content — it draws over the overlay's header and cuts off the
    // panel tabs. Hide it while the overlay is open. The hide is a native
    // LEASE (~3.5 s, TabManager.setBarHidden) renewed every second here, so
    // a page that reloads or dies with the overlay open can never strand the
    // bar hidden — the native watchdog restores it once renewals stop.
    let barHideRenewal: number | undefined;

    function openOverlay() {
        setTabBarHidden(true);
        if (barHideRenewal === undefined) {
            barHideRenewal = window.setInterval(() => setTabBarHidden(true), 1000);
        }
        // Pre-login (no #hs-screen-mask) only the 📱 Mobile tab is offered:
        // core stores plugin settings per-username and there's no username
        // at the login screen, so Hub/Settings edits could land on the wrong
        // account. Mobile settings are device-wide localStorage — safe.
        const atLogin = !document.getElementById('hs-screen-mask');
        overlay.classList.toggle('rlm-login-only', atLogin);
        overlay.classList.add('rlm-open');
        // Auto-open the first panel (📱 Mobile) so the user never lands on a
        // blank page
        if (!drawer!.classList.contains('activated')) {
            const first = bar!.querySelector<HTMLElement>('.highlite_bar_item');
            if (first) selectTab(first);
        } else if (atLogin) {
            // A non-Mobile panel can be left open from the last session; its
            // tab is hidden while logged out, so force the Mobile panel.
            // (Guarded on the title — clicking the already-current tab would
            // toggle the drawer closed.)
            const title = drawer!.querySelector('#selectedContentTitle');
            const mobileTab = bar!.querySelector<HTMLElement>('.rlm-mobile-tab');
            if (mobileTab && title && title.textContent !== 'Mobile') {
                selectTab(mobileTab);
            }
        }
        syncTabHighlight();
    }

    function closeOverlay() {
        overlay.classList.remove('rlm-open');
        if (barHideRenewal !== undefined) {
            window.clearInterval(barHideRenewal);
            barHideRenewal = undefined;
        }
        setTabBarHidden(false);
    }

    closeBtn.addEventListener('pointerup', closeOverlay);

    // ------------------------------------------------------------------
    // Entry point: link inside the game's own settings menu, styled like
    // its native sections, inserted above the Graphics section.
    // ------------------------------------------------------------------

    const SECTION_ID = 'rlm-settings-section';

    function bindClick(el: HTMLElement, handler: () => void) {
        // The game overlays a click-blocking mask over its UI; this is the
        // canonical way to make injected controls clickable (same as
        // ChatEnhancer / Chat+).
        const uiManager = (document as any).highlite?.managers?.UIManager;
        if (uiManager?.bindOnClickBlockHsMask) {
            uiManager.bindOnClickBlockHsMask(el, handler);
        } else {
            el.addEventListener('click', handler);
        }
    }

    function injectSettingsLink(): boolean {
        const menu = document.getElementById('hs-settings-menu');
        if (!menu || document.getElementById(SECTION_ID)) return !!menu;

        const sections = Array.from(
            menu.querySelectorAll('.hs-settings-menu__section')
        );
        const graphics = sections.find(s => s.textContent?.includes('Graphics'));

        const section = document.createElement('div');
        section.className = 'hs-settings-menu__section';
        section.id = SECTION_ID;

        const title = document.createElement('span');
        title.className = 'hs-text--yellow';
        title.textContent = 'RyeLite';

        const link = document.createElement('span');
        link.className = 'hs-text--cyan hs-text-button';
        link.textContent = 'Open RyeLite Mobile Settings';
        bindClick(link, openOverlay);

        section.appendChild(title);
        section.appendChild(link);

        if (graphics) {
            graphics.parentElement!.insertBefore(section, graphics);
        } else {
            menu.appendChild(section);
        }
        console.log('[RyeLite Mobile] Settings link injected into game menu.');
        return true;
    }

    // ------------------------------------------------------------------
    // Entry point #2: settings gear top-left of the login screen, so mobile
    // settings are editable before logging in. Same lifecycle pattern as
    // world-select: exists only at the login screen (absence of
    // #hs-screen-mask), removed in-world, recreated on the post-logout
    // rebuild. Sized in rem like the world picker (touch target under the
    // virtual viewport).
    // ------------------------------------------------------------------

    const GEAR_ID = 'rlm-login-settings';

    function maybeLoginGear(): void {
        const atLoginScreen =
            !document.getElementById('hs-screen-mask') &&
            !!document.querySelector('#login-screen-container');
        const gear = document.getElementById(GEAR_ID);
        if (!atLoginScreen) {
            gear?.remove();
            return;
        }
        if (gear) return;
        const container = document.querySelector('#game-container');
        if (!container) return;

        const btn = document.createElement('div');
        btn.id = GEAR_ID;
        btn.textContent = '⚙️';
        btn.style.position = 'absolute';
        // Below the native multi-account tab bar, which owns the top-left
        // corner (it lives in Android view space, above all page content).
        btn.style.top = '4.5rem';
        btn.style.left = '0';
        btn.style.margin = '1rem';
        btn.style.zIndex = '1000';
        btn.style.display = 'flex';
        btn.style.alignItems = 'center';
        btn.style.justifyContent = 'center';
        btn.style.width = '4rem';
        btn.style.height = '4rem';
        btn.style.fontSize = '2.2rem';
        btn.style.background = 'rgba(34, 34, 34, 0.85)';
        btn.style.backdropFilter = 'blur(6px)';
        btn.style.borderRadius = '1.25rem';
        btn.style.boxShadow = '0 2px 12px 0 rgba(0,0,0,0.18)';
        btn.style.cursor = 'pointer';
        btn.style.userSelect = 'none';
        btn.style.webkitUserSelect = 'none';
        btn.addEventListener('click', openOverlay);
        container.appendChild(btn);
    }

    // ------------------------------------------------------------------
    // World Map plugin (Hub) mobile repairs. The plugin's floating window
    // (.highlite-map) embeds https://highlite.dev/map — and highlite.dev
    // has NO DNS record any more (ERR_NAME_NOT_RESOLVED; the plugin is
    // broken on desktop too). RyeLite hosts the same map app at
    // www.ryelite.org/map with the identical postMessage marker protocol
    // ({X, Y, lvl} — verified in its bundle), so rewrite the iframe there.
    // Also inflate the plugin's 10×10px ✕ into a tappable target.
    // ------------------------------------------------------------------

    function fixWorldMapWindow(): void {
        const win = document.querySelector<HTMLElement>('.highlite-map');
        if (!win || win.dataset.rlmMobileFixed) return;
        win.dataset.rlmMobileFixed = '1';
        // The plugin's 50vh × 50vw default wastes a landscape phone screen —
        // near-fullheight gives the map real estate (user request). Only the
        // creation-time inline size is touched; interact.js drag/resize
        // still works from here.
        win.style.height = '90vh';
        win.style.top = '5vh';
        win.style.width = '62vw';
        win.style.left = '19vw';
        const frame = win.querySelector('iframe');
        if (frame && frame.src.includes('highlite.dev/map')) {
            const query = frame.src.split('?')[1];
            frame.src =
                'https://www.ryelite.org/map' + (query ? `?${query}` : '');
            // The plugin only re-sends the player marker when the player
            // MOVES (it diffs against its previousPosition), and its first
            // send went to the dead iframe — kick one position message into
            // the live map on load, in the plugin's own {X, Y, lvl} shape.
            frame.addEventListener('load', () => {
                try {
                    const player = (document as any).highlite?.gameHooks
                        ?.EntityManager?.Instance?.MainPlayer;
                    const pos = player?.CurrentGamePosition;
                    if (!pos) return;
                    const lvl =
                        player.CurrentMapLevel == 1
                            ? 'Overworld'
                            : player.CurrentMapLevel == 0
                              ? 'Underworld'
                              : 'Sky';
                    frame.contentWindow?.postMessage(
                        { X: pos.X + 512, Y: pos.Z + 512, lvl },
                        '*'
                    );
                } catch {
                    /* marker syncs on next movement instead */
                }
            });
        }
        const close = [...win.querySelectorAll<HTMLElement>('div')].find(
            d => d.textContent?.trim() === '✕'
        );
        if (close) {
            close.style.width = '34px';
            close.style.height = '34px';
            close.style.fontSize = '20px';
        }
    }

    // The settings menu may not exist yet (login screen), and the game's
    // relogin UI re-init REPLACES #hs-settings-menu with a fresh element —
    // so observing the menu node itself goes stale. Watch the body instead
    // and re-inject whenever the link is missing (getElementById only sees
    // connected nodes, so a wiped/replaced menu re-triggers injection).
    // The same observer drives the login-screen gear lifecycle and the
    // World Map window repairs (its div is created lazily on first open,
    // and recreated if the plugin is stopped/started).
    injectSettingsLink();
    maybeLoginGear();
    new MutationObserver(() => {
        injectSettingsLink();
        maybeLoginGear();
        fixWorldMapWindow();
    }).observe(document.body, {
        childList: true,
        subtree: true,
    });

    // Counter-scale the overlay so it stays finger-sized when the virtual
    // desktop viewport makes CSS pixels physically smaller.
    function rescaleShell() {
        const k = shellScale();
        (overlay.style as unknown as { zoom: string }).zoom = String(k);
    }
    rescaleShell();
    window.addEventListener('resize', rescaleShell);

    console.log('[RyeLite Mobile] Mobile shell installed.');
}
