# tmux-web

[English](README.md)

`tmux-web` 是一个用于在浏览器中使用 tmux 的轻量 Web 网关，直接从浏览器访问服务器上的 tmux 会话，并大量优化移动端的体验。

## 功能

- 创建、重命名、切换、刷新和关闭 tmux session。
- 以标签页形式查看 tmux window，创建、关闭、切换 window。
- 分割、切换、缩放 Pane、轮换布局，移动端有 `Panes List` 方便切换。
- 为移动端提供粘滞按键：`Esc`、`Tab`、`Ctrl`、`Alt`、`Shift`、`Enter`
  和方向键。
- 自动适配浏览器窗口，掉线自动重连。
- 支持浅色、深色、自动或自定义 JSON 主题，可配置 UI、终端配色和 tmux pane
  边框颜色。
- 支持 `tsz` 和 `trz` 文件传输。

## 运行要求

- 部署 `tmux-web` 的机器上需要安装 `tmux`。

## 快速开始

先构建前端，再运行 Rust 服务端：

```sh
tmux-web --host 127.0.0.1 --port 8082 --theme auto
```

服务启动后会打印类似下面的输出：

```text
tmux-web listening on http://127.0.0.1:8082
tmux-web token: <token>
```

如果没有设置 token 参数，每次服务启动都会生成一个新的 token。

构建 release 二进制：

```sh
npm install
npm run build
cargo build --release
./target/release/tmux-web --host 127.0.0.1 --port 8082
```

按 `Ctrl+g` 切换命令模式。在命令模式下：

- `s` 打开 session 命令。
- `w` 打开 window 命令。
- `p` 打开 pane 命令。
- `?` 打开帮助。
- `Esc` 或 `q` 关闭当前子菜单。
- `b` 向 tmux 发送 `Ctrl+b`，然后回到锁定模式。

内置 pane 和 window 命令只支持 tmux 默认的 `Ctrl+b` 前缀。如果修改了 tmux prifix 按键，则命令栏的命令将会失效。

在移动端或触摸设备上，命令栏中存在 `Esc`、`Tab`、`Ctrl`、`Alt`、`Shift`、`Enter` 等粘滞键开关和Panes List 按钮，方便快速切换 Pane。

## 配置

```sh
TMUX_WEB_HOST=0.0.0.0 TMUX_WEB_PORT=8082 TMUX_WEB_THEME=light cargo run
```

| 选项 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--host` | `TMUX_WEB_HOST` | `127.0.0.1` | HTTP 绑定地址，别名 `--listen`。 |
| `--port` | `TMUX_WEB_PORT` | `8082` | HTTP 端口。 |
| `--theme` | `TMUX_WEB_THEME` | `auto` | `auto`、`dark`、`light`，或一个 JSON 主题文件路径。 |
| `--tmux` | | `tmux` | tmux 可执行文件路径。 |
| `--socket-path` | | | 传给 `tmux -S` 的 tmux socket 路径。 |
| `--token` | `TMUX_WEB_TOKEN` | 自动生成 | 登录 token。省略时，tmux-web 会在启动时打印一个新 token。 |
| `--token-file` | `TMUX_WEB_TOKEN_FILE` | | 从文件读取登录 token。 |
| `--static-dir` | | 嵌入资源 | 从改目录加载前端文件，而不是使用内嵌的。 |

示例：

如果你是从源码运行，可以把下面示例中的 `tmux-web` 替换为 `cargo run --`。

```sh
# 监听所有网卡，并使用固定 token。
TMUX_WEB_TOKEN='change-me' tmux-web --host 0.0.0.0 --port 8082

# 使用非默认 tmux 可执行文件和 socket。
tmux-web --tmux /usr/local/bin/tmux --socket-path /tmp/tmux-custom

# 避免 token 出现在进程参数中。
tmux-web --token-file /etc/tmux-web/token
```

## 主题

内置了 `light` 和 `dark` 两套主题，支持 `auto` 跟随浏览器系统主题自动切换。

覆盖内置的 `dark` 或 `light` 部分配色：

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

自定义主题：

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

使用 theme 文件启动：

```sh
tmux-web --theme ./my-theme.json
```

## 部署注意事项

- 使用反向代理需要配置 websocket。
