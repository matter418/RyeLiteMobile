# RyeLite Mobile — session context

**This is the RELEASE project** (renamed from the RyeliteMobileMulti fork on
2026-07-15): app name "RyeLite Mobile", appId `com.matter418.ryelitemobile`,
Java namespace unchanged (`com.matter418.ryelite`). It installs side-by-side
with both older dev installs (`com.matter418.ryelite` = the pre-tabs original,
`com.matter418.ryelite.multi` = the fork). `../RyeliteMobile` and
`../RyeliteMobileMulti` remain on disk as untouched backups; new work happens
HERE. Launcher icon is an RL monogram styled after the HighLite logo
(SVG sources in `resources/`, PNGs baked into `res/mipmap-*`).

## Multi-account tab system (SHIPPED 2026-07-14, device-verified)

Up to 6 RyeLite instances, one WebView per tab. Native tab bar top-left:
numbered boxes 1..N + "+" (numbers hidden while only 1 tab exists; "+"
hidden at 6; active tab = green box). **Close a tab: LONG-PRESS its box →
confirm dialog → close + renumber** (device-verified 2026-07-15). Tab 1 has
NO close gesture at all — it's the Capacitor WebView, which cannot be
destroyed (user chose no-gesture over a reset-to-login fallback). Session
flags are keyed by stable tab id (TabSessions, ids never reused within a
run) so renumbering can't corrupt keep-alive gating; closing destroys the
WebView, which disconnects any live session (hence the confirm). Every tab runs the FULL loader (touch translation,
plugins, saved profiles, world picker) — verified: tab 2 booted to the
RyeLite login screen with the saved profile autofilled and world list
populated, all through the new bridge.

- **Tab 0** = Capacitor's WebView (unchanged, full plugin bridge).
- **Tabs 1+** = bare WebViews + `TabWebViewClient.java` (serves
  `assets/public` at the highspell.com origin — the non-Capacitor hostname
  trick; unknown paths fall through to the real network, unlike Capacitor's
  404) + `RLMBridge.java` (`addJavascriptInterface`, name `RLMBridge`):
  sync `httpRequest` (POST /game etc. — HttpURLConnection, spoof headers,
  transparent gzip), `cred*` (shared `CredentialVault.java`, extracted from
  the plugin), `setLoggedIn`/background-mode passthrough.
- **TS façade `src/native-bridge.ts`**: `gameGetText`/`gamePostForm`/
  `credentialStore`/`backgroundMode` pick RLMBridge (secondary) vs Capacitor
  plugins (tab 0) by `window.RLMBridge` presence. client.ts,
  world-select.ts, login-profiles.ts, background-mode.ts route through it.
- **Keep-alive**: per-tab logged-in flags in `TabSessions.java` (in-memory,
  ORed; replaces the old persisted pref) gate KeepAliveService/wakelock;
  last-session-ends-while-backgrounded still tears down immediately.
- **Tab switching** (`TabManager.java`, REWORKED 2026-07-15): hidden tabs
  get `setVisibility(GONE)` **+ page-side rAF throttle** (`__rlmSetHidden`
  → `frame-throttle.ts`, ~2 fps setTimeout pump) — **NOT `WebView.
  onPause()`**: Chromium FREEZES a paused hidden page after ~60 s
  (measured: 'freeze' event at t+66 s; frozen JS can't pong → server drops
  the session ~45 s later → the "connection lost on alternate tabs after a
  couple of minutes" bug). The original "onPause == proven-safe
  app-backgrounded state" rationale was WRONG — Capacitor (KeepRunning)
  never calls WebView.onPause() on app background; those soaks never
  tested it. The 2 s watchdog re-pushes the hidden flag to every tab
  (covers reload-while-hidden / boot races — pages boot assuming shown).
  `MainActivity.onResume` calls `reassertVisibility()` (activity resume
  wakes WebViews wholesale). Side effect of the loop running at 2 fps
  hidden: hidden tabs keep PROCESSING (chat, emits, idle-watch) instead of
  full rAF stop — game-loop accumulator TIMESTEP is 600 ms so 2 fps is
  still real-time. **Fix soak-verified 2026-07-15**: hidden in-world tab,
  ping/pong every 25 s for 15 min straight, no freeze (was: FROZEN at 66 s
  under onPause) — ended at ~15 min idle by a CLEAN `engine close: forced
  close` = the game/server's own AFK-idle logout, which still applies to
  ignored hidden tabs (clean logout, not "connection lost"; server policy,
  not a client bug). Hidden-tab visibilityState stays "visible" under
  GONE-without-onPause — don't use it as a hidden signal; the pushed
  `__rlmSetHidden` flag is the truth. CPU during soak (visible login-screen
  tab + hidden in-world tab): ~1.2–1.7 cores total, no thermal alarm.
- The login ⚙️ gear moved DOWN (top 4.5rem, mobile-shell.ts) — the native
  bar owns the top-left corner.
- **Tab bar hides while the settings overlay is open** (2026-07-15,
  device-verified): the bar floats above all page content and was cutting
  off the overlay's panel tabs. `TabManager.setBarHidden(hidden)` is a
  LEASE (3.5 s): openOverlay hides + renews every 1 s via
  `setTabBarHidden()` (native-bridge.ts → RLMBridge / BackgroundModePlugin
  `setTabBarHidden`); closeOverlay releases. The 2 s watchdog only re-shows
  the bar when NO lease is live, so a page that reloads/dies with the
  overlay open gets the bar back ≤3.5 s later; nothing persists.
  This freed the top-left corner, so the overlay ✕ close button moved to
  the LEFT end of the header (far-right was hard to hit on curved glass —
  user report).
- **Overlay tab highlight is truth-derived** (2026-07-15, device-verified):
  reopening the overlay used to highlight 📱 while the drawer still showed
  the panel left open last time (core keeps drawer content across overlay
  close/reopen). syncTabHighlight now derives the highlight from
  `PanelManager.currentMenuItem` (icon string of the open panel, compared
  to each bar item's innerHTML) instead of hand-marking items on click.
- **World Map plugin repairs** (2026-07-15, device-verified in Middlefern):
  the Hub "World Map" plugin hijacks its 🗺️ bar icon's onclick to toggle a
  floating iframe window (`.highlite-map`, z-index 1000) instead of opening
  a panel — invisible under our overlay (z 2147483300), hence "tapping it
  does nothing". AND its iframe points at `highlite.dev/map`, a domain with
  NO DNS record any more (ERR_NAME_NOT_RESOLVED — **the plugin is equally
  broken on desktop**). mobile-shell.ts fixes both: the bar click handler
  closes the overlay when a 🗺️ tap leaves the map visible (codepoint match
  `\u{1F5FA}`, scoped so other tabs never auto-close), and
  `fixWorldMapWindow()` (run from the body observer) rewrites the iframe to
  `https://www.ryelite.org/map` (same app, identical `{X, Y, lvl}`
  postMessage marker protocol — verified in its bundle), posts one position
  message on iframe load (the plugin only re-sends on player MOVEMENT and
  its first send died with the dead iframe), and inflates the plugin's
  10×10px ✕ to 34px, and resizes the window to 90vh × 62vw (top 5vh /
  left 19vw — user asked for near-fullheight; plugin default was 50%×50%).
  Map pans/zooms natively inside the iframe (separate document — the touch
  translator never sees it).
  ⚠ Once (2026-07-15, while the map iframe existed on the old build) the
  WebView GPU process wedged: logcat flooded `SharedImageManager::
  ProduceSkia ... CompoundImageBacking` errors, screen composited
  black/white, taps dead — page JS/DOM stayed alive (CDP fine, game clock
  ticking, socket up). MapLibre WebGL (iframe) + game WebGL share one GPU
  process; suspected trigger. Recovery: `location.reload()` via CDP on the
  wedged tab, then relaunch. If "the game froze but chat still updates",
  check logcat for this signature FIRST.
- **Settings scroll-anywhere fix** (2026-07-15, device-verified): core's
  settings pages (plugin list AND per-plugin config) nest their scroll area
  `#highlite-settings-content-row-holder` as a lone content-width flex
  child of the panel page — most of a landscape screen was dead to swipes.
  mobile-shell.css stretches it (`flex: 1 1 auto`) to fill the page and
  caps its child rows at 640px so controls stay near labels. Verified via
  CDP touch-drag at x=1200 CSS (old dead zone) → scrollTop moved.
- Boot has NO retry: a transient DNS failure at launch (seen once, locked
  phone) leaves a black tab — `location.reload()` via CDP fixes; a JS-side
  boot retry is a known TODO.
- **Hardening round (2026-07-14 late, after the bar vanished in the field):**
  (1) Tab bar left margin follows the game's Screen edge margin —
  `pushTabBarInset()` in native-bridge.ts converts CSS px → device px
  (`cssPx * devicePixelRatio * visualViewport.scale`) and pushes via
  BackgroundMode plugin (tab 0) / RLMBridge (tabs 1+) → `setEdgeInsetPx`.
  Re-pushed on every applyEdgeInset (boot + slider). Verified: 32 CSS px →
  67 device px, bar aligned with game window.
  (2) Tab COUNT persists (`ryelite-tabs` SharedPreferences) and restores on
  activity create; restored tabs are LAZY (loadUrl on first switch).
  Verified via force-stop → "restoring 3 tab(s)" → [1][2][3][+].
  (3) `onBackPressed → moveTaskToBack(true)` — a back gesture must never
  finish the activity (would tear down all sessions).
  (4) 2s watchdog self-heals the bar (re-attach/re-show/re-raise) and logs
  under tag `RLMTabs` which condition it fixed.
- **ACTUAL root cause of BOTH "tabs vanished" reports (solved 2026-07-14
  late): the user was in the ORIGINAL RyeLite app, not the Multi fork.**
  Identical launcher icons + near-identical names in recents. Confirmed via
  `dumpsys window | grep mCurrentFocus` → `com.matter418.ryelite` while
  Multi idled in background with its tabs fully intact (and its FGS
  running). The watchdog+persistence+back-guard hardening predates this
  finding and stays (all defensible on their own). Fix: Multi's adaptive
  icon background is now DEEP ORANGE (`#FF6D00`,
  `values/ic_launcher_background.xml`) vs the original's white — check
  `mCurrentFocus` FIRST next time "the tabs disappeared".
  ⚠ Related: a backgrounded in-world session can still drop (~13 min
  observed, screen on, FGS running — "Connection to the server was lost"
  on return; game never auto-reconnects). Same Doze/network variance
  documented in the backgrounding research; not tab-system related.
- ⚠ CDP quirk (observed while hidden tabs were still onPause()'d, may be
  moot since the 2026-07-15 rework — a FROZEN page definitely hangs evals):
  `Runtime.evaluate` on a deeply-idle hidden tab can queue forever (even
  synchronous exprs) — put a timeout on probes and don't read a hang as a
  dead tab. The visible tab always answers.
- localStorage/IndexedDB are shared across tabs (same origin, same profile):
  mobile settings + game settings + client JS cache are one copy — wanted.
  Each tab has its own JS context/socket; CDP lists each tab as its own
  page target (all titled 'RyeLite' — tell them apart via
  `window.RLMBridge` presence or visibilityState).

## Second test device: Lenovo TB-X306F tablet (verified 2026-07-15)

Tab M10 HD Gen 2 — Android 11, 3 GB RAM, 1280×800 @ 160 dpi → **dpr 1.0, CSS
viewport = device px = 1280×800** (adb `input tap` coords are CSS coords
directly; no ×3 like the Pixel). WebView 150 (auto-updated, modern). All
tab-system tests PASS on it: boot to login + world list, "+" creates tab 2
(full loader via RLMBridge, world picker live), switch both ways, hidden-tab
throttle at exactly 2.0 rAF/s (visible ~48), overlay hide-lease + ✕-left +
login-only Mobile panel, long-press close confirm + renumber, 2-tab restore
after force-stop + lazy load on first switch, back → moveTaskToBack (pid
survives, tabs intact). No crashes/JS errors/watchdog repairs.
⚠ Memory: 2 tabs AT LOGIN ≈ 963 MB PSS (app 284 + renderer 679) with only
~830 MB left free — realistic ceiling on this device is 2 (maybe 3) in-world
tabs before renderer OOM kills all tabs. Height 800 > 768 so the game's
mobile-mode media query never triggers here even without ForceDesktopMode.
In-world (user logged in as Itmatters on tab 2, 2026-07-15): ~26 FPS visible
tab, app+renderer ≈ 2.2 cores, battery 35 °C — laggy but stable; pure
hardware limit (Helio P22T), no client bug. Socket stayed healthy through
the whole test run. VERIFIED in-world: tap-to-walk, long-press → context
menu (translator suppress + synth b2), camera touch-drag (alpha moved),
chat-tap opens text menu, IME key mirroring shadow→game input, idle alert
e2e (stub action→idle → red overlay + chime after delay, cleared on
pointerdown).
**Android 11 keyboard-bridge IME quirk — auto-fix tried and REVERTED
(2026-07-15).** Symptom: chat tap opens the text menu and focus-retry
sticks (activeElement = shadow input) but the keyboard doesn't show —
Android 11 only shows the IME for a tap directly ON an editable;
programmatic focus after the tap is ignored (Pixel/newer Android accepts
it). Login form unaffected (real inputs, direct taps). **Accepted UX: a
second tap on the input line opens the keyboard reliably** (the invisible
shadow input overlays it) and typing then mirrors perfectly. An auto-nudge
was implemented — `TabManager.showSoftKeyboard(tabId)` (requestFocus +
`InputMethodManager.showSoftInput`, UI-thread hop) via
`RLMBridge.showKeyboard()` / BackgroundModePlugin `showKeyboard` /
native-bridge `showSoftKeyboard()`, called by keyboard-bridge once focus
stuck — both native paths individually verified (mInputShown=true), but
in real play the user found it glitchy and preferred the second tap, so
the keyboard-bridge call was removed same day. All the native + façade
plumbing REMAINS (dormant, documented in-code) if an opt-in is ever wanted.
⚠ Test-tooling gotchas on this device: (1) `adb shell input tap/swipe`
arrives with **pointerType '' (empty)** on Android 11 → bypasses the touch
translator's `pointerType !== 'touch'` gate entirely (raw tap still walks
via native default action — deceptive!). Use CDP `Input.dispatchTouchEvent`
(scratchpad longpress.mjs / drag.mjs pattern) to exercise the translator;
real fingers report 'touch' correctly (translator device-verified working).
(2) Secondary tabs' console does NOT reach logcat — `Capacitor/Console`
only carries tab 0; probe via CDP instead.
Still untested on tablet: keep-alive/backgrounding under Lenovo's Android
11 power management, pinch zoom (translator engagement proven, so low risk).

## Idle alert (STANDALONE, SHIPPED 2026-07-15, device-verified e2e)

`src/idle-watch.ts` — our own idle alert, replacing the Idle Alert Hub
plugin on mobile (users should DISABLE that plugin — its detection lives in
a `GameLoop_update` hook, so on a hidden tab it freezes with rAF and then
re-fires the moment you switch back = double ping; that resume-refire was
observed live and is why v2 went standalone instead of calling the plugin's
createAlert, which was v1 of this feature and had exactly that flaw).

Why polling works where the plugin can't: game STATE isn't frozen on hidden
tabs — `_socket.on(GameStateUpdate, _gameStateUpdate)` applies packets in
the socket handler (v61: `_handleEnteredIdleStateAction` flips
`MainPlayer.CurrentState` synchronously), and per-view JS timers kept
running through onPause() — though onPause was later found to FREEZE the
page entirely after ~60 s hidden and was replaced by the frame-throttle
(2026-07-15), under which hidden-tab JS runs unconditionally. The watcher polls
`_mainPlayer._currentState.getCurrentState()` every 600 ms with the
plugin's exact detection semantics (ignoredStates list, manual-move
exclusion; `ActionState` enum from `@ryelite/core`). When a real action
settles into idle for `delaySeconds`:
- **Chime** — synthesized at first play (two-note WAV data URI, A5→D6 with
  decay, built in `buildChime()` — no bundled asset), volume from settings.
  Audio output from a paused WebView is device-verified (AAudio track
  `state:started` reaches the mixer from a hidden tab).
- **Red overlay** — `#rlm-idle-overlay`, rgba(255,0,0,.3), pointer-events
  none; removed on any pointerdown (window capture, once) or when the
  character acts again.
- **Native tab-box blink** (hidden tabs only) — `setIdleBlink(true)` →
  `TabManager.setTabBlink` (stable tab id; RLMBridge for tabs 1+,
  BackgroundModePlugin for tab 0): 500 ms red flash; never blinks the
  ACTIVE tab; cleared on switch-to-tab / tab close / character acting.
Fires on visible AND hidden tabs (it's a full replacement, not a hidden-tab
shim). Settings in the 📱 Mobile panel (mobile-shell.ts): Idle alert
on/off, volume 0–100 (slider release previews the chime), red overlay
on/off, delay 3–30 s (default 12 ≈ the plugin's 20 ticks). Stored in
`ryelite-mobile-idle` localStorage {enabled, volume, overlay, delaySeconds}.
Debug handle: `window.__rlmIdleWatch()`.

Testing gotchas (all hit live): CDP /json target list REORDERS
(most-recently-active first) — identify tabs by `window.RLMBridge` presence
per call, never by index. Device-px for `adb input tap` on scaled tabs =
`cssPx × devicePixelRatio × visualViewport.scale` (the pushTabBarInset
formula) — `2992/innerWidth` is ~2% off and misses 40 px buttons. Simulate
an action→idle transition by stubbing
`player._currentState.getCurrentState = () => 13` (own-property; `delete`
restores). After logout the server holds the session ~1 min ("Your account
is currently logged in") — retry loop needed before relogin.

### Files added/changed vs the original project

| Path | What |
|---|---|
| `src/idle-watch.ts` | Standalone idle alert (see section above): 600 ms poll, plugin-parity detection, synthesized chime + red overlay + native blink, settings exported to the Mobile panel |
| `src/native-bridge.ts` | THE tab-abstraction façade: `gameGetText`/`gamePostForm`/`credentialStore`/`backgroundMode`/`pushTabBarInset`, picking Capacitor plugins (tab 0) vs `window.RLMBridge` (tabs 1+). client.ts, world-select.ts, login-profiles.ts, background-mode.ts, ui-scale.ts all route through it |
| `android/.../TabManager.java` | Tabs list (stable ids), tab bar UI + inset, add/close/switch/restore, onPause visibility rule, 2s watchdog, `setTabBlink` idle-alert flash (500ms beat, stable-id keyed) |
| `android/.../RLMBridge.java` | `addJavascriptInterface` for secondary tabs: sync `httpRequest`, `cred*`, `setLoggedIn`, background-mode, `setTabBarInset`, `setIdleBlink` |
| `android/.../TabWebViewClient.java` | Serves `assets/public` at the highspell.com origin for secondary tabs; unknown paths → real network |
| `android/.../TabSessions.java` | Per-tab logged-in flags (stable-id keyed, in-memory), ORed to gate KeepAliveService |
| `android/.../CredentialVault.java` | Keystore crypto + store extracted from CredentialStorePlugin; shared by plugin (tab 0) and RLMBridge (tabs 1+) |
| `android/.../BackgroundModePlugin.java` | Now delegates logged-in to TabSessions (tab id 0), exposes `writeEnabled` + `setTabBarInset` |
| `android/.../MainActivity.java` | TabManager wiring, `onBackPressed → moveTaskToBack` (never finish = never kill sessions), onDestroy cleanup, keep-alive gate on `TabSessions.anyLoggedIn()` |
| `values/ic_launcher_background.xml` | Dark (#1D1D1D) adaptive-icon bg matching the RL launcher artwork (the fork-era deep orange existed to disambiguate from the original app; the RL icon now does that job) |
| `src/mobile-shell.ts` | Login ⚙️ gear moved down (top 4.5rem); overlay ✕ moved to the LEFT of the header; overlay open/close drives the tab-bar hide lease (renewed 1 s interval); tab highlight derived from `PanelManager.currentMenuItem`; World Map plugin repairs (`fixWorldMapWindow` + 🗺️-tap overlay auto-close — see bullets above) |
| `src/css/mobile-shell.css` | (also changed vs original) settings scroll-anywhere: `#highlite-settings-content-row-holder` stretched to fill the panel page, rows capped 640px |
| `src/frame-throttle.ts` | **Hidden-tab rAF throttle, the WebView.onPause() replacement (2026-07-15).** Wraps window.requestAnimationFrame/cancelAnimationFrame once at boot (before the game script); `__rlmSetHidden(bool)` (pushed by TabManager on switch + every 2 s watchdog beat) swaps hidden tabs onto a ~2 fps setTimeout pump and MIGRATES pending callbacks between the real rAF queue and the pump (a callback stranded in the stopped real queue would kill the self-rearming game loop). Exists because onPause'd hidden pages get FROZEN by Chromium after ~60 s → no pongs → server drops the session (the "connection lost on alternate tabs" bug) |
| `src/world-select.ts` | **World-lock fix (2026-07-15, device-verified e2e).** The inherited doc's claim "game reads hidden inputs at Login click → just update them live" is WRONG past the first login: v61 reads `#server-id-input`/`#server-url` via memoized module-scope getters (`ej()`/`tj()`), primed at the first `getLoginToken` POST and cached for the page's lifetime — that's why desktop reloads on world change. Symptom was: login → logout → pick another world → login lands on the OLD world (user hit it: picked w1, got w2). Fix: a `window.fetch` wrap (installed at module import, before the game script) records the input value at the first `/getLoginToken` as `lockedServerId`; the change handler and the post-logout re-assert compare against it and `location.reload()` on conflict (boot POST /game uses the stored world, which is written BEFORE reloading). Before any login, live input update still works (only those 2 inputs differ per world in /game — api/chat/cdn are global, verified). The lock check in `setupWorldSelect` also covers cross-tab clobber (shared localStorage): a rebuilt login screen whose page-lock disagrees with storage reloads itself. ⚠ ORIGINAL RyeliteMobile has this same latent bug |

### TODO
1. Loader boot retry (transient DNS failure at launch = black tab until reload).
2. Optional FPS cap for the visible tab (game renders at the display's 120 Hz; ~2.5 cores while playing — a 60 fps cap would halve it). User showed interest.

Original pre-build notes (differences from the original app; **the spike
WebView + "⇄" toggle described below were REMOVED when the real tab system
shipped** — spike bullets kept for the measurements and lessons only):

- `applicationId` / Capacitor `appId` = `com.matter418.ryelitemobile`,
  app label "RyeLite Mobile" — installs SIDE-BY-SIDE with the two older dev
  installs, so `adb install` here never kills a live session in those.
  Java `namespace` is unchanged (`com.matter418.ryelite`), so the launch
  component is
  `com.matter418.ryelitemobile/com.matter418.ryelite.MainActivity`
  and every `pidof`/`dumpsys` example below needs the `ryelitemobile`
  package id.
- Fresh app storage: CredentialStore/localStorage are empty — saved login
  profiles from the original do NOT carry over; first login is manual.
- Baseline RAM (measured on the original, 2026-07-14): ~460 MB app process
  (~220 MB of it GL/EGL) + ~560 MB WebView renderer ≈ 1.0 GB PSS; marginal
  cost per extra account est. ~650 MB → 6 accounts ≈ 4–4.5 GB. ⚠ The app
  was found at the LOGIN screen shortly after measuring, so this may be a
  login-screen baseline — re-measure in-world (likely higher: entities,
  sprite sheets). All WebViews share ONE renderer process
  (`sandboxed_process0`) — a renderer OOM/crash kills every tab at once.
- **SPIKE STATUS (2026-07-14): second-WebView spike BUILT & BOOTING.**
  `MainActivity.setupMultiAccountSpike()` adds a bare second WebView (vanilla
  `https://highspell.com`, no loader) + a floating "⇄" toggle (top-center)
  that lazy-loads it on first switch. Verified on device: tab 2 navigated
  homepage → world select → World 2 → vanilla game client BOOTED to its login
  screen while tab 1 (full RyeLite loader) sat at its own login screen.
  CDP shows both page targets under the app's devtools socket
  (`RyeLite` + `HighSpell - World 2`); both WebViews share ONE renderer
  process (confirmed). **Memory: two clients-at-login ≈ 1.24 GB PSS total
  (app 507 MB + renderer 729 MB) vs ~1.0 GB for one — marginal cost of the
  2nd client only ~200 MB at the login screen** (V8/Blink shared internals);
  in-world marginal cost still unmeasured. Remaining spike step: user logs
  two accounts in (no saved profiles in this fork — manual login; Claude
  must never type passwords), then verify both sockets alive simultaneously
  (`_lastPacketReceivedTime` on each target) + in-world RAM.
- **SPIKE RESULT (2026-07-14): TWO ACCOUNTS IN-WORLD SIMULTANEOUSLY —
  CONFIRMED WORKING.** User logged one account into each tab; both sockets
  verified live at once (tab 1: 165 packets, last 4s ago; tab 2: live WS
  frames via CDP Network watch — vanilla tab has no highlite hooks, so
  Network.webSocketFrameReceived is the way to check it). Same IP, same app
  process, one shared renderer — server accepted both. **In-world RAM: 1.41
  GB PSS for two accounts (app 620 MB + renderer 791 MB) → ~+400 MB per
  in-world account → 6 accounts ≈ 3 GB. Comfortable on the 16 GB Pixel.**
  ⚠ HEAT LESSON (the load-bearing one for the real tab UI): a WebView that
  is merely COVERED by another view keeps rendering at full tilt (~2.7
  cores, battery 41 °C, thermal status 2/moderate) — occlusion does NOT
  propagate into Chromium. And `setVisibility(GONE)` alone is UNRELIABLE:
  it throttled the Capacitor WebView (~2 rAF/s) but was flat-out ignored on
  the addContentView spike WebView (121 rAF/s while GONE). The spike-era
  conclusion "the deterministic per-view switch is `WebView.onPause()`/
  `onResume()`" turned out WRONG on a longer horizon: onPause looked
  perfect short-term (visibilityState hidden, rAF 0, timers running,
  device-verified 2026-07-14) but Chromium FREEZES the paused page ~60 s
  later, killing the socket (found 2026-07-15 — the "byte-for-byte
  app-backgrounded state" reasoning was false; Capacitor never onPauses
  its WebView). Superseded by the page-side rAF throttle
  (frame-throttle.ts). Still true: never the global `pauseTimers()` — that
  would freeze every tab's timers incl. socket pongs.
- **LOGIN AUTH — cookie question RETIRED (2026-07-14, from v61 source):**
  Login = `POST /getLoginToken` (username/password/serverId JSON) → JSON
  `data.token` → `SocketManager.openSocketConnection(username, token, url)`
  stores `_sessionToken` and emits it in the first packet after socket
  connect. Game socket has `reconnection:false` (a drop = back to login
  screen, no silent reconnect), and a separate chat socket uses
  `MainPlayer.ChatToken` (server-issued) with reconnection:true. **Cookies
  play no role in game auth** — the shared CookieManager is a non-issue for
  multi-account; ProfileStore isolation NOT needed for sessions.
- **Cookie finding (2026-07-14, CDP `Storage.getCookies` on the original):
  the WebView holds an HttpOnly `sid` cookie on `.highspell.com`** (present
  even at the login screen; `document.cookie` is empty — HttpOnly). Cookie
  jar (`CookieManager`) is GLOBAL across all WebViews in an app, so if `sid`
  participates in login/socket auth, account B's login clobbers account A's
  sid (established sockets don't care — cookies only ride the handshake —
  but reconnects would present the wrong sid). Still unverified whether the
  game actually uses `sid` for auth vs. pure credential-over-socket login;
  verify by watching a login. If it matters, the fix is androidx.webkit
  **ProfileStore** (multi-profile WebView, WebView 122+; fine on the Pixel) —
  note per-profile isolation also splits localStorage, so mobile settings
  would need native storage or cross-tab sync. Other open question: High
  Spell's multiboxing policy.

Everything below is inherited from the original project's doc.

---

Android port of the RyeLite client (High Spell game client, fork of HighLite).
Capacitor WebView app that reuses `@ryelite/core` — the plugin runtime, Plugin
Hub browser, and settings UI all come from core unchanged; this project is the
loader, Electron shims, mobile input translation, and mobile presentation.

**Status: fully playable.** Login → world → touch controls → Hub plugin
install/enable → plugin settings all verified working on the user's device
(Pixel 10 Pro XL). User plays with Chat+ and Experience Tracker installed from
the live Hub.

## Repo layout (this folder)

| Path | What |
|---|---|
| `src/client.ts` | Loader: adapted from `RyeliteDesktop/src/renderer/client/client.ts`. POST /game → DOM merge → fetch client JS → Reflector hooks → inject → `Highlite.start()` → mobile shell |
| `src/shims.ts` | The 3 Electron preload globals: `window.settings` (localStorage), `window.screenshot` (stub), `window.electron.ipcRenderer` (no-op). Plus a `Notification` shim (WebView lacks it; core crashes without it) |
| `src/touch-input.ts` | Touch→mouse gesture translation (see Input section) |
| `src/mobile-shell.ts` | Fullscreen overlay re-housing core's panel bar + 📱 Mobile settings panel + settings-menu entry link |
| `src/login-profiles.ts` | Login screen: saved-profile dropdown + Remember Me + delete + last-used autofill (port of desktop `userHelper.js`) |
| `src/world-select.ts` | World picker, bottom-left of login screen (port of desktop `worldSelectHelper.js`). Fetches `/play` via CapacitorHttp (443 = intercepted), lists worlds + player counts. NO reload on change (desktop reloads): the game reads hidden `#server-id-input`/`#server-url` at Login click, so the change handler just updates them live (verified on device: picked World 2 → socket to `server2.highspell.com`). Selection persists in `ryelite-mobile-world` localStorage; client.ts uses it for the boot POST /game. Login-screen-only: body observer removes the picker when `#hs-screen-mask` appears (`#login-screen-container` alone is NOT a valid signal — it stays in the DOM in-world) and re-creates it + re-asserts inputs on the post-logout rebuild. Sized ~1.4x desktop (1.4rem font) for touch — was 2x, trimmed to 70% on user request |
| `src/chat-tap.ts` | Tap chat bar → game's "Type a public chat message" input. The game's own handler is mobile-mode-only (vetoed by ForceDesktopMode) but still bound in desktop mode; we call `HTMLUIManager.Instance._controller._chatMenuController._handleChatInputMenuPointerDown` on delegated pointerdown over `#hs-chat-input-player-name-and-input-container` (settings button excluded; `IsTextInputMenuShowing` getter guards re-entry). **Capture phase required** — the game stops pointerdown propagation inside the chat menu |
| `src/keyboard-bridge.ts` | Soft keyboard for ALL game text input menus (chat, bank X-amount, …). In desktop mode `TextInputMenu` builds a span-based fake input fed by hardware keys (`_isUsingTrueHTMLInput = MobileHelper.IsMobile` — vetoed) → no IME ever. Bridge: on `.hs-text-input-menu` insertion, overlay an invisible real `<input>`, focus it (tap's user activation opens IME), mirror value via `textInput.setInputValue()`, Enter → `processKey('Enter')`. Shadow input stopPropagations all key events (game's document-level key handling would double-feed the same TextInput). **Focus-retry required** — the game blurs focus back to body during menu setup, so a single `focus()` doesn't survive (verified on device); retry every 100ms until it sticks. Close a text input menu programmatically with `_screenMaskController._removeTextInputMenu()` |
| `src/error-trap.ts` | console.error getter/setter wrap (survives the game's console replacement) + window error/unhandledrejection → full stacks in logcat. Exports `rawLog` |
| `src/sprite-worker-fix.ts` | ROOT-CAUSE fix for invisible players/NPCs: rewrites the game's sprite worker at Blob-construction time (rAF reply → `convertToBlob`), delivers the blob straight to SpriteSheetManager. ⚠ Until 2026-07-14 direct delivery was silently INERT: the `d.blob instanceof Blob` check used our patched `window.Blob` subclass, and structured-cloned worker blobs are native-Blob instances → always false → every sprite fell back to the game's placeholder-toBlob path (source of the "everyone dressed the same" login bug). Fixed with module-scope `NativeBlob` capture. Ships delivery diagnostics: `window.__rlmSpriteDeliveries` (ring buffer w/ blob sizes + appearance ids), `__rlmSpriteReport()` (cached sheets vs deliveries), `__rlmSpriteWorkerUrls`/`__rlmRewrittenWorkerSource`, logcat lines `delivered ...`, `⚠ create reply without blob` (fallback), `⚠ ANOMALY` (distinct ids → identical blob sizes) |
| `src/sprite-guard.ts` | Defense-in-depth: sanitizes SpriteSheetManager state at login screen + wraps `reset()` + in-world stall watchdog |
| `android/app/src/main/java/com/matter418/ryelite/CredentialStorePlugin.java` | Keystore-backed credential store (AES-256-GCM, non-exportable key; ciphertext in `ryelite-credentials` SharedPreferences). Registered in MainActivity |
| `android/.../KeepAliveService.java` + `BackgroundModePlugin.java` + `src/background-mode.ts` | **Background keep-alive** (Glimmer-style): foreground service started in `MainActivity.onPause`, stopped in `onResume` — exempts the process from the cached-app freezer so the game socket survives app-switching. Silent low-importance notification ("Keeping your game connected", icon `ic_stat_ryelite`) only visible while backgrounded. Plus a 20-min `PARTIAL_WAKE_LOCK` for screen-off. `foregroundServiceType="specialUse"` (NOT Glimmer's `dataSync` — that's capped 6h/day on Android 15+ w/ targetSdk 35). Toggle "Keep game alive in background" in 📱 Mobile panel, default ON; setting lives in native SharedPreferences `ryelite-background-mode` (onPause reads it natively, so NOT in localStorage). **Login-gated** (user request: no battery waste at the login screen): `src/login-state.ts` mirrors `#hs-screen-mask` presence to `setLoggedIn` via a body observer; onPause requires enabled AND loggedIn, and `setLoggedIn(false)` while backgrounded stops the service/wakelock immediately (covers logout-or-disconnect-while-hidden). Cold start reports false, clearing a stale flag from a killed session. Service is `START_NOT_STICKY` (divergence from Glimmer — a sticky restart after an app kill guards a WebView-less zombie process with a lying notification; observed live). POST_NOTIFICATIONS requested in onCreate (pre-granted via adb on the dev device). All three gating cases device-verified 2026-07-14: login-screen background → no service/wakelock; in-world background → both held; logout → background → both released |
| `src/ui-scale.ts` | Virtual desktop viewport + screen edge margin + per-element scale overrides (logout button / context menus / chat bar — see Settings table) incl. `watchContextMenu()` (body observer that points the scaled context menu's transform-origin at the nearest screen corner per open, so it grows into free space) |
| `src/css/mobile-shell.css` | Shell styling + the FULL desktop `:root` CSS var set (`--theme-*`, `--vt-c-*`, `--color-*`, `--titlebar-height: 0px`) copied from desktop `static/css/index.css` — plugins reference these in inline styles; an undefined var inside `calc()` collapses the property (Nameplates sized its overlay `calc(100% - var(--titlebar-height))` → height 0 → every nameplate clipped, the "doesn't work on mobile" bug). Checkboxes get `color-scheme: dark` (light scheme draws a white glyph — invisible on the yellow accent) |
| `src/plugins/` | Build-time bundled plugins (empty — Hub handles distribution) |
| `android/app/src/main/java/com/matter418/ryelite/MainActivity.java` | `setUseWideViewPort(true)` + `setLoadWithOverviewMode(true)` (required for viewport meta) + immersive fullscreen (hide system bars) |
| `android/app/src/main/AndroidManifest.xml` | `android:screenOrientation="sensorLandscape"` |

Related local repos: `../RyeliteDesktop` (the Electron client + user's plugin
sources under `plugins/`). Hub registry: `RyeL1te/Plugin-Hub` on GitHub, but
the client syncs from `https://www.ryelite.org/api/plugins/manifest.json`.

## Build & deploy loop

```powershell
cd RyeLiteMobile2
npm run build                    # vite → dist/
npx cap sync android
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"   # system Java 24 too new for Gradle 8.11.1; JBR is 21
cd android; .\gradlew.bat assembleDebug
adb install -r app\build\outputs\apk\debug\app-debug.apk         # only kills RyeLite Mobile, never the older dev installs
adb shell am start -n com.matter418.ryelitemobile/com.matter418.ryelite.MainActivity
```

**Before `adb install`: if the user is logged in (CDP: `#hs-screen-mask`
exists), log them out first** — killing the app mid-session leaves the
character online until the server times it out. The whole cycle is
automatable via adb taps (user-approved workflow, used repeatedly 2026-07-13):

1. **Logout**: tap the logout button (get its rect via CDP → device px =
   CSS × `2992 / window.innerWidth`). The tap opens the shared context menu
   with Logout/Cancel — find the "Logout" `.hs-context-menu__item` rect and
   tap it. Verify: body text contains "Enter your username and password".
2. **Install + relaunch** (commands above), then re-forward CDP (new pid).
3. **Login**: saved profile autofills via Remember Me; just tap the Login
   button (device coords (1675, 754) with current settings — recompute from
   its rect if layout/settings changed). Verify `#hs-screen-mask` exists.

## Debugging workflow (hard-won — use this, not chrome://inspect)

- **CDP into the live WebView** (full JS eval, DOM inspection, event dispatch):
  ```bash
  adb forward --remove-all
  adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof com.matter418.ryelitemobile | tr -d '\r\n')
  node scratchpad/cdp.mjs "<expression>"   # cdp.mjs: ~40-line Runtime.evaluate client; Node 22 has global WebSocket.
  ```
  `includeCommandLineAPI:true` means `getEventListeners()` works. Re-forward
  after every app restart (pid changes). The cdp.mjs script lives in the
  Claude scratchpad — recreate it if gone (fetch /json, open ws, send
  Runtime.evaluate with returnByValue+awaitPromise).
- **⚠️ The game REPLACES `console.log` at init** (routes to its in-game dev
  console). Our modules capture `const nativeLog = console.log.bind(console)`
  at module scope (before the game script). Any logging added later must use
  captured refs or it vanishes.
- Logcat: one-shot `adb shell "logcat -d -s Capacitor/Console:*"` works;
  **streaming logcat over wireless adb dies silently** — don't trust it.
  Default 256KiB ring buffer rotates in seconds; `adb logcat -G 16M` first.
- Screenshots: `adb exec-out screencap -p > file` **via bash** (PowerShell `>`
  corrupts binary). Device: 2992×1344 landscape, devicePixelRatio 3, CSS
  viewport 997×448 at 100% scale. `adb shell input tap/swipe X Y` uses device
  px (CSS×3 at 100%; multiply by current scale otherwise) and DOES exercise
  the touch translator (trusted events).
- Android fires its own long-press haptic — a vibration is NOT proof our code ran.
- Soft keyboard visibility: `adb shell dumpsys input_method | grep mInputShown`
  (the WebView does NOT resize when the IME opens — `window.innerHeight` is
  useless as a keyboard signal under immersive fullscreen).
- Useful runtime paths (all under
  `document.highlite.gameHooks.HTMLUIManager.Instance._controller`):
  `._chatMenuController` (chat handlers), `._screenMaskController`
  (`IsTextInputMenuShowing` getter, `showTextInputMenu`,
  `_removeTextInputMenu`, `_currentTextInputMenu.getTextInput()` →
  `setInputValue`/`processKey`). `_controller` only exists in-world.

## Game integration facts (all verified live; game client v61)

- **`#hs-screen-mask` covers the whole viewport (z-index 2) and receives ALL
  real input. The canvas never does.** Game click/menu/camera logic lives on
  the mask's listeners. Synthetic events must target the mask (or the touched
  element for UI). The game has NO window-level input listeners → our
  window-capture suppressors (registered first, top of client.ts) are airtight.
- **Desktop-mode input semantics** (we force desktop mode): button 0 down/up =
  default action (fires on pointerdown for walk); button 2 down = world
  context menu (menu items: `.hs-context-menu__item`); **camera rotates ONLY
  on middle-button (1) drag** — 0/2 do nothing (measured via
  `document.highlite.gameHooks.GameCameraManager.Camera.alpha`).
- **Item reordering is HTML5 native drag-and-drop** — slots
  (`.hs-inventory-item`, covers inventory/bank/trade) are `draggable=true`
  with dragstart/dragend; containers take dragover/drop (per-cell
  `.hs-item-table__cell` listeners; drop reads the dragged element id from
  dataTransfer "text" and fires the reorganize event with from/to slots).
  Synthetic pointer drags just complete a click (= withdraw). Synthesize
  `DragEvent`s sharing one `new DataTransfer()`. Synthetic DnD has no native
  drag image, so touch-input.ts renders its own ghost: a translucent clone of
  the slot follows the finger (inline-styled, `pointer-events:none` so it
  never wins `elementFromPoint`; offset up so the fingertip doesn't hide it)
  and the source slot dims to 0.4 for the duration.
- **Game mobile mode is screen-size based**, not touch: `MobileHelper` media
  query `(height < 48rem)...`. In mobile mode every click opens the menu and
  button 2 is dead. **"Force Desktop Mode"** (game setting; its localStorage
  key `"17"` = `"true"`; settings enum ForceDesktopMode=17) vetoes it —
  REQUIRED for the touch translator's semantics. "Use One Mouse Button" must
  stay OFF (it means left-click-opens-menu, for one-button mice).
- **The game page ships its own viewport meta** — the DOM merge would copy it
  in after ours and win. `enforceViewport()` deletes all viewport metas and
  recreates ours (`#rlm-viewport`); recreation (not mutation) guarantees
  re-evaluation. Bare `width=N` is IGNORED by Android WebView — must include
  explicit `initial-scale`.
- Game settings menu `#hs-settings-menu` is persistent DOM; sections are
  `.hs-settings-menu__section` divs of spans (`hs-text--yellow` title,
  `hs-text--cyan hs-text-button` links). Our entry link is injected above the
  Graphics section; clicks bound via `UIManager.bindOnClickBlockHsMask`
  (game's click-mask unblocker — plain onclick is dead in game UI).
- CORS (all verified): `highspell.com:3002` and `:8887` (binary assets) send
  `ACAO: *`; socket.io `server1.highspell.com:8888` and the Hub API
  `www.ryelite.org` allow exactly `https://highspell.com` — which IS our
  origin thanks to `server.hostname` in capacitor.config.ts.
- **CapacitorHttp global fetch patch corrupts binary responses** — stays
  disabled; loader calls `CapacitorHttp.request()` explicitly for the three
  port-443 URLs (intercepted by the WebView local server due to the hostname
  trick): POST /game, client JS, version JSON. Game page stylesheets on :443
  are fetched natively and inlined as `<style>`.
- Client JS from the server is **gzipped** (`1f 8b`) — gunzip before grepping.
- **Invisible players/human-NPCs: ROOT CAUSE (v61, fixed by
  sprite-worker-fix.ts).** Human sprites are composited by a blob-URL Web
  Worker on an OffscreenCanvas transferred from a placeholder `<canvas>`
  that is NEVER in the DOM. Delivery is frame-driven in THREE places:
  worker replies via `requestAnimationFrame(l)`, canvas pixels reach the
  placeholder on the rAF frame commit, and the main thread does
  `rAF → placeholder.toBlob('image/webp')`. rAF only fires while the
  compositor produces frames — backgrounding the app / screen-off stops
  them, and worker rAF for a never-displayed canvas may never resume. The
  reply then never arrives; `SpriteSheetManager._isAwaitingWorkerResult`
  sticks true; every human sprite afterwards queues forever (billboard
  mesh `visibility 0`, no material; creatures/items don't use the worker).
  Desktop keeps producing frames while playing → mobile-only. Fix: Blob
  constructor wrap rewrites the worker source (reply via
  `convertToBlob()`, blob attached to the message) + Worker onmessage
  shadow delivers it straight to
  `SpriteSheetManager._handleSpritesheetCreatedByWebWorker` with duck-typed
  args, bypassing the placeholder/commit machinery. Signature-gated on
  v61 minified strings — if a client update changes them the rewrite
  silently no-ops (old path returns, sprite-guard still watchdogs).
- **"Everyone dressed the same" after login (upstream bug, all clients).**
  The vanilla delivery pipeline reads composited pixels from the PLACEHOLDER
  canvas (`uU._canvas.toBlob` after main-thread rAF), but the placeholder's
  contents only update on OffscreenCanvas frame commits from the worker. When
  commits lag behind the reply messages (login burst + frame stalls), every
  toBlob captures the SAME stale frame → many/all players+human-NPCs get
  identical spritesheets (distinct blob URLs, identical pixels). Our direct
  `convertToBlob` delivery bypasses the placeholder entirely (snapshot is
  taken synchronously at call time per spec, so request↔pixels can't cross
  even with overlapping requests) — but ONLY protects us while direct
  delivery is actually active (see instanceof pitfall in the file table).
  Vanilla/desktop clients keep this bug. Verified live 2026-07-14: with
  direct delivery active, 9/9 login sprites had distinct sizes & correct
  outfits; while it was inert, every reply logged the fallback warning.
- **Secondary teardown fragility** (why sprite-guard.ts exists):
  `SpriteSheetManager.reset()` does the queue cleanup and flag resets in
  ONE try/catch, and several game managers throw harmless-looking
  exceptions during quick logouts (TargetActionManager.reset:
  `null.destroy()`; EntityManager clearOtherPlayers → `_removeMenu` reads
  `null.EntityID`). If teardown is ever aborted before reset completes,
  the flag wedge persists into the next session and
  `initializeNewSession()` no-ops (guarded on `_isInitializedForSession`).
  Guard sanitizes at login-screen-shown, wraps reset(), and re-kicks a
  stalled queue in-world.
- The game's UI re-init on relogin REBUILDS `#hs-settings-menu` (new
  element — "MobileHelper is already initialized" is the tell), so the
  settings link re-injection must observe document.body, not the menu node.
- (Glimmer, the other Capacitor HighSpell app, is launcher+notifications
  only — no plugin runtime, and no handling for any of this.)
  Diagnosed live on device + from un-minified v61 source, 2026-07-13.
- **Backgrounding & the session** (measured on device 2026-07-13): Capacitor's
  `KeepRunning` pref defaults true → JS timers keep running on pause;
  socket.io is EIO=4 (server pings 25s/timeout 20s; client pong is
  event-driven, survives Chromium timer throttling). The game sends NOTHING
  while idle (no app-level keepalive; whole game loop incl. outbound emits is
  rAF-driven and rAF stops when hidden) — the server tolerates a silent but
  pong-responsive client. With KeepAliveService running, session verified
  alive through ~19 min continuously backgrounded (screen off); died at
  ~19.7 min ("transport close" mid-background) ≈ light-Doze network
  restriction (device was CHARGING; unplugged may differ). NOT the WebView
  renderer freezing — renderer stayed `isFrozen=false` throughout a 9-min
  zero-CDP-contact soak; `setRendererPriorityPolicy(IMPORTANT, false)` in
  MainActivity is belt-and-braces anyway (default policy waives renderer
  priority when invisible → freezer-eligible; stock freezer delay ~10 min
  was never reached in tests). Beating Doze would need the
  battery-optimization exemption (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
  flow) — not implemented; Glimmer declares the permission but never
  requests it either. **Screen-OFF background survival is high-variance**
  (one run died silently within 3 min, discovered only on resume-send;
  another lived 19.7 min) — likely Wi-Fi power-save/Doze; a
  `WifiManager.WifiLock(WIFI_MODE_FULL_HIGH_PERF)` held by KeepAliveService
  is the untried candidate fix. Screen-ON app-switching (the actual "check
  an email" case) never failed. ⚠️ Measurement gotchas: (1) CDP
  `Runtime.evaluate` polling keeps the renderer active — soak tests must be
  observed via logcat + `dumpsys` only; (2) "in-world DOM present" does NOT
  prove the socket is alive — a silently-dead TCP raises no close event
  until the next send; only packet timestamps (`_lastPacketReceivedTime`)
  or the logged disconnect time are evidence.
- **Wakelock semantics** (20 min, `WAKELOCK_TIMEOUT_MS` in MainActivity,
  value copied from Glimmer): acquired on pause (when logged in + enabled),
  auto-released by Android at 20 min, released early on resume. Screen-ON
  app-switching doesn't need it (CPU already awake; the FGS is what matters,
  and the FGS has no time limit). Screen-OFF survival is effectively capped
  ~20 min by this + Doze — deliberate battery courtesy, not a bug; extending
  it properly = battery-optimization exemption + WifiLock, not a bigger
  timeout.

## Research sources (2026-07-13/14 backgrounding work — where to look next time)

- **Glimmer** — `https://github.com/lillelilje/glimmer`, the other Capacitor
  HighSpell app and the reference for all four of its features (custom
  launcher, Always Awake, alerts, runs-in-background). Cloned to the session
  scratchpad (re-clone; scratchpads don't persist). Key files, all under
  `android/app/src/main/java/io/glimmer/client/`:
  - `ForegroundService.java` — FGS template we ported (silent IMPORTANCE_LOW
    channel, START_STICKY — we changed to NOT_STICKY, `dataSync` type — we
    changed to `specialUse` for the Android 15+ 6h/day cap).
  - `MainActivity.java` — start FGS in onPause / stop in onResume, 20-min
    PARTIAL_WAKE_LOCK, POST_NOTIFICATIONS request, gating pref read from
    SharedPreferences (`CapacitorStorage`, key `glimmer_runInBackground`).
  - `GlimmerNativeBridge.java` — `addJavascriptInterface` bridge: `notify()`
    (game alerts, IMPORTANCE_HIGH channel), `keepAwake()`/`allowSleep()`
    (Always Awake = `FLAG_KEEP_SCREEN_ON`) — the two features NOT yet ported.
  - Manifest declares `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` but no code
    ever requests it — Glimmer has the same Doze gap we do.
  - `GlimmerPlugin.java` does the POST /game natively + `loadDataWithBaseURL`
    (their alternative to our hostname-trick loader); injects
    `injected-script.js` + interact.min.js into `<head>`.
- **HighSpell client source** — fetch
  `https://highspell.com/js/client/client.<V>.js` (gzip on the wire, ~7 MB
  minified; `V` from `https://highspell.com:3002/assetsClient` →
  `data.latestClientVersion`, v61 at time of writing). Grep-verified facts:
  game loop is `requestAnimationFrame(this._runGameLoop)` with
  `TIMESTEP=600` ms accumulator; NO app-level keepalive/heartbeat (only
  setIntervals are a util poller + server-shutdown countdown); all
  `emitPacket` calls are user-action-driven; `visibilitychange` handler only
  recalculates entity Y positions; "Connection to the server was lost"
  appears in `_handleLostConnection`/`_handleConnectFailed`;
  `EnteredIdleState` (action 12) is an animation state, NOT afk-logout.
- **Live socket internals via CDP** (in-world only):
  `document.highlite.gameHooks.SocketManager.Instance` → `_socket`
  (socket.io, EIO=4, websocket transport to `server1.highspell.com:8888`),
  `._socket.io.engine` (pingInterval 25s / pingTimeout 20s — server pings,
  client pong is event-driven), `_lastPacketReceivedTime` /
  `_packetReceivedCount` (ground truth for "is the connection actually
  alive"), `_queuedPackets`, `_handleLostConnection`. Disconnect reasons
  surface on `_socket.on('disconnect', reason)` — "transport close" = TCP
  died.
- **Capacitor Android source** (in `node_modules/@capacitor/android/.../com/getcapacitor/`):
  `Bridge.java` `shouldKeepRunning()` — `KeepRunning` pref defaults TRUE, so
  WebView JS timers are NOT paused on background (the
  `webView.pauseTimers()` path in `cordova/MockCordovaWebViewImpl.handlePause`
  only runs when it's false). This is why the socket keeps working while
  backgrounded at all.
- **Android platform behaviors** (observed on Pixel 10 Pro XL, Android 16):
  cached-app freezer (`dumpsys activity processes` → `isFrozen=`) is what
  killed sessions pre-FGS; WebView renderer is a separate sandboxed process
  (`com.google.android.webview:sandboxed_process0`, priority default waives
  when invisible → `setRendererPriorityPolicy`); FGS `dataSync` capped
  6h/day on Android 15+ (targetSdk 35) → use `specialUse`; light Doze cuts
  network ~15-20 min after screen-off even with an FGS.
- **Useful dumpsys one-liners**: service alive →
  `dumpsys activity services com.matter418.ryelitemobile/com.matter418.ryelite.KeepAliveService`;
  wakelock held → `dumpsys power | grep KeepAliveWakeLock`; freeze state →
  `dumpsys activity processes | grep isFrozen` (pair with awk on
  ProcessRecord lines); screen → `dumpsys display | grep mScreenState`;
  doze → `dumpsys deviceidle get light`.

## Input translation (src/touch-input.ts)

| Surface | Tap | Hold (400ms default) | Drag | Pinch |
|---|---|---|---|---|
| World (`#hs-screen-mask` bare, or CANVAS pre-login) | synth b0 down/up | synth b2 down/up + contextmenu | synth middle-button drag (camera) | synth wheel events (camera zoom) |
| Item slots (`.hs-inventory-item` closest) | synth b0 down/up | synth b2 (item menu) | synth HTML5 DnD (reorder) + finger-following ghost clone, source dims | swallowed |
| Everything else (menus, chat, buttons) | native | native | native | native |

Raw touch suppressed at window capture (preventDefault + stopImmediatePropagation);
synthetics reuse the REAL pointerId (Babylon setPointerCapture throws on fake
ids and kills drags). **Pinch zoom** (verified on device 2026-07-14): second
finger on the world surface during a world gesture (pending OR mid-drag — the
drag gets a clean synth pointerup first) → `pinching` mode; spread change is
converted to synthetic WheelEvents on the mask (deltaY>0 = zoom out; the
camera is a Babylon ArcRotateCamera with a mousewheel input, wheel handler on
the mask). ⚠ The zoom step is NORMALIZED per wheel event (deltaY 30 ≈ 120,
~1 radius unit/tick, usable radius ≈ 4–18) and synchronous event bursts are
swallowed by the frame accumulator — so pinch emits at most ONE tick per
pointermove, paced by `PINCH_STEP_PX` (40 CSS px of spread) with remainder
carry. Lifting one finger transitions the survivor to a fresh camera drag
(stationary middle-button down/up is a no-op, so safe). Third+ fingers, item
gestures, and open long-press menus still swallow the extra finger.
`DEBUG = true` currently — gesture logs visible in logcat via captured
nativeLog. Flip off for release.

**Testing multi-touch without root**: `sendevent` is permission-denied and
`adb shell input` is single-pointer — use CDP `Input.dispatchTouchEvent`
(events arrive `isTrusted: true`, coordinates in clientX space). Semantics:
touchStart/touchMove take the full active-point set; touchEnd takes the
RELEASED point(s) only. Scratchpad scripts `pinch.mjs` / `drag.mjs` /
`combo.mjs` (this session) show the pattern.

## Settings (all localStorage, per-origin https://highspell.com)

| Key | Contents |
|---|---|
| `ryelite-mobile-touch-v2` | `{enabled, longPressMs}` (camera button is hardcoded middle — not a preference) |
| `ryelite-mobile-ui` | `{viewportWidth, edgeInset, logoutScale, contextMenuScale, chatInputScale}` — Game UI size (0 = native; default 1280), horizontal screen-edge padding (0–96px, for curved glass; top/bottom padding rejected by user), and per-element scale %s (100–250, enlarge only) for `#hs-logout-button` (origin top right), the shared `#hs-context-menu` (origin = `--rlm-ctx-origin`, set per open by a body observer to the screen quadrant's corner so the menu grows into free space), and `#hs-chat-input-menu` (origin bottom left, **plus `margin-top: calc(1.5rem * (k-1))`** — transform is visual-only, the margin adds the extra height as real layout space so the bottom-anchored chat menu pushes the message list up instead of the scaled bar painting over it). All `transform: scale()` via `#rlm-elem-scale` style tag |
| `ryelite-mobile-settings` | shim for `window.settings` (Enable Plugins etc.) |
| `ryelite-mobile-world` | `{worldName, serverId, serverUrl, playerCount}` — last world picked in the login-screen world selector; used for the boot POST /game |
| Game's own `"17"` | ForceDesktopMode (user has it on) |

Login credentials are NOT in localStorage — they're in the `CredentialStore`
native plugin (Keystore-encrypted SharedPreferences), surviving app data
inspection and excluded from backups.

📱 Mobile panel (a core panel via `panelManager.requestMenuItem('📱','Mobile')`):
tap&hold toggle, hold delay, Game UI size %, Logout button size %, Context
menu size %, Chat bar size %, Screen edge margin. The 📱 tab is moved to the
FRONT of the panel bar (`icon.parentElement.prepend`, class `rlm-mobile-tab`)
so it's also the default panel openOverlay lands on. Rows are capped at
520px (full-bleed rows put controls a screen away from labels); panel pages
get `box-sizing: border-box` in mobile-shell.css — load-bearing, inline page
padding + `width:100%` otherwise overflows and core's `overflow-x:hidden`
clips the right edge of every row (was a live bug). Entry points:
(1) in-game settings gear → "RyeLite / Open RyeLite Mobile Settings";
(2) `#rlm-login-settings` ⚙️ gear top-left of the LOGIN screen (world-select
lifecycle pattern: exists only while `#hs-screen-mask` absent +
`#login-screen-container` present). Pre-login the overlay gets class
`rlm-login-only` → only the 📱 tab is visible/forced (core plugin settings
are per-username; no username at the login screen), and a non-Mobile panel
left open from last session is force-switched (guarded on
`#selectedContentTitle` ≠ 'Mobile' — clicking the current tab toggles the
drawer closed). A `.rlm-login-note` box at the top of the Mobile panel
('Once logged in, you can also open these settings from the HighSpell
settings menu (⚙️ → "Open RyeLite Mobile Settings").') is display:none
except under `.rlm-login-only`.

## TODO (rough priority)

1. Flip `DEBUG = false` in touch-input.ts; consider a signed release build.
2. `git init` + push to `matter418` (project has NO version control yet).
3. iOS someday (WKWebView + App Store policy problems — parked).

Done 2026-07-14: drag ghost for item drags (bank/inventory/trade) — verified
on device via CDP touch injection (ghost follows finger, source dims,
clean removal + correct drop on both bank and inventory tables).

## History / deeper context

Full narrative in Claude auto-memory `project_ryelite_plugin.md` (RyeLite
Mobile sections) — includes the desktop plugin-dev knowledge base (QuickDeposit
synth-click trick, Chat+ DOM maps, Hub publishing flow) that informed most of
the mobile mechanisms.
