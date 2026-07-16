# RyeLite Mobile

RyeLite for Android — a [RyeLite](https://www.ryelite.org) (HighLite-family)
client for the game [High Spell](https://highspell.com), running the real web
client inside a Capacitor WebView with the full `@ryelite/core` plugin runtime.

## Features

- **Full plugin support** — the Plugin Hub, plugin settings, and the plugin
  runtime are the same code the desktop client runs. Install and configure
  Hub plugins in-game.
- **Multi-account tabs** — up to 6 simultaneous game sessions, one per tab,
  switched from a native tab bar. Hidden tabs stay connected (render-throttled
  to ~2 fps, sockets fully alive). Long-press a tab to close it.
- **Touch controls** — tap = left click, hold = right click (context menu),
  drag = camera, pinch = zoom, drag items to reorder with a visual ghost.
  The game runs in desktop mode with full desktop UI.
- **Saved login profiles** — username dropdown + autofill; passwords are
  encrypted with a non-exportable Android Keystore key, never stored in
  plain text.
- **World picker** on the login screen, like desktop.
- **Background keep-alive** — a foreground service keeps your session
  connected while you check another app (toggleable; runs only while
  logged in and backgrounded).
- **Idle alert** — chime + red overlay + tab-number flash when your character
  finishes its action, including on tabs you aren't watching.
- **Soft keyboard bridge** — chat and every game text prompt (bank X-amounts
  etc.) open the Android keyboard, which the game's desktop mode normally
  never does.
- **UI scaling** — game UI size, screen edge margin (for curved glass), and
  per-element size sliders for the logout button, context menus, and chat bar.

Settings live in the 📱 Mobile panel: gear icon on the login screen, or
in-game ⚙️ Settings → "Open RyeLite Mobile Settings".

## Install

Download the APK from [Releases](../../releases) and sideload it
(you may need to allow "install unknown apps" for your browser/file manager).
Landscape only.

## Build from source

Requirements: Node 20+, Android SDK, JDK 21 (Android Studio's JBR works).

```powershell
npm install
npm run build                    # vite → dist/
npx cap sync android             # copy dist/ + config into android/
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
cd android
.\gradlew.bat assembleDebug      # → app\build\outputs\apk\debug\app-debug.apk
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

## How it works (short version)

The WebView's origin is set to `https://highspell.com`
(`server.hostname` in [capacitor.config.ts](capacitor.config.ts)), so the
game's own asset fetches and socket.io connections pass CORS natively.
[src/client.ts](src/client.ts) is the loader: it POSTs `/game`, merges the
game page's DOM, injects the versioned game client with `@ryelite/core`'s
hooks reflected into it, and starts the plugin runtime. Everything else is
mobile adaptation:

| Area | Where |
|---|---|
| Touch → mouse translation | [src/touch-input.ts](src/touch-input.ts) |
| Multi-account tabs (native) | [TabManager.java](android/app/src/main/java/com/matter418/ryelite/TabManager.java), [RLMBridge.java](android/app/src/main/java/com/matter418/ryelite/RLMBridge.java), [TabWebViewClient.java](android/app/src/main/java/com/matter418/ryelite/TabWebViewClient.java) |
| Tab-aware native facade (JS) | [src/native-bridge.ts](src/native-bridge.ts) |
| Hidden-tab frame throttle | [src/frame-throttle.ts](src/frame-throttle.ts) |
| Mobile settings overlay + panel | [src/mobile-shell.ts](src/mobile-shell.ts) |
| Login profiles / credential store | [src/login-profiles.ts](src/login-profiles.ts), [CredentialVault.java](android/app/src/main/java/com/matter418/ryelite/CredentialVault.java) |
| World picker | [src/world-select.ts](src/world-select.ts) |
| Background keep-alive | [src/background-mode.ts](src/background-mode.ts), [KeepAliveService.java](android/app/src/main/java/com/matter418/ryelite/KeepAliveService.java) |
| Idle alert | [src/idle-watch.ts](src/idle-watch.ts) |
| Soft keyboard bridge | [src/keyboard-bridge.ts](src/keyboard-bridge.ts), [src/chat-tap.ts](src/chat-tap.ts) |
| Sprite pipeline fixes | [src/sprite-worker-fix.ts](src/sprite-worker-fix.ts), [src/sprite-guard.ts](src/sprite-guard.ts) |
| UI scaling / virtual viewport | [src/ui-scale.ts](src/ui-scale.ts) |
| Electron API shims | [src/shims.ts](src/shims.ts) |

## Debugging

Capacitor mirrors JS console output to logcat:
`adb logcat -s "Capacitor/Console:*"`. Loader crashes paint an error overlay
onto the boot screen. For full DevTools, use `chrome://inspect` or connect
straight to the WebView's CDP socket.

## Credits & license

Built on the RyeLite / [HighLite](https://github.com/Highl1te) client family
and `@ryelite/core`. Not affiliated with High Spell; use at your own
discretion.

GPL-3.0-only — see [LICENSE](LICENSE).
