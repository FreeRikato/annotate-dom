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

## Daemon

A local daemon lets the agent read the annotations itself instead of receiving a paste. It listens on `localhost:4747` and starts at login.

```sh
bun run daemon:install     # writes ~/Library/LaunchAgents/com.annotate-dom.daemon.plist and loads it
bun run daemon:uninstall   # unloads it and removes the plist
```

Logs go to `~/.annotate-dom/daemon.log`. Both commands print the line that registers the MCP server with Claude Code:

```sh
claude mcp add --transport http annotate-dom http://localhost:4747/mcp
```

The daemon only accepts WebSocket connections from this extension (its id comes from the `key` in `public/manifest.json`; override with `ANNOTATE_DOM_EXTENSION_ID`). Set `ANNOTATE_DOM_PORT` to listen elsewhere.

### Send

While the daemon is connected the overlay's main button reads "Send". Clicking it writes the batch into the project the page belongs to, at `<project>/.annotations/<YYYY-MM-DD-HHmm>-<page>/`, with `batch.json`, `batch.md` and the PNGs, then copies `Fix the annotations in .annotations/<folder>/` to the clipboard. Nothing is downloaded. The folder is added to the repo's `info/exclude`, so git ignores it. When the daemon is stopped the button reads "Copy all" and works as described above.

### MCP tools

Pass your working directory as `project`.

| Tool | Does |
|---|---|
| `list_annotations` | Open pins, newest batch first. `status: "resolved"` lists the finished ones. |
| `get_annotation` | One pin in full, with absolute paths to its screenshots. Ids look like `2026-10-27-1405-settings#1`. |
| `resolve_annotation` | Marks a pin resolved with a one-line summary. |
| `recapture` | Re-finds the element in the running app and returns the before and after images, a style diff and whether the HTML changed. Uses the open tab on that URL, or opens one in the background and closes it. |

### Pin fields

Besides the note, screenshot and React sources, each pin records:

- excerpts of the code around its call sites, read from disk
- console errors, failed requests and slow requests from the 30 seconds before the pin (localhost pages only)
- TanStack Query keys with status and data shape, never data values
- focused element, hovered element, open dialogs and URL search params
- design tokens that match its computed styles, such as `background-color: rgb(...) = var(--background)`
- role, accessible name, states and axe violations for its subtree
- a Playwright locator, such as `getByRole('button', { name: 'Toggle dark mode' })`

Source locations need a React 19 dev build (Next.js with Turbopack or Vite). Production pages still get DOM metadata and screenshots.

## Develop

```sh
bun run test           # unit tests (Vitest)
bun run test:server    # daemon, MCP and launchd script tests (bun test)
bun run test:e2e       # builds dist-test/ and runs Playwright
```

The Send, button-state and recapture specs serve their own fixture page and start a daemon on port 4747 with a temporary HOME, so stop a running daemon first (they skip when the port is taken). The Copy all spec runs against APP_URL (default http://localhost:3000) and skips when it is not reachable. It pins the theme toggle on granite-inventory-management's `/login`; set `APP_URL` and `APP_ROOT` to point it at another app.
