// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// Mobile adaptation of RyeliteDesktop/src/renderer/client/client.ts.
// Same loader flow: fetch the High Spell game page, merge its DOM, download
// the versioned game client JS, reflect hooks into it, inject it, then start
// the @ryelite/core plugin runtime.
//
// Removed vs desktop: titlebar helpers, static desktop CSS. Electron IPC
// globals come from shims.ts. The desktop user/password autofill helper is
// ported as login-profiles.ts, the world selector as world-select.ts.

import './shims'; // must run before anything reads window.settings/electron

// Exception logging that survives the game's console replacement — must be
// installed before any game code can throw or reassign console.error.
import { initErrorTrap } from './error-trap';
initErrorTrap();

// Rewrites the game's sprite-compositing worker to not depend on
// requestAnimationFrame (dies on Android when the app backgrounds → invisible
// characters). Must wrap Blob/Worker before the game client script runs.
import { initSpriteWorkerFix } from './sprite-worker-fix';
initSpriteWorkerFix();

// Hidden-tab rAF throttle (the WebView.onPause replacement — onPause'd
// pages get frozen by Chromium after ~60 s, killing the game socket). Must
// wrap requestAnimationFrame before the game client script captures it.
import { initFrameThrottle } from './frame-throttle';
initFrameThrottle();

// Touch→mouse translation listeners must be the FIRST window-capture
// listeners registered in this page. The game page's own scripts (executed
// during the DOM merge below) register window-level input handlers — same
// target + same phase means registration order decides who runs first, and
// whoever is first can suppress for everyone after.
import { initTouchInput } from './touch-input';
initTouchInput();

// Apply the virtual desktop viewport before the game page loads, and keep it
// authoritative — the game page ships its own viewport meta (copied in by
// the DOM merge), and the last-processed viewport meta wins.
import { enforceViewport } from './ui-scale';
enforceViewport();

// Tapping the chat bar opens the game's text input (the game only wires
// this in its mobile mode, which ForceDesktopMode vetoes). Delegated +
// lazily resolved, so registering before the game loads is fine.
import { initChatTapToType } from './chat-tap';
initChatTapToType();

// The game's text input menus are keyboard-dead in desktop mode (span-based
// fake input fed by hardware keys) — overlay a real invisible <input> so the
// soft keyboard opens and typing reaches the game.
import { initKeyboardBridge } from './keyboard-bridge';
initKeyboardBridge();

import { gameGetText, gamePostForm } from './native-bridge';
import { getStoredWorld, initWorldSelect } from './world-select';
import { Highlite, Reflector, HighliteResources } from '@ryelite/core';
import '@iconify/iconify';
import './css/overrides.css';
import './css/item-tooltip.css';

// Load settings via the shim (values are available via window.settings)
await window.settings.getAll();

// The WebView origin is https://highspell.com, so the game's own fetches run
// natively. But requests to https://highspell.com:443 are intercepted (they
// serve local app assets) — the loader's few calls to the main domain must
// bypass the WebView entirely. native-bridge.ts routes them through
// CapacitorHttp (tab 1) or the RLMBridge JS interface (secondary tabs).
const nativeGetText = gameGetText;

async function obtainGameClient() {
    const highspellAssetsURL = 'https://highspell.com:3002/assetsClient';

    const highliteResources = new HighliteResources();
    await highliteResources.init();

    // Check if clientLastVersion is set
    const clientLastVersion = await highliteResources.getItem('clientLastVersion');

    // Get Asset JSON to determine latest version (port 3002 — not intercepted,
    // but native keeps the loader deterministic)
    const highSpellAssetJSON = JSON.parse(await nativeGetText(highspellAssetsURL));
    const remoteLastVersion = highSpellAssetJSON.data.latestClientVersion;

    // Load the stored hooks
    const savedHooks = await Reflector.hasSavedHooks();

    // Fetch the latest client
    async function fetchLatestClient() {
        const highSpellClientURL = `https://highspell.com/js/client/client.${highSpellAssetJSON.data.latestClientVersion}.js`;
        console.log(highSpellClientURL);
        return await nativeGetText(highSpellClientURL + '?time=' + Date.now());
    }

    let highSpellClient: string | null = null;
    if (
        clientLastVersion == undefined ||
        clientLastVersion < remoteLastVersion ||
        !savedHooks
    ) {
        console.log('[Ryelite Loader] High Spell Client Version is outdated, updating...');

        // Fetch the latest client
        highSpellClient = await fetchLatestClient();

        // Reflect the game hooks
        await Reflector.loadHooksFromSource(highSpellClient);

        // Inject the hook handlers (identical to desktop — do not reformat,
        // the substring offsets assume the upstream file's exact tail)
        highSpellClient =
            highSpellClient.substring(0, highSpellClient.length - 9) +
            '; document.client = {};' +
            'document.client.get = function(a) {' +
            'return eval(a);' +
            '};' +
            'document.client.set = function(a, b) {' +
            "eval(a + ' = ' + b);" +
            '};' +
            highSpellClient.substring(highSpellClient.length - 9);

        // Save latest version
        await highliteResources.setItem('highSpellClient', highSpellClient);
        await highliteResources.setItem('clientLastVersion', remoteLastVersion);
        console.log(
            '[Ryelite Loader] High Spell Client Version ' +
                highSpellAssetJSON.data.latestClientVersion +
                ' downloaded.'
        );
    } else {
        console.log('[Ryelite Loader] High Spell Client Version is up to date.');

        // Load the client from save db
        highSpellClient = await highliteResources.getItem('highSpellClient');

        // Load the hooks from db
        await Reflector.loadHooksFromDB();

        // In the background we still bind the latest hook code for dev testing
        setTimeout(async () => {
            await Reflector.loadHooksFromSource(highSpellClient || '');
        }, 200);
    }

    return Promise.resolve(highSpellClient);
}

// Transient DNS/network failures at launch are common on a phone that just
// woke up (Wi-Fi still reconnecting) — without a retry, a failed boot leaves
// a black screen until the app is force-restarted. Retry with backoff and
// keep the user informed via the boot banner; after the last attempt the
// error propagates to index.html's boot error overlay as before.
async function bootRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const MAX_ATTEMPTS = 8;
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt >= MAX_ATTEMPTS) throw err;
            const waitMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
            console.error(
                `[Ryelite Loader] ${label} failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${waitMs}ms:`,
                err
            );
            const banner = document.getElementById('ryelite-boot');
            if (banner) banner.textContent = `Waiting for network… (${label})`;
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
    }
}

// POST Request to https://highspell.com/game, targeting the world the user
// last picked in the login-screen world selector (world-select.ts).
const bootWorld = getStoredWorld();
const text: string = await bootRetry('game page', () =>
    gamePostForm('https://highspell.com/game', {
        submit: bootWorld.worldName,
        serverid: bootWorld.serverId,
        serverurl: bootWorld.serverUrl,
    })
);

const parser = new DOMParser();
const doc = parser.parseFromString(text, 'text/html');
const clientJS = doc.querySelector('script[src*="/js/client/client"]');
if (clientJS) {
    clientJS.remove();
}

// Replace head and body content (non-script)
Array.from(doc.head.children).forEach(child => {
    if (child.tagName.toLowerCase() !== 'script') {
        // If child has a relative href, update it to absolute
        if (child.hasAttribute('href')) {
            const href = child.getAttribute('href');
            if (href && href.startsWith('/')) {
                child.setAttribute('href', 'https://highspell.com' + href);
            }
        }
        document.head.appendChild(child.cloneNode(true));
    }
});

Array.from(doc.body.children).forEach(child => {
    if (child.tagName.toLowerCase() !== 'script') {
        // If child has a relative href, update it to absolute
        if (child.hasAttribute('href')) {
            const href = child.getAttribute('href');
            if (href && href.startsWith('/')) {
                child.setAttribute('href', 'https://highspell.com' + href);
            }
        }

        // Append the child
        document.body.appendChild(child.cloneNode(true));
    }
});

// Process and inject scripts manually
const scripts = doc.querySelectorAll('script');
scripts.forEach(script => {
    const newScript = script.cloneNode(true);
    // if script was in head, append to head
    if (
        script.parentNode &&
        (script.parentNode as Element).tagName?.toLowerCase() === 'head'
    ) {
        document.head.appendChild(newScript as Node);
    } else {
        // if script was in body, append to body
        document.body.appendChild(newScript as Node);
    }
});

/* Find DOM elements with the attribute to= */
const toElements = document.querySelectorAll('[to]');
toElements.forEach(element => {
    const to = element.getAttribute('to');
    if (!to) return;
    const targetElement = document.querySelector(to);

    const before = element.getAttribute('before');
    const after = element.getAttribute('after');

    if (before && !after) {
        const beforeElement = document.querySelector(before);
        if (beforeElement && beforeElement.parentNode) {
            element.remove();
            beforeElement.parentNode.insertBefore(element, beforeElement);
        }
    } else if (after && !before) {
        const afterElement = document.querySelector(after);
        if (afterElement && afterElement.parentNode) {
            element.remove();
            afterElement.parentNode.insertBefore(element, afterElement.nextSibling);
        }
    } else if (!after && !before) {
        if (targetElement) {
            element.remove();
            targetElement.appendChild(element);
        }
    } else if (after && before) {
        console.warn('Element has both before and after attributes. Peforming default behavior.');
        if (targetElement) {
            element.remove();
            targetElement.appendChild(element);
        }
    }
});

// Stylesheets on the main domain (port 443) would be intercepted by the
// WebView's local server (our origin IS https://highspell.com) and 404.
// Fetch them natively and inline as <style>. Links to :8887/:3002 are
// different origins and load normally — the ^= match excludes them.
const interceptedLinks = document.querySelectorAll(
    'link[rel="stylesheet"][href^="https://highspell.com/"]'
);
for (const link of Array.from(interceptedLinks)) {
    const href = link.getAttribute('href')!;
    try {
        const css = await nativeGetText(href);
        const style = document.createElement('style');
        style.setAttribute('data-inlined-from', href);
        style.textContent = css;
        link.replaceWith(style);
    } catch (error) {
        console.error(`[Ryelite Loader] Failed to inline stylesheet ${href}:`, error);
    }
}

// Page Setup Completed, Add Game Client Script. Retried for the same
// launch-time network flakiness as the boot POST — obtainGameClient's DB
// writes are idempotent, so a mid-flight failure re-runs safely.
const clientScript = document.createElement('script');
clientScript.id = 'highspellClientScript';
clientScript.textContent = await bootRetry('game client', obtainGameClient);
document.body.append(clientScript);

// Login profiles: saved-account dropdown + autofill on the login screen.
// Passwords live in the Android Keystore-backed CredentialStore plugin.
import('./login-profiles').then(module => {
    module.initLoginProfiles();
});

// World picker, bottom-left of the login screen (like the desktop client).
initWorldSelect();

// Keep-alive gating: tell the native side whether we're actually in-world,
// so backgrounding at the login screen doesn't start the foreground service.
import('./login-state').then(module => {
    module.initLoginStateMirror();
});


if (await window.settings.getByName('Enable Plugins')) {
    const highlite = new Highlite();

    // Load and register all plugins using dynamic imports
    console.log('[Ryelite] Loading plugins...');
    const loadedPlugins: Array<{ class: any; name: string }> = [];

    try {
        const pluginModules = import.meta.glob('./plugins/*.js', { eager: true });

        for (const [path, moduleLoader] of Object.entries(pluginModules)) {
            try {
                const pluginName = path.split('/').pop()?.replace('.js', '') || 'UnknownPlugin';
                const PluginClass = (moduleLoader as any).default;

                if (PluginClass) {
                    highlite.pluginManager.registerPlugin(PluginClass);
                    loadedPlugins.push({ class: PluginClass, name: pluginName });
                } else {
                    console.error(`[Ryelite] Plugin class not found in module: ${pluginName}`);
                }
            } catch (error) {
                console.error(`[Ryelite] Failed to load plugin from ${path}:`, error);
            }
        }
    } catch (error) {
        console.error('[Ryelite] Error loading plugins:', error);
    }
    await highlite.start();

    // Re-house the core's desktop sidebar (panel bar + drawer) into the
    // mobile fullscreen shell with a floating open button.
    const { initMobileShell } = await import('./mobile-shell');
    initMobileShell();

    // Repair the game's sprite manager when its logout teardown crashes
    // (upstream bug — see sprite-guard.ts). Needs document.highlite, so
    // plugins-enabled only.
    const { initSpriteGuard } = await import('./sprite-guard');
    initSpriteGuard();

    // Native idle alert — replaces the Idle Alert Hub plugin, whose game-loop
    // hook stalls on rAF-throttled hidden tabs (see idle-watch.ts). Needs
    // document.highlite.gameHooks, so plugins-enabled only.
    const { initIdleWatch } = await import('./idle-watch');
    initIdleWatch();
} else {
    for (const element of document.getElementsByClassName('highlite-ui')) {
        element.remove();
    }
}

// Desktop signals the main process here; on mobile it's just a log line.
window.electron.ipcRenderer.send('ui-ready');
document.dispatchEvent(
    new Event('DOMContentLoaded', {
        bubbles: true,
        cancelable: true,
    })
);
