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

// Facade over "how this tab talks to native". Tab 1 is Capacitor's WebView
// and uses the Capacitor plugin bridge (CapacitorHttp, CredentialStore,
// BackgroundMode). Secondary tabs (the multi-account tab system) are plain
// WebViews with no Capacitor runtime — MainActivity injects
// `window.RLMBridge` (addJavascriptInterface, RLMBridge.java) instead, and
// the helpers below route through it. Call sites import these and never
// care which kind of tab they're running in.
//
// RLMBridge methods are SYNCHRONOUS (addJavascriptInterface string returns;
// they run on the WebView's JavaBridge thread, blocking only this tab's JS).
// httpRequest returns JSON: {status: number, data: string, error?: string}.

import { CapacitorHttp, registerPlugin } from '@capacitor/core';

interface RLMTabBridge {
    httpRequest(
        method: string,
        url: string,
        body: string,
        contentType: string
    ): string;
    credList(): string;
    credGet(username: string): string;
    credSave(username: string, password: string): void;
    credDelete(username: string): void;
    credSetLastUsed(username: string): void;
    setLoggedIn(loggedIn: boolean): void;
    getBackgroundEnabled(): boolean;
    setBackgroundEnabled(enabled: boolean): void;
    setTabBarInset(px: number): void;
    setTabBarHidden(hidden: boolean): void;
    setIdleBlink(on: boolean): void;
}

declare global {
    interface Window {
        RLMBridge?: RLMTabBridge;
    }
}

const bridge = window.RLMBridge;

// Same spoof set the desktop client and tab 1 have always sent.
const SPOOF_HEADERS: Record<string, string> = {
    'Origin': 'https://highspell.com',
    'Referer': 'https://highspell.com/',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

function bridgeHttp(
    method: string,
    url: string,
    body: string,
    contentType: string
): { status: number; data: string } {
    const res = JSON.parse(bridge!.httpRequest(method, url, body, contentType));
    if (res.error) {
        throw new Error(`${method} ${url} -> ${res.error}`);
    }
    if (res.status < 200 || res.status >= 300) {
        throw new Error(`${method} ${url} -> HTTP ${res.status}`);
    }
    return res;
}

// GET a main-domain (or :3002) URL as text, bypassing this tab's own origin
// interception. Tab 1: CapacitorHttp plugin. Secondary: native bridge.
export async function gameGetText(url: string): Promise<string> {
    if (bridge) {
        return bridgeHttp('GET', url, '', '').data;
    }
    const res = await CapacitorHttp.get({
        url,
        headers: SPOOF_HEADERS,
        responseType: 'text',
    });
    if (res.status < 200 || res.status >= 300) {
        throw new Error(`GET ${url} -> HTTP ${res.status}`);
    }
    // content-type json gets auto-parsed by the plugin; normalize to string
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
}

// POST a form (x-www-form-urlencoded) and return the response text.
export async function gamePostForm(
    url: string,
    form: Record<string, string>
): Promise<string> {
    if (bridge) {
        const body = new URLSearchParams(form).toString();
        return bridgeHttp(
            'POST',
            url,
            body,
            'application/x-www-form-urlencoded'
        ).data;
    }
    // Preserve tab 1's long-standing encoding quirk exactly (spaces were
    // pre-replaced with '+' before CapacitorHttp form-encoded the object).
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(form)) {
        data[k] = v.replace(' ', '+');
    }
    const res = await CapacitorHttp.post({
        url,
        headers: {
            ...SPOOF_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        data,
        responseType: 'text',
    });
    if (res.status < 200 || res.status >= 300) {
        throw new Error(`POST ${url} -> HTTP ${res.status}`);
    }
    return typeof res.data === 'string' ? res.data : String(res.data);
}

// ---------------------------------------------------------------------------
// CredentialStore — same interface as the Capacitor plugin (login-profiles.ts
// is the only consumer). All tabs share the one Keystore-backed store.
// ---------------------------------------------------------------------------

export interface CredentialStoreApi {
    list(): Promise<{ usernames: string[]; lastUsed?: string | null }>;
    get(options: { username: string }): Promise<{ password?: string | null }>;
    save(options: { username: string; password: string }): Promise<void>;
    delete(options: { username: string }): Promise<void>;
    setLastUsed(options: { username: string }): Promise<void>;
}

export const credentialStore: CredentialStoreApi = bridge
    ? {
          async list() {
              return JSON.parse(bridge.credList());
          },
          async get({ username }) {
              return JSON.parse(bridge.credGet(username));
          },
          async save({ username, password }) {
              bridge.credSave(username, password);
          },
          async delete({ username }) {
              bridge.credDelete(username);
          },
          async setLastUsed({ username }) {
              bridge.credSetLastUsed(username);
          },
      }
    : registerPlugin<CredentialStoreApi>('CredentialStore');

// ---------------------------------------------------------------------------
// BackgroundMode — keep-alive toggle + per-tab logged-in reporting. The
// native side ORs the logged-in flags across tabs (TabSessions.java) to gate
// KeepAliveService, so every tab must report its own state.
// ---------------------------------------------------------------------------

export interface BackgroundModeApi {
    setEnabled(options: { enabled: boolean }): Promise<void>;
    getEnabled(): Promise<{ enabled: boolean }>;
    setLoggedIn(options: { loggedIn: boolean }): Promise<void>;
    setTabBarInset(options: { px: number }): Promise<void>;
    setTabBarHidden(options: { hidden: boolean }): Promise<void>;
    setIdleBlink(options: { on: boolean }): Promise<void>;
}

export const backgroundMode: BackgroundModeApi = bridge
    ? {
          async setEnabled({ enabled }) {
              bridge.setBackgroundEnabled(enabled);
          },
          async getEnabled() {
              return { enabled: bridge.getBackgroundEnabled() };
          },
          async setLoggedIn({ loggedIn }) {
              bridge.setLoggedIn(loggedIn);
          },
          async setTabBarInset({ px }) {
              bridge.setTabBarInset(px);
          },
          async setTabBarHidden({ hidden }) {
              bridge.setTabBarHidden(hidden);
          },
          async setIdleBlink({ on }) {
              bridge.setIdleBlink(on);
          },
      }
    : registerPlugin<BackgroundModeApi>('BackgroundMode');

// Blink (or stop blinking) THIS tab's box in the native tab bar — the
// idle alert for tabs you aren't looking at (idle-watch.ts). Fire-and-forget.
export function setIdleBlink(on: boolean): void {
    backgroundMode.setIdleBlink({ on }).catch(() => {});
}

// Hide/show the native multi-account tab bar while a fullscreen page UI
// (the mobile settings overlay) covers the screen — the bar lives in Android
// view space above all page content and would cut off the overlay's own tab
// strip. Hiding is a native-side LEASE (~3.5 s, TabManager.setBarHidden):
// the caller renews it every second while its UI stays open, so a page that
// reloads or dies mid-hide can never strand the bar off-screen.
export function setTabBarHidden(hidden: boolean): void {
    backgroundMode.setTabBarHidden({ hidden }).catch(() => {});
}

// Tell the native tab bar how far the page content is inset from the screen
// edge (the "Screen edge margin" setting, CSS px in this tab's scaled
// viewport) so the bar's left edge lines up with the game window instead of
// hugging curved glass. Converts to device px here — the native side has no
// idea what scale this tab renders at.
export function pushTabBarInset(cssPx: number): void {
    const devicePx = Math.round(
        cssPx *
            window.devicePixelRatio *
            (window.visualViewport?.scale ?? 1)
    );
    backgroundMode.setTabBarInset({ px: devicePx }).catch(() => {});
}
