use anyhow::{anyhow, Context, Result};
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::process::Command;
use tokio::sync::Mutex;
use uuid::Uuid;

const RESPONSIVE_LAYOUT_STORE_VERSION: u32 = 1;
const RESPONSIVE_LAYOUT_STORE_FILE: &str = "tmux-web-responsive-layouts.json";
const TMUX_FIELD_SEPARATOR: &str = "::tmux-web::";

#[derive(Clone, Debug)]
pub struct TmuxConfig {
    tmux_path: Arc<OsString>,
    socket_path: Option<Arc<OsString>>,
    zoom_lock: Arc<Mutex<()>>,
    responsive_zoom_windows: Arc<Mutex<HashMap<String, DesktopLayoutSnapshot>>>,
}

#[derive(Debug, Serialize)]
pub struct TmuxSession {
    pub name: String,
    pub windows: u32,
    pub attached: u32,
    pub created: u64,
    pub last_attached: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TmuxPane {
    pub id: String,
    pub left: u16,
    pub top: u16,
    pub width: u16,
    pub height: u16,
    pub active: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct TmuxWindow {
    pub id: String,
    pub index: u32,
    pub name: String,
    pub active: bool,
    pub panes: u32,
    pub zoomed: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct TmuxPaneBorderTheme {
    pub pane_border_style: Option<String>,
    pub pane_active_border_style: Option<String>,
}

#[derive(Clone, Debug)]
struct TmuxWindowEntry {
    session_id: String,
    window: TmuxWindow,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DesktopLayoutSnapshot {
    version: u32,
    session_name: String,
    session_id: String,
    window_id: String,
    window_index: u32,
    window_name: String,
    window_layout: String,
    active_pane_id: String,
    panes: Vec<TmuxPane>,
    was_zoomed_before_auto: bool,
    created_at_unix_secs: u64,
}

#[derive(Debug, Deserialize, Serialize)]
struct DesktopLayoutStore {
    version: u32,
    snapshots: Vec<DesktopLayoutSnapshot>,
}

#[derive(Debug)]
struct TmuxWindowZoomState {
    zoomed: bool,
}

#[derive(Debug)]
struct TmuxCurrentWindowState {
    session_name: String,
    session_id: String,
    window_id: String,
    window_index: u32,
    window_name: String,
    window_layout: String,
    window_zoomed: bool,
    active_pane_id: String,
}

impl TmuxPaneBorderTheme {
    pub fn is_empty(&self) -> bool {
        self.pane_border_style
            .as_deref()
            .unwrap_or_default()
            .is_empty()
            && self
                .pane_active_border_style
                .as_deref()
                .unwrap_or_default()
                .is_empty()
    }
}

impl TmuxConfig {
    pub fn new(tmux_path: PathBuf, socket_path: Option<PathBuf>) -> Self {
        let responsive_zoom_windows = load_responsive_layout_store()
            .map_err(|error| {
                eprintln!("failed to load responsive layout store: {error:#}");
                error
            })
            .unwrap_or_default();

        Self {
            tmux_path: Arc::new(tmux_path.into_os_string()),
            socket_path: socket_path.map(|path| Arc::new(path.into_os_string())),
            zoom_lock: Arc::new(Mutex::new(())),
            responsive_zoom_windows: Arc::new(Mutex::new(responsive_zoom_windows)),
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
            .arg(tmux_format(&[
                "#{session_name}",
                "#{session_windows}",
                "#{session_attached}",
                "#{session_created}",
                "#{session_last_attached}",
            ]))
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
        stdout
            .lines()
            .filter(|line| !line.is_empty())
            .map(parse_session_line)
            .collect()
    }

    pub async fn list_panes_for_window(
        &self,
        session_name: &str,
        window_id: &str,
    ) -> Result<Vec<TmuxPane>> {
        let entry = self
            .window_entry_in_session(session_name, window_id)
            .await?;
        self.list_panes_for_target(&entry.window.id).await
    }

    pub async fn select_pane_in_window(
        &self,
        session_name: &str,
        window_id: &str,
        pane_id: &str,
    ) -> Result<TmuxPane> {
        validate_pane_id(pane_id)?;
        let panes = self.list_panes_for_window(session_name, window_id).await?;
        if !panes.iter().any(|pane| pane.id == pane_id) {
            return Err(anyhow!(
                "tmux pane {pane_id} was not found in window {window_id}"
            ));
        }

        let output = self
            .command()
            .arg("select-pane")
            .arg("-t")
            .arg(pane_id)
            .output()
            .await
            .context("failed to execute tmux select-pane")?;
        ensure_success(output.status.success(), &output.stderr, "tmux select-pane")?;

        self.list_panes_for_window(session_name, window_id)
            .await?
            .into_iter()
            .find(|pane| pane.id == pane_id)
            .ok_or_else(|| anyhow!("pane was selected but not found in tmux list-panes"))
    }

    pub async fn list_windows(&self, session_name: &str) -> Result<Vec<TmuxWindow>> {
        let entries = self.list_window_entries(session_name).await?;
        Ok(entries.into_iter().map(|entry| entry.window).collect())
    }

    pub async fn apply_pane_border_theme_to_session_windows(
        &self,
        session_name: &str,
        theme: &TmuxPaneBorderTheme,
    ) -> Result<()> {
        validate_session_name(session_name)?;
        validate_pane_border_theme(theme)?;
        if theme.is_empty() {
            return Ok(());
        }

        let windows = self.list_window_entries(session_name).await?;
        for entry in windows {
            self.apply_pane_border_theme_to_window(&entry.window.id, theme)
                .await?;
        }
        Ok(())
    }

    pub async fn apply_pane_border_theme_to_window(
        &self,
        window_id: &str,
        theme: &TmuxPaneBorderTheme,
    ) -> Result<()> {
        validate_window_id(window_id)?;
        validate_pane_border_theme(theme)?;
        if let Some(style) = theme
            .pane_border_style
            .as_deref()
            .filter(|style| !style.is_empty())
        {
            self.set_window_option(window_id, "pane-border-style", style)
                .await?;
        }
        if let Some(style) = theme
            .pane_active_border_style
            .as_deref()
            .filter(|style| !style.is_empty())
        {
            self.set_window_option(window_id, "pane-active-border-style", style)
                .await?;
        }
        Ok(())
    }

    async fn set_window_option(&self, window_id: &str, option: &str, value: &str) -> Result<()> {
        let output = self
            .command()
            .arg("set-window-option")
            .arg("-q")
            .arg("-t")
            .arg(window_id)
            .arg(option)
            .arg(value)
            .output()
            .await
            .with_context(|| format!("failed to execute tmux set-window-option {option}"))?;
        ensure_success(
            output.status.success(),
            &output.stderr,
            "tmux set-window-option",
        )
    }

    async fn list_window_entries(&self, session_name: &str) -> Result<Vec<TmuxWindowEntry>> {
        validate_session_name(session_name)?;
        let output = self
            .command()
            .arg("list-windows")
            .arg("-t")
            .arg(session_name)
            .arg("-F")
            .arg(tmux_format(&[
                "#{session_id}",
                "#{window_id}",
                "#{window_index}",
                "#{window_active}",
                "#{window_panes}",
                "#{window_zoomed_flag}",
                "#{window_name}",
            ]))
            .output()
            .await
            .context("failed to execute tmux list-windows")?;
        ensure_success(output.status.success(), &output.stderr, "tmux list-windows")?;

        let stdout = String::from_utf8(output.stdout).context("tmux output was not UTF-8")?;
        stdout
            .lines()
            .filter(|line| !line.is_empty())
            .map(parse_window_entry_line)
            .collect()
    }

    pub async fn create_window(
        &self,
        session_name: &str,
        requested_name: Option<String>,
    ) -> Result<TmuxWindow> {
        validate_session_name(session_name)?;
        let name = requested_name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty());
        if let Some(name) = &name {
            validate_window_name(name)?;
        }

        let mut command = self.command();
        command
            .arg("new-window")
            .arg("-d")
            .arg("-P")
            .arg("-F")
            .arg("#{window_id}")
            .arg("-t")
            .arg(session_name);
        if let Some(name) = &name {
            command.arg("-n").arg(name);
        }
        let output = command
            .output()
            .await
            .context("failed to execute tmux new-window")?;
        ensure_success(output.status.success(), &output.stderr, "tmux new-window")?;

        let window_id = String::from_utf8(output.stdout)
            .context("tmux output was not UTF-8")?
            .trim()
            .to_string();
        validate_window_id(&window_id)?;
        self.select_window(session_name, &window_id).await
    }

    pub async fn select_window(&self, session_name: &str, window_id: &str) -> Result<TmuxWindow> {
        validate_session_name(session_name)?;
        let entry = self
            .window_entry_in_session(session_name, window_id)
            .await?;
        let output = self
            .command()
            .arg("select-window")
            .arg("-t")
            .arg(&entry.window.id)
            .output()
            .await
            .context("failed to execute tmux select-window")?;
        ensure_success(
            output.status.success(),
            &output.stderr,
            "tmux select-window",
        )?;

        self.window_entry_in_session(session_name, window_id)
            .await
            .map(|entry| entry.window)
    }

    pub async fn kill_window(&self, session_name: &str, window_id: &str) -> Result<()> {
        validate_session_name(session_name)?;
        let entry = self
            .window_entry_in_session(session_name, window_id)
            .await?;
        let output = self
            .command()
            .arg("kill-window")
            .arg("-t")
            .arg(&entry.window.id)
            .output()
            .await
            .context("failed to execute tmux kill-window")?;
        ensure_success(output.status.success(), &output.stderr, "tmux kill-window")?;
        self.clear_responsive_layout_for_window(&entry.session_id, &entry.window.id)
            .await
    }

    async fn window_entry_in_session(
        &self,
        session_name: &str,
        window_id: &str,
    ) -> Result<TmuxWindowEntry> {
        validate_window_id(window_id)?;
        self.list_window_entries(session_name)
            .await?
            .into_iter()
            .find(|entry| entry.window.id == window_id)
            .ok_or_else(|| {
                anyhow!("tmux window {window_id} was not found in session {session_name}")
            })
    }

    async fn list_panes_for_target(&self, target: &str) -> Result<Vec<TmuxPane>> {
        let output = self
            .command()
            .arg("list-panes")
            .arg("-t")
            .arg(target)
            .arg("-F")
            .arg(tmux_format(&[
                "#{pane_id}",
                "#{pane_left}",
                "#{pane_top}",
                "#{pane_width}",
                "#{pane_height}",
                "#{pane_active}",
            ]))
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

    pub async fn window_zoomed(&self, session_name: &str) -> Result<bool> {
        self.window_zoom_state(session_name)
            .await
            .map(|state| state.zoomed)
    }

    async fn window_zoom_state(&self, session_name: &str) -> Result<TmuxWindowZoomState> {
        validate_session_name(session_name)?;
        let output = self
            .command()
            .arg("display-message")
            .arg("-p")
            .arg("-t")
            .arg(session_name)
            .arg(tmux_format(&["#{window_id}", "#{window_zoomed_flag}"]))
            .output()
            .await
            .context("failed to execute tmux display-message")?;
        ensure_success(
            output.status.success(),
            &output.stderr,
            "tmux display-message",
        )?;

        let stdout = String::from_utf8(output.stdout).context("tmux output was not UTF-8")?;
        parse_window_zoom_state(&stdout)
    }

    pub async fn set_window_zoomed(&self, session_name: &str, zoomed: bool) -> Result<bool> {
        let _guard = self.zoom_lock.lock().await;
        self.set_window_zoomed_locked(session_name, zoomed).await
    }

    pub async fn set_responsive_window_zoomed(
        &self,
        session_name: &str,
        zoomed: bool,
    ) -> Result<bool> {
        let _guard = self.zoom_lock.lock().await;
        let window = self.current_window_state(session_name).await?;
        let key = responsive_zoom_key(&window.session_id, &window.window_id);

        if zoomed {
            if window.window_zoomed {
                return Ok(true);
            }
            let snapshot = self.desktop_layout_snapshot(&window).await?;
            {
                let mut snapshots = self.responsive_zoom_windows.lock().await;
                snapshots.insert(key.clone(), snapshot);
                persist_responsive_layout_store(&snapshots)?;
            }
            let zoomed = self.set_window_zoomed_locked(session_name, true).await?;
            if !zoomed {
                let mut snapshots = self.responsive_zoom_windows.lock().await;
                snapshots.remove(&key);
                persist_responsive_layout_store(&snapshots)?;
            }
            return Ok(zoomed);
        }

        let Some(snapshot) = self.responsive_zoom_windows.lock().await.get(&key).cloned() else {
            return Ok(window.window_zoomed);
        };

        let mut zoomed = window.window_zoomed;
        let restore_result = if !snapshot.was_zoomed_before_auto {
            if window.window_zoomed {
                zoomed = self.set_window_zoomed_locked(session_name, false).await?;
            }
            self.restore_desktop_layout(&snapshot).await
        } else {
            Ok(())
        };

        {
            let mut snapshots = self.responsive_zoom_windows.lock().await;
            snapshots.remove(&key);
            persist_responsive_layout_store(&snapshots)?;
        }
        restore_result?;
        Ok(zoomed)
    }

    pub async fn clear_responsive_window_zoomed(&self, session_name: &str) -> Result<()> {
        let _guard = self.zoom_lock.lock().await;
        let window = self.current_window_state(session_name).await?;
        let key = responsive_zoom_key(&window.session_id, &window.window_id);
        let mut snapshots = self.responsive_zoom_windows.lock().await;
        snapshots.remove(&key);
        persist_responsive_layout_store(&snapshots)?;
        Ok(())
    }

    async fn current_window_state(&self, session_name: &str) -> Result<TmuxCurrentWindowState> {
        validate_session_name(session_name)?;
        let output = self
            .command()
            .arg("display-message")
            .arg("-p")
            .arg("-t")
            .arg(session_name)
            .arg(tmux_format(&[
                "#{session_name}",
                "#{session_id}",
                "#{window_id}",
                "#{window_index}",
                "#{window_layout}",
                "#{window_zoomed_flag}",
                "#{pane_id}",
                "#{window_name}",
            ]))
            .output()
            .await
            .context("failed to execute tmux display-message")?;
        ensure_success(
            output.status.success(),
            &output.stderr,
            "tmux display-message",
        )?;

        let stdout = String::from_utf8(output.stdout).context("tmux output was not UTF-8")?;
        parse_current_window_state(&stdout)
    }

    async fn desktop_layout_snapshot(
        &self,
        window: &TmuxCurrentWindowState,
    ) -> Result<DesktopLayoutSnapshot> {
        Ok(DesktopLayoutSnapshot {
            version: RESPONSIVE_LAYOUT_STORE_VERSION,
            session_name: window.session_name.clone(),
            session_id: window.session_id.clone(),
            window_id: window.window_id.clone(),
            window_index: window.window_index,
            window_name: window.window_name.clone(),
            window_layout: window.window_layout.clone(),
            active_pane_id: window.active_pane_id.clone(),
            panes: self.list_panes_for_target(&window.window_id).await?,
            was_zoomed_before_auto: window.window_zoomed,
            created_at_unix_secs: now_unix_secs(),
        })
    }

    async fn restore_desktop_layout(&self, snapshot: &DesktopLayoutSnapshot) -> Result<()> {
        let output = self
            .command()
            .arg("select-layout")
            .arg("-t")
            .arg(&snapshot.window_id)
            .arg(&snapshot.window_layout)
            .output()
            .await
            .context("failed to execute tmux select-layout")?;
        ensure_success(
            output.status.success(),
            &output.stderr,
            "tmux select-layout",
        )?;

        if snapshot.active_pane_id.is_empty() {
            return Ok(());
        }

        let output = self
            .command()
            .arg("select-pane")
            .arg("-t")
            .arg(&snapshot.active_pane_id)
            .output()
            .await
            .context("failed to execute tmux select-pane")?;
        ensure_success(output.status.success(), &output.stderr, "tmux select-pane")
    }

    async fn set_window_zoomed_locked(&self, session_name: &str, zoomed: bool) -> Result<bool> {
        let currently_zoomed = self.window_zoom_state(session_name).await?.zoomed;
        if currently_zoomed == zoomed {
            return Ok(currently_zoomed);
        }

        let output = self
            .command()
            .arg("resize-pane")
            .arg("-Z")
            .arg("-t")
            .arg(session_name)
            .output()
            .await
            .context("failed to execute tmux resize-pane")?;
        ensure_success(output.status.success(), &output.stderr, "tmux resize-pane")?;

        self.window_zoomed(session_name).await
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
        let session_id = self.session_id(name).await.ok();
        let output = self
            .command()
            .arg("kill-session")
            .arg("-t")
            .arg(name)
            .output()
            .await
            .context("failed to execute tmux kill-session")?;
        ensure_success(output.status.success(), &output.stderr, "tmux kill-session")?;
        self.clear_responsive_layouts_for_session(name, session_id.as_deref())
            .await
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

    async fn clear_responsive_layouts_for_session(
        &self,
        session_name: &str,
        session_id: Option<&str>,
    ) -> Result<()> {
        let mut snapshots = self.responsive_zoom_windows.lock().await;
        let before = snapshots.len();
        snapshots.retain(|_, snapshot| {
            snapshot.session_name != session_name
                && session_id.map_or(true, |session_id| snapshot.session_id != session_id)
        });
        if snapshots.len() != before {
            persist_responsive_layout_store(&snapshots)?;
        }
        Ok(())
    }

    async fn clear_responsive_layout_for_window(
        &self,
        session_id: &str,
        window_id: &str,
    ) -> Result<()> {
        let mut snapshots = self.responsive_zoom_windows.lock().await;
        if snapshots
            .remove(&responsive_zoom_key(session_id, window_id))
            .is_some()
        {
            persist_responsive_layout_store(&snapshots)?;
        }
        Ok(())
    }

    async fn session_id(&self, session_name: &str) -> Result<String> {
        validate_session_name(session_name)?;
        let output = self
            .command()
            .arg("display-message")
            .arg("-p")
            .arg("-t")
            .arg(session_name)
            .arg("#{session_id}")
            .output()
            .await
            .context("failed to execute tmux display-message")?;
        ensure_success(
            output.status.success(),
            &output.stderr,
            "tmux display-message",
        )?;
        let stdout = String::from_utf8(output.stdout).context("tmux output was not UTF-8")?;
        Ok(stdout.trim().to_string())
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

fn validate_window_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 32 {
        return Err(anyhow!("window id must be 1-32 characters"));
    }
    if !id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '@' | '$' | '-' | '_' | '.'))
    {
        return Err(anyhow!("window id contains unsupported characters"));
    }
    Ok(())
}

fn validate_window_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > 80 {
        return Err(anyhow!("window name must be 1-80 characters"));
    }
    if name.contains('\0') || name.contains('\n') || name.contains('\r') {
        return Err(anyhow!("window name contains unsupported characters"));
    }
    Ok(())
}

fn validate_pane_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 32 {
        return Err(anyhow!("pane id must be 1-32 characters"));
    }
    if !id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '%' | '-' | '_' | '.'))
    {
        return Err(anyhow!("pane id contains unsupported characters"));
    }
    Ok(())
}

fn validate_pane_border_theme(theme: &TmuxPaneBorderTheme) -> Result<()> {
    if let Some(style) = &theme.pane_border_style {
        validate_tmux_style(style)?;
    }
    if let Some(style) = &theme.pane_active_border_style {
        validate_tmux_style(style)?;
    }
    Ok(())
}

fn validate_tmux_style(style: &str) -> Result<()> {
    if style.len() > 256 {
        return Err(anyhow!("tmux style must be 256 characters or fewer"));
    }
    if style.chars().any(|ch| ch.is_control()) {
        return Err(anyhow!("tmux style contains unsupported characters"));
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

fn tmux_format(fields: &[&str]) -> String {
    fields.join(TMUX_FIELD_SEPARATOR)
}

fn parse_u32(value: Option<&str>) -> u32 {
    value.and_then(|value| value.parse().ok()).unwrap_or(0)
}

fn parse_u64(value: Option<&str>) -> u64 {
    value.and_then(|value| value.parse().ok()).unwrap_or(0)
}

fn parse_required_u32(value: &str) -> Result<u32> {
    value
        .parse()
        .with_context(|| format!("unexpected tmux integer output: {value:?}"))
}

fn parse_required_u64(value: &str) -> Result<u64> {
    value
        .parse()
        .with_context(|| format!("unexpected tmux integer output: {value:?}"))
}

fn parse_u16(value: Option<&str>) -> u16 {
    value.and_then(|value| value.parse().ok()).unwrap_or(0)
}

fn parse_session_line(line: &str) -> Result<TmuxSession> {
    let mut parts = line.splitn(5, TMUX_FIELD_SEPARATOR);
    let name = required_part(&mut parts, "session_name")?;
    let windows = parse_required_u32(&required_part(&mut parts, "session_windows")?)?;
    let attached = parse_required_u32(&required_part(&mut parts, "session_attached")?)?;
    let created = parse_required_u64(&required_part(&mut parts, "session_created")?)?;
    let last_attached = parse_u64(parts.next());

    Ok(TmuxSession {
        name,
        windows,
        attached,
        created,
        last_attached,
    })
}

fn parse_pane_line(line: &str) -> Option<TmuxPane> {
    let mut parts = line.splitn(6, TMUX_FIELD_SEPARATOR);
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

fn parse_window_entry_line(line: &str) -> Result<TmuxWindowEntry> {
    let mut parts = line.splitn(7, TMUX_FIELD_SEPARATOR);
    let session_id = required_part(&mut parts, "session_id")?;
    let id = required_part(&mut parts, "window_id")?;
    let index = parse_u32(Some(&required_part(&mut parts, "window_index")?));
    let active = parse_bool_flag(&required_part(&mut parts, "window_active")?)?;
    let panes = parse_u32(Some(&required_part(&mut parts, "window_panes")?));
    let zoomed = parse_window_zoomed_flag(&required_part(&mut parts, "window_zoomed_flag")?)?;
    let name = parts.next().unwrap_or_default().to_string();

    Ok(TmuxWindowEntry {
        session_id,
        window: TmuxWindow {
            id,
            index,
            name,
            active,
            panes,
            zoomed,
        },
    })
}

fn parse_window_zoom_state(value: &str) -> Result<TmuxWindowZoomState> {
    let mut parts = value.trim().splitn(2, TMUX_FIELD_SEPARATOR);
    let _id = parts
        .next()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow!("tmux window_id output was empty"))?;
    let zoomed = parse_window_zoomed_flag(parts.next().unwrap_or_default())?;
    Ok(TmuxWindowZoomState { zoomed })
}

fn parse_current_window_state(value: &str) -> Result<TmuxCurrentWindowState> {
    let mut parts = value.trim().splitn(8, TMUX_FIELD_SEPARATOR);
    let session_name = required_part(&mut parts, "session_name")?;
    let session_id = required_part(&mut parts, "session_id")?;
    let window_id = required_part(&mut parts, "window_id")?;
    let window_index = parse_u32(Some(&required_part(&mut parts, "window_index")?));
    let window_layout = required_part(&mut parts, "window_layout")?;
    let window_zoomed =
        parse_window_zoomed_flag(&required_part(&mut parts, "window_zoomed_flag")?)?;
    let active_pane_id = required_part(&mut parts, "pane_id")?;
    let window_name = parts.next().unwrap_or_default().to_string();

    Ok(TmuxCurrentWindowState {
        session_name,
        session_id,
        window_id,
        window_index,
        window_name,
        window_layout,
        window_zoomed,
        active_pane_id,
    })
}

fn parse_window_zoomed_flag(value: &str) -> Result<bool> {
    parse_bool_flag(value).map_err(|_| {
        anyhow!(
            "unexpected tmux window_zoomed_flag output: {:?}",
            value.trim()
        )
    })
}

fn parse_bool_flag(value: &str) -> Result<bool> {
    match value.trim() {
        "0" => Ok(false),
        "1" => Ok(true),
        output => Err(anyhow!("unexpected tmux boolean output: {output:?}")),
    }
}

fn required_part<'a>(parts: &mut impl Iterator<Item = &'a str>, name: &str) -> Result<String> {
    parts
        .next()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("tmux {name} output was empty"))
}

fn responsive_zoom_key(session_name: &str, window_id: &str) -> String {
    format!("{session_name}\t{window_id}")
}

fn responsive_layout_store_path() -> PathBuf {
    std::env::temp_dir().join(RESPONSIVE_LAYOUT_STORE_FILE)
}

fn load_responsive_layout_store() -> Result<HashMap<String, DesktopLayoutSnapshot>> {
    let path = responsive_layout_store_path();
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let contents =
        fs::read_to_string(&path).with_context(|| format!("failed to read {}", path.display()))?;
    if contents.trim().is_empty() {
        return Ok(HashMap::new());
    }

    let store: DesktopLayoutStore = serde_json::from_str(&contents)
        .with_context(|| format!("failed to parse {}", path.display()))?;
    let snapshots = store
        .snapshots
        .into_iter()
        .map(|snapshot| {
            (
                responsive_zoom_key(&snapshot.session_id, &snapshot.window_id),
                snapshot,
            )
        })
        .collect();
    Ok(snapshots)
}

fn persist_responsive_layout_store(
    snapshots: &HashMap<String, DesktopLayoutSnapshot>,
) -> Result<()> {
    let path = responsive_layout_store_path();
    persist_responsive_layout_store_to_path(&path, snapshots)
}

fn persist_responsive_layout_store_to_path(
    path: &Path,
    snapshots: &HashMap<String, DesktopLayoutSnapshot>,
) -> Result<()> {
    if snapshots.is_empty() {
        match fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(error).with_context(|| format!("failed to remove {}", path.display()));
            }
        }
    }

    let store = DesktopLayoutStore {
        version: RESPONSIVE_LAYOUT_STORE_VERSION,
        snapshots: snapshots.values().cloned().collect(),
    };
    let contents = serde_json::to_string_pretty(&store).context("failed to encode layout store")?;
    let tmp_path = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&tmp_path, contents)
        .with_context(|| format!("failed to write {}", tmp_path.display()))?;
    fs::rename(&tmp_path, path).with_context(|| format!("failed to replace {}", path.display()))?;
    Ok(())
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
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
    fn parses_tmux_session_format() {
        let output = tmux_format(&["cnm", "1", "0", "1783301478", ""]);
        let session = parse_session_line(&output).expect("session should parse");

        assert_eq!(session.name, "cnm");
        assert_eq!(session.windows, 1);
        assert_eq!(session.attached, 0);
        assert_eq!(session.created, 1783301478);
        assert_eq!(session.last_attached, 0);
    }

    #[test]
    fn rejects_malformed_tmux_session_format() {
        assert!(parse_session_line("cnm_1_0_1783301478_").is_err());
    }

    #[test]
    fn parses_tmux_pane_geometry() {
        let output = tmux_format(&["%3", "81", "0", "79", "24", "1"]);
        let pane = parse_pane_line(&output).expect("pane should parse");
        assert_eq!(pane.id, "%3");
        assert_eq!(pane.left, 81);
        assert_eq!(pane.top, 0);
        assert_eq!(pane.width, 79);
        assert_eq!(pane.height, 24);
        assert!(pane.active);
    }

    #[test]
    fn validates_safe_pane_ids() {
        assert!(validate_pane_id("%1").is_ok());
        assert!(validate_pane_id("%123").is_ok());
        assert!(validate_pane_id("").is_err());
        assert!(validate_pane_id("%1:bad").is_err());
        assert!(validate_pane_id("bad pane").is_err());
    }

    #[test]
    fn validates_pane_border_theme_styles() {
        let theme = TmuxPaneBorderTheme {
            pane_border_style: Some("fg=#31373b".to_string()),
            pane_active_border_style: Some("fg=#65a8a6,bold".to_string()),
        };
        assert!(validate_pane_border_theme(&theme).is_ok());

        let theme = TmuxPaneBorderTheme {
            pane_border_style: Some("fg=#31373b\nset -g status off".to_string()),
            pane_active_border_style: None,
        };
        assert!(validate_pane_border_theme(&theme).is_err());
    }

    #[test]
    fn parses_tmux_window_zoomed_flag() {
        assert!(!parse_window_zoomed_flag("0\n").expect("zoom flag should parse"));
        assert!(parse_window_zoomed_flag(" 1 ").expect("zoom flag should parse"));
        assert!(parse_window_zoomed_flag("yes").is_err());
    }

    #[test]
    fn parses_tmux_window_zoom_state() {
        let output = format!("{}\n", tmux_format(&["@2", "1"]));
        let state = parse_window_zoom_state(&output).expect("zoom state should parse");
        assert!(state.zoomed);
        assert!(parse_window_zoom_state(&tmux_format(&["", "1"])).is_err());
    }

    #[test]
    fn parses_tmux_window_entry_line() {
        let output = tmux_format(&["$1", "@2", "3", "1", "4", "0", "shell"]);
        let entry = parse_window_entry_line(&output).expect("window entry should parse");

        assert_eq!(entry.session_id, "$1");
        assert_eq!(entry.window.id, "@2");
        assert_eq!(entry.window.index, 3);
        assert_eq!(entry.window.name, "shell");
        assert!(entry.window.active);
        assert_eq!(entry.window.panes, 4);
        assert!(!entry.window.zoomed);
        assert!(parse_window_entry_line(&tmux_format(&[
            "$1", "@2", "3", "active", "4", "0", "shell"
        ]))
        .is_err());
    }

    #[test]
    fn parses_tmux_current_window_state() {
        let output = format!(
            "{}\n",
            tmux_format(&[
                "dev",
                "$1",
                "@2",
                "3",
                "b25d,120x30,0,0,0",
                "0",
                "%4",
                "shell"
            ])
        );
        let state = parse_current_window_state(&output).expect("current window state should parse");

        assert_eq!(state.session_name, "dev");
        assert_eq!(state.session_id, "$1");
        assert_eq!(state.window_id, "@2");
        assert_eq!(state.window_index, 3);
        assert_eq!(state.window_layout, "b25d,120x30,0,0,0");
        assert!(!state.window_zoomed);
        assert_eq!(state.active_pane_id, "%4");
        assert_eq!(state.window_name, "shell");
    }

    #[test]
    fn persists_responsive_layout_store() {
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let path = dir.path().join("layouts.json");
        let snapshot = DesktopLayoutSnapshot {
            version: RESPONSIVE_LAYOUT_STORE_VERSION,
            session_name: "dev".to_string(),
            session_id: "$1".to_string(),
            window_id: "@2".to_string(),
            window_index: 1,
            window_name: "shell".to_string(),
            window_layout: "layout".to_string(),
            active_pane_id: "%3".to_string(),
            panes: vec![TmuxPane {
                id: "%3".to_string(),
                left: 0,
                top: 0,
                width: 80,
                height: 24,
                active: true,
            }],
            was_zoomed_before_auto: false,
            created_at_unix_secs: 42,
        };
        let mut snapshots = HashMap::new();
        snapshots.insert(responsive_zoom_key("$1", "@2"), snapshot);

        persist_responsive_layout_store_to_path(&path, &snapshots)
            .expect("layout store should persist");
        let contents = fs::read_to_string(path).expect("layout store should be readable");
        let store: DesktopLayoutStore =
            serde_json::from_str(&contents).expect("layout store should be JSON");

        assert_eq!(store.version, RESPONSIVE_LAYOUT_STORE_VERSION);
        assert_eq!(store.snapshots.len(), 1);
        assert_eq!(store.snapshots[0].session_name, "dev");
        assert_eq!(store.snapshots[0].window_id, "@2");
        assert_eq!(store.snapshots[0].panes[0].id, "%3");
    }

    #[test]
    fn removes_empty_responsive_layout_store() {
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let path = dir.path().join("layouts.json");
        fs::write(&path, "{}").expect("layout store placeholder should be writable");

        persist_responsive_layout_store_to_path(&path, &HashMap::new())
            .expect("empty layout store should remove the file");

        assert!(!path.exists());
    }
}
