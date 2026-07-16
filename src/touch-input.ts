// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// Touch → mouse input translation for the High Spell 3D world.
//
// Verified live against the real game (CDP experiments, 2026-07-13):
//  - #hs-screen-mask covers the entire viewport (z-index 2). ALL real input
//    targets the mask — never the canvas. The game's action/menu logic lives
//    on the mask's listeners; Babylon's canvas listeners are fed separately.
//    Synthetic events must therefore target the mask (dispatching on the
//    canvas reaches Babylon but the game's click/menu logic never sees it).
//  - Desktop mode (ForceDesktopMode): button 0 down/up on the mask = default
//    action; button 2 down = world context menu; button 1 (middle) drag =
//    camera rotation (buttons 0/2 do not move the camera at all).
//  - The game REPLACES console.log after it initializes (routes to its
//    in-game dev console) — all our logging must go through references
//    captured before the game client script runs.
//
// Gesture mapping (game in desktop mode, which the loader relies on):
//   tap                 → button 0 down/up   (default action)
//   hold (configurable) → button 2 down/up + contextmenu (context menu)
//   drag                → button 1 drag      (camera)
//   pinch               → wheel events       (camera zoom)
//
// Pinch → zoom notes (verified live via CDP, 2026-07-14): the camera is a
// Babylon ArcRotateCamera with a mousewheel input; synthetic WheelEvents on
// the mask zoom it (deltaY > 0 = zoom out). The zoom step is NORMALIZED per
// event (deltaY 30 and 120 produce the same ~1 radius step) and synchronous
// event bursts are mostly swallowed (frame-accumulator), so pinch emits at
// most one discrete tick per pointermove, paced by the accumulated change in
// finger spread.

// Captured BEFORE the game replaces console.log — see note above.
const nativeLog = console.log.bind(console);
const nativeWarn = console.warn.bind(console);

const SETTINGS_KEY = 'ryelite-mobile-touch-v2'; // v2: dragButton default fixed to middle

export interface TouchSettings {
    enabled: boolean;
    longPressMs: number;
}

export const touchSettings: TouchSettings = {
    enabled: true,
    longPressMs: 400,
    ...((): Partial<TouchSettings> => {
        try {
            return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        } catch {
            return {};
        }
    })(),
};

// Middle-button drag is what rotates the camera — measured against the live
// game (buttons 0/2 don't move it at all). Not configurable on purpose.
const CAMERA_BUTTON = 1;

export function saveTouchSettings(): void {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(touchSettings));
}

const MOVE_THRESHOLD_PX = 12;

// CSS px of finger-spread change per zoom tick. One tick ≈ 1 camera radius
// unit; the game's usable radius range is roughly 4–18, so a full-screen
// pinch sweeps about half the range.
const PINCH_STEP_PX = 40;

// Diagnostics (visible in `adb logcat -s Capacitor/Console` thanks to the
// captured native console.log). Keep OFF for release builds.
const DEBUG = false;

function describe(el: EventTarget | null): string {
    if (!(el instanceof Element)) return String(el);
    const id = el.id ? `#${el.id}` : '';
    const cls =
        typeof el.className === 'string' && el.className
            ? `.${el.className.split(/\s+/).slice(0, 3).join('.')}`
            : '';
    return `${el.tagName}${id}${cls}`;
}

function buttonsFor(button: number): number {
    return button === 0 ? 1 : button === 1 ? 4 : 2;
}

function synth(
    target: Element,
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    x: number,
    y: number,
    button: number,
    pointerId: number
): void {
    target.dispatchEvent(
        new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            pointerId,
            pointerType: 'mouse',
            isPrimary: true,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            button: type === 'pointermove' ? -1 : button,
            buttons: type === 'pointerup' ? 0 : buttonsFor(button),
        })
    );
}

function synthWheel(target: Element, x: number, y: number, deltaY: number): void {
    target.dispatchEvent(
        new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            deltaY,
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
        })
    );
}

// The BARE screen mask = the 3D world surface. CANVAS is a fallback for any
// pre-login state without the mask.
function isWorldSurface(el: EventTarget | null): el is Element {
    return (
        el instanceof Element &&
        (el.id === 'hs-screen-mask' || el.tagName === 'CANVAS')
    );
}

// Inventory-style slots (inventory, bank, trade — .hs-inventory-item covers
// all three). Hold on these should open the item's context menu; the
// mechanism (synthetic button-2 PointerEvents on the slot) is the same one
// QuickDeposit/QuickDrop use on desktop. Drag replays as LEFT drag here
// (item reordering), not the camera button.
function inventoryItemOf(el: EventTarget | null): Element | null {
    return el instanceof Element ? el.closest('.hs-inventory-item') : null;
}

export function initTouchInput(): void {
    type GestureMode = 'pending' | 'dragging' | 'longpressed' | 'pinching' | 'dead';

    let activePointerId: number | null = null;
    let mode: GestureMode = 'dead';
    let target: Element | null = null;
    const dragBtn = CAMERA_BUTTON; // world drags = camera
    // Pinch (two fingers on the world surface) → camera zoom via synthetic
    // wheel events. We track both fingers' latest positions; spread change is
    // converted to discrete wheel ticks (see PINCH_STEP_PX note up top).
    let pinchPointerId: number | null = null; // the second finger
    let primaryX = 0;
    let primaryY = 0;
    let pinchX = 0;
    let pinchY = 0;
    let pinchLastSpread = 0;
    let pinchAccum = 0;
    // Item drags use HTML5 drag-and-drop, NOT pointer events: slots are
    // draggable=true with dragstart/dragend listeners, containers handle
    // dragover/drop (verified live — a synthetic dragstart→dragover→drop
    // sequence with a shared DataTransfer swaps bank items; synthetic
    // pointer drags just complete a click and trigger the default action).
    let dragSlot: Element | null = null; // non-null → item gesture
    let dataTransfer: DataTransfer | null = null;
    let startX = 0;
    let startY = 0;
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    // Synthetic DnD has no native drag image, so item drags were invisible
    // until the drop landed. The ghost is a translucent clone of the slot
    // that follows the finger (offset up so the fingertip doesn't hide it);
    // the source slot dims while the drag is in flight. All styling is
    // inline — game CSS load order can't interfere.
    let dragGhost: HTMLElement | null = null;
    let dragGhostSource: HTMLElement | null = null;

    function makeDragGhost(slot: Element, x: number, y: number): void {
        removeDragGhost();
        const rect = slot.getBoundingClientRect();
        const ghost = slot.cloneNode(true) as HTMLElement;
        ghost.removeAttribute('id');
        ghost.removeAttribute('draggable');
        ghost.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
        ghost.classList.add('rlm-drag-ghost');
        Object.assign(ghost.style, {
            position: 'fixed',
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            margin: '0',
            pointerEvents: 'none', // must never win elementFromPoint
            opacity: '0.75',
            zIndex: '2147483000',
            transform: 'translate(-50%, -80%)',
        });
        document.body.appendChild(ghost);
        dragGhost = ghost;
        dragGhostSource = slot as HTMLElement;
        dragGhostSource.style.opacity = '0.4';
        moveDragGhost(x, y);
    }

    function moveDragGhost(x: number, y: number): void {
        if (!dragGhost) return;
        dragGhost.style.left = `${x}px`;
        dragGhost.style.top = `${y}px`;
    }

    function removeDragGhost(): void {
        dragGhost?.remove();
        dragGhost = null;
        if (dragGhostSource) {
            dragGhostSource.style.opacity = '';
            dragGhostSource = null;
        }
    }

    function mkDragEvent(type: string, x: number, y: number): DragEvent {
        return new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            dataTransfer: dataTransfer!,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            button: 0,
        });
    }

    function clearTimer() {
        if (longPressTimer !== null) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    }

    function endGesture() {
        clearTimer();
        activePointerId = null;
        pinchPointerId = null;
        mode = 'dead';
        target = null;
    }

    function suppress(e: Event) {
        e.preventDefault();
        e.stopImmediatePropagation();
    }

    window.addEventListener(
        'pointerdown',
        e => {
            if (!e.isTrusted || !touchSettings.enabled) return;
            if (e.pointerType !== 'touch') return;
            const world = isWorldSurface(e.target);
            const item = world ? null : inventoryItemOf(e.target);
            if (!world && !item) return;

            if (activePointerId !== null) {
                suppress(e);
                // Second finger on the world surface during a world gesture
                // → pinch zoom. (Item gestures, open long-press menus, and
                // third+ fingers stay swallowed.)
                if (
                    world &&
                    !dragSlot &&
                    pinchPointerId === null &&
                    (mode === 'pending' || mode === 'dragging')
                ) {
                    if (mode === 'dragging') {
                        // End the in-flight camera drag cleanly first.
                        synth(target!, 'pointerup', primaryX, primaryY, dragBtn, activePointerId);
                    }
                    clearTimer();
                    mode = 'pinching';
                    pinchPointerId = e.pointerId;
                    pinchX = e.clientX;
                    pinchY = e.clientY;
                    pinchLastSpread = Math.hypot(pinchX - primaryX, pinchY - primaryY);
                    pinchAccum = 0;
                    if (DEBUG) nativeLog('[TouchDebug] PINCH start');
                }
                return;
            }

            activePointerId = e.pointerId;
            mode = 'pending';
            target = e.target as Element;
            dragSlot = item;
            dataTransfer = null;
            startX = e.clientX;
            startY = e.clientY;
            primaryX = e.clientX;
            primaryY = e.clientY;
            suppress(e);
            if (DEBUG)
                nativeLog(
                    `[TouchDebug] gesture start on ${describe(target)} at ${Math.round(startX)},${Math.round(startY)}`
                );

            longPressTimer = setTimeout(() => {
                if (mode !== 'pending' || !target) return;
                mode = 'longpressed';
                navigator.vibrate?.(20);
                const t = target;
                const pid = activePointerId!;
                if (DEBUG) nativeLog('[TouchDebug] HOLD -> right click (menu)');
                synth(t, 'pointerdown', startX, startY, 2, pid);
                requestAnimationFrame(() => {
                    synth(t, 'pointerup', startX, startY, 2, pid);
                    t.dispatchEvent(
                        new MouseEvent('contextmenu', {
                            bubbles: true,
                            cancelable: true,
                            composed: true,
                            view: window,
                            button: 2,
                            clientX: startX,
                            clientY: startY,
                            screenX: startX,
                            screenY: startY,
                        })
                    );
                });
            }, touchSettings.longPressMs);
        },
        { capture: true, passive: false }
    );

    window.addEventListener(
        'pointermove',
        e => {
            if (!e.isTrusted) return;
            if (e.pointerId !== activePointerId && e.pointerId !== pinchPointerId) return;
            suppress(e);

            if (mode === 'pinching') {
                if (e.pointerId === activePointerId) {
                    primaryX = e.clientX;
                    primaryY = e.clientY;
                } else {
                    pinchX = e.clientX;
                    pinchY = e.clientY;
                }
                const spread = Math.hypot(pinchX - primaryX, pinchY - primaryY);
                pinchAccum += spread - pinchLastSpread;
                pinchLastSpread = spread;
                // At most ONE tick per pointermove — the game swallows event
                // bursts (see header note); the remainder carries over.
                if (Math.abs(pinchAccum) >= PINCH_STEP_PX) {
                    const zoomIn = pinchAccum > 0; // fingers apart = zoom in
                    pinchAccum -= (zoomIn ? 1 : -1) * PINCH_STEP_PX;
                    const midX = (primaryX + pinchX) / 2;
                    const midY = (primaryY + pinchY) / 2;
                    if (DEBUG)
                        nativeLog(`[TouchDebug] PINCH tick -> wheel ${zoomIn ? 'in' : 'out'}`);
                    synthWheel(target!, midX, midY, zoomIn ? -100 : 100);
                }
                return;
            }

            if (e.pointerId !== activePointerId) return;
            primaryX = e.clientX;
            primaryY = e.clientY;

            if (mode === 'longpressed') return; // menu open; ignore finger drift

            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (mode === 'pending') {
                if (Math.hypot(dx, dy) < MOVE_THRESHOLD_PX) return;
                mode = 'dragging';
                clearTimer();
                if (dragSlot) {
                    if (DEBUG) nativeLog('[TouchDebug] ITEM DRAG start (HTML5 DnD)');
                    dataTransfer = new DataTransfer();
                    dragSlot.dispatchEvent(mkDragEvent('dragstart', startX, startY));
                    makeDragGhost(dragSlot, e.clientX, e.clientY);
                } else {
                    if (DEBUG) nativeLog(`[TouchDebug] DRAG start (button ${dragBtn})`);
                    synth(target!, 'pointerdown', startX, startY, dragBtn, e.pointerId);
                }
            }
            if (dragSlot) {
                moveDragGhost(e.clientX, e.clientY);
                document
                    .elementFromPoint(e.clientX, e.clientY)
                    ?.dispatchEvent(mkDragEvent('dragover', e.clientX, e.clientY));
            } else {
                synth(target!, 'pointermove', e.clientX, e.clientY, dragBtn, e.pointerId);
            }
        },
        { capture: true, passive: false }
    );

    const onUpOrCancel = (e: PointerEvent) => {
        if (!e.isTrusted) return;
        if (e.pointerId !== activePointerId && e.pointerId !== pinchPointerId) return;
        suppress(e);

        if (mode === 'pinching') {
            // One pinch finger lifted → the remaining finger becomes a fresh
            // camera drag (middle button does nothing on a stationary
            // down/up, so this is safe even if it lifts without moving).
            const remainingId =
                e.pointerId === activePointerId ? pinchPointerId! : activePointerId!;
            const rx = e.pointerId === activePointerId ? pinchX : primaryX;
            const ry = e.pointerId === activePointerId ? pinchY : primaryY;
            activePointerId = remainingId;
            pinchPointerId = null;
            mode = 'dragging';
            startX = rx;
            startY = ry;
            primaryX = rx;
            primaryY = ry;
            if (DEBUG) nativeLog('[TouchDebug] PINCH end -> camera drag');
            synth(target!, 'pointerdown', rx, ry, dragBtn, remainingId);
            return;
        }

        if (e.pointerId !== activePointerId) return;
        const t = target!;
        const slot = dragSlot;
        const endedMode: GestureMode = mode;
        const x = e.clientX;
        const y = e.clientY;
        const pid = e.pointerId;
        // NOTE: endGesture() clears state but dataTransfer/mkDragEvent still
        // reference the object via closure until this handler returns.
        const finishItemDrag = (dropIt: boolean) => {
            removeDragGhost(); // first — a throwing drop handler must not strand the ghost
            if (dropIt) {
                document
                    .elementFromPoint(x, y)
                    ?.dispatchEvent(mkDragEvent('drop', x, y));
            }
            slot!.dispatchEvent(mkDragEvent('dragend', x, y));
        };
        endGesture();

        if (e.type === 'pointercancel') {
            if (endedMode === 'dragging') {
                if (slot) finishItemDrag(false);
                else synth(t, 'pointerup', x, y, dragBtn, pid);
            }
            return;
        }

        if (endedMode === 'pending') {
            // Quick stationary tap → left click at the touch point
            if (DEBUG) nativeLog('[TouchDebug] TAP -> left click');
            synth(t, 'pointerdown', startX, startY, 0, pid);
            requestAnimationFrame(() => synth(t, 'pointerup', startX, startY, 0, pid));
        } else if (endedMode === 'dragging') {
            if (slot) {
                if (DEBUG) nativeLog('[TouchDebug] ITEM DROP');
                finishItemDrag(true);
            } else {
                synth(t, 'pointerup', x, y, dragBtn, pid);
            }
        }
        // longpressed: button-2 sequence already dispatched by the timer
    };
    window.addEventListener('pointerup', onUpOrCancel, {
        capture: true,
        passive: false,
    });
    window.addEventListener('pointercancel', onUpOrCancel, {
        capture: true,
        passive: false,
    });

    // The game also has document-level touch listeners; keep raw touch events
    // away from everything while a gesture is being translated (pointer* and
    // touch* are separate streams — suppressing one does not suppress the
    // other).
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
        window.addEventListener(
            type,
            e => {
                if (!e.isTrusted) return;
                // While a translated gesture is active it owns the finger —
                // keep ALL raw touch events (any target) away from the game.
                if (activePointerId === null && mode === 'dead') return;
                e.preventDefault();
                e.stopImmediatePropagation();
            },
            { capture: true, passive: false }
        );
    }

    if (typeof nativeWarn === 'function' && !navigator.vibrate) {
        nativeWarn('[RyeLite Mobile] navigator.vibrate unavailable — no haptic cue for holds.');
    }
    nativeLog('[RyeLite Mobile] Touch input translation installed (mask-targeted).');
}
