// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// Soft-keyboard bridge for the game's text input menus.
//
// The game's TextInputMenu only builds a real HTML <input> when its
// MobileHelper says IsMobile — which ForceDesktopMode (required for our
// touch semantics) vetoes. In desktop mode it builds a span-based fake
// input fed by hardware key events, so Android never shows a soft keyboard
// and there is no way to type (chat, bank "Withdraw X", item creation —
// every text prompt).
//
// Bridge: whenever a .hs-text-input-menu enters the DOM, overlay the fake
// input with an invisible real <input>, focus it (the menu always appears
// as the direct result of a tap, so user activation lets the IME open),
// and mirror its value into the game's TextInput via setInputValue().
// Enter submits via processKey('Enter'). The game's own span renders the
// typed text, so the invisible overlay is purely a keyboard conduit.
// Tapping the input area again refocuses it if the keyboard was dismissed.

const nativeLog = console.log.bind(console);

// The game's TextInput object for the currently-open menu (span-based fake
// input with setInputValue/processKey), or null.
function currentTextInput(): any {
    const smc = (document as any).highlite?.gameHooks?.HTMLUIManager?.Instance
        ?._controller?._screenMaskController;
    return smc?._currentTextInputMenu?.getTextInput?.() ?? null;
}

export function initKeyboardBridge(): void {
    let shadow: HTMLInputElement | null = null;
    let watcher: ReturnType<typeof setInterval> | null = null;

    function cleanup() {
        if (watcher !== null) {
            clearInterval(watcher);
            watcher = null;
        }
        shadow?.remove();
        shadow = null;
    }

    function attach(menuEl: Element) {
        cleanup();
        const ti = currentTextInput();
        if (!ti) return;
        const fake =
            menuEl.querySelector('.hs-text-input-span') ??
            menuEl.querySelector('.hs-input') ??
            menuEl;

        const inp = document.createElement('input');
        shadow = inp;
        inp.type = 'text';
        inp.autocomplete = 'off';
        inp.autocapitalize = 'off';
        inp.spellcheck = false;
        inp.enterKeyHint = 'send';
        inp.style.cssText =
            'position:fixed;opacity:0;background:transparent;border:none;' +
            'outline:none;caret-color:transparent;color:transparent;' +
            'font-size:16px;z-index:2147483200;margin:0;padding:0;';
        const place = () => {
            const r = fake.getBoundingClientRect();
            inp.style.left = `${r.left}px`;
            inp.style.top = `${r.top}px`;
            inp.style.width = `${Math.max(r.width, 40)}px`;
            inp.style.height = `${Math.max(r.height, 24)}px`;
        };
        place();
        inp.value = ti._inputValue ?? '';

        // Never let the shadow's key events reach the game's document-level
        // key handling — it feeds the same TextInput and would double up
        // (worst case a duplicate Enter submits an empty second message).
        // All mirroring goes through the input event below.
        for (const t of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input']) {
            inp.addEventListener(t, e => e.stopPropagation());
        }
        inp.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                try {
                    ti.processKey('Enter'); // submits; menu close → watcher cleans up
                } catch (err) {
                    console.warn('[RyeLite Mobile] keyboard bridge submit failed:', err);
                }
            }
        });
        inp.addEventListener('input', () => {
            const max = typeof ti._maxLength === 'number' ? ti._maxLength : 200;
            if (inp.value.length > max) inp.value = inp.value.slice(0, max);
            try {
                ti.setInputValue(inp.value);
            } catch (err) {
                console.warn('[RyeLite Mobile] keyboard bridge mirror failed:', err);
            }
        });

        document.body.appendChild(inp);
        // The game blurs focus during menu setup (it keeps key handling on
        // the document), so one immediate focus() doesn't survive — verified
        // on device: activeElement was back to BODY by the next task. Retry
        // until it sticks; the opening tap's user activation lets the IME
        // show for these programmatic focuses.
        //
        // Android 11 (Lenovo tablet) never shows the IME for a programmatic
        // focus — only for a tap directly on an editable, so there the
        // keyboard takes a second tap (on the input line). A native
        // showSoftInput auto-nudge was tried and reverted (glitchy in
        // practice; the second tap is reliable) — see git history if an
        // opt-in is ever wanted.
        let tries = 0;
        const refocus = () => {
            if (shadow !== inp || !inp.isConnected) return;
            if (document.activeElement !== inp && tries++ < 10) {
                inp.focus();
                setTimeout(refocus, 100);
            }
        };
        inp.focus();
        setTimeout(refocus, 50);

        // Follow the menu (the IME opening resizes the viewport and recenters
        // it) and tear down when the game removes it.
        watcher = setInterval(() => {
            if (!menuEl.isConnected) {
                cleanup();
                return;
            }
            place();
        }, 300);
    }

    new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const node of Array.from(m.addedNodes)) {
                if (!(node instanceof Element)) continue;
                const menu = node.classList?.contains('hs-text-input-menu')
                    ? node
                    : node.querySelector?.('.hs-text-input-menu');
                if (menu) {
                    attach(menu);
                    return;
                }
            }
        }
    }).observe(document.body, { childList: true, subtree: true });

    nativeLog('[RyeLite Mobile] Soft-keyboard bridge installed.');
}
