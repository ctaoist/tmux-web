use anyhow::{anyhow, Context, Result};
use axum::http::{header, HeaderMap, HeaderValue};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::OpenOptions,
    io::{ErrorKind, Write},
    net::IpAddr,
    path::PathBuf,
    sync::Arc,
};
use tokio::sync::Mutex;

const COOKIE_NAME: &str = "tmux_web_session";

#[derive(Clone)]
pub struct LoginAttemptTracker {
    error_count: usize,
    black_file: Arc<PathBuf>,
    state: Arc<Mutex<LoginAttemptState>>,
}

struct LoginAttemptState {
    failures: HashMap<IpAddr, usize>,
    blacklisted: HashSet<IpAddr>,
}

impl LoginAttemptTracker {
    pub fn new(error_count: usize, black_file: PathBuf) -> Result<Self> {
        if error_count == 0 {
            return Err(anyhow!("--error-count must be greater than zero"));
        }

        Ok(Self {
            error_count,
            state: Arc::new(Mutex::new(LoginAttemptState {
                failures: HashMap::new(),
                blacklisted: load_blacklisted_hosts(&black_file)?,
            })),
            black_file: Arc::new(black_file),
        })
    }

    pub fn error_count(&self) -> usize {
        self.error_count
    }

    pub async fn is_blacklisted(&self, host: IpAddr) -> bool {
        self.state.lock().await.blacklisted.contains(&host)
    }

    /// Records a failed token attempt and returns true when this attempt newly
    /// blacklists the host.
    pub async fn record_failure(&self, host: IpAddr) -> bool {
        let mut state = self.state.lock().await;
        if state.blacklisted.contains(&host) {
            return false;
        }

        let failures = state.failures.entry(host).or_default();
        *failures = failures.saturating_add(1);
        if *failures < self.error_count {
            return false;
        }

        state.failures.remove(&host);
        state.blacklisted.insert(host);
        if let Err(error) = append_blacklisted_host(&self.black_file, host) {
            eprintln!(
                "warning: failed to persist blacklisted host {host} to {}: {error:#}",
                self.black_file.display()
            );
        }
        true
    }

    pub async fn record_success(&self, host: IpAddr) {
        self.state.lock().await.failures.remove(&host);
    }
}

fn load_blacklisted_hosts(path: &PathBuf) -> Result<HashSet<IpAddr>> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .with_context(|| format!("failed to create black file {}", path.display()))?;
            String::new()
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to read black file {}", path.display()));
        }
    };

    contents
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let host = line.trim();
            (!host.is_empty() && !host.starts_with('#')).then_some((index + 1, host))
        })
        .map(|(line, host)| {
            host.parse::<IpAddr>().with_context(|| {
                format!(
                    "invalid IP address on line {line} of black file {}",
                    path.display()
                )
            })
        })
        .collect()
}

fn append_blacklisted_host(path: &PathBuf, host: IpAddr) -> Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("failed to open black file {}", path.display()))?;
    writeln!(file, "{host}")
        .with_context(|| format!("failed to write black file {}", path.display()))?;
    Ok(())
}

#[derive(Clone)]
pub struct AuthState {
    token: Arc<String>,
    secure_cookie: bool,
}

impl AuthState {
    pub fn new(token: String, secure_cookie: bool) -> Self {
        Self {
            token: Arc::new(token),
            secure_cookie,
        }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn issue_session(&self, token: &str) -> Option<HeaderValue> {
        if token != self.token() {
            return None;
        }
        let session_id = self.session_cookie_value();

        let secure = if self.secure_cookie { "; Secure" } else { "" };
        HeaderValue::from_str(&format!(
            "{COOKIE_NAME}={session_id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000{secure}"
        ))
        .ok()
    }

    pub fn authenticated(&self, headers: &HeaderMap) -> bool {
        let Some(cookie_session) = cookie_value(headers, COOKIE_NAME) else {
            return false;
        };
        constant_time_eq(
            cookie_session.as_bytes(),
            self.session_cookie_value().as_bytes(),
        )
    }

    pub fn logout_cookie(&self, _headers: &HeaderMap) -> HeaderValue {
        HeaderValue::from_static("tmux_web_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
    }

    fn session_cookie_value(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"tmux-web-session-v1\0");
        hasher.update(self.token.as_bytes());
        format!("v1.{}", hex_digest(hasher.finalize().as_slice()))
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right.iter())
        .fold(0_u8, |acc, (left, right)| acc | (left ^ right))
        == 0
}

fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
    for cookie in cookies.split(';') {
        let cookie = cookie.trim();
        let (key, value) = cookie.split_once('=')?;
        if key == name {
            return Some(value);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::NamedTempFile;

    #[test]
    fn issues_and_checks_cookie_sessions() {
        let auth = AuthState::new("secret".to_string(), false);
        let cookie = auth.issue_session("secret").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, cookie);
        assert!(auth.authenticated(&headers));
    }

    #[test]
    fn cookie_survives_server_restart_when_token_is_the_same() {
        let auth = AuthState::new("secret".to_string(), false);
        let cookie = auth.issue_session("secret").unwrap();
        let restarted_auth = AuthState::new("secret".to_string(), false);
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, cookie);
        assert!(restarted_auth.authenticated(&headers));
    }

    #[test]
    fn cookie_is_rejected_after_token_change() {
        let auth = AuthState::new("secret".to_string(), false);
        let cookie = auth.issue_session("secret").unwrap();
        let restarted_auth = AuthState::new("different".to_string(), false);
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, cookie);
        assert!(!restarted_auth.authenticated(&headers));
    }

    #[test]
    fn rejects_bad_tokens() {
        let auth = AuthState::new("secret".to_string(), false);
        assert!(auth.issue_session("wrong").is_none());
    }

    #[tokio::test]
    async fn blacklists_a_host_after_the_configured_failure_count() {
        let file = NamedTempFile::new().unwrap();
        let tracker = LoginAttemptTracker::new(2, file.path().to_path_buf()).unwrap();
        let host = "192.0.2.1".parse().unwrap();

        assert!(!tracker.record_failure(host).await);
        assert!(!tracker.is_blacklisted(host).await);
        assert!(tracker.record_failure(host).await);
        assert!(tracker.is_blacklisted(host).await);
        assert_eq!(fs::read_to_string(file.path()).unwrap(), "192.0.2.1\n");

        let reloaded = LoginAttemptTracker::new(2, file.path().to_path_buf()).unwrap();
        assert!(reloaded.is_blacklisted(host).await);
    }

    #[tokio::test]
    async fn successful_login_resets_consecutive_failures() {
        let file = NamedTempFile::new().unwrap();
        let tracker = LoginAttemptTracker::new(2, file.path().to_path_buf()).unwrap();
        let host = "192.0.2.1".parse().unwrap();

        assert!(!tracker.record_failure(host).await);
        tracker.record_success(host).await;
        assert!(!tracker.record_failure(host).await);
        assert!(!tracker.is_blacklisted(host).await);
    }
}
