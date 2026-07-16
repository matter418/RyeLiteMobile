// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// Virtual desktop viewport for the game's desktop-mode layout.
//
// A phone viewport (997x448 CSS px on the Pixel @3x) is far below the ~768px
// height the desktop layout assumes, so windows overlap (bank over minimap,
// etc.). Rendering at a wider virtual viewport (browser scales to fit) gives
// the layout the room it expects. Requires useWideViewPort(true) in
// MainActivity — the WebView ignores <meta viewport width=N> otherwise.

const KEY = 'ryelite-mobile-ui';

export interface UiSettings {
    /** Virtual viewport width in CSS px. 0 = native device width. */
    viewportWidth: number;
    /**
     * Horizontal page padding in CSS px, pulling the game UI in from the
     * physical screen edges — corner buttons (logout, settings) are otherwise
     * unreachable under curved glass. 0 = edge-to-edge.
     */
    edgeInset: number;
    /**
     * Extra scale (percent, 100 = game default; all scales are >= 100 —
     * enlarge only) for the logout button, which is desktop-sized and hard
     * to hit once the virtual viewport shrinks CSS pixels.
     */
    logoutScale: number;
    /** Extra scale (percent) for context menus (world, item, and logout —
     *  the game shares one menu element for all of them). */
    contextMenuScale: number;
    /** Extra scale (percent) for the chat input bar (tap-to-type row). */
    chatInputScale: number;
}

export const uiSettings: UiSettings = {
    viewportWidth: 1280,
    edgeInset: 0,
    logoutScale: 100,
    contextMenuScale: 100,
    chatInputScale: 100,
    ...((): Partial<UiSettings> => {
        try {
            return JSON.parse(localStorage.getItem(KEY) || '{}');
        } catch {
            return {};
        }
    })(),
};

export function saveUiSettings(): void {
    localStorage.setItem(KEY, JSON.stringify(uiSettings));
}

/** Native (unscaled) viewport width in CSS px for the current orientation. */
export function naturalWidth(): number {
    return window.screen.width;
}

/** Current shell counter-scale factor (>= 1 when the viewport is widened). */
export function shellScale(): number {
    return Math.max(1, window.innerWidth / naturalWidth());
}

const OUR_META_ID = 'rlm-viewport';

export function applyViewport(): void {
    // Ours is the ONLY viewport meta allowed to exist — the game page ships
    // its own (width=device-width), which the DOM merge would otherwise copy
    // in after ours, and last-processed viewport meta wins. Recreate ours
    // fresh every time: element INSERTION always triggers viewport
    // re-evaluation, whereas re-setting an unchanged content may not.
    for (const other of Array.from(
        document.querySelectorAll('meta[name="viewport"]')
    )) {
        other.remove();
    }
    const meta = document.createElement('meta');
    meta.id = OUR_META_ID;
    meta.setAttribute('name', 'viewport');
    const w = uiSettings.viewportWidth;
    // The explicit initial-scale is REQUIRED — Android WebView ignores a bare
    // width=N (verified on device; with the scale present it applies, even
    // for changes made at runtime).
    meta.setAttribute(
        'content',
        w > 0 && w > naturalWidth()
            ? `width=${w}, initial-scale=${(naturalWidth() / w).toFixed(4)}`
            : 'width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no'
    );
    document.head.appendChild(meta);
}

export function applyEdgeInset(): void {
    let style = document.getElementById('rlm-edge-inset') as HTMLStyleElement | null;
    if (!style) {
        style = document.createElement('style');
        style.id = 'rlm-edge-inset';
        document.head.appendChild(style);
    }
    const n = uiSettings.edgeInset;
    // Horizontal only — vertical padding looked wrong (user feedback), and
    // with immersive fullscreen the top strip is fully tappable again.
    style.textContent =
        n > 0
            ? `html { padding: 0 ${n}px !important; box-sizing: border-box !important; background: black !important; }`
            : '';
    // Keep the native multi-account tab bar aligned with the game window.
    import('./native-bridge').then(m => m.pushTabBarInset(n));
}

/**
 * Per-element scale overrides for the game controls that stay desktop-sized
 * (and finger-hostile) under the virtual viewport. transform (not zoom) so
 * layout is untouched; transform-origin matches each element's screen anchor
 * so the enlarged control grows inward instead of off-screen.
 */
export function applyElementScales(): void {
    let style = document.getElementById('rlm-elem-scale') as HTMLStyleElement | null;
    if (!style) {
        style = document.createElement('style');
        style.id = 'rlm-elem-scale';
        document.head.appendChild(style);
    }
    const rules: string[] = [];
    const logout = uiSettings.logoutScale / 100;
    if (logout !== 1) {
        // Button is position:absolute, pinned top-right of the viewport.
        rules.push(
            `#hs-logout-button { transform: scale(${logout}); transform-origin: top right; }`
        );
    }
    const ctx = uiSettings.contextMenuScale / 100;
    if (ctx !== 1) {
        // The game's ONE shared context menu opens at the tap point, so the
        // grow direction must follow it around the screen — watchContextMenu()
        // sets --rlm-ctx-origin per open to grow toward the free space.
        rules.push(
            `#hs-context-menu { transform: scale(${ctx}); transform-origin: var(--rlm-ctx-origin, top left); }`
        );
    }
    const chat = uiSettings.chatInputScale / 100;
    if (chat !== 1) {
        // Bottom row of the bottom-left chat menu — keep it glued there.
        // transform is visual-only, so the enlarged bar would paint over the
        // message list above; the margin-top adds the extra visual height
        // (row is 1.5rem tall in the game's CSS) as real layout space,
        // pushing the list up clear of the overlap.
        rules.push(
            `#hs-chat-input-menu { transform: scale(${chat}); transform-origin: bottom left; ` +
                `margin-top: calc(1.5rem * ${(chat - 1).toFixed(4)}); }`
        );
    }
    style.textContent = rules.join('\n');
}

/**
 * Point the scaled context menu's transform-origin at whichever screen
 * corner it opened nearest, so the enlarged menu grows into free space
 * instead of off-screen. Runs on every menu (re)population; MutationObserver
 * callbacks fire before paint, so the origin lands before the menu is shown.
 * The menu is repopulated on every open and rebuilt on relogin, so watch the
 * whole body rather than the menu node.
 */
export function watchContextMenu(): void {
    const sync = () => {
        const wrapper = document.getElementById('hs-context-menu-wrapper');
        const menu = document.getElementById('hs-context-menu');
        if (!wrapper || !menu) return;
        const r = wrapper.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return; // hidden/detached
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const h = cx < window.innerWidth / 2 ? 'left' : 'right';
        const v = cy < window.innerHeight / 2 ? 'top' : 'bottom';
        menu.style.setProperty('--rlm-ctx-origin', `${v} ${h}`);
    };
    const touchesMenu = (n: Node): boolean =>
        n instanceof Element && !!n.closest('#hs-context-menu-wrapper');
    new MutationObserver(mutations => {
        for (const m of mutations) {
            if (touchesMenu(m.target) || Array.from(m.addedNodes).some(touchesMenu)) {
                sync();
                return;
            }
        }
    }).observe(document.body, { childList: true, subtree: true });
}

/**
 * Keep our viewport authoritative for the page's lifetime: the game page's
 * own viewport meta arrives via the DOM merge, and the game could add more
 * at runtime. Any foreign viewport meta is removed and ours re-asserted.
 */
export function enforceViewport(): void {
    applyViewport();
    applyEdgeInset();
    applyElementScales();
    watchContextMenu();
    new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const node of Array.from(m.addedNodes)) {
                if (
                    node instanceof HTMLMetaElement &&
                    node.name === 'viewport' &&
                    node.id !== OUR_META_ID
                ) {
                    applyViewport(); // removes it and re-asserts ours
                    return;
                }
            }
        }
    }).observe(document.head, { childList: true });
}
