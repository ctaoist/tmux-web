use crate::tmux::{TmuxConfig, TmuxStateSnapshot};
use axum::extract::ws::{Message, WebSocket};
use serde::Serialize;
use std::{sync::Arc, time::Duration};
use tokio::sync::{watch, Notify};

const TMUX_STATE_POLL_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone)]
pub struct TmuxEventHub {
    sender: watch::Sender<Option<Arc<TmuxStateSnapshot>>>,
    wake: Arc<Notify>,
}

#[derive(Serialize)]
struct TmuxStateMessage<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    sessions: &'a [crate::tmux::TmuxSession],
    windows: &'a std::collections::BTreeMap<String, Vec<crate::tmux::TmuxWindow>>,
}

impl TmuxEventHub {
    pub fn new(tmux: TmuxConfig) -> Self {
        let (sender, receiver) = watch::channel(None);
        drop(receiver);
        let wake = Arc::new(Notify::new());
        tokio::spawn(monitor_tmux_state(tmux, sender.clone(), wake.clone()));
        Self { sender, wake }
    }

    fn subscribe(&self) -> watch::Receiver<Option<Arc<TmuxStateSnapshot>>> {
        let receiver = self.sender.subscribe();
        self.sender.send_modify(|_| {});
        self.wake.notify_one();
        receiver
    }
}

pub async fn run_tmux_events(mut socket: WebSocket, hub: TmuxEventHub) {
    let mut receiver = hub.subscribe();

    loop {
        tokio::select! {
            changed = receiver.changed() => {
                if changed.is_err() {
                    break;
                }
                let snapshot = receiver.borrow_and_update().clone();
                let Some(snapshot) = snapshot else {
                    continue;
                };
                let Ok(message) = serialize_snapshot(&snapshot) else {
                    continue;
                };
                if socket.send(Message::Text(message.into())).await.is_err() {
                    break;
                }
            }
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else {
                    break;
                };
                match message {
                    Message::Ping(bytes) => {
                        if socket.send(Message::Pong(bytes)).await.is_err() {
                            break;
                        }
                    }
                    Message::Close(_) => break,
                    Message::Text(_) | Message::Binary(_) | Message::Pong(_) => {}
                }
            }
        }
    }
}

fn serialize_snapshot(snapshot: &TmuxStateSnapshot) -> serde_json::Result<String> {
    serde_json::to_string(&TmuxStateMessage {
        kind: "tmux_state",
        sessions: &snapshot.sessions,
        windows: &snapshot.windows,
    })
}

async fn monitor_tmux_state(
    tmux: TmuxConfig,
    sender: watch::Sender<Option<Arc<TmuxStateSnapshot>>>,
    wake: Arc<Notify>,
) {
    let mut last_error: Option<String> = None;

    loop {
        if sender.receiver_count() == 0 {
            sender.send_if_modified(|snapshot| {
                if snapshot.is_none() {
                    false
                } else {
                    *snapshot = None;
                    true
                }
            });
            wake.notified().await;
            continue;
        }

        match tmux.state_snapshot().await {
            Ok(snapshot) => {
                last_error = None;
                let snapshot = Arc::new(snapshot);
                sender.send_if_modified(|current| {
                    if current.as_deref() == Some(snapshot.as_ref()) {
                        false
                    } else {
                        *current = Some(snapshot.clone());
                        true
                    }
                });
            }
            Err(error) => {
                let message = format!("{error:#}");
                if last_error.as_deref() != Some(message.as_str()) {
                    eprintln!("failed to monitor tmux state: {message}");
                    last_error = Some(message);
                }
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(TMUX_STATE_POLL_INTERVAL) => {}
            _ = wake.notified() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tmux::{TmuxSession, TmuxWindow};
    use std::collections::BTreeMap;

    #[test]
    fn serializes_tmux_state_message() {
        let mut windows = BTreeMap::new();
        windows.insert(
            "$1".to_string(),
            vec![TmuxWindow {
                id: "@2".to_string(),
                index: 0,
                name: "shell".to_string(),
                active: true,
                panes: 1,
                zoomed: false,
            }],
        );
        let snapshot = TmuxStateSnapshot {
            sessions: vec![TmuxSession {
                id: "$1".to_string(),
                name: "dev".to_string(),
                windows: 1,
                attached: 1,
                created: 1,
                last_attached: 2,
            }],
            windows,
        };

        let message: serde_json::Value = serde_json::from_str(
            &serialize_snapshot(&snapshot).expect("tmux state should serialize"),
        )
        .expect("tmux state should be valid JSON");
        assert_eq!(message["type"], "tmux_state");
        assert_eq!(message["sessions"][0]["id"], "$1");
        assert_eq!(message["windows"]["$1"][0]["name"], "shell");
    }
}
