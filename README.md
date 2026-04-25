# pi-draw

A [pi](https://pi.dev) extension for quickly drawing something and attaching it to the current prompt.

Press `Ctrl+Shift+C` or run `/draw` to open a browser window with a tldraw
infinite canvas. Click **Submit to Pi** to export the current page as a PNG,
save it under `/tmp`, and append the image path to the current pi prompt as an
`@/tmp/...png` attachment.

The browser window can stay open. Every time you click **Submit to Pi**, pi
receives a fresh screenshot path in the active prompt. If you close the browser
window, press `Ctrl+Shift+C` or run `/draw` again to reopen it.

## Install

```bash
pi install https://github.com/earendil-works/pi-draw
```

For local development from this checkout:

```bash
pi -e ./draw.ts
```

Or install this directory as a local pi package:

```bash
pi install .
```

## Usage

- `Ctrl+Shift+C` — open the drawing canvas.
- `/draw` — fallback command for terminals that intercept `Ctrl+Shift+C`.
- **Submit to Pi** — save the canvas as a PNG in `/tmp` and append its `@path` to the current prompt.

## Notes

- The local server is started lazily on first use.
- The server binds to `127.0.0.1` on a random free port.
- Screenshots are written to `/tmp/pi-draw-*.png`.
- The tldraw web UI is loaded from public CDNs (`esm.sh` and `unpkg.com`).
