# Plugins

Drop compiled plugin `.js` files here (same format as
`RyeliteDesktop/src/renderer/client/plugins/`) and they'll be picked up by the
`import.meta.glob('./plugins/*.js')` in `src/client.ts` at build time.

Intentionally empty for the spike — the mobile plugin UI direction hasn't been
decided yet. Desktop plugins will load, but their panels/interactions assume a
mouse and a desktop-sized window.
