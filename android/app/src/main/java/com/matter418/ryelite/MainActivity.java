// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package com.matter418.ryelite;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // Glimmer-style background keep-alive: hold the CPU for up to 20 minutes
    // after backgrounding so the game survives screen-off too, not just
    // app-switching (the foreground service alone keeps the process unfrozen
    // but doesn't prevent Doze from suspending the CPU).
    private static final long WAKELOCK_TIMEOUT_MS = 20 * 60 * 1000L;
    private PowerManager.WakeLock wakeLock;

    // Multi-account tab system (up to TabManager.MAX_TABS RyeLite instances).
    private TabManager tabManager;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge is created.
        registerPlugin(CredentialStorePlugin.class);
        registerPlugin(BackgroundModePlugin.class);
        super.onCreate(savedInstanceState);
        // Honor <meta name="viewport" content="width=N"> so the page can
        // render at a virtual desktop-sized viewport (scaled down to fit).
        WebSettings settings = getBridge().getWebView().getSettings();
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);

        // The WebView renderer is a SEPARATE sandboxed process; by default its
        // binding priority is waived when the WebView isn't visible, making it
        // eligible for the cached-app freezer even while our own process is
        // protected by KeepAliveService. Keep it important so the game's
        // socket handlers stay runnable during long backgrounding.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getBridge().getWebView()
                    .setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }

        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        if (powerManager != null) {
            wakeLock = powerManager.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK, "RyeLite::KeepAliveWakeLock");
        }

        // The keep-alive notification needs POST_NOTIFICATIONS on Android 13+.
        // (The service still runs without it — the notification is just hidden.)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                    this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1001);
        }

        tabManager = new TabManager(this, getBridge().getWebView());
    }

    TabManager getTabManager() {
        return tabManager;
    }

    // A stray back gesture must not finish the activity — that would tear
    // down every tab's WebView (up to 6 live sessions). Minimize instead,
    // which is the exact state the keep-alive machinery is built for.
    @Override
    public void onBackPressed() {
        moveTaskToBack(true);
    }

    @Override
    public void onDestroy() {
        if (tabManager != null) {
            tabManager.onActivityDestroy();
        }
        super.onDestroy();
    }

    @Override
    public void onPause() {
        super.onPause();
        // Keep-alive only makes sense for a live session — backgrounding at
        // the login screen shouldn't hold a wakelock. Every tab mirrors its
        // own in-world state (login-state.ts → BackgroundMode plugin or
        // RLMBridge); TabSessions ORs them.
        if (BackgroundModePlugin.isEnabled(this) && TabSessions.anyLoggedIn()) {
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire(WAKELOCK_TIMEOUT_MS);
            }
            ContextCompat.startForegroundService(this, new Intent(this, KeepAliveService.class));
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        releaseKeepAliveWakeLock();
        stopService(new Intent(this, KeepAliveService.class));
        // The activity resume path wakes WebViews wholesale — re-pause the
        // hidden tabs so only the active one renders.
        if (tabManager != null) {
            tabManager.reassertVisibility();
        }
    }

    void releaseKeepAliveWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            // Immersive fullscreen: the status bar otherwise overlays the
            // game's top strip and its pull-down gesture zone eats touches
            // near the top edge (where the game keeps its logout button).
            // Swiping from a screen edge transiently reveals the bars.
            WindowInsetsControllerCompat controller =
                    WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
            controller.hide(WindowInsetsCompat.Type.systemBars());
            controller.setSystemBarsBehavior(
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }
    }
}
