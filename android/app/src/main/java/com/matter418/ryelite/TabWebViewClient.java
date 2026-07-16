// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package com.matter418.ryelite;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;

/**
 * WebViewClient for secondary tab WebViews — the non-Capacitor version of
 * the "hostname trick": requests to https://highspell.com (port 443) are
 * served from the bundled web assets (assets/public, i.e. the vite dist/),
 * giving every tab the RyeLite loader AT the game's own origin, so the
 * game's asset fetches (:8887/:3002) and socket.io (:8888) pass CORS
 * natively, exactly like tab 1.
 *
 * Divergence from Capacitor's local server (deliberate): unknown paths fall
 * through to the real network instead of 404ing. The loader still routes its
 * boot requests through RLMBridge for byte-identical behavior with tab 1
 * (and because shouldInterceptRequest cannot see POST bodies anyway).
 */
class TabWebViewClient extends WebViewClient {
    private final Context context;

    TabWebViewClient(Context context) {
        this.context = context;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if (!"https".equals(url.getScheme()) || !"highspell.com".equals(url.getHost())) {
            return null;
        }
        int port = url.getPort();
        if (port != -1 && port != 443) {
            return null; // :3002/:8887/:8888 are real network, always
        }
        String path = url.getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) {
            path = "/index.html";
        }
        try {
            InputStream stream = context.getAssets().open("public" + path);
            return new WebResourceResponse(mimeFor(path), "utf-8", stream);
        } catch (IOException notBundled) {
            return null; // not a local asset — let the real server answer
        }
    }

    private static String mimeFor(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }
}
