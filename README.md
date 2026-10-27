# annotate-dom

Chrome extension (Manifest V3) for pinning notes on DOM elements and copying them as one markdown prompt for an AI agent. Each pin carries a cropped screenshot, the React source location (`file:line` for the element and every component above it), props and hook state, selector, computed styles, parents and HTML. Nothing is installed in your app.

## Build and load

```sh
bun install
bun run build          # writes dist/
```

Open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick `dist/`. After a rebuild, click the reload icon on the extension card.

## Use

1. Open your app's dev server (for Next.js use `http://localhost:3000`, not `127.0.0.1`: Next 16 blocks HMR and hydration for origins outside `allowedDevOrigins`).
2. Click the toolbar icon or press `Alt+Shift+A`. Hover to highlight, click an element, type a note, press Enter.
3. Pin across as many pages in the tab as you like. Pins survive reloads; after a full reload, press the shortcut again to show the overlay.
4. Click "Copy all" and paste into your agent. PNGs land in `~/Downloads/annotate-dom/`, and the markdown refers to them by absolute path. "Undo" in the toast restores the batch.

Source locations need a React 19 dev build (Next.js with Turbopack or Vite). Production pages still get DOM metadata and screenshots.

## Develop

```sh
bun run test           # unit tests (Vitest)
bun run test:e2e       # builds dist-test/ and runs Playwright against APP_URL (default http://localhost:3000)
```

The e2e test pins the theme toggle on granite-inventory-management's `/login`; set `APP_URL` and `APP_ROOT` to point it at another app.
