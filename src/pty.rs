use crate::tmux::{validate_session_name, TmuxConfig, TmuxPaneBorderTheme};
use anyhow::{Context, Result};
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, PtySize};
use serde::Deserialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
};
use tokio::sync::mpsc;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientTerminalMessage {
    Attach {
        cols: u16,
        rows: u16,
        client_kind: ClientKind,
        pane_border_theme: Option<TmuxPaneBorderTheme>,
    },
    Input {
        data: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    ClientActivity,
    SetPaneBorderTheme {
        pane_border_theme: TmuxPaneBorderTheme,
    },
    GetZoom {
        request_id: String,
    },
    SetZoom {
        request_id: String,
        zoomed: bool,
        managed: Option<bool>,
    },
    ClearAutoZoom {
        request_id: String,
    },
    ListPanes {
        request_id: String,
        window_id: String,
    },
    SelectPane {
        request_id: String,
        window_id: String,
        pane_id: String,
    },
    ListWindows {
        request_id: String,
    },
    CreateWindow {
        request_id: String,
        name: Option<String>,
    },
    SelectWindow {
        request_id: String,
        window_id: String,
    },
    KillWindow {
        request_id: String,
        window_id: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ClientKind {
    Mobile,
    Desktop,
}

impl ClientKind {
    fn should_zoom(self) -> bool {
        matches!(self, Self::Mobile)
    }
}

impl ClientTerminalMessage {
    fn request_id(&self) -> Option<&str> {
        match self {
            Self::GetZoom { request_id }
            | Self::SetZoom { request_id, .. }
            | Self::ClearAutoZoom { request_id }
            | Self::ListPanes { request_id, .. }
            | Self::SelectPane { request_id, .. }
            | Self::ListWindows { request_id }
            | Self::CreateWindow { request_id, .. }
            | Self::SelectWindow { request_id, .. }
            | Self::KillWindow { request_id, .. } => Some(request_id),
            Self::Attach { .. }
            | Self::Input { .. }
            | Self::Resize { .. }
            | Self::ClientActivity
            | Self::SetPaneBorderTheme { .. } => None,
        }
    }
}

#[derive(Clone, Copy)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl TerminalSize {
    pub fn clamped(cols: u16, rows: u16) -> Self {
        Self {
            cols: cols.clamp(20, 500),
            rows: rows.clamp(5, 200),
        }
    }
}

#[derive(Clone)]
struct AttachInfo {
    size: TerminalSize,
    client_kind: ClientKind,
    pane_border_theme: TmuxPaneBorderTheme,
}

#[derive(Clone, Default)]
pub struct TransferRegistry {
    inner: Arc<Mutex<HashMap<String, mpsc::Sender<Vec<u8>>>>>,
}

impl TransferRegistry {
    pub fn register(&self, id: &str, tx: mpsc::Sender<Vec<u8>>) -> Result<()> {
        validate_transfer_id(id)?;
        let mut transfers = self.inner.lock().expect("transfer registry lock poisoned");
        if transfers.contains_key(id) {
            return Err(anyhow::anyhow!("transfer id is already registered"));
        }
        transfers.insert(id.to_string(), tx);
        Ok(())
    }

    pub fn unregister(&self, id: &str) {
        if let Ok(mut transfers) = self.inner.lock() {
            transfers.remove(id);
        }
    }

    fn sender(&self, id: &str) -> Option<mpsc::Sender<Vec<u8>>> {
        if validate_transfer_id(id).is_err() {
            return None;
        }
        let transfers = self.inner.lock().ok()?;
        transfers.get(id).cloned()
    }
}

fn validate_transfer_id(id: &str) -> Result<()> {
    if id.len() < 16 || id.len() > 128 {
        return Err(anyhow::anyhow!("invalid transfer id"));
    }
    if !id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(anyhow::anyhow!("invalid transfer id"));
    }
    Ok(())
}

pub async fn run_terminal(
    socket: WebSocket,
    tmux: TmuxConfig,
    transfers: TransferRegistry,
    session_name: String,
    size: TerminalSize,
    transfer_id: Option<String>,
) {
    if let Err(error) =
        run_terminal_inner(socket, tmux, transfers, session_name, size, transfer_id).await
    {
        eprintln!("terminal websocket failed: {error:#}");
    }
}

async fn run_terminal_inner(
    mut socket: WebSocket,
    tmux: TmuxConfig,
    transfers: TransferRegistry,
    session_name: String,
    size: TerminalSize,
    transfer_id: Option<String>,
) -> Result<()> {
    validate_session_name(&session_name)?;
    let attach = wait_for_attach(&mut socket, size).await?;
    let mut pane_border_theme = attach.pane_border_theme.clone();
    if let Err(error) = tmux
        .apply_pane_border_theme_to_session_windows(&session_name, &pane_border_theme)
        .await
    {
        eprintln!("failed to apply pane border theme before attach: {error:#}");
    }
    apply_responsive_layout_for_client(&tmux, &session_name, attach.client_kind).await?;
    let size = attach.size;
    let default_client_kind = attach.client_kind;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: size.rows,
            cols: size.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("failed to open PTY")?;

    let command = tmux.attach_command(&session_name);
    let mut child = pair
        .slave
        .spawn_command(command)
        .context("failed to spawn tmux attach-session")?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .context("failed to clone PTY reader")?;
    let mut writer = pair
        .master
        .take_writer()
        .context("failed to take PTY writer")?;
    let master = pair.master;

    let (pty_tx, mut pty_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    if pty_tx.send(buffer[..read].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let (transfer_tx, mut transfer_rx) = mpsc::channel::<Vec<u8>>(128);
    let registered_transfer_id = match transfer_id {
        Some(id) => {
            transfers.register(&id, transfer_tx)?;
            Some(id)
        }
        None => None,
    };

    let (mut ws_tx, mut ws_rx) = socket.split();
    loop {
        tokio::select! {
            biased;
            Some(message) = ws_rx.next() => {
                let Ok(message) = message else { break };
                match message {
                    Message::Text(text) => {
                        let parsed = serde_json::from_str::<ClientTerminalMessage>(&text);
                        match parsed {
                            Ok(ClientTerminalMessage::Input { data }) => {
                                if let Err(error) = apply_responsive_layout_for_client(
                                    &tmux,
                                    &session_name,
                                    default_client_kind,
                                )
                                .await
                                {
                                    eprintln!("failed to apply responsive layout before input: {error:#}");
                                }
                                if writer.write_all(data.as_bytes()).is_err() {
                                    break;
                                }
                                let _ = writer.flush();
                            }
                            Ok(ClientTerminalMessage::Resize { cols, rows }) => {
                                if let Err(error) = apply_responsive_layout_for_client(
                                    &tmux,
                                    &session_name,
                                    default_client_kind,
                                )
                                .await
                                {
                                    eprintln!("failed to apply responsive layout before resize: {error:#}");
                                }
                                let size = TerminalSize::clamped(cols, rows);
                                let _ = master.resize(PtySize {
                                    rows: size.rows,
                                    cols: size.cols,
                                    pixel_width: 0,
                                    pixel_height: 0,
                                });
                            }
                            Ok(ClientTerminalMessage::Attach { .. }) => {}
                            Ok(message) => {
                                if let Some(response) = control_response(
                                    &tmux,
                                    &session_name,
                                    default_client_kind,
                                    &mut pane_border_theme,
                                    message,
                                )
                                .await
                                {
                                    if ws_tx.send(Message::Text(response.into())).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            Err(_) => {}
                        }
                    }
                    Message::Binary(bytes) => {
                        if let Err(error) = apply_responsive_layout_for_client(
                            &tmux,
                            &session_name,
                            default_client_kind,
                        )
                        .await
                        {
                            eprintln!("failed to apply responsive layout before binary input: {error:#}");
                        }
                        if writer.write_all(&bytes).is_err() {
                            break;
                        }
                        let _ = writer.flush();
                    }
                    Message::Ping(bytes) => {
                        let _ = ws_tx.send(Message::Pong(bytes)).await;
                    }
                    Message::Close(_) => break,
                    Message::Pong(_) => {}
                }
            }
            Some(bytes) = pty_rx.recv() => {
                if ws_tx.send(Message::Binary(bytes.into())).await.is_err() {
                    break;
                }
            }
            Some(bytes) = transfer_rx.recv() => {
                if writer.write_all(&bytes).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
            else => break,
        }
    }

    if let Some(id) = registered_transfer_id {
        transfers.unregister(&id);
    }
    let _ = child.kill();
    Ok(())
}

pub async fn run_trzsz_transfer(
    mut socket: WebSocket,
    transfers: TransferRegistry,
    transfer_id: String,
) {
    let Some(tx) = transfers.sender(&transfer_id) else {
        let _ = socket.send(Message::Close(None)).await;
        return;
    };

    while let Some(message) = socket.next().await {
        let Ok(message) = message else { break };
        match message {
            Message::Text(text) => {
                if tx.send(text.as_bytes().to_vec()).await.is_err() {
                    break;
                }
            }
            Message::Binary(bytes) => {
                if tx.send(bytes.to_vec()).await.is_err() {
                    break;
                }
            }
            Message::Ping(bytes) => {
                let _ = socket.send(Message::Pong(bytes)).await;
            }
            Message::Close(_) => break,
            Message::Pong(_) => {}
        }
    }
}

async fn wait_for_attach(
    socket: &mut WebSocket,
    fallback_size: TerminalSize,
) -> Result<AttachInfo> {
    let mut size = fallback_size;
    loop {
        let Some(message) = socket.next().await else {
            return Err(anyhow::anyhow!("terminal websocket closed before attach"));
        };
        let message = message.context("failed to read terminal websocket message")?;
        match message {
            Message::Text(text) => {
                let parsed = serde_json::from_str::<ClientTerminalMessage>(&text);
                match parsed {
                    Ok(ClientTerminalMessage::Attach {
                        cols,
                        rows,
                        client_kind,
                        pane_border_theme,
                    }) => {
                        return Ok(AttachInfo {
                            size: TerminalSize::clamped(cols, rows),
                            client_kind,
                            pane_border_theme: pane_border_theme.unwrap_or_default(),
                        });
                    }
                    Ok(ClientTerminalMessage::Resize { cols, rows }) => {
                        size = TerminalSize::clamped(cols, rows);
                    }
                    Ok(ClientTerminalMessage::Input { .. }) => {}
                    Ok(message) => {
                        if let Some(request_id) = message.request_id() {
                            let response = control_error_message(
                                request_id,
                                "terminal attach must be sent before control messages",
                            );
                            if socket.send(Message::Text(response.into())).await.is_err() {
                                return Err(anyhow::anyhow!(
                                    "terminal websocket closed before attach"
                                ));
                            }
                        }
                    }
                    Err(_) => {}
                }
            }
            Message::Ping(bytes) => {
                let _ = socket.send(Message::Pong(bytes)).await;
            }
            Message::Close(_) => {
                return Err(anyhow::anyhow!("terminal websocket closed before attach"));
            }
            Message::Binary(_) | Message::Pong(_) => {}
        }
        if size.cols == 0 || size.rows == 0 {
            size = fallback_size;
        }
    }
}

async fn control_response(
    tmux: &TmuxConfig,
    session_name: &str,
    default_client_kind: ClientKind,
    pane_border_theme: &mut TmuxPaneBorderTheme,
    message: ClientTerminalMessage,
) -> Option<String> {
    match message {
        ClientTerminalMessage::ClientActivity => {
            if let Err(error) =
                apply_responsive_layout_for_client(tmux, session_name, default_client_kind).await
            {
                eprintln!("failed to apply responsive layout for client activity: {error:#}");
            }
            None
        }
        ClientTerminalMessage::SetPaneBorderTheme {
            pane_border_theme: theme,
        } => {
            *pane_border_theme = theme;
            if let Err(error) = tmux
                .apply_pane_border_theme_to_session_windows(session_name, pane_border_theme)
                .await
            {
                eprintln!("failed to apply pane border theme: {error:#}");
            }
            None
        }
        ClientTerminalMessage::GetZoom { request_id } => {
            let response = match tmux.window_zoomed(session_name).await {
                Ok(zoomed) => control_ok(&request_id, serde_json::json!({ "zoomed": zoomed })),
                Err(error) => control_error(&request_id, &error),
            };
            Some(response)
        }
        ClientTerminalMessage::SetZoom {
            request_id,
            zoomed,
            managed,
        } => {
            let result = if managed.unwrap_or(false) {
                tmux.set_responsive_window_zoomed(session_name, zoomed)
                    .await
            } else {
                tmux.set_window_zoomed(session_name, zoomed).await
            };
            let response = match result {
                Ok(zoomed) => control_ok(&request_id, serde_json::json!({ "zoomed": zoomed })),
                Err(error) => control_error(&request_id, &error),
            };
            Some(response)
        }
        ClientTerminalMessage::ClearAutoZoom { request_id } => {
            let response = match tmux.clear_responsive_window_zoomed(session_name).await {
                Ok(()) => control_ok(&request_id, serde_json::json!({})),
                Err(error) => control_error(&request_id, &error),
            };
            Some(response)
        }
        ClientTerminalMessage::ListPanes {
            request_id,
            window_id,
        } => {
            let result = async {
                apply_responsive_layout_for_client(tmux, session_name, default_client_kind).await?;
                tmux.list_panes_for_window(session_name, &window_id).await
            }
            .await;
            let response = match result {
                Ok(panes) => control_ok(&request_id, serde_json::json!({ "panes": panes })),
                Err(error) => control_error(&request_id, &error),
            };
            Some(response)
        }
        ClientTerminalMessage::SelectPane {
            request_id,
            window_id,
            pane_id,
        } => {
            let result = async {
                if !default_client_kind.should_zoom() {
                    apply_responsive_layout_for_client(tmux, session_name, default_client_kind)
                        .await?;
                }
                let pane = tmux
                    .select_pane_in_window(session_name, &window_id, &pane_id)
                    .await?;
                if default_client_kind.should_zoom() {
                    apply_responsive_layout_for_client(tmux, session_name, default_client_kind)
                        .await?;
                }
                Ok(pane)
            }
            .await;
            let response = match result {
                Ok(pane) => control_ok(&request_id, serde_json::json!({ "pane": pane })),
                Err(error) => control_error(&request_id, &error),
            };
            Some(response)
        }
        ClientTerminalMessage::ListWindows { request_id } => {
            let result = async {
                apply_responsive_layout_for_client(tmux, session_name, default_client_kind).await?;
                tmux.list_windows(session_name).await
            }
            .await;
            let response = match result {
                Ok(windows) => control_ok(&request_id, serde_json::json!({ "windows": windows })),
                Err(error) => control_error(&request_id, &error),
            };
            Some(response)
        }
        ClientTerminalMessage::CreateWindow { request_id, name } => {
            let result = async {
                if !default_client_kind.should_zoom() {
                    apply_responsive_layout_for_client(tmux, session_name, default_client_kind)
                        .await?;
                }
                let window = tmux.create_window(session_name, name).await?;
                tmux.apply_pane_border_theme_to_window(&window.id, pane_border_theme)
                    .await?;
                if default_client_kind.should_zoom() {
                    apply_responsive_layout_for_client(tmux, session_name, default_client_kind)
                        .await?;
                }
                Ok(window)
            }
            .await;
            let response = match result {
                Ok(window) => control_ok(&request_id, serde_json::json!({ "window": window })),
                Err(error) => control_error(&request_id, &error),
            };
            Some(response)
        }
        ClientTerminalMessage::SelectWindow {
            request_id,
            window_id,
        } => {
            let result = async {
                if !default_client_kind.should_zoom() {
                    apply_responsive_layout_for_client(tmux, session_name, default_client_kind)
                        .await?;
                }
                let window = tmux.select_window(session_name, &window_id).await?;
                tmux.apply_pane_border_theme_to_window(&window.id, pane_border_theme)
                    .await?;
                if default_client_kind.should_zoom() {
                    apply_responsive_layout_for_client(tmux, session_name, default_client_kind)
                        .await?;
                }
                Ok(window)
            }
            .await;
            let response = match result {
                Ok(window) => control_ok(&request_id, serde_json::json!({ "window": window })),
                Err(error) => control_error(&request_id, &error),
            };
            Some(response)
        }
        ClientTerminalMessage::KillWindow {
            request_id,
            window_id,
        } => {
            let result = async {
                if !default_client_kind.should_zoom() {
                    apply_responsive_layout_for_client(tmux, session_name, default_client_kind)
                        .await?;
                }
                tmux.kill_window(session_name, &window_id).await?;
                if default_client_kind.should_zoom() {
                    let _ =
                        apply_responsive_layout_for_client(tmux, session_name, default_client_kind)
                            .await;
                }
                Ok(())
            }
            .await;
            let response = match result {
                Ok(()) => control_ok(&request_id, serde_json::json!({})),
                Err(error) => control_error(&request_id, &error),
            };
            Some(response)
        }
        ClientTerminalMessage::Attach { .. }
        | ClientTerminalMessage::Input { .. }
        | ClientTerminalMessage::Resize { .. } => None,
    }
}

async fn apply_responsive_layout_for_client(
    tmux: &TmuxConfig,
    session_name: &str,
    client_kind: ClientKind,
) -> Result<()> {
    tmux.set_responsive_window_zoomed(session_name, client_kind.should_zoom())
        .await?;
    Ok(())
}

fn control_ok(request_id: &str, data: serde_json::Value) -> String {
    serde_json::json!({
        "type": "terminal_response",
        "request_id": request_id,
        "ok": true,
        "data": data,
    })
    .to_string()
}

fn control_error(request_id: &str, error: &anyhow::Error) -> String {
    control_error_message(request_id, &error.to_string())
}

fn control_error_message(request_id: &str, error: &str) -> String {
    serde_json::json!({
        "type": "terminal_response",
        "request_id": request_id,
        "ok": false,
        "error": error,
    })
    .to_string()
}
