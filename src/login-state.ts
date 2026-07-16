// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// Mirrors "is the player in-world?" to the native side so the keep-alive
// foreground service only runs for a real session — sitting at the login
// screen and minimizing shouldn't hold a wakelock.
//
// In-world truth: #hs-screen-mask exists only while logged in (it's removed
// for the login screen and the connection-lost dialog). Same body-observer
// pattern as mobile-shell's settings-link re-injection.

import { BackgroundMode } from './background-mode';

export function initLoginStateMirror(): void {
    let last: boolean | null = null;
    const report = () => {
        const inWorld = !!document.getElementById('hs-screen-mask');
        if (inWorld !== last) {
            last = inWorld;
            BackgroundMode.setLoggedIn({ loggedIn: inWorld }).catch(() => {});
        }
    };
    // Cold start is always the login screen — this also clears a stale
    // logged-in flag left behind if the app was killed mid-session.
    report();
    new MutationObserver(report).observe(document.body, {
        childList: true,
        subtree: true,
    });
}
