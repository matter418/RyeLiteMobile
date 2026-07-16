// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package com.matter418.ryelite;

import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * addJavascriptInterface bridge for secondary tab WebViews (the multi-account
 * tab system). Secondary tabs have no Capacitor runtime, so this exposes the
 * three native services the RyeLite loader needs (see src/native-bridge.ts,
 * the only JS consumer):
 *
 *  - httpRequest: main-domain requests that the tab's own origin interception
 *    (TabWebViewClient) would otherwise swallow — POST /game, client JS,
 *    version JSON, /play, stylesheet inlining. Synchronous by design:
 *    @JavascriptInterface methods run on the WebView's JavaBridge thread, so
 *    blocking here blocks only this tab's JS (the loader awaits these
 *    serially during boot anyway). Android's HttpURLConnection handles gzip
 *    transparently.
 *  - cred*: the shared CredentialVault (same store as tab 1's plugin).
 *  - keep-alive: per-tab logged-in reporting + the background-mode setting.
 *
 * Responses are JSON strings; httpRequest returns {status, data} or
 * {status: 0, error}.
 */
class RLMBridge {
    private final MainActivity activity;
    private final int tabId;

    RLMBridge(MainActivity activity, int tabId) {
        this.activity = activity;
        this.tabId = tabId;
    }

    @JavascriptInterface
    public String httpRequest(String method, String url, String body, String contentType) {
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("Origin", "https://highspell.com");
            conn.setRequestProperty("Referer", "https://highspell.com/");
            conn.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                            + " (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
            if (contentType != null && !contentType.isEmpty()) {
                conn.setRequestProperty("Content-Type", contentType);
            }
            if (body != null && !body.isEmpty()) {
                conn.setDoOutput(true);
                OutputStream os = conn.getOutputStream();
                os.write(body.getBytes(StandardCharsets.UTF_8));
                os.close();
            }
            int status = conn.getResponseCode();
            InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String data = is == null ? "" : readAll(is);
            conn.disconnect();
            JSONObject ret = new JSONObject();
            ret.put("status", status);
            ret.put("data", data);
            return ret.toString();
        } catch (Exception e) {
            return errorJson(String.valueOf(e));
        }
    }

    private static String readAll(InputStream is) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[16384];
        int n;
        while ((n = is.read(chunk)) != -1) {
            buf.write(chunk, 0, n);
        }
        is.close();
        return buf.toString("UTF-8");
    }

    private static String errorJson(String message) {
        try {
            JSONObject ret = new JSONObject();
            ret.put("status", 0);
            ret.put("error", message);
            return ret.toString();
        } catch (Exception impossible) {
            return "{\"status\":0,\"error\":\"unknown\"}";
        }
    }

    // --- CredentialVault -------------------------------------------------

    @JavascriptInterface
    public String credList() {
        try {
            JSONArray usernames = new JSONArray();
            for (String n : CredentialVault.list(activity)) {
                usernames.put(n);
            }
            JSONObject ret = new JSONObject();
            ret.put("usernames", usernames);
            String lastUsed = CredentialVault.getLastUsed(activity);
            ret.put("lastUsed", lastUsed == null ? JSONObject.NULL : lastUsed);
            return ret.toString();
        } catch (Exception e) {
            return "{\"usernames\":[],\"lastUsed\":null}";
        }
    }

    @JavascriptInterface
    public String credGet(String username) {
        try {
            String password = CredentialVault.get(activity, username);
            JSONObject ret = new JSONObject();
            ret.put("password", password == null ? JSONObject.NULL : password);
            return ret.toString();
        } catch (Exception e) {
            return "{\"password\":null}";
        }
    }

    @JavascriptInterface
    public void credSave(String username, String password) {
        try {
            CredentialVault.save(activity, username, password);
        } catch (Exception e) {
            // JS treats save as fire-and-forget; nothing useful to surface.
        }
    }

    @JavascriptInterface
    public void credDelete(String username) {
        CredentialVault.delete(activity, username);
    }

    @JavascriptInterface
    public void credSetLastUsed(String username) {
        CredentialVault.setLastUsed(activity, username);
    }

    // --- Keep-alive ------------------------------------------------------

    @JavascriptInterface
    public void setLoggedIn(boolean loggedIn) {
        TabSessions.setLoggedIn(activity, tabId, loggedIn);
    }

    @JavascriptInterface
    public void setTabBarInset(int px) {
        TabManager tm = activity.getTabManager();
        if (tm != null) {
            tm.setEdgeInsetPx(px); // hops to the UI thread itself
        }
    }

    @JavascriptInterface
    public void setTabBarHidden(boolean hidden) {
        TabManager tm = activity.getTabManager();
        if (tm != null) {
            tm.setBarHidden(hidden); // hops to the UI thread itself
        }
    }

    @JavascriptInterface
    public boolean getBackgroundEnabled() {
        return BackgroundModePlugin.isEnabled(activity);
    }

    @JavascriptInterface
    public void setIdleBlink(boolean on) {
        TabManager tm = activity.getTabManager();
        if (tm != null) {
            tm.setTabBlink(tabId, on); // hops to the UI thread itself
        }
    }

    @JavascriptInterface
    public void showKeyboard() {
        TabManager tm = activity.getTabManager();
        if (tm != null) {
            tm.showSoftKeyboard(tabId); // hops to the UI thread itself
        }
    }

    @JavascriptInterface
    public void setBackgroundEnabled(boolean enabled) {
        BackgroundModePlugin.writeEnabled(activity, enabled);
    }
}
