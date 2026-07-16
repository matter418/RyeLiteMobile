// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// Mobile replacements for the three globals the Electron preload script
// (RyeliteDesktop/src/preload/index.ts) exposes via contextBridge.
// The @ryelite/core runtime itself has no Electron dependency — these shims
// exist only for the loader (client.ts) and any plugin that touches them.

// ---------------------------------------------------------------------------
// window.settings — desktop version round-trips over IPC to a JSON file.
// Here it's a flat localStorage-backed store keyed the same way the loader
// reads it (getByName with the human-readable label).
// ---------------------------------------------------------------------------

const SETTINGS_STORAGE_KEY = 'ryelite-mobile-settings';

const DEFAULT_SETTINGS: Record<string, unknown> = {
    'Enable Plugins': true,
};

function loadSettings(): Record<string, unknown> {
    try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        return raw
            ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
            : { ...DEFAULT_SETTINGS };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function persistSettings(settings: Record<string, unknown>) {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

const settingsAPI = {
    // Desktop signature is (section, key); the section is a UI grouping we
    // don't have yet, so it's folded into the key namespace here.
    get: async (section: string, key: string) =>
        loadSettings()[`${section}.${key}`],
    set: async (section: string, key: string, value: unknown) => {
        const settings = loadSettings();
        settings[`${section}.${key}`] = value;
        persistSettings(settings);
    },
    getAll: async () => loadSettings(),
    getByName: async (label: string) => loadSettings()[label],
    // Directory pickers are meaningless in a WebView sandbox.
    selectDirectory: async () => null,
    validateDirectory: async () => false,
};

// ---------------------------------------------------------------------------
// window.screenshot — desktop captures via Electron's desktopCapturer.
// Stubbed until there's a mobile story (Capacitor has plugins for this).
// ---------------------------------------------------------------------------

const screenshotAPI = {
    capture: async () => ({
        ok: false as const,
        error: 'Screenshots are not supported on mobile yet',
    }),
};

// ---------------------------------------------------------------------------
// window.electron — only ipcRenderer.send('ui-ready') is used by the loader;
// everything else is a defensive no-op for legacy plugins that poke at it.
// ---------------------------------------------------------------------------

const electronAPI = {
    ipcRenderer: {
        send: (channel: string, ..._args: unknown[]) => {
            console.log(`[RyeLite Mobile] ipcRenderer.send('${channel}') (no-op)`);
        },
        invoke: async (channel: string, ..._args: unknown[]) => {
            console.log(`[RyeLite Mobile] ipcRenderer.invoke('${channel}') (no-op)`);
            return undefined;
        },
        on: (_channel: string, _listener: (...args: unknown[]) => void) => {},
        removeAllListeners: (_channel: string) => {},
    },
};

// ---------------------------------------------------------------------------
// Notification — Android WebView doesn't implement the Web Notifications API
// at all (the global is undefined). @ryelite/core's notificationManager logs
// "this browser does not support notifications" but still dereferences
// Notification, which crashes the whole loader module. Minimal inert shim.
// ---------------------------------------------------------------------------

if (typeof (window as any).Notification === 'undefined') {
    class NotificationShim {
        static readonly permission = 'denied';
        static async requestPermission() {
            return 'denied' as const;
        }
        onclick: unknown = null;
        constructor(_title?: string, _options?: unknown) {}
        close() {}
    }
    (window as any).Notification = NotificationShim;
}

declare global {
    interface Window {
        settings: typeof settingsAPI;
        screenshot: typeof screenshotAPI;
        electron: typeof electronAPI;
    }
}

window.settings = settingsAPI;
window.screenshot = screenshotAPI;
window.electron = electronAPI;

export {};
