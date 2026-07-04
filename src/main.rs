mod auth;
mod pty;
mod static_assets;
mod tmux;

use anyhow::{anyhow, Context, Result};
use auth::AuthState;
use axum::{
    body::{Body, Bytes},
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use clap::{Parser, ValueEnum};
use futures_util::{SinkExt, StreamExt};
use pty::TerminalSize;
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
};
use tmux::{TmuxConfig, TmuxSession};
use tower_http::services::{ServeDir, ServeFile};
use uuid::Uuid;

#[derive(Parser, Debug)]
#[command(author, version, about)]
struct Args {
    #[arg(
        long,
        visible_alias = "listen",
        env = "TMUX_WEB_HOST",
        default_value_t = IpAddr::V4(Ipv4Addr::LOCALHOST)
    )]
    host: IpAddr,

    #[arg(long, env = "TMUX_WEB_PORT", default_value_t = 8082)]
    port: u16,

    #[arg(long, env = "TMUX_WEB_THEME", value_enum, default_value = "dark")]
    theme: Theme,

    #[arg(long, default_value = "tmux")]
    tmux: PathBuf,

    #[arg(long)]
    socket_path: Option<PathBuf>,

    #[arg(long, env = "TMUX_WEB_TOKEN")]
    token: Option<String>,

    #[arg(long, env = "TMUX_WEB_TOKEN_FILE")]
    token_file: Option<PathBuf>,

    #[arg(long)]
    static_dir: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, Serialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
enum Theme {
    Dark,
    Light,
}

impl Theme {
    fn as_str(self) -> &'static str {
        match self {
            Self::Dark => "dark",
            Self::Light => "light",
        }
    }
}

#[derive(Clone)]
struct AppState {
    auth: AuthState,
    tmux: TmuxConfig,
    theme: Theme,
}

#[derive(Deserialize)]
struct LoginRequest {
    token: String,
}

#[derive(Deserialize)]
struct CreateSessionRequest {
    name: Option<String>,
}

#[derive(Deserialize)]
struct RenameSessionRequest {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ControlMessage {
    ListWindows {
        request_id: String,
        session_name: String,
    },
    CreateWindow {
        request_id: String,
        session_name: String,
        name: Option<String>,
    },
    SelectWindow {
        request_id: String,
        session_name: String,
        window_id: String,
    },
    KillWindow {
        request_id: String,
        session_name: String,
        window_id: String,
    },
}

#[derive(Deserialize)]
struct TerminalQuery {
    session: String,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Serialize)]
struct LoginResponse {
    authenticated: bool,
}

#[derive(Serialize)]
struct MeResponse {
    authenticated: bool,
}

#[derive(Serialize)]
struct ConfigResponse {
    theme: Theme,
}

#[derive(Serialize)]
struct SessionsResponse {
    sessions: Vec<TmuxSession>,
}

#[derive(Serialize)]
struct SessionResponse {
    session: TmuxSession,
}

#[derive(Serialize)]
struct ApiError {
    error: String,
}

type ApiResult<T> = Result<Json<T>, (StatusCode, Json<ApiError>)>;

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let token = load_token(&args)?;
    let state = AppState {
        auth: AuthState::new(token.clone(), false),
        tmux: TmuxConfig::new(args.tmux.clone(), args.socket_path.clone()),
        theme: args.theme,
    };

    let app = Router::new()
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/me", get(me))
        .route("/api/config", get(config))
        .route("/api/sessions", get(list_sessions).post(create_session))
        .route(
            "/api/sessions/{name}",
            delete(kill_session).put(rename_session),
        )
        .route("/ws/terminal", get(terminal_ws))
        .route("/ws/control", get(control_ws));

    let app = if let Some(static_dir) = &args.static_dir {
        let index_file = static_dir.join("index.html");
        app.fallback_service(
            ServeDir::new(static_dir.clone()).not_found_service(ServeFile::new(index_file)),
        )
    } else {
        app.fallback(embedded_static)
    }
    .with_state(Arc::new(state));

    let addr = SocketAddr::new(args.host, args.port);
    eprintln!("tmux-web listening on http://{addr}");
    eprintln!("tmux-web theme: {}", args.theme.as_str());
    eprintln!("tmux-web token: {token}");
    if let Some(static_dir) = &args.static_dir {
        eprintln!("tmux-web frontend: {}", static_dir.display());
    } else {
        eprintln!("tmux-web frontend: embedded");
    }
    if !args.host.is_loopback() {
        eprintln!("warning: HTTP is enabled on a non-loopback address; use a reverse proxy or trusted network.");
    }

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .context("failed to bind HTTP listener")?;
    axum::serve(listener, app)
        .await
        .context("tmux-web server failed")?;

    Ok(())
}

fn load_token(args: &Args) -> Result<String> {
    if let Some(token) = &args.token {
        if token.trim().is_empty() {
            return Err(anyhow!("--token must not be empty"));
        }
        return Ok(token.trim().to_string());
    }
    if let Some(path) = &args.token_file {
        let token = std::fs::read_to_string(path)
            .with_context(|| format!("failed to read token file {}", path.display()))?;
        if token.trim().is_empty() {
            return Err(anyhow!("token file must not be empty"));
        }
        return Ok(token.trim().to_string());
    }
    Ok(Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(24)
        .collect())
}

fn require_auth(headers: &HeaderMap, state: &AppState) -> Result<(), (StatusCode, Json<ApiError>)> {
    if state.auth.authenticated(headers) {
        Ok(())
    } else {
        Err(api_error(StatusCode::UNAUTHORIZED, "unauthorized"))
    }
}

async fn login(
    State(state): State<Arc<AppState>>,
    Json(request): Json<LoginRequest>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let Some(cookie) = state.auth.issue_session(request.token.trim()) else {
        return Err(api_error(StatusCode::UNAUTHORIZED, "invalid token"));
    };
    let mut response = Json(LoginResponse {
        authenticated: true,
    })
    .into_response();
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    Ok(response)
}

async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let mut response = Json(MeResponse {
        authenticated: false,
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, state.auth.logout_cookie(&headers));
    response
}

async fn me(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Json<MeResponse> {
    Json(MeResponse {
        authenticated: state.auth.authenticated(&headers),
    })
}

async fn config(State(state): State<Arc<AppState>>) -> Json<ConfigResponse> {
    Json(ConfigResponse { theme: state.theme })
}

async fn list_sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<SessionsResponse> {
    require_auth(&headers, &state)?;
    state
        .tmux
        .list_sessions()
        .await
        .map(|sessions| Json(SessionsResponse { sessions }))
        .map_err(internal_error)
}

async fn create_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CreateSessionRequest>,
) -> ApiResult<SessionResponse> {
    require_auth(&headers, &state)?;
    state
        .tmux
        .create_session(request.name)
        .await
        .map(|session| Json(SessionResponse { session }))
        .map_err(bad_request)
}

async fn kill_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> ApiResult<MeResponse> {
    require_auth(&headers, &state)?;
    state
        .tmux
        .kill_session(&name)
        .await
        .map(|_| {
            Json(MeResponse {
                authenticated: true,
            })
        })
        .map_err(bad_request)
}

async fn rename_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(request): Json<RenameSessionRequest>,
) -> ApiResult<SessionResponse> {
    require_auth(&headers, &state)?;
    state
        .tmux
        .rename_session(&name, request.name.trim())
        .await
        .map(|session| Json(SessionResponse { session }))
        .map_err(bad_request)
}

async fn terminal_ws(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<TerminalQuery>,
) -> Response {
    if require_auth(&headers, &state).is_err() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let size = TerminalSize::clamped(query.cols.unwrap_or(100), query.rows.unwrap_or(30));
    ws.on_upgrade(move |socket| pty::run_terminal(socket, state.tmux.clone(), query.session, size))
}

async fn control_ws(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if require_auth(&headers, &state).is_err() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| run_control_socket(socket, state.tmux.clone()))
}

async fn run_control_socket(socket: WebSocket, tmux: TmuxConfig) {
    let (mut sender, mut receiver) = socket.split();
    while let Some(message) = receiver.next().await {
        let Ok(message) = message else { break };
        match message {
            Message::Text(text) => {
                let response = match serde_json::from_str::<ControlMessage>(&text) {
                    Ok(message) => control_response(&tmux, message).await,
                    Err(error) => Some(control_error("", &error)),
                };
                if let Some(response) = response {
                    if sender.send(Message::Text(response.into())).await.is_err() {
                        break;
                    }
                }
            }
            Message::Ping(bytes) => {
                let _ = sender.send(Message::Pong(bytes)).await;
            }
            Message::Close(_) => break,
            Message::Binary(_) | Message::Pong(_) => {}
        }
    }
}

async fn control_response(tmux: &TmuxConfig, message: ControlMessage) -> Option<String> {
    match message {
        ControlMessage::ListWindows {
            request_id,
            session_name,
        } => {
            let response = match tmux.list_windows(&session_name).await {
                Ok(windows) => control_ok(&request_id, serde_json::json!({ "windows": windows })),
                Err(error) => control_anyhow_error(&request_id, &error),
            };
            Some(response)
        }
        ControlMessage::CreateWindow {
            request_id,
            session_name,
            name,
        } => {
            let response = match tmux.create_window(&session_name, name).await {
                Ok(window) => control_ok(&request_id, serde_json::json!({ "window": window })),
                Err(error) => control_anyhow_error(&request_id, &error),
            };
            Some(response)
        }
        ControlMessage::SelectWindow {
            request_id,
            session_name,
            window_id,
        } => {
            let response = match tmux.select_window(&session_name, &window_id).await {
                Ok(window) => control_ok(&request_id, serde_json::json!({ "window": window })),
                Err(error) => control_anyhow_error(&request_id, &error),
            };
            Some(response)
        }
        ControlMessage::KillWindow {
            request_id,
            session_name,
            window_id,
        } => {
            let response = match tmux.kill_window(&session_name, &window_id).await {
                Ok(()) => control_ok(&request_id, serde_json::json!({})),
                Err(error) => control_anyhow_error(&request_id, &error),
            };
            Some(response)
        }
    }
}

fn control_ok(request_id: &str, data: serde_json::Value) -> String {
    serde_json::json!({
        "type": "control_response",
        "request_id": request_id,
        "ok": true,
        "data": data,
    })
    .to_string()
}

fn control_error(request_id: &str, error: &serde_json::Error) -> String {
    serde_json::json!({
        "type": "control_response",
        "request_id": request_id,
        "ok": false,
        "error": error.to_string(),
    })
    .to_string()
}

fn control_anyhow_error(request_id: &str, error: &anyhow::Error) -> String {
    serde_json::json!({
        "type": "control_response",
        "request_id": request_id,
        "ok": false,
        "error": error.to_string(),
    })
    .to_string()
}

async fn embedded_static(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let fallback = if path.starts_with("assets/") {
        None
    } else {
        static_assets::get("index.html")
    };
    let Some(asset) = static_assets::get(path).or(fallback) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let cache_control = if asset.path == "index.html" {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, asset.mime)
        .header(header::CACHE_CONTROL, cache_control)
        .body(Body::from(Bytes::from_static(asset.bytes)))
        .expect("embedded asset response should be valid")
}

fn api_error(status: StatusCode, error: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (
        status,
        Json(ApiError {
            error: error.into(),
        }),
    )
}

fn bad_request(error: anyhow::Error) -> (StatusCode, Json<ApiError>) {
    api_error(StatusCode::BAD_REQUEST, error.to_string())
}

fn internal_error(error: anyhow::Error) -> (StatusCode, Json<ApiError>) {
    api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}
