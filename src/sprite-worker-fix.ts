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

// Root-cause fix for invisible players/human NPCs (game client v61).
//
// The game composites human spritesheets in a Web Worker on an
// OffscreenCanvas transferred from a placeholder <canvas> that is never in
// the DOM. Its delivery pipeline is frame-driven in THREE places:
//   worker: composite → requestAnimationFrame(reply)          (worker rAF)
//   canvas: pixels reach the placeholder on the rAF frame commit
//   main:   ready-flag → requestAnimationFrame → placeholder.toBlob()
// requestAnimationFrame only fires while the compositor produces frames.
// On Android, backgrounding the app or the screen blanking stops frames —
// and worker rAF for a never-displayed canvas may never resume. The reply
// then never arrives, SpriteSheetManager._isAwaitingWorkerResult sticks
// true, and every human sprite afterwards queues forever (invisible
// characters until the page is reloaded). Desktop browsers keep producing
// frames while the game is played, which is why this is mobile-only.
//
// Fix: rewrite the worker source at Blob-construction time (we run before
// the game script) so it replies with the image via
// OffscreenCanvas.convertToBlob() — direct pixel readback, no frames
// involved — and route that blob straight to
// SpriteSheetManager._handleSpritesheetCreatedByWebWorker(), skipping the
// placeholder-canvas commit machinery entirely.

import { rawLog } from './error-trap';

// Per-delivery logging (one line per composited sprite) — noisy in normal
// play; the ⚠ warning/anomaly lines below stay on regardless.
const DEBUG = false;

// Unique substrings of the human-sprite worker source (game client v61).
// If a client update changes these, the rewrite silently doesn't apply and
// the game runs its original (desktop-fine) path — sprite-guard.ts still
// watchdogs the stall case.
const WORKER_SIGNATURE = 'doesHelmetHideSpritesUnderneath';
const REPLY_FN_HEAD = 'function l(){self.postMessage({type:o.type,';
const RAF_REPLY = 'requestAnimationFrame(l);';

const rewrittenBlobs = new WeakSet<Blob>();
const spriteWorkerUrls = new Set<string>();
const rewrittenSources: string[] = [];

// The NATIVE Blob, captured before initSpriteWorkerFix() replaces
// window.Blob with a subclass. Blobs structured-cloned from the worker are
// instances of the native class, NOT of our subclass — `x instanceof Blob`
// after the patch is therefore always false for worker replies. (This exact
// mistake made direct delivery silently fall back to the game's stale-canvas
// toBlob path for every sprite — the "everyone dressed the same" bug.)
const NativeBlob = window.Blob;

// ---- "everyone dressed the same" diagnostics -------------------------------
// A known intermittent bug (also seen on desktop clients) renders every
// player/human NPC with the same outfit after login. Candidate mechanisms:
//   (a) game's vanilla delivery ran (our fallback): placeholder-canvas toBlob
//       reads stale pixels → distinct URLs, identical pixels;
//   (b) worker composited identical pixels despite distinct request ids
//       (canvas/bitmap wedge) → identical blob sizes with distinct ids;
//   (c) identical request ids for everyone (packet/def-level) → identical ids;
//   (d) application-level mixup → distinct blobs but same sheet applied.
// The delivery log + __rlmSpriteReport() discriminate all four.

type DeliveryRecord = {
    at: number;
    entityType: unknown;
    name: unknown;
    entityId: unknown;
    entityTypeId: unknown;
    sessionId: unknown;
    blobSize: number;
    url: string;
    ids: string; // JSON of [appearanceIds, equippedItemIds]
};

const DELIVERY_LOG_MAX = 200;
const deliveryLog: DeliveryRecord[] = [];

function recordDelivery(rec: DeliveryRecord): void {
    deliveryLog.push(rec);
    if (deliveryLog.length > DELIVERY_LOG_MAX) deliveryLog.shift();
    if (DEBUG) {
        rawLog(
            `[RyeLite Mobile] SpriteWorkerFix: delivered type=${rec.entityType} ` +
                `name=${rec.name} typeId=${rec.entityTypeId} entityId=${rec.entityId} size=${rec.blobSize}`
        );
    }
    // Identical webp byte-size across DIFFERENT appearance ids ⇒ the worker is
    // producing the same pixels for different requests (mechanism b).
    const recent = deliveryLog.slice(-6);
    if (recent.length >= 4) {
        const sizes = new Set(recent.map(r => r.blobSize));
        const ids = new Set(recent.map(r => r.ids));
        if (sizes.size === 1 && ids.size > 1) {
            rawLog(
                `[RyeLite Mobile] SpriteWorkerFix: ⚠ ANOMALY — last ${recent.length} deliveries ` +
                    `have distinct appearance ids but identical blob size ${recent[0].blobSize}. ` +
                    `Same-pixels bug is active; dump window.__rlmSpriteDeliveries / __rlmSpriteReport().`
            );
        }
    }
}

function installDiagnostics(): void {
    const w = window as unknown as Record<string, unknown>;
    w.__rlmSpriteDeliveries = deliveryLog;
    // Live-debug handles: the object URLs of rewritten sprite workers (fetch
    // one and grep for "convertToBlob" to confirm the RUNNING worker has the
    // injected reply path) and the exact source we produced.
    w.__rlmSpriteWorkerUrls = spriteWorkerUrls;
    w.__rlmRewrittenWorkerSource = rewrittenSources;
    // Snapshot of what the game currently has cached vs. what we delivered.
    // If two players share one SpritesheetURL → application-level mixup (d).
    // If URLs are distinct, correlate sizes/ids in the delivery log (a/b/c).
    w.__rlmSpriteReport = () => {
        const ssm = (document as unknown as {
            highlite?: { gameHooks?: { SpriteSheetManager?: { Instance?: {
                _playerSpritesheetInfo?: Map<unknown, { SpritesheetURL?: string }>;
                _humanNPCSpritesheetInfo?: Map<unknown, { SpritesheetURL?: string }>;
            } } } };
        }).highlite?.gameHooks?.SpriteSheetManager?.Instance;
        const dump = (m?: Map<unknown, { SpritesheetURL?: string }>) =>
            m ? [...m.entries()].map(([k, v]) => ({ key: k, url: v?.SpritesheetURL })) : null;
        return {
            players: dump(ssm?._playerSpritesheetInfo),
            humanNpcs: dump(ssm?._humanNPCSpritesheetInfo),
            deliveries: deliveryLog.slice(-40),
        };
    };
}

export function initSpriteWorkerFix(): void {
    installDiagnostics();
    const OrigBlob = window.Blob;
    const origCreateObjectURL = URL.createObjectURL.bind(URL);
    const OrigWorker = window.Worker;

    window.Blob = class extends OrigBlob {
        constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
            let rewritten = false;
            if (Array.isArray(parts)) {
                parts = parts.map(part => {
                    if (
                        typeof part === 'string' &&
                        part.includes(WORKER_SIGNATURE) &&
                        part.includes(REPLY_FN_HEAD) &&
                        part.includes(RAF_REPLY)
                    ) {
                        rewritten = true;
                        const out = part
                            .replace(
                                REPLY_FN_HEAD,
                                'function l(){self.postMessage({type:o.type,blob:o.blob,blobError:o.blobError,'
                            )
                            .replace(
                                RAF_REPLY,
                                // Capture the request locally: a later create
                                // message reassigns `o` while convertToBlob is
                                // pending. Restore before l() (which reads o).
                                // convertToBlob can throw synchronously OR
                                // reject; report either via blobError so the
                                // main thread can see why direct delivery
                                // fell back.
                                '(function(req){try{a.convertToBlob({type:"image/webp",quality:1})' +
                                    '.then(function(b){req.blob=b;o=req;l()})' +
                                    '.catch(function(err){req.blobError=String(err);o=req;l()})}' +
                                    'catch(err){req.blobError=String(err&&err.stack||err);o=req;l()}})(o);'
                            );
                        rewrittenSources.push(out);
                        return out;
                    }
                    return part;
                });
            }
            super(parts, options);
            if (rewritten) {
                rewrittenBlobs.add(this);
                rawLog(
                    '[RyeLite Mobile] SpriteWorkerFix: worker source rewritten (rAF reply → convertToBlob).'
                );
            }
        }
    };

    URL.createObjectURL = ((obj: Blob | MediaSource) => {
        const url = origCreateObjectURL(obj as Blob);
        if (obj instanceof OrigBlob && rewrittenBlobs.has(obj as Blob)) {
            spriteWorkerUrls.add(url);
        }
        return url;
    }) as typeof URL.createObjectURL;

    window.Worker = class extends OrigWorker {
        constructor(scriptURL: string | URL, options?: WorkerOptions) {
            super(scriptURL, options);
            if (spriteWorkerUrls.has(String(scriptURL))) {
                interceptOnMessage(this);
                rawLog('[RyeLite Mobile] SpriteWorkerFix: sprite worker instance hooked.');
            }
        }
    };
}

// The game assigns worker.onmessage = its handler. Shadow the accessor so
// blob-carrying create replies are consumed by us and everything else
// (initialize completion, failed creates) passes through untouched.
function interceptOnMessage(worker: Worker): void {
    const proto = Object.getPrototypeOf(worker);
    const desc = findOnMessageDescriptor(proto);
    let installed: ((e: MessageEvent) => void) | null = null;
    Object.defineProperty(worker, 'onmessage', {
        configurable: true,
        get: () => installed,
        set: (handler: ((e: MessageEvent) => void) | null) => {
            installed = handler;
            desc?.set?.call(worker, (e: MessageEvent) => {
                if (deliverSpritesheetDirectly(e)) return;
                handler?.call(worker, e);
            });
        },
    });
}

function findOnMessageDescriptor(proto: object | null): PropertyDescriptor | undefined {
    while (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'onmessage');
        if (desc) return desc;
        proto = Object.getPrototypeOf(proto);
    }
    return undefined;
}

function deliverSpritesheetDirectly(e: MessageEvent): boolean {
    const d = e?.data as
        | {
              blob?: Blob;
              result?: boolean;
              entityType?: unknown;
              name?: unknown;
              entityId?: unknown;
              entityTypeId?: unknown;
              appearanceIds?: unknown;
              equippedItemIds?: unknown;
              sessionId?: unknown;
          }
        | undefined;
    if (!d || d.result !== true || d.entityType === undefined) {
        return false; // not a successful create reply (init/error replies take the game path)
    }
    if (!(d.blob instanceof NativeBlob)) {
        // convertToBlob failed in the worker — the game's toBlob-on-placeholder
        // path runs instead, which can capture STALE canvas pixels (the
        // suspected "everyone dressed the same" mechanism).
        rawLog(
            '[RyeLite Mobile] SpriteWorkerFix: ⚠ create reply without blob — ' +
                `falling back to game toBlob path (stale-canvas risk). blobError=${(d as { blobError?: unknown }).blobError}`
        );
        return false;
    }
    const ssm = (document as unknown as {
        highlite?: { gameHooks?: { SpriteSheetManager?: { Instance?: { _handleSpritesheetCreatedByWebWorker?: (e: unknown, t: unknown) => void } } } };
    }).highlite?.gameHooks?.SpriteSheetManager?.Instance;
    if (!ssm?._handleSpritesheetCreatedByWebWorker) {
        rawLog(
            '[RyeLite Mobile] SpriteWorkerFix: ⚠ SpriteSheetManager hook unavailable — ' +
                'falling back to game toBlob path (stale-canvas risk).'
        );
        return false;
    }

    // Duck-typed stand-in for the game's spritesheet-created args object —
    // the handler only reads these PascalCase getters.
    const args = {
        SpritesheetUrl: URL.createObjectURL(d.blob),
        EntityType: d.entityType,
        Name: d.name,
        EntityID: d.entityId,
        EntityTypeID: d.entityTypeId,
        AppearanceIDs: d.appearanceIds,
        EquippedItemIDs: d.equippedItemIds,
        SessionID: d.sessionId,
    };
    try {
        ssm._handleSpritesheetCreatedByWebWorker(null, args);
        recordDelivery({
            at: Date.now(),
            entityType: d.entityType,
            name: d.name,
            entityId: d.entityId,
            entityTypeId: d.entityTypeId,
            sessionId: d.sessionId,
            blobSize: d.blob.size,
            url: args.SpritesheetUrl,
            ids: JSON.stringify([d.appearanceIds, d.equippedItemIds]),
        });
    } catch (err) {
        rawLog(`[RyeLite Mobile] SpriteWorkerFix: direct delivery failed: ${err}`);
    }
    return true;
}
