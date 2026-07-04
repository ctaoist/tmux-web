use crate::tmux::{validate_session_name, TmuxConfig};
use anyhow::{Context, Result};
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, PtySize};
use serde::Deserialize;
use std::{
    io::{Read, Write},
    thread,
};
use tokio::sync::mpsc;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientTerminalMessage {
    Attach {
        cols: u16,
        rows: u16,
    },
    Input {
        data: String,
    },
    Resize {
        cols: u16,
        rows: u16,
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

pub async fn run_terminal(
    socket: WebSocket,
    tmux: TmuxConfig,
    session_name: String,
    size: TerminalSize,
) {
    if let Err(error) = run_terminal_inner(socket, tmux, session_name, size).await {
        eprintln!("terminal websocket failed: {error:#}");
    }
}

async fn run_terminal_inner(
    mut socket: WebSocket,
    tmux: TmuxConfig,
    session_name: String,
    size: TerminalSize,
) -> Result<()> {
    validate_session_name(&session_name)?;
    let size = wait_for_attach(&mut socket, &tmux, &session_name, size).await?;

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

    let (mut ws_tx, mut ws_rx) = socket.split();
    loop {
        tokio::select! {
            Some(bytes) = pty_rx.recv() => {
                if ws_tx.send(Message::Binary(bytes.into())).await.is_err() {
                    break;
                }
            }
            Some(message) = ws_rx.next() => {
                let Ok(message) = message else { break };
                match message {
                    Message::Text(text) => {
                        let parsed = serde_json::from_str::<ClientTerminalMessage>(&text);
                        match parsed {
                            Ok(ClientTerminalMessage::Input { data }) => {
                                if writer.write_all(data.as_bytes()).is_err() {
                                    break;
                                }
                                let _ = writer.flush();
                            }
                            Ok(ClientTerminalMessage::Resize { cols, rows }) => {
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
                                if let Some(response) =
                                    control_response(&tmux, &session_name, message).await
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
            else => break,
        }
    }

    let _ = child.kill();
    Ok(())
}

async fn wait_for_attach(
    socket: &mut WebSocket,
    tmux: &TmuxConfig,
    session_name: &str,
    fallback_size: TerminalSize,
) -> Result<TerminalSize> {
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
                    Ok(ClientTerminalMessage::Attach { cols, rows }) => {
                        return Ok(TerminalSize::clamped(cols, rows));
                    }
                    Ok(ClientTerminalMessage::Resize { cols, rows }) => {
                        size = TerminalSize::clamped(cols, rows);
                    }
                    Ok(ClientTerminalMessage::Input { .. }) => {}
                    Ok(message) => {
                        if let Some(response) = control_response(tmux, session_name, message).await
                        {
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
    message: ClientTerminalMessage,
) -> Option<String> {
    match message {
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
            let response = match tmux.list_panes_for_window(session_name, &window_id).await {
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
            let response = match tmux
                .select_pane_in_window(session_name, &window_id, &pane_id)
                .await
            {
                Ok(pane) => control_ok(&request_id, serde_json::json!({ "pane": pane })),
                Err(error) => control_error(&request_id, &error),
            };
            Some(response)
        }
        ClientTerminalMessage::Attach { .. }
        | ClientTerminalMessage::Input { .. }
        | ClientTerminalMessage::Resize { .. } => None,
    }
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
    serde_json::json!({
        "type": "terminal_response",
        "request_id": request_id,
        "ok": false,
        "error": error.to_string(),
    })
    .to_string()
}
