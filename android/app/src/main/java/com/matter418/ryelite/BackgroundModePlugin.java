// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package com.matter418.ryelite;

import android.content.Context;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// JS-facing toggle for the KeepAliveService. The setting lives in
// SharedPreferences (not WebView localStorage) because MainActivity.onPause
// must read it on the native side, synchronously, while the WebView is
// already backgrounded.
@CapacitorPlugin(name = "BackgroundMode")
public class BackgroundModePlugin extends Plugin {

    private static final String PREFS = "ryelite-background-mode";
    private static final String KEY_ENABLED = "enabled";

    static boolean isEnabled(Context context) {
        return context
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(KEY_ENABLED, true);
    }

    // Shared with RLMBridge (secondary tabs' Mobile panel toggles the same
    // app-wide setting).
    static void writeEnabled(Context context, boolean enabled) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_ENABLED, enabled)
                .apply();
    }

    @PluginMethod
    public void setEnabled(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("enabled is required");
            return;
        }
        writeEnabled(getContext(), enabled);
        call.resolve();
    }

    @PluginMethod
    public void getEnabled(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("enabled", isEnabled(getContext()));
        call.resolve(ret);
    }

    // Mirrored from JS (login-state.ts): true only while in-world. This is
    // tab 1's report — secondary tabs report through RLMBridge. TabSessions
    // ORs them to gate KeepAliveService, and tears it down immediately when
    // the LAST session ends while backgrounded (server drop / logout).
    @PluginMethod
    public void setLoggedIn(PluginCall call) {
        Boolean loggedIn = call.getBoolean("loggedIn");
        if (loggedIn == null) {
            call.reject("loggedIn is required");
            return;
        }
        Context context = getActivity() != null ? getActivity() : getContext();
        TabSessions.setLoggedIn(context, 0, loggedIn);
        call.resolve();
    }

    // Tab 1's route for the idle-alert tab blink (idle-watch.ts); secondary
    // tabs use RLMBridge.setIdleBlink.
    @PluginMethod
    public void setIdleBlink(PluginCall call) {
        Boolean on = call.getBoolean("on");
        if (on == null) {
            call.reject("on is required");
            return;
        }
        if (getActivity() instanceof MainActivity) {
            TabManager tm = ((MainActivity) getActivity()).getTabManager();
            if (tm != null) {
                tm.setTabBlink(0, on);
            }
        }
        call.resolve();
    }

    // Tab 1's route for hiding the tab bar while the mobile settings overlay
    // is open (secondary tabs use RLMBridge.setTabBarHidden). Hide is a
    // lease the overlay renews while open — see TabManager.setBarHidden.
    @PluginMethod
    public void setTabBarHidden(PluginCall call) {
        Boolean hidden = call.getBoolean("hidden");
        if (hidden == null) {
            call.reject("hidden is required");
            return;
        }
        if (getActivity() instanceof MainActivity) {
            TabManager tm = ((MainActivity) getActivity()).getTabManager();
            if (tm != null) {
                tm.setBarHidden(hidden);
            }
        }
        call.resolve();
    }

    // Tab 1's route for the keyboard-bridge IME nudge (secondary tabs use
    // RLMBridge.showKeyboard) — see TabManager.showSoftKeyboard.
    @PluginMethod
    public void showKeyboard(PluginCall call) {
        if (getActivity() instanceof MainActivity) {
            TabManager tm = ((MainActivity) getActivity()).getTabManager();
            if (tm != null) {
                tm.showSoftKeyboard(0);
            }
        }
        call.resolve();
    }

    // Tab 1's route for aligning the native tab bar with the game window
    // (secondary tabs use RLMBridge.setTabBarInset).
    @PluginMethod
    public void setTabBarInset(PluginCall call) {
        Integer px = call.getInt("px");
        if (px == null) {
            call.reject("px is required");
            return;
        }
        if (getActivity() instanceof MainActivity) {
            TabManager tm = ((MainActivity) getActivity()).getTabManager();
            if (tm != null) {
                tm.setEdgeInsetPx(px);
            }
        }
        call.resolve();
    }
}
