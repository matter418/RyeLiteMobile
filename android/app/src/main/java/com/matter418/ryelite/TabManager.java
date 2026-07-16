// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package com.matter418.ryelite;

import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Multi-account tab system: up to MAX_TABS RyeLite instances, one WebView
 * each. Tab 0 is Capacitor's WebView (full plugin bridge); tabs 1+ are bare
 * WebViews wired up with TabWebViewClient (assets at the game origin) and
 * RLMBridge (native services) — the loader detects which kind it's in via
 * window.RLMBridge (src/native-bridge.ts).
 *
 * Tab bar (top-left): numbered boxes 1..N + a "+" box. With a single tab
 * only "+" is shown; "+" disappears at MAX_TABS. LONG-PRESS a numbered box
 * (tabs 2+ only) → confirm dialog → tab closes, later tabs renumber. Tab 1
 * is the Capacitor WebView and can never be closed or destroyed — it gets
 * no long-press handler at all (user decision). Session flags are keyed by
 * STABLE tab id, not bar position, so renumbering can't corrupt keep-alive
 * gating (see TabSessions).
 *
 * The tab COUNT persists (SharedPreferences) and is restored on activity
 * creation — restored tabs are created lazily (no loadUrl until first
 * shown) so a 6-tab restore doesn't boot five loaders at once.
 *
 * Visibility rule (hard-won, TWICE — see CLAUDE.md): hidden tabs get GONE
 * plus a PAGE-SIDE rAF throttle (__rlmSetHidden → frame-throttle.ts), and
 * must NOT get WebView.onPause(): Chromium freezes a paused hidden page
 * after ~60 s, which kills the game socket (the "connection lost on
 * alternate tabs" bug, 2026-07-15). GONE alone is also not enough — it
 * propagates into Chromium unreliably and a covered-but-visible WebView
 * renders at full tilt (thermal throttling); the rAF throttle is what
 * actually stops the render churn. Never the global pauseTimers().
 *
 * A 2s watchdog self-heals the bar (re-attach / re-show / re-raise) and
 * logs (tag RLMTabs) whenever it had to fix something.
 */
class TabManager {
    static final int MAX_TABS = 6;
    private static final String TAG = "RLMTabs";
    private static final String PREFS = "ryelite-tabs";
    private static final String KEY_COUNT = "count";
    private static final long WATCHDOG_INTERVAL_MS = 2000;
    private static final long BLINK_INTERVAL_MS = 500;
    private static final long BAR_HIDE_LEASE_MS = 3500;

    private static class Tab {
        final WebView view;
        final int id; // stable — survives renumbering, keys TabSessions
        Tab(WebView view, int id) {
            this.view = view;
            this.id = id;
        }
    }

    private final MainActivity activity;
    private final List<Tab> tabs = new ArrayList<>();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Set<Integer> blinkingTabIds = new HashSet<>(); // stable ids
    private final List<TextView> boxViews = new ArrayList<>(); // parallel to tabs (empty when bar shows no numbers)
    private boolean blinkPhase = false;
    private boolean blinkScheduled = false;
    private LinearLayout bar;
    private FrameLayout.LayoutParams barLayoutParams;
    private int active = 0;
    private int edgeInsetPx = 0;
    private long barHiddenUntilUptime = 0; // setBarHidden lease expiry
    private int nextTabId = 1; // 0 is forever the Capacitor tab
    private boolean destroyed = false;

    TabManager(MainActivity activity, WebView capacitorWebView) {
        this.activity = activity;
        tabs.add(new Tab(capacitorWebView, 0));
        int restoreCount = Math.min(
                activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(KEY_COUNT, 1),
                MAX_TABS);
        Log.i(TAG, "TabManager init (restoring " + restoreCount + " tab(s))");
        for (int i = 1; i < restoreCount; i++) {
            createSecondaryTab(); // lazy — boots when first switched to
        }
        buildBar();
        handler.postDelayed(this::watchdog, WATCHDOG_INTERVAL_MS);
    }

    /** Create a secondary tab's WebView, hidden and NOT yet loaded. */
    private Tab createSecondaryTab() {
        WebView webView = new WebView(activity);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUseWideViewPort(true);       // ui-scale's virtual viewport
        settings.setLoadWithOverviewMode(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        webView.setWebViewClient(new TabWebViewClient(activity));
        webView.setWebChromeClient(new WebChromeClient()); // console → logcat
        webView.setBackgroundColor(Color.BLACK);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        Tab tab = new Tab(webView, nextTabId++);
        webView.addJavascriptInterface(new RLMBridge(activity, tab.id), "RLMBridge");
        webView.setVisibility(View.GONE); // no onPause — see setTabShown
        activity.addContentView(webView, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        tabs.add(tab);
        return tab;
    }

    private void addTab() {
        if (tabs.size() >= MAX_TABS) {
            return;
        }
        createSecondaryTab();
        persistCount();
        switchTo(tabs.size() - 1);
    }

    /** Close a secondary tab (never position 0 — enforced by the callers
     *  AND here). Destroys its WebView (disconnecting any live session),
     *  renumbers the bar, and keeps keep-alive gating consistent. */
    private void removeTab(int index) {
        if (index <= 0 || index >= tabs.size()) {
            return;
        }
        Tab tab = tabs.remove(index);
        Log.i(TAG, "closing tab at position " + (index + 1) + " (id " + tab.id + ")");
        TabSessions.setLoggedIn(activity, tab.id, false);
        blinkingTabIds.remove(tab.id);
        ViewGroup parent = (ViewGroup) tab.view.getParent();
        if (parent != null) {
            parent.removeView(tab.view);
        }
        tab.view.destroy();
        persistCount();
        // Closing a tab left of the active one shifts the active position;
        // closing the active one falls back to its left neighbor.
        int newActive = active > index ? active - 1
                : active == index ? index - 1
                : active;
        switchTo(newActive);
    }

    private void confirmClose(int index) {
        new AlertDialog.Builder(activity)
                .setTitle("Close tab " + (index + 1) + "?")
                .setMessage("If an account is logged in on this tab, it will be disconnected.")
                .setPositiveButton("Close tab", (d, w) -> removeTab(index))
                .setNegativeButton("Cancel", null)
                .show();
    }

    void switchTo(int index) {
        active = index;
        blinkingTabIds.remove(tabs.get(index).id); // alert acknowledged by looking
        for (int i = 0; i < tabs.size(); i++) {
            setTabShown(tabs.get(i).view, i == active);
        }
        WebView shown = tabs.get(active).view;
        if (shown.getUrl() == null) {
            shown.loadUrl("https://highspell.com/"); // lazily boot restored tabs
        }
        bar.bringToFront();
        rebuildBar();
    }

    /**
     * Re-assert per-tab shown/hidden state. Called from onResume: the
     * activity-level resume path can wake WebViews wholesale, and hidden
     * tabs must stay paused.
     */
    void reassertVisibility() {
        for (int i = 0; i < tabs.size(); i++) {
            setTabShown(tabs.get(i).view, i == active);
        }
        bar.bringToFront();
    }

    /**
     * Blink tabId's bar box (idle alert, pushed from idle-watch.ts through
     * the bridges). Never blinks the ACTIVE tab (its alerts are on screen
     * already); cleared when the user switches to the tab, when the tab
     * closes, or when JS reports the character acting again. tabId is the
     * STABLE id, matching what each bridge was constructed with.
     */
    void setTabBlink(int tabId, boolean on) {
        activity.runOnUiThread(() -> {
            boolean isActiveTab = active < tabs.size() && tabs.get(active).id == tabId;
            if (on && !isActiveTab) {
                blinkingTabIds.add(tabId);
            } else {
                blinkingTabIds.remove(tabId);
            }
            paintBoxes();
            scheduleBlinkTick();
        });
    }

    private void scheduleBlinkTick() {
        if (blinkScheduled || blinkingTabIds.isEmpty()) {
            return;
        }
        blinkScheduled = true;
        handler.postDelayed(this::blinkTick, BLINK_INTERVAL_MS);
    }

    private void blinkTick() {
        if (destroyed) {
            return;
        }
        if (blinkingTabIds.isEmpty()) {
            blinkScheduled = false;
            blinkPhase = false;
            paintBoxes();
            return;
        }
        blinkPhase = !blinkPhase;
        paintBoxes();
        handler.postDelayed(this::blinkTick, BLINK_INTERVAL_MS);
    }

    /**
     * Hide the tab bar while a page-side fullscreen UI (the mobile settings
     * overlay) owns the screen — the bar floats above all page content and
     * would cut off the overlay's own tab strip. LEASE semantics: a hide
     * expires after BAR_HIDE_LEASE_MS unless re-asserted (the overlay renews
     * every second while open), so a page that reloads or dies mid-hide can
     * never strand the bar off-screen — the watchdog restores it once the
     * renewals stop.
     */
    void setBarHidden(boolean hidden) {
        activity.runOnUiThread(() -> {
            if (hidden) {
                barHiddenUntilUptime = SystemClock.uptimeMillis() + BAR_HIDE_LEASE_MS;
                bar.setVisibility(View.GONE);
            } else {
                barHiddenUntilUptime = 0;
                bar.setVisibility(View.VISIBLE);
                bar.bringToFront();
            }
        });
    }

    private boolean barHideLeased() {
        return SystemClock.uptimeMillis() < barHiddenUntilUptime;
    }

    /** Left inset in device px (game's screen-edge margin), pushed from JS. */
    void setEdgeInsetPx(int px) {
        activity.runOnUiThread(() -> {
            edgeInsetPx = Math.max(0, px);
            if (barLayoutParams != null) {
                barLayoutParams.leftMargin = Math.max(dp(6), edgeInsetPx);
                bar.setLayoutParams(barLayoutParams);
            }
        });
    }

    void onActivityDestroy() {
        destroyed = true;
        handler.removeCallbacksAndMessages(null);
        // Capacitor destroys its own WebView; ours would otherwise leak with
        // live pages (and sockets) attached to a dead activity.
        for (int i = 1; i < tabs.size(); i++) {
            tabs.get(i).view.destroy();
        }
        Log.i(TAG, "TabManager destroyed with activity (" + tabs.size() + " tab(s))");
    }

    private void persistCount() {
        activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putInt(KEY_COUNT, tabs.size())
                .apply();
    }

    private void setTabShown(WebView v, boolean shown) {
        // NEVER WebView.onPause() here: Chromium FREEZES a paused hidden
        // page after ~60 s (measured 2026-07-15) — frozen JS can't pong, so
        // the server drops the session ~45 s later ("Connection to the
        // server was lost" on every hidden tab). onResume() stays as a
        // belt-and-braces wake for tabs paused by older builds.
        // Render throttling of hidden tabs (the reason onPause was used —
        // GONE alone is unreliably propagated into Chromium) is done
        // page-side instead: __rlmSetHidden swaps requestAnimationFrame to
        // a ~2 fps timeout pump (frame-throttle.ts).
        if (shown) {
            v.onResume();
            v.setVisibility(View.VISIBLE);
        } else {
            v.setVisibility(View.GONE);
        }
        pushHiddenState(v, shown);
    }

    /**
     * Tell the page whether its tab is hidden (frame-throttle.ts). Re-pushed
     * by the watchdog every 2 s: a page that reloads while hidden (or hasn't
     * booted yet at switch time) boots with the default "shown" state and
     * would otherwise render at full tilt behind the active tab.
     */
    private void pushHiddenState(WebView v, boolean shown) {
        v.evaluateJavascript(
                "window.__rlmSetHidden&&window.__rlmSetHidden(" + !shown + ")", null);
    }

    // --- Watchdog ----------------------------------------------------------

    private void watchdog() {
        if (destroyed) {
            return;
        }
        ViewGroup parent = (ViewGroup) bar.getParent();
        if (parent == null) {
            Log.w(TAG, "watchdog: bar was DETACHED — re-adding");
            activity.addContentView(bar, barLayoutParams);
        } else {
            if (bar.getVisibility() != View.VISIBLE && !barHideLeased()) {
                // Not VISIBLE with no live setBarHidden lease = either the
                // lease-holder page died (self-heal case) or something else
                // hid the bar (the original watchdog case). Either way: show.
                Log.w(TAG, "watchdog: bar was visibility=" + bar.getVisibility() + " — re-showing");
                bar.setVisibility(View.VISIBLE);
            }
            if (parent.indexOfChild(bar) != parent.getChildCount() - 1) {
                Log.w(TAG, "watchdog: bar was BURIED at z " + parent.indexOfChild(bar)
                        + "/" + (parent.getChildCount() - 1) + " — raising");
                bar.bringToFront();
            }
        }
        // Heal the page-side hidden flag (idempotent; covers reload-while-
        // hidden and boot races — see pushHiddenState).
        for (int i = 0; i < tabs.size(); i++) {
            pushHiddenState(tabs.get(i).view, i == active);
        }
        handler.postDelayed(this::watchdog, WATCHDOG_INTERVAL_MS);
    }

    // --- Tab bar ----------------------------------------------------------

    private void buildBar() {
        bar = new LinearLayout(activity);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        barLayoutParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.START);
        barLayoutParams.topMargin = dp(6);
        barLayoutParams.leftMargin = Math.max(dp(6), edgeInsetPx);
        activity.addContentView(bar, barLayoutParams);
        rebuildBar();
    }

    private void rebuildBar() {
        bar.removeAllViews();
        boxViews.clear();
        // A single tab needs no numbers — just the "+" (user-specified UX).
        if (tabs.size() > 1) {
            for (int i = 0; i < tabs.size(); i++) {
                final int index = i;
                TextView box = box(String.valueOf(i + 1), v -> {
                    if (index != active) {
                        switchTo(index);
                    }
                });
                if (i > 0) {
                    // Long-press closes — tabs 2+ only. Tab 1 is the
                    // Capacitor WebView and cannot be destroyed, so it gets
                    // no close gesture at all (user decision).
                    box.setOnLongClickListener(v -> {
                        confirmClose(index);
                        return true;
                    });
                }
                boxViews.add(box);
                paintBox(box, index);
                bar.addView(box);
            }
        }
        if (tabs.size() < MAX_TABS) {
            TextView plus = box("+", v -> addTab());
            paintBox(plus, -1);
            bar.addView(plus);
        }
    }

    private TextView box(String label, View.OnClickListener onClick) {
        TextView tv = new TextView(activity);
        tv.setText(label);
        tv.setTextColor(Color.WHITE);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        tv.setTextSize(16f);
        tv.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(40), dp(40));
        lp.rightMargin = dp(6);
        tv.setLayoutParams(lp);
        tv.setOnClickListener(onClick);
        return tv;
    }

    /** Style one bar box for its current state (index -1 = the "+" box). */
    private void paintBox(TextView tv, int index) {
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(10));
        boolean isActive = index >= 0 && index == active;
        boolean blinkOn = index >= 0 && blinkPhase && index < tabs.size()
                && blinkingTabIds.contains(tabs.get(index).id);
        if (isActive) {
            // Active tab gets the HighSpell green.
            bg.setColor(Color.argb(230, 26, 138, 74));
            bg.setStroke(dp(2), Color.argb(255, 60, 220, 130));
        } else if (blinkOn) {
            // Idle alert: flash red on the blink beat.
            bg.setColor(Color.argb(230, 190, 45, 35));
            bg.setStroke(dp(2), Color.argb(255, 255, 120, 90));
        } else {
            bg.setColor(Color.argb(170, 25, 25, 25));
        }
        tv.setBackground(bg);
    }

    private void paintBoxes() {
        for (int i = 0; i < boxViews.size(); i++) {
            paintBox(boxViews.get(i), i);
        }
    }

    private int dp(int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }
}
