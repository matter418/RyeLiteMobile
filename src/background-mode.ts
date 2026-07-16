// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// Keep-alive toggle + per-tab logged-in reporting. Now a re-export of the
// native-bridge facade so it works in Capacitor tab 1 (BackgroundMode
// Capacitor plugin) AND secondary tab WebViews (RLMBridge JS interface).
// The setting itself lives in native SharedPreferences (onPause must read
// it without any WebView), and logged-in state is per-tab, ORed natively
// (TabSessions.java) to gate the KeepAliveService.

export { backgroundMode as BackgroundMode } from './native-bridge';
