# tmux-web

`tmux-web` is a sidecar web gateway for tmux. It keeps tmux itself unchanged and
opens real `tmux attach-session` clients behind a browser terminal.

## Build

```sh
npm install
npm run build
cargo run -- --host 127.0.0.1 --port 8082 --theme dark
```

`cargo build` embeds the generated `assets/dist` frontend into the Rust binary.
Run `npm run build` again before rebuilding Rust whenever the web UI changes.

The server prints a one-time token on startup. Open the printed URL and log in
with that token.

## Configuration

```sh
TMUX_WEB_HOST=0.0.0.0 TMUX_WEB_PORT=8082 TMUX_WEB_THEME=light cargo run
```

- `--host` configures the HTTP bind address. `--listen` remains supported as an
  alias-compatible legacy name.
- `--port` configures the HTTP port.
- `--theme` accepts `dark` or `light` and controls the web UI and terminal color
  palette.
- `--static-dir` serves frontend files from a directory instead of the embedded
  assets. This is mainly useful while iterating on local frontend builds.

## Notes

- HTTP is the default. Put `tmux-web` behind nginx, Caddy, SSH tunneling, or
  another trusted reverse proxy when you need HTTPS.
- `@xterm/xterm` and `@xterm/addon-fit` are standard npm dependencies, so xterm
  upgrades are handled through `package.json`.
- Session names created or managed by the UI are limited to letters, numbers,
  `.`, `_`, and `-`.
