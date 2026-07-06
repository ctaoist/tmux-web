# tmux-web

[简体中文](README_CN.md)

`tmux-web` is a lightweight web gateway for using tmux in a browser. It lets you
access tmux sessions on a server directly from the browser, with extra attention
paid to the mobile experience.

## Features

- Create, rename, switch, refresh, and kill tmux sessions.
- View tmux windows as tabs, and create, close, and switch windows.
- Split, switch, and zoom panes, cycle layouts, and use `Panes List` on mobile
  for convenient pane switching.
- Use mobile-friendly sticky keys for `Esc`, `Tab`, `Ctrl`, `Alt`, `Shift`,
  `Enter`, and arrow keys.
- Automatically fit the browser window and reconnect after disconnection.
- Use light, dark, auto, or custom JSON themes for the UI, terminal palette, and
  tmux pane border colors.
- Support `tsz` and `trz` file transfers.

## Requirements

- `tmux` must be installed on the machine where `tmux-web` is deployed.

## Quick Start

Run the server:

```sh
tmux-web --host 127.0.0.1 --port 8082 --theme auto
```

The server prints output similar to:

```text
tmux-web listening on http://127.0.0.1:8082
tmux-web token: <token>
```

If no token is configured, a new token is generated on every server start.

Build a release binary:

```sh
npm install
npm run build
cargo build --release
./target/release/tmux-web --host 127.0.0.1 --port 8082
```

Press `Ctrl+g` to toggle command mode. In command mode:

- `s` opens session commands.
- `w` opens window commands.
- `p` opens pane commands.
- `?` opens help.
- `Esc` or `q` closes the current submenu.
- `b` sends `Ctrl+b` to tmux and returns to locked mode.

The built-in pane and window commands only support tmux's default `Ctrl+b`
prefix. If you changed the tmux prefix key, command bar commands will stop
working.

On mobile or touch devices, the command bar includes sticky key toggles such as
`Esc`, `Tab`, `Ctrl`, `Alt`, `Shift`, and `Enter`, plus a `Panes List` button for
quick pane switching.

## Configuration

```sh
TMUX_WEB_HOST=0.0.0.0 TMUX_WEB_PORT=8082 TMUX_WEB_THEME=light cargo run
```

| Option | Environment | Default | Description |
| --- | --- | --- | --- |
| `--host` | `TMUX_WEB_HOST` | `127.0.0.1` | HTTP bind address, with `--listen` as an alias. |
| `--port` | `TMUX_WEB_PORT` | `8082` | HTTP port. |
| `--theme` | `TMUX_WEB_THEME` | `auto` | `auto`, `dark`, `light`, or a JSON theme file path. |
| `--tmux` | | `tmux` | Path to the tmux executable. |
| `--socket-path` | | | tmux socket path passed to `tmux -S`. |
| `--token` | `TMUX_WEB_TOKEN` | generated | Login token. If omitted, tmux-web prints a new startup token. |
| `--token-file` | `TMUX_WEB_TOKEN_FILE` | | Read the login token from a file. |
| `--static-dir` | | embedded assets | Load frontend files from this directory instead of the embedded bundle. |

Examples:

If you are running from source, replace `tmux-web` in these examples with
`cargo run --`.

```sh
# Listen on all interfaces with a fixed token.
TMUX_WEB_TOKEN='change-me' tmux-web --host 0.0.0.0 --port 8082

# Use a non-default tmux binary and socket.
tmux-web --tmux /usr/local/bin/tmux --socket-path /tmp/tmux-custom

# Keep the token outside the process list.
tmux-web --token-file /etc/tmux-web/token
```

## Themes

tmux-web includes built-in `light` and `dark` themes. `auto` follows the
browser's system theme automatically.

Override part of the built-in `dark` or `light` theme:

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

Custom theme:

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
    },
    "tmux": {
      "paneBorderStyle": "fg=#bcc0cc",
      "paneActiveBorderStyle": "fg=#179299"
    }
  }
}
```

Run with a theme file:

```sh
tmux-web --theme ./my-theme.json
```

## Deployment Notes

- Configure websocket support when using a reverse proxy.
