// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package com.matter418.ryelite;

import android.content.Context;
import android.content.Intent;

import java.util.HashSet;
import java.util.Set;

/**
 * Per-tab logged-in flags, ORed to gate the keep-alive machinery: the
 * KeepAliveService should run while ANY tab has a live session, and be torn
 * down as soon as the last one ends — including while backgrounded (server
 * drop / logout), instead of waiting for the next onResume.
 *
 * Keyed by STABLE tab id (not bar position) — closing a tab renumbers the
 * bar, but each tab's RLMBridge keeps reporting under the id it was born
 * with. Tab 0 (the Capacitor WebView, never closable) is always id 0,
 * reported via the BackgroundMode plugin.
 *
 * In-memory by design: a cold start must never inherit a stale logged-in
 * flag from a killed session.
 */
final class TabSessions {
    private static final Set<Integer> loggedIn = new HashSet<>();

    private TabSessions() {}

    static synchronized void setLoggedIn(Context context, int tabId, boolean state) {
        if (state) {
            loggedIn.add(tabId);
        } else {
            loggedIn.remove(tabId);
            if (loggedIn.isEmpty()) {
                context.stopService(new Intent(context, KeepAliveService.class));
                if (context instanceof MainActivity) {
                    ((MainActivity) context).releaseKeepAliveWakeLock();
                }
            }
        }
    }

    static synchronized boolean anyLoggedIn() {
        return !loggedIn.isEmpty();
    }
}
