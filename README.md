# tmux-web

[简体中文](README_CN.md)

`tmux-web` is a lightweight web gateway for using tmux in a browser. It lets you
access tmux sessions on a server directly from the browser, with extra attention
paid to the mobile experience.

## Features

- Create, rename, switch, refresh, and kill tmux sessions.
- View tmux windows as tabs, and create, close, and switch windows.
- Receive live session and window updates over WebSocket, including renames and exits.
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

## Automatic Update Script

[`scripts/auto-update.sh`](scripts/auto-update.sh) can be invoked periodically by
cron or a systemd timer. It checks the latest stable GitHub release and, only
when that version is newer, downloads and verifies the existing `.tar.gz`
release asset before atomically replacing the tmux-web binary. Apart from the
optional restart command, it does not modify service configuration or other
files.

```sh
TMUX_WEB_BINARY=/usr/local/bin/tmux-web \
TMUX_WEB_RESTART_ENABLED=true \
TMUX_WEB_RESTART_COMMAND='systemctl restart tmux-web' \
./scripts/auto-update.sh
```

| Environment | Default | Description |
| --- | --- | --- |
| `TMUX_WEB_BINARY` | `tmux-web` from `PATH` | Binary to check and replace; symlinks resolve to their target. |
| `TMUX_WEB_RESTART_ENABLED` | `false` | Run the restart command after an update. Accepts `true/false`, `1/0`, `yes/no`, or `on/off`. |
| `TMUX_WEB_RESTART_COMMAND` | empty | Required when restart is enabled and executed through `/bin/sh -c`. |

The script is compatible with OpenWrt BusyBox and requires `curl`, `tar`,
`sha256sum`, `awk`, a `sort` implementation with `-V`, `stat`, and common BusyBox
tools. The restart command runs only after the binary is actually replaced; it
does not run when checking or verification fails, or when no update is available.
The release workflow injects its input tag into the Rust build through
`APP_VERSION`, so `tmux-web -V` matches the release version; ordinary local builds
continue to report the version from `Cargo.toml`.

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
| `--error-count` | `TMUX_WEB_ERROR_COUNT` | `0` (disabled) | Consecutive invalid token attempts from one peer IP before it is blacklisted. Requires `--black-file`. `--token-error-count` is an alias. |
| `--black-file` | `TMUX_WEB_BLACK_FILE` | | Blacklist file path. One IP address per line; existing entries are loaded and new blacklisted IPs are appended. Requires `--error-count` greater than zero. `--blacklist-file` is an alias. |
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

# Blacklist a peer IP after five consecutive invalid token attempts.
tmux-web --error-count 5 --black-file /var/lib/tmux-web/blacklist
```

The login failure counter uses the TCP peer IP address. A successful login resets
that address's counter; once blacklisted, all subsequent requests from that IP
are rejected. If tmux-web is behind a reverse proxy, it sees the proxy as the
peer, so restrict access at the proxy or run tmux-web directly.

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
