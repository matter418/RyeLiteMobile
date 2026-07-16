// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// Tap-to-type for the chat bar.
//
// The game's own "tap the chat input to open a text box" handler
// (_handleChatInputMenuPointerDown) is registered in _addMobileOnlyEvents(),
// which never runs because we force desktop mode — so on our client, tapping
// the chat bar does nothing. The handler itself is still constructed and
// bound in desktop mode, so we re-wire it: a delegated tap on the chat
// input area invokes it, opening the game's native "Type a public chat
// message" input (which brings up the soft keyboard and sends through the
// game's normal chat path).
//
// Delegated on document so it survives the game rebuilding the chat menu on
// relogin. Restricted to the name+input container — the chat settings
// button shares the row and keeps its own handler.

const TAP_AREA = '#hs-chat-input-player-name-and-input-container';

export function initChatTapToType(): void {
    document.addEventListener('pointerdown', e => {
        const target = e.target as HTMLElement | null;
        if (!target?.closest?.(TAP_AREA)) return;
        const ctrl = (document as any).highlite?.gameHooks?.HTMLUIManager
            ?.Instance?._controller;
        const chatCtrl = ctrl?._chatMenuController;
        if (typeof chatCtrl?._handleChatInputMenuPointerDown !== 'function') {
            return;
        }
        // Already open (e.g. double tap) — don't stack a second menu.
        if (ctrl?._screenMaskController?.IsTextInputMenuShowing) return;
        try {
            chatCtrl._handleChatInputMenuPointerDown(e, null);
        } catch (err) {
            console.warn('[RyeLite Mobile] chat tap-to-type failed:', err);
        }
        // Capture phase is REQUIRED: the game stops pointerdown propagation
        // inside the chat menu, so a bubble listener never fires (verified
        // live — capture sees the tap, bubble does not).
    }, { capture: true });
    console.log('[RyeLite Mobile] Chat tap-to-type installed.');
}
