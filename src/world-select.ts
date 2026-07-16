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

// World picker — mobile port of RyeliteDesktop's
// src/renderer/client/helpers/worldSelectHelper.js. Bottom-left overlay on
// the login screen, like the desktop client.
//
// Divergences from desktop:
// - No page reload on world change — UNLESS this page has already made a
//   login attempt. The game (v61) reads the hidden #server-id-input/
//   #server-url inputs LAZILY and memoizes them in module-scope vars: the
//   first getLoginToken POST primes the cache and every later input update
//   is ignored for the page's lifetime (this is why desktop reloads — a
//   pick-after-relogin without reload silently logs into the OLD world;
//   bug seen live 2026-07-15: picked World 1, landed on server2). We track
//   the primed world via a fetch wrap and reload only when the pick
//   actually conflicts with it; before any login the inputs update live.
// - The selection persists in localStorage and client.ts uses it for the
//   boot-time POST /game, so the page's initial hidden inputs already match.
//   (localStorage is shared across the multi-account tabs; each tab's page
//   only trusts it at boot / while unlocked, so tabs can't clobber each
//   other's live session — a conflicting rebuilt login screen reloads.)
// - /play is on port 443 → intercepted by the WebView local server (our
//   origin is https://highspell.com), so the world list is fetched natively
//   like the loader's other main-domain requests.
// - Only #server-id-input/#server-url differ between worlds in the /game
//   response (api/chat/cdn URLs are global — verified against both worlds),
//   so live-updating just those two is complete.

import { gameGetText } from './native-bridge';

export interface World {
    worldName: string;
    serverId: string;
    serverUrl: string;
    playerCount: number;
}

const STORAGE_KEY = 'ryelite-mobile-world';

const DEFAULT_WORLD: World = {
    worldName: 'World 1',
    serverId: '1',
    serverUrl: 'https://server1.highspell.com:8888',
    playerCount: 0,
};

export function getStoredWorld(): World {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const world = JSON.parse(raw);
            if (world && world.serverId && world.serverUrl) {
                return world as World;
            }
        }
    } catch {
        // fall through to default
    }
    return DEFAULT_WORLD;
}

function storeWorld(world: World): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(world));
}

async function fetchWorlds(): Promise<World[]> {
    const html = await gameGetText('https://highspell.com/play');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = Array.from(
        doc.querySelectorAll('#server_data .hs_data__row')
    ).slice(1); // skip header row
    return rows.map(row => ({
        worldName:
            row.querySelector<HTMLInputElement>('input[type="submit"]')
                ?.value || '',
        serverId:
            row.querySelector<HTMLInputElement>('input[name="serverid"]')
                ?.value || '',
        serverUrl:
            row.querySelector<HTMLInputElement>('input[name="serverurl"]')
                ?.value || '',
        playerCount: Number(
            row
                .querySelector('.server_data__row__playercount')
                ?.textContent?.trim() || '0'
        ),
    }));
}

// The game caches serverId/serverUrl (module vars, memoized getters) at the
// first getLoginToken POST of the page's life. Until then, updating the
// hidden inputs live works; afterwards only a reload can change worlds.
// This wrap records what got locked in. Installed at module import time —
// client.ts imports us before the game script is fetched, and window.fetch
// stays native (the CapacitorHttp global patch is disabled).
let lockedServerId: string | null = null;

const nativeFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (lockedServerId === null) {
        try {
            const url =
                input instanceof Request ? input.url : String(input);
            if (url.includes('/getLoginToken')) {
                lockedServerId =
                    document.querySelector<HTMLInputElement>(
                        '#server-id-input'
                    )?.value ?? null;
            }
        } catch {
            // never break the game's fetch
        }
    }
    return nativeFetch(input, init);
}) as typeof window.fetch;

// The game reads these when the Login button is clicked.
function updateFormInputs(world: World): void {
    const serverIdInput =
        document.querySelector<HTMLInputElement>('#server-id-input');
    const serverUrlInput =
        document.querySelector<HTMLInputElement>('#server-url');
    if (serverIdInput) serverIdInput.value = world.serverId;
    if (serverUrlInput) serverUrlInput.value = world.serverUrl;
}

let setupRunning = false;

export function initWorldSelect(): void {
    // Same lifecycle pattern as login-profiles: the login screen exists at
    // boot and is recreated after logout; #rlm-world-select doubles as the
    // "already set up" guard (a detached node no longer matches).
    const observer = new MutationObserver(() => {
        maybeSetup();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    maybeSetup();
}

function maybeSetup(): void {
    if (setupRunning) return;
    // #login-screen-container stays in the DOM while in-world, so login-screen
    // truth is the absence of #hs-screen-mask (same signal as login-state.ts).
    const atLoginScreen =
        !document.getElementById('hs-screen-mask') &&
        !!document.querySelector('#login-screen-container');
    const picker = document.querySelector('#rlm-world-select');
    if (!atLoginScreen) {
        picker?.remove();
        return;
    }
    if (picker) return;
    if (!document.querySelector('#game-container')) return;
    setupRunning = true;
    setupWorldSelect()
        .catch(err =>
            console.error('[RyeLite Mobile] World select setup failed:', err)
        )
        .finally(() => {
            setupRunning = false;
        });
}

async function setupWorldSelect(): Promise<void> {
    // Re-assert the persisted selection immediately — a rebuilt login screen
    // must connect to the chosen world even if the world-list fetch fails.
    const stored = getStoredWorld();
    if (lockedServerId !== null && lockedServerId !== stored.serverId) {
        // A login already locked this page to another world (e.g. the world
        // was changed on a different tab — localStorage is shared). Reload;
        // the boot POST /game uses the stored world and unlocks everything.
        location.reload();
        return;
    }
    updateFormInputs(stored);

    const container = document.createElement('div');
    container.id = 'rlm-world-select';
    container.style.position = 'absolute';
    container.style.bottom = '0';
    container.style.left = '0';
    container.style.margin = '0 1rem 1rem';
    container.style.zIndex = '1000';
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.gap = '0.5rem';
    container.style.padding = '0.5rem 0.9rem';
    container.style.background = 'rgba(34, 34, 34, 0.85)';
    container.style.backdropFilter = 'blur(6px)';
    container.style.borderRadius = '1.25rem';
    container.style.boxShadow = '0 2px 12px 0 rgba(0,0,0,0.18)';

    const globe = document.createElement('span');
    globe.textContent = '🌍';
    globe.style.fontSize = '1.5rem';

    const select = document.createElement('select');
    select.id = 'rlm-world-select-dropdown';
    select.style.background = 'rgba(48, 48, 48, 0.95)';
    select.style.color = '#fff';
    select.style.border = '1px solid #444';
    select.style.borderRadius = '0.5rem';
    // ~1.4x desktop sizing — started at 2x for touch, trimmed to 70% of
    // that (user request: 2x was a bit big).
    select.style.padding = '0.7rem 2.8rem 0.7rem 1rem';
    select.style.fontSize = '1.4rem';
    select.style.fontWeight = '500';
    select.style.fontFamily = "'Segoe UI', 'Roboto', 'Arial', sans-serif";
    select.style.minWidth = '18rem';
    select.style.outline = 'none';
    select.style.appearance = 'none';
    select.style.backgroundImage =
        "url('data:image/svg+xml;utf8,<svg fill=\'%23fff\' height=\'16\' viewBox=\'0 0 24 24\' width=\'16\' xmlns=\'http://www.w3.org/2000/svg\'><path d=\'M7 10l5 5 5-5z\'/></svg>')";
    select.style.backgroundRepeat = 'no-repeat';
    select.style.backgroundPosition = 'right 0.7rem center';
    select.style.backgroundSize = '1.4rem';

    const loadingOption = document.createElement('option');
    loadingOption.value = stored.serverId;
    loadingOption.textContent = `${stored.worldName || 'World ' + stored.serverId}…`;
    select.appendChild(loadingOption);

    container.appendChild(globe);
    container.appendChild(select);
    document.querySelector('#game-container')!.appendChild(container);

    let worlds: World[] = [];
    try {
        worlds = await fetchWorlds();
    } catch (err) {
        console.error('[RyeLite Mobile] Failed to fetch worlds:', err);
    }
    // The login screen can be torn down while the fetch was in flight.
    if (!select.isConnected) return;

    if (worlds.length === 0) {
        // Leave the stored world as a lone option — login still works, the
        // hidden inputs are already set.
        loadingOption.textContent =
            stored.worldName || `World ${stored.serverId}`;
        return;
    }

    select.textContent = '';
    for (const world of worlds) {
        const option = document.createElement('option');
        option.value = world.serverId;
        option.textContent = `${world.worldName} (${world.playerCount} players)`;
        select.appendChild(option);
    }

    const initial =
        worlds.find(w => w.serverId === stored.serverId) ??
        worlds.find(w => w.serverId === '1') ??
        worlds[0];
    select.value = initial.serverId;
    updateFormInputs(initial);
    storeWorld(initial); // refresh persisted name/url in case they changed

    select.addEventListener('change', () => {
        const world = worlds.find(w => w.serverId === select.value);
        if (!world) return;
        storeWorld(world);
        if (lockedServerId !== null && lockedServerId !== world.serverId) {
            // Past the first login the game ignores input updates — do what
            // desktop does and reload (boot picks up the stored world).
            location.reload();
            return;
        }
        updateFormInputs(world);
    });
}
