// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// Serialize exceptions to logcat with name/message/stack. The game logs
// caught exceptions via console.error(e), which Capacitor's console bridge
// flattens to useless "[object DOMException]" lines — and the game REPLACES
// console.error at init, so a plain wrapper would be discarded. The
// getter/setter property keeps our wrapper installed across the game's
// reassignment while still delegating to whatever it installed.

const nativeLog = console.log.bind(console);
const nativeError = console.error.bind(console);

// Logging that reaches logcat even after the game replaces console.log.
export const rawLog = nativeLog;

function describe(value: unknown): string | null {
    if (value instanceof Error || value instanceof DOMException) {
        return `${value.name}: ${value.message}\n${(value as { stack?: string }).stack ?? '(no stack)'}`;
    }
    return null;
}

export function initErrorTrap() {
    let inner: (...args: unknown[]) => void = nativeError;
    const wrapped = (...args: unknown[]) => {
        for (const arg of args) {
            const detail = describe(arg);
            if (detail) nativeLog('[RLM ErrorTrap] console.error:', detail);
        }
        try {
            inner.apply(console, args);
        } catch {
            /* never let logging break the caller */
        }
    };
    Object.defineProperty(console, 'error', {
        configurable: true,
        get: () => wrapped,
        set: fn => {
            inner = fn as typeof inner;
        },
    });

    window.addEventListener(
        'error',
        e =>
            nativeLog(
                '[RLM ErrorTrap] window.onerror:',
                e.message,
                `${e.filename}:${e.lineno}:${e.colno}`,
                (e.error as { stack?: string } | undefined)?.stack ?? ''
            ),
        true
    );
    window.addEventListener(
        'unhandledrejection',
        e =>
            nativeLog(
                '[RLM ErrorTrap] unhandledrejection:',
                describe(e.reason) ?? String(e.reason)
            ),
        true
    );
}
