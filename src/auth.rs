use axum::http::{header, HeaderMap, HeaderValue};
use sha2::{Digest, Sha256};
use std::sync::Arc;

const COOKIE_NAME: &str = "tmux_web_session";

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
}
