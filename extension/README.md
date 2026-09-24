# Variational Session Exporter

Unofficial Manifest V3 extension that turns the session you already have in your browser
into a `session.json` the client in this repo can load. No private key, no DevTools.

Full guide (what it reads, permissions, the push contract): [docs/EXTENSION.md](../docs/EXTENSION.md).

## Build and load

```bash
pnpm build:extension     # from the repo root; or `pnpm build` inside extension/
```

Then `chrome://extensions` → **Developer mode** → **Load unpacked** → `extension/dist`.

## Use

Sign in at <https://omni.variational.io>, open the popup, then **Copy session JSON** or
**Download session.json**. Both are disabled while you are signed out or the session has
expired. **Push to server** is optional and off by default.

The exported file is a live login for your account. Keep it out of git, chats and
screenshots.

## Layout

| path | what |
|---|---|
| `src/background/` | Service worker: reads the cookies and `GET /api/me`, runs the optional push. |
| `src/popup/` | Popup UI, and the Copy / Download helpers. |
| `src/shared/` | Pure logic: cookie filtering, the bundle format, JWT claims, status, settings. |
| `public/` | Manifest, popup markup and styles, icons (regenerate with `pnpm icons`). |
| `scripts/build.mjs` | esbuild bundle into `dist/`. |

```bash
pnpm typecheck && pnpm test   # inside extension/, or `pnpm test:extension` from the root; chrome.* is faked
```
