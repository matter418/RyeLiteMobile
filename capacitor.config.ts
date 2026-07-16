import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
    appId: 'com.matter418.ryelitemobile',
    appName: 'RyeLite Mobile',
    webDir: 'dist',
    server: {
        // Make the WebView origin https://highspell.com. This is what lets the
        // game's own network stack run natively:
        //  - asset fetches to :8887/:3002 pass CORS (ACAO: * on those servers)
        //    with binary responses intact (CapacitorHttp's fetch patch corrupts
        //    the binary .carbon files — verified on device)
        //  - socket.io on server1:8888 only allows Origin https://highspell.com
        //    (fixed allowlist, verified) — both polling and the WS upgrade now
        //    present the right origin.
        // Trade-off: requests to https://highspell.com:443 are intercepted by
        // Capacitor's local server, so the loader routes those few calls
        // through the CapacitorHttp plugin API explicitly (see gameFetch in
        // src/client.ts) and inlines the game page's stylesheets.
        androidScheme: 'https',
        hostname: 'highspell.com',
    },
    plugins: {
        // Global fetch/XHR patching stays OFF — it mangles binary responses.
        // The loader calls CapacitorHttp.request() explicitly where needed;
        // the plugin API works regardless of this flag.
        CapacitorHttp: {
            enabled: false,
        },
    },
    android: {
        allowMixedContent: true,
    },
};

export default config;
