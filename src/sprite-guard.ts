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

// Guards the game's SpriteSheetManager against a real upstream bug: its
// logout teardown (reset()) runs the human-sprite queue cleanup and the
// `_isAwaitingWorkerResult=false` reset inside ONE try/catch, and the whole
// teardown sequence can be aborted by unrelated exceptions (several game
// managers throw on quick/edge-case logouts — see error-trap captures).
// When that happens the manager is left believing a worker request is
// forever in flight; every later session queues spritesheet requests behind
// the stuck flag and players/human NPCs render invisible (billboard mesh
// with no material). initializeNewSession() then ALSO no-ops because
// `_isInitializedForSession` is still true.
//
// Strategy (game state machine stays authoritative; we only repair):
// 1. Sanitize on the login screen reappearing — our own teardown-of-last-
//    resort, independent of whether the game's crash path reached reset().
// 2. Wrap reset() to enforce its own invariants after it returns (it
//    swallows internal exceptions).
// 3. A watchdog re-kicks the queue if it ever stalls in-world anyway
//    (covers a genuinely lost worker reply).

import { rawLog } from './error-trap';

type Ssm = {
    _isAwaitingWorkerResult: boolean;
    _isInitializedForSession: boolean;
    _humanSpriteWorkerRequestQueue: unknown[];
    _playerSpritesheetInfo: Map<unknown, unknown>;
    _humanNPCSpritesheetInfo: Map<unknown, unknown>;
    _destroySpritesheetInformation(info: unknown): void;
    _postCreateSpritesheetRequestToWorker(req: unknown): void;
};

type SsmClass = { Instance: Ssm | null; prototype: Ssm & { reset(): void } };

const CLASS_POLL_MS = 1000;
const WATCHDOG_MS = 5000;
const STUCK_TICKS = 3; // ≥15s without progress counts as stalled
const MAX_KICKS_PER_SESSION = 5;

let kicks = 0;

function sanitize(ssm: Ssm, context: string): void {
    const queue = ssm._humanSpriteWorkerRequestQueue;
    const dirty =
        ssm._isAwaitingWorkerResult ||
        ssm._isInitializedForSession ||
        (Array.isArray(queue) && queue.length > 0);
    if (!dirty) return;

    rawLog(
        `[RyeLite Mobile] SpriteGuard: repairing sprite manager after ${context} ` +
            `(awaiting=${ssm._isAwaitingWorkerResult}, initForSession=${ssm._isInitializedForSession}, ` +
            `queue=${Array.isArray(queue) ? queue.length : '?'})`
    );

    // Null-safe version of what the game's reset() should have finished:
    // release leftover composited sheets so the next session starts clean.
    for (const map of [ssm._playerSpritesheetInfo, ssm._humanNPCSpritesheetInfo]) {
        try {
            for (const info of map.values()) {
                try {
                    if (info) ssm._destroySpritesheetInformation(info);
                } catch {
                    /* per-entry: never let one bad sheet stop the repair */
                }
            }
            map.clear();
        } catch {
            /* map itself unusable — leave it; worst case is a small leak */
        }
    }
    ssm._humanSpriteWorkerRequestQueue = [];
    ssm._isAwaitingWorkerResult = false;
    ssm._isInitializedForSession = false;
    kicks = 0;
}

function installResetWrap(cls: SsmClass): void {
    const original = cls.prototype.reset;
    cls.prototype.reset = function (this: Ssm, ...args: unknown[]) {
        const result = (original as (...a: unknown[]) => unknown).apply(this, args);
        // reset() catches its own exceptions; enforce the invariants its
        // tail sets in case it bailed mid-loop.
        if (
            this._isAwaitingWorkerResult ||
            this._isInitializedForSession ||
            this._humanSpriteWorkerRequestQueue.length > 0
        ) {
            sanitize(this, 'a partially-failed reset()');
        }
        return result;
    };
}

function installLoginScreenSanitizer(cls: SsmClass): void {
    let wasInWorld = false;
    new MutationObserver(() => {
        if (!wasInWorld) {
            if (document.querySelector('#hs-screen-mask')) wasInWorld = true;
            return;
        }
        if (document.querySelector('#login-menu-username')) {
            wasInWorld = false;
            const ssm = cls.Instance;
            if (ssm) sanitize(ssm, 'logout (login screen shown)');
        }
    }).observe(document.body, { childList: true, subtree: true });
}

function installWatchdog(cls: SsmClass): void {
    let lastSheetCount = -1;
    let stuckTicks = 0;
    setInterval(() => {
        const ssm = cls.Instance;
        if (!ssm || !document.querySelector('#hs-screen-mask')) return;

        const queue = ssm._humanSpriteWorkerRequestQueue;
        const sheets =
            (ssm._playerSpritesheetInfo?.size ?? 0) +
            (ssm._humanNPCSpritesheetInfo?.size ?? 0);
        const stalled =
            ssm._isAwaitingWorkerResult &&
            Array.isArray(queue) &&
            queue.length > 0 &&
            sheets === lastSheetCount;
        lastSheetCount = sheets;
        stuckTicks = stalled ? stuckTicks + 1 : 0;
        if (stuckTicks < STUCK_TICKS || kicks >= MAX_KICKS_PER_SESSION) return;

        stuckTicks = 0;
        kicks++;
        const live = queue.filter(Boolean);
        const next = live.shift();
        ssm._humanSpriteWorkerRequestQueue = live;
        ssm._isAwaitingWorkerResult = false;
        if (!next) return;
        try {
            ssm._postCreateSpritesheetRequestToWorker(next);
            rawLog(
                `[RyeLite Mobile] SpriteGuard: queue stalled in-world — re-kicked worker (kick ${kicks}, ${live.length} still queued)`
            );
        } catch (e) {
            rawLog(`[RyeLite Mobile] SpriteGuard: re-kick failed: ${e}`);
        }
    }, WATCHDOG_MS);
}

export function initSpriteGuard(): void {
    const poll = setInterval(() => {
        const cls = (document as unknown as { highlite?: { gameHooks?: Record<string, unknown> } })
            .highlite?.gameHooks?.SpriteSheetManager as SsmClass | undefined;
        if (!cls?.prototype?.reset) return;
        clearInterval(poll);
        installResetWrap(cls);
        installLoginScreenSanitizer(cls);
        installWatchdog(cls);
        rawLog('[RyeLite Mobile] SpriteGuard installed.');
    }, CLASS_POLL_MS);
}
