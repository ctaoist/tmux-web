use anyhow::{anyhow, Context, Result};
use portable_pty::CommandBuilder;
use serde::Serialize;
use std::{ffi::OsString, path::PathBuf, sync::Arc};
use tokio::process::Command;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct TmuxConfig {
    tmux_path: Arc<OsString>,
    socket_path: Option<Arc<OsString>>,
}

#[derive(Debug, Serialize)]
pub struct TmuxSession {
    pub name: String,
    pub windows: u32,
    pub attached: u32,
    pub created: u64,
    pub last_attached: u64,
}

#[derive(Debug, Serialize)]
pub struct TmuxPane {
    pub id: String,
    pub left: u16,
    pub top: u16,
    pub width: u16,
    pub height: u16,
    pub active: bool,
}

impl TmuxConfig {
    pub fn new(tmux_path: PathBuf, socket_path: Option<PathBuf>) -> Self {
        Self {
            tmux_path: Arc::new(tmux_path.into_os_string()),
            socket_path: socket_path.map(|path| Arc::new(path.into_os_string())),
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&*self.tmux_path);
        if let Some(socket_path) = &self.socket_path {
            command.arg("-S").arg(&**socket_path);
        }
        command
    }

    pub fn attach_command(&self, session_name: &str) -> CommandBuilder {
        let mut command = CommandBuilder::new(&*self.tmux_path);
        if let Some(socket_path) = &self.socket_path {
            command.arg("-S");
            command.arg(&**socket_path);
        }
        command.arg("-u");
        command.arg("attach-session");
        command.arg("-t");
        command.arg(session_name);
        command.env("TERM", "xterm-256color");
        command
    }

    pub async fn list_sessions(&self) -> Result<Vec<TmuxSession>> {
        let output = self
            .command()
            .arg("list-sessions")
            .arg("-F")
            .arg("#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_last_attached}")
            .output()
            .await
            .context("failed to execute tmux list-sessions")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("no server running") || stderr.contains("failed to connect") {
                return Ok(Vec::new());
            }
            return Err(anyhow!("tmux list-sessions failed: {}", stderr.trim()));
        }

        let stdout = String::from_utf8(output.stdout).context("tmux output was not UTF-8")?;
        let mut sessions = Vec::new();
        for line in stdout.lines().filter(|line| !line.is_empty()) {
            let mut parts = line.splitn(5, '\t');
            let Some(name) = parts.next() else { continue };
            let windows = parse_u32(parts.next());
            let attached = parse_u32(parts.next());
            let created = parse_u64(parts.next());
            let last_attached = parse_u64(parts.next());
            sessions.push(TmuxSession {
                name: name.to_string(),
                windows,
                attached,
                created,
                last_attached,
            });
        }
        Ok(sessions)
    }

    pub async fn list_panes(&self, session_name: &str) -> Result<Vec<TmuxPane>> {
        validate_session_name(session_name)?;
        let output = self
            .command()
            .arg("list-panes")
            .arg("-t")
            .arg(session_name)
            .arg("-F")
            .arg("#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_active}")
            .output()
            .await
            .context("failed to execute tmux list-panes")?;
        ensure_success(output.status.success(), &output.stderr, "tmux list-panes")?;

        let stdout = String::from_utf8(output.stdout).context("tmux output was not UTF-8")?;
        let panes = stdout
            .lines()
            .filter(|line| !line.is_empty())
            .filter_map(parse_pane_line)
            .collect();
        Ok(panes)
    }

    pub async fn create_session(&self, requested_name: Option<String>) -> Result<TmuxSession> {
        let name = match requested_name {
            Some(name) if !name.trim().is_empty() => name.trim().to_string(),
            _ => generated_session_name(),
        };
        validate_session_name(&name)?;

        let output = self
            .command()
            .arg("new-session")
            .arg("-d")
            .arg("-s")
            .arg(&name)
            .output()
            .await
            .context("failed to execute tmux new-session")?;
        ensure_success(output.status.success(), &output.stderr, "tmux new-session")?;

        let sessions = self.list_sessions().await?;
        sessions
            .into_iter()
            .find(|session| session.name == name)
            .ok_or_else(|| anyhow!("session was created but not found in tmux list-sessions"))
    }

    pub async fn kill_session(&self, name: &str) -> Result<()> {
        validate_session_name(name)?;
        let output = self
            .command()
            .arg("kill-session")
            .arg("-t")
            .arg(name)
            .output()
            .await
            .context("failed to execute tmux kill-session")?;
        ensure_success(output.status.success(), &output.stderr, "tmux kill-session")
    }

    pub async fn rename_session(&self, old_name: &str, new_name: &str) -> Result<TmuxSession> {
        validate_session_name(old_name)?;
        validate_session_name(new_name)?;
        let output = self
            .command()
            .arg("rename-session")
            .arg("-t")
            .arg(old_name)
            .arg(new_name)
            .output()
            .await
            .context("failed to execute tmux rename-session")?;
        ensure_success(
            output.status.success(),
            &output.stderr,
            "tmux rename-session",
        )?;

        let sessions = self.list_sessions().await?;
        sessions
            .into_iter()
            .find(|session| session.name == new_name)
            .ok_or_else(|| anyhow!("session was renamed but not found in tmux list-sessions"))
    }
}

pub fn validate_session_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > 80 {
        return Err(anyhow!("session name must be 1-80 characters"));
    }
    if !name
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err(anyhow!(
            "session name may only contain letters, numbers, '.', '_' and '-'"
        ));
    }
    Ok(())
}

fn generated_session_name() -> String {
    let suffix: String = Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect();
    format!("web-{suffix}")
}

fn parse_u32(value: Option<&str>) -> u32 {
    value.and_then(|value| value.parse().ok()).unwrap_or(0)
}

fn parse_u64(value: Option<&str>) -> u64 {
    value.and_then(|value| value.parse().ok()).unwrap_or(0)
}

fn parse_u16(value: Option<&str>) -> u16 {
    value.and_then(|value| value.parse().ok()).unwrap_or(0)
}

fn parse_pane_line(line: &str) -> Option<TmuxPane> {
    let mut parts = line.splitn(6, '\t');
    let id = parts.next()?;
    Some(TmuxPane {
        id: id.to_string(),
        left: parse_u16(parts.next()),
        top: parse_u16(parts.next()),
        width: parse_u16(parts.next()),
        height: parse_u16(parts.next()),
        active: parts.next() == Some("1"),
    })
}

fn ensure_success(success: bool, stderr: &[u8], command: &str) -> Result<()> {
    if success {
        return Ok(());
    }
    Err(anyhow!(
        "{command} failed: {}",
        String::from_utf8_lossy(stderr).trim()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_safe_session_names() {
        assert!(validate_session_name("work").is_ok());
        assert!(validate_session_name("ops-1.dev").is_ok());
        assert!(validate_session_name("").is_err());
        assert!(validate_session_name("bad name").is_err());
        assert!(validate_session_name("bad:target").is_err());
    }

    #[test]
    fn parses_tmux_pane_geometry() {
        let pane = parse_pane_line("%3\t81\t0\t79\t24\t1").expect("pane should parse");
        assert_eq!(pane.id, "%3");
        assert_eq!(pane.left, 81);
        assert_eq!(pane.top, 0);
        assert_eq!(pane.width, 79);
        assert_eq!(pane.height, 24);
        assert!(pane.active);
    }
}
