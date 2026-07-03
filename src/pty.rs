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
    Input { data: String },
    Resize { cols: u16, rows: u16 },
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
    socket: WebSocket,
    tmux: TmuxConfig,
    session_name: String,
    size: TerminalSize,
) -> Result<()> {
    validate_session_name(&session_name)?;

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
