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

// Standalone idle alert — sound + red overlay + native tab-box blink when a
// character's action ends, on ANY tab, visible or hidden. Replaces the Idle
// Alert Hub plugin on mobile (disable that plugin to avoid double sounds):
// the plugin detects idleness in a GameLoop_update hook, and the game loop
// is rAF-driven — historically frozen on hidden tabs (fully under the old
// onPause scheme; ~2 fps under frame-throttle.ts now), so its alerts were
// late or resume-refired. Game STATE is not frozen: GameStateUpdate
// packets are applied in the socket 'on' handler (verified in v61 source —
// EnteredIdleState flips MainPlayer.CurrentState synchronously), and
// per-view JS timers keep running. So this watcher polls the player's state
// on a plain interval. Audio output from a paused WebView is device-verified
// working (the AAudio track reaches the mixer even while hidden).
//
// Detection mirrors the Idle Alert plugin (CodyBrunson/Idle-Alert)
// tick-for-tick so alerts fire on the same conditions: only after a real
// action state (woodcutting, combat, ...) settles into idle — manual
// walking around doesn't count.
//
// Settings live in the 📱 Mobile panel (mobile-shell.ts) under
// `ryelite-mobile-idle` localStorage. The chime is synthesized at first
// play — no bundled asset.

import { ActionState } from '@ryelite/core';
import { setIdleBlink } from './native-bridge';
import { isTabHidden } from './frame-throttle';

const nativeLog = console.log.bind(console);
const DEBUG = false;

// One poll ≈ one game tick (the game loop runs a 600ms TIMESTEP accumulator).
const POLL_MS = 600;

// Same states the Idle Alert plugin ignores.
const IGNORED_STATES: number[] = [
    ActionState.BankingState,
    ActionState.ClimbSameMapLevelState,
    ActionState.GoThroughDoorState,
    ActionState.PlayerLoggingOutState,
    ActionState.PlayerDeadState,
    ActionState.StunnedState,
    ActionState.TradingState,
];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface IdleAlertSettings {
    enabled: boolean;
    volume: number; // 0–100
    overlay: boolean;
    delaySeconds: number; // idle time before the alert
}

const SETTINGS_KEY = 'ryelite-mobile-idle';

function loadSettings(): IdleAlertSettings {
    const defaults: IdleAlertSettings = {
        enabled: true,
        volume: 50,
        overlay: true,
        delaySeconds: 12, // ≈ the plugin's default 20 ticks × 600ms
    };
    try {
        return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
    } catch {
        return defaults;
    }
}

export const idleSettings: IdleAlertSettings = loadSettings();

export function saveIdleSettings(): void {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(idleSettings));
    } catch {
        // storage full/unavailable — settings just won't persist
    }
}

// ---------------------------------------------------------------------------
// Chime — a two-note ding synthesized into a WAV data URI on first use.
// ---------------------------------------------------------------------------

let chimeUri: string | null = null;

function buildChime(): string {
    const rate = 16000;
    const notes: Array<[freq: number, seconds: number]> = [
        [880, 0.4], // A5
        [1174.66, 0.5], // D6
    ];
    const total = notes.reduce((n, [, s]) => n + Math.round(rate * s), 0);
    const data = new Uint8Array(44 + total);
    const dv = new DataView(data.buffer);
    const ws = (o: number, s: string) => {
        for (let i = 0; i < s.length; i++) data[o + i] = s.charCodeAt(i);
    };
    ws(0, 'RIFF');
    dv.setUint32(4, 36 + total, true);
    ws(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, 1, true); // mono
    dv.setUint32(24, rate, true);
    dv.setUint32(28, rate, true);
    dv.setUint16(32, 1, true);
    dv.setUint16(34, 8, true); // 8-bit
    ws(36, 'data');
    dv.setUint32(40, total, true);
    let n = 44;
    for (const [freq, seconds] of notes) {
        const len = Math.round(rate * seconds);
        for (let i = 0; i < len; i++) {
            const env = Math.exp(-3.5 * (i / len)); // pluck-style decay
            data[n++] =
                128 + Math.round(96 * env * Math.sin((2 * Math.PI * freq * i) / rate));
        }
    }
    let bin = '';
    for (let i = 0; i < data.length; i += 8192) {
        bin += String.fromCharCode(...data.subarray(i, i + 8192));
    }
    return 'data:audio/wav;base64,' + btoa(bin);
}

/** Play the alert chime at a 0–100 volume (also used by the settings row
 *  as a preview). Safe to call from hidden tabs. */
export function playIdleChime(volumePct: number): void {
    if (volumePct <= 0) {
        return;
    }
    try {
        if (!chimeUri) {
            chimeUri = buildChime();
        }
        const a = new Audio(chimeUri);
        a.volume = Math.min(1, volumePct / 100);
        void a.play().catch(() => {});
    } catch {
        // no audio — the blink/overlay still fire
    }
}

// ---------------------------------------------------------------------------
// Red overlay (like the plugin's): tap anywhere or act to dismiss.
// ---------------------------------------------------------------------------

let overlayEl: HTMLDivElement | null = null;

function showOverlay(): void {
    if (overlayEl) {
        return;
    }
    const el = document.createElement('div');
    el.id = 'rlm-idle-overlay';
    el.style.position = 'fixed';
    el.style.inset = '0';
    el.style.background = 'rgba(255, 0, 0, 0.3)';
    el.style.pointerEvents = 'none'; // never eat input — informational only
    el.style.zIndex = '9998';
    document.body.appendChild(el);
    overlayEl = el;
    window.addEventListener('pointerdown', hideOverlay, {
        capture: true,
        once: true,
    });
}

function hideOverlay(): void {
    overlayEl?.remove();
    overlayEl = null;
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

export function initIdleWatch(): void {
    let lastActionState: number = ActionState.IdleState;
    let idlePolls = 0;
    let shouldTick = false;
    let blinking = false;

    const clearBlink = () => {
        if (blinking) {
            blinking = false;
            setIdleBlink(false);
        }
    };

    const reset = () => {
        lastActionState = ActionState.IdleState;
        idlePolls = 0;
        shouldTick = false;
    };

    setInterval(() => {
        try {
            if (!idleSettings.enabled) {
                reset();
                clearBlink();
                hideOverlay();
                return;
            }

            const player = (document as any).highlite?.gameHooks
                ?.EntityManager?.Instance?._mainPlayer;
            if (!player) {
                reset();
                clearBlink(); // logged out / disconnected
                hideOverlay();
                return;
            }

            const state = player._currentState?.getCurrentState?.();
            if (typeof state !== 'number' || IGNORED_STATES.includes(state)) {
                return;
            }

            // Character is doing something again — alert is stale.
            if (state !== ActionState.IdleState) {
                clearBlink();
                hideOverlay();
            }

            // Manual movement is not an AFK action (plugin parity).
            if (
                player._isMoving &&
                player._currentTarget == null &&
                state === ActionState.IdleState
            ) {
                shouldTick = false;
                lastActionState = ActionState.IdleState;
                return;
            }
            shouldTick = true;

            if (state !== ActionState.IdleState) {
                lastActionState = state;
            }

            if (
                state === ActionState.IdleState &&
                lastActionState !== ActionState.IdleState &&
                player._currentTarget == null &&
                shouldTick
            ) {
                idlePolls++;
            } else {
                idlePolls = 0;
            }

            const neededPolls = Math.max(
                1,
                Math.round((idleSettings.delaySeconds * 1000) / POLL_MS)
            );
            if (idlePolls > neededPolls) {
                playIdleChime(idleSettings.volume);
                if (idleSettings.overlay) {
                    showOverlay();
                }
                // Blink only matters for tabs you aren't looking at; the
                // native side refuses to blink the active tab anyway.
                // (isTabHidden, not visibilityState — a GONE-but-unpaused
                // WebView still reports "visible".)
                if (isTabHidden() || document.visibilityState === 'hidden') {
                    setIdleBlink(true);
                    blinking = true;
                }
                if (DEBUG) nativeLog('[IdleWatch] idle alert fired');
                lastActionState = ActionState.IdleState;
                idlePolls = 0;
            }
        } catch {
            // Never let the watcher break anything else; try again next poll.
        }
    }, POLL_MS);

    // CDP/debugging handle.
    (window as any).__rlmIdleWatch = () => ({
        lastActionState,
        idlePolls,
        shouldTick,
        blinking,
        overlay: !!overlayEl,
        settings: { ...idleSettings },
        visibility: document.visibilityState,
    });

    if (DEBUG) nativeLog('[IdleWatch] started');
}
