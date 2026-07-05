# tmux-web

`tmux-web` is a sidecar web gateway for tmux. It keeps tmux itself unchanged and
opens real `tmux attach-session` clients behind a browser terminal.

## Build

```sh
npm install
npm run build
cargo run -- --host 127.0.0.1 --port 8082 --theme auto
```

`cargo build` embeds the generated `assets/dist` frontend into the Rust binary.
Compressible embedded assets are stored as pre-compressed gzip bytes and served
with `Content-Encoding: gzip`. Run `npm run build` again before rebuilding Rust
whenever the web UI changes. Frontend source lives in `web-src/`; Vite writes
the production bundle to `assets/dist`.

The server prints a one-time token on startup. Open the printed URL and log in
with that token.

## Configuration

```sh
TMUX_WEB_HOST=0.0.0.0 TMUX_WEB_PORT=8082 TMUX_WEB_THEME=light cargo run
```

- `--host` configures the HTTP bind address. `--listen` remains supported as an
  alias-compatible legacy name.
- `--port` configures the HTTP port.
- `--theme` accepts `auto`, `dark`, `light`, or a JSON theme file path. The
  default is `auto`. `TMUX_WEB_THEME` uses the same values.
- `--static-dir` serves frontend files from a directory instead of the embedded
  assets. This is mainly useful while iterating on local frontend builds.

Built-in UI CSS variables, xterm palettes, and tmux pane border styles live in
`web-src/styles/theme.css`.

Theme files use a top-level `theme` selector. `auto` follows the browser system theme and can partially override built-in `dark` or `light` definitions:

```json
{
  "theme": "auto",
  "light": {
    "ui": {
      "--bg": "#eff1f5"
    },
    "terminal": {
      "background": "#eff1f5",
      "foreground": "#4c4f69"
    },
    "tmux": {
      "paneBorderStyle": "fg=#bcc0cc",
      "paneActiveBorderStyle": "fg=#179299"
    }
  }
}
```

Custom theme names must have a matching top-level definition and are applied as provided:

```json
{
  "theme": "my-theme",
  "my-theme": {
    "ui": {
      "--bg": "#111111",
      "--panel": "#181818",
      "--text": "#eeeeee"
    },
    "terminal": {
      "background": "#111111",
      "foreground": "#eeeeee",
      "cursor": "#ffcc66"
    }
  }
}
```

## Notes

- HTTP is the default. Put `tmux-web` behind nginx, Caddy, SSH tunneling, or
  another trusted reverse proxy when you need HTTPS.
- `@xterm/xterm` and `@xterm/addon-fit` are standard npm dependencies, so xterm
  upgrades are handled through `package.json`.
- Session names created or managed by the UI are limited to letters, numbers,
  `.`, `_`, and `-`.
