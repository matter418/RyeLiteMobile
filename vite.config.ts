import { defineConfig } from 'vite';

export default defineConfig({
    base: './',
    build: {
        // Top-level await in src/client.ts requires es2022; Android System
        // WebView on any remotely modern device (Chromium 89+) supports it.
        target: 'es2022',
    },
});
