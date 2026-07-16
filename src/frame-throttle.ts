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

// Hidden-tab frame throttle — the replacement for WebView.onPause().
//
// Why: Chromium FREEZES an onPause()'d WebView's page ~60 s after it goes
// hidden (measured on device 2026-07-15: 'freeze' event at 60 s, socket
// pongs stop, the server drops the session ~45 s later → "Connection to
// the server was lost" when the user switches back — the hidden-tab
// session deaths). App-backgrounding never had this problem because
// Capacitor (KeepRunning=true) never calls WebView.onPause() at all.
//
// So hidden tabs now stay RESUMED, and the thermal problem onPause used to
// solve (a covered/GONE WebView can keep rendering at full tilt — Chromium
// ignores the visibility signal unreliably) is solved page-side instead:
// TabManager pushes __rlmSetHidden(true/false) on every tab switch, and
// while hidden every requestAnimationFrame caller (game loop, Babylon) is
// served from a ~2 fps setTimeout pump instead of the real compositor
// clock. JS, timers, and the game socket stay fully alive; the game loop
// keeps processing in real time (its accumulator TIMESTEP is 600 ms, so
// 500 ms frames lose nothing) — idle-watch and chat keep working on hidden
// tabs — but there is no 120 Hz render churn.
//
// Callback bookkeeping matters at the transition: a callback that is
// sitting in the REAL rAF queue when the tab goes hidden may never fire
// (Chromium stops producing frames for hidden views) — that would kill the
// game loop, which re-arms itself from inside its own callback. So the
// wrapper owns the id space and MIGRATES pending callbacks between the
// real queue and the timeout pump on every state change.

const nativeRaf = window.requestAnimationFrame.bind(window);
const nativeCaf = window.cancelAnimationFrame.bind(window);

const HIDDEN_FRAME_MS = 500;

type Pending = { kind: 'raf' | 'timeout'; underlying: number; cb: FrameRequestCallback };

let hidden = false;
let nextId = 1;
const pending = new Map<number, Pending>();

// The page's REAL hidden state. document.visibilityState is useless for
// this now: a GONE-but-not-paused WebView keeps reporting "visible".
export function isTabHidden(): boolean {
    return hidden;
}

function schedule(id: number, cb: FrameRequestCallback): Pending {
    if (hidden) {
        return {
            kind: 'timeout',
            cb,
            underlying: window.setTimeout(() => {
                pending.delete(id);
                cb(performance.now());
            }, HIDDEN_FRAME_MS),
        };
    }
    return {
        kind: 'raf',
        cb,
        underlying: nativeRaf(ts => {
            pending.delete(id);
            cb(ts);
        }),
    };
}

function unschedule(p: Pending): void {
    if (p.kind === 'timeout') window.clearTimeout(p.underlying);
    else nativeCaf(p.underlying);
}

export function initFrameThrottle(): void {
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        const id = nextId++;
        pending.set(id, schedule(id, cb));
        return id;
    }) as typeof window.requestAnimationFrame;

    window.cancelAnimationFrame = ((id: number) => {
        const p = pending.get(id);
        if (p) {
            unschedule(p);
            pending.delete(id);
        }
    }) as typeof window.cancelAnimationFrame;

    (window as any).__rlmSetHidden = (h: boolean) => {
        if (h === hidden) return;
        hidden = h;
        // Migrate every pending callback to the other clock, so nothing is
        // stranded in a queue that has stopped ticking.
        for (const [id, p] of [...pending]) {
            unschedule(p);
            pending.set(id, schedule(id, p.cb));
        }
    };
}
