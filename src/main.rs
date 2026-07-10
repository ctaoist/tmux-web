mod auth;
mod pty;
mod static_assets;
mod tmux;

use anyhow::{anyhow, Context, Result};
use auth::AuthState;
use axum::{
    body::{Body, Bytes},
    extract::{ws::WebSocketUpgrade, Path, Query, State},
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use clap::Parser;
use pty::{ResponsiveLayoutRegistry, TerminalSize, TransferRegistry};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::ErrorKind,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Component, Path as FsPath, PathBuf},
    sync::Arc,
};
use tmux::{TmuxConfig, TmuxSession};
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

    #[arg(long, env = "TMUX_WEB_THEME", default_value = "auto")]
    theme: String,

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

type ThemeConfig = Value;

#[derive(Clone)]
struct AppState {
    auth: AuthState,
    tmux: TmuxConfig,
    transfers: TransferRegistry,
    responsive_layouts: ResponsiveLayoutRegistry,
    theme_config: ThemeConfig,
    static_dir: Option<PathBuf>,
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

#[derive(Deserialize)]
struct TerminalQuery {
    session: String,
    cols: Option<u16>,
    rows: Option<u16>,
    transfer_id: Option<String>,
}

#[derive(Deserialize)]
struct TransferQuery {
    id: String,
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
    let theme_config = load_theme_config(&args.theme)?;
    let theme_name = theme_config
        .get("theme")
        .and_then(Value::as_str)
        .unwrap_or("auto")
        .to_string();
    let state = AppState {
        auth: AuthState::new(token.clone(), false),
        tmux: TmuxConfig::new(args.tmux.clone(), args.socket_path.clone()),
        transfers: TransferRegistry::default(),
        responsive_layouts: ResponsiveLayoutRegistry::default(),
        theme_config,
        static_dir: args.static_dir.clone(),
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
        .route("/ws/trzsz", get(trzsz_ws))
        .fallback(static_response)
        .with_state(Arc::new(state));

    let addr = SocketAddr::new(args.host, args.port);
    eprintln!("tmux-web listening on http://{addr}");
    eprintln!("tmux-web theme: {theme_name}");
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

fn load_theme_config(theme: &str) -> Result<ThemeConfig> {
    let theme = theme.trim();
    if theme.is_empty() {
        return Err(anyhow!("--theme must not be empty"));
    }

    if is_builtin_theme_preference(theme) {
        return Ok(builtin_theme_config(theme));
    }

    let path = PathBuf::from(theme);
    let contents = std::fs::read_to_string(&path)
        .with_context(|| format!("failed to read theme file {}", path.display()))?;
    let value: Value = serde_json::from_str(&contents)
        .with_context(|| format!("failed to parse theme file {}", path.display()))?;
    let Value::Object(mut object) = value else {
        return Err(anyhow!(
            "theme file {} must contain a JSON object",
            path.display()
        ));
    };

    let theme_name = object
        .get("theme")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|theme| !theme.is_empty())
        .ok_or_else(|| anyhow!("theme file must contain a top-level string field \"theme\""))?
        .to_string();

    if theme_name == "theme" {
        return Err(anyhow!("theme name \"theme\" is reserved"));
    }

    if !is_builtin_theme_preference(&theme_name) && !object.contains_key(&theme_name) {
        return Err(anyhow!(
            "theme file selected theme \"{}\" but no top-level \"{}\" definition exists",
            theme_name,
            theme_name
        ));
    }

    object.insert("theme".to_string(), Value::String(theme_name));
    Ok(Value::Object(object))
}

fn is_builtin_theme_preference(theme: &str) -> bool {
    matches!(theme, "auto" | "dark" | "light")
}

fn builtin_theme_config(theme: &str) -> ThemeConfig {
    let mut object = serde_json::Map::new();
    object.insert("theme".to_string(), Value::String(theme.to_string()));
    Value::Object(object)
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

async fn config(State(state): State<Arc<AppState>>) -> Json<ThemeConfig> {
    Json(state.theme_config.clone())
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
    state.tmux.kill_session(&name).await.map_err(bad_request)?;
    state.responsive_layouts.remove_session(&name).await;
    Ok(Json(MeResponse {
        authenticated: true,
    }))
}

async fn rename_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(request): Json<RenameSessionRequest>,
) -> ApiResult<SessionResponse> {
    require_auth(&headers, &state)?;
    let session = state
        .tmux
        .rename_session(&name, request.name.trim())
        .await
        .map_err(bad_request)?;
    state.responsive_layouts.remove_session(&name).await;
    state.responsive_layouts.remove_session(&session.name).await;
    Ok(Json(SessionResponse { session }))
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
    ws.on_upgrade(move |socket| {
        pty::run_terminal(
            socket,
            state.tmux.clone(),
            state.transfers.clone(),
            state.responsive_layouts.clone(),
            query.session,
            size,
            query.transfer_id,
        )
    })
}

async fn trzsz_ws(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<TransferQuery>,
) -> Response {
    if require_auth(&headers, &state).is_err() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| pty::run_trzsz_transfer(socket, state.transfers.clone(), query.id))
}

async fn static_response(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if let Some(static_dir) = &state.static_dir {
        return static_dir_response(static_dir, &uri).await;
    }

    embedded_static(headers, uri).await
}

async fn static_dir_response(static_dir: &FsPath, uri: &Uri) -> Response {
    let path = request_asset_path(uri);
    if let Some(response) = read_static_file(static_dir, path).await {
        return response;
    }

    if path == "index.html" {
        return StatusCode::NOT_FOUND.into_response();
    }

    read_static_file(static_dir, "index.html")
        .await
        .unwrap_or_else(|| StatusCode::NOT_FOUND.into_response())
}

async fn read_static_file(static_dir: &FsPath, request_path: &str) -> Option<Response> {
    let path = safe_static_path(static_dir, request_path)?;
    match tokio::fs::metadata(&path).await {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return None,
        Err(error) if error.kind() == ErrorKind::NotFound => return None,
        Err(error) => return Some(internal_static_error(error)),
    }

    match tokio::fs::read(&path).await {
        Ok(bytes) => Some(
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime_for(request_path))
                .body(Body::from(bytes))
                .expect("static file response should be valid"),
        ),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => Some(internal_static_error(error)),
    }
}

fn request_asset_path(uri: &Uri) -> &str {
    let path = uri.path().trim_start_matches('/');
    if path.is_empty() {
        "index.html"
    } else {
        path
    }
}

fn safe_static_path(root: &FsPath, request_path: &str) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    for component in FsPath::new(request_path).components() {
        match component {
            Component::Normal(component) => path.push(component),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => return None,
        }
    }
    Some(path)
}

fn internal_static_error(error: std::io::Error) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("failed to read static file: {error}"),
    )
        .into_response()
}

async fn embedded_static(headers: HeaderMap, uri: Uri) -> Response {
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

    if asset.encoding == Some("gzip") && !accepts_gzip(&headers) {
        return Response::builder()
            .status(StatusCode::NOT_ACCEPTABLE)
            .header(header::VARY, header::ACCEPT_ENCODING.as_str())
            .body(Body::empty())
            .expect("embedded asset response should be valid");
    }

    let cache_control = if asset.path == "index.html" {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };

    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, asset.mime)
        .header(header::CACHE_CONTROL, cache_control)
        .header(header::VARY, header::ACCEPT_ENCODING.as_str());

    if let Some(encoding) = asset.encoding {
        response = response.header(header::CONTENT_ENCODING, encoding);
    }

    response
        .body(Body::from(Bytes::from_static(asset.bytes)))
        .expect("embedded asset response should be valid")
}

fn mime_for(path: &str) -> &'static str {
    match FsPath::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
    {
        "css" => "text/css; charset=utf-8",
        "gif" => "image/gif",
        "html" => "text/html; charset=utf-8",
        "ico" => "image/x-icon",
        "jpg" | "jpeg" => "image/jpeg",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "wasm" => "application/wasm",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn accepts_gzip(headers: &HeaderMap) -> bool {
    let mut saw_accept_encoding = false;
    let mut gzip_quality = None;
    let mut wildcard_quality = None;

    for value in headers.get_all(header::ACCEPT_ENCODING) {
        let Ok(value) = value.to_str() else {
            saw_accept_encoding = true;
            continue;
        };
        saw_accept_encoding = true;

        for coding in value.split(',') {
            let mut parts = coding.split(';').map(str::trim);
            let name = parts.next().unwrap_or_default();
            let quality = qvalue(parts);

            if name.eq_ignore_ascii_case("gzip") {
                gzip_quality = Some(quality);
            } else if name == "*" {
                wildcard_quality = Some(quality);
            }
        }
    }

    match gzip_quality.or(wildcard_quality) {
        Some(quality) => quality > 0.0,
        None => !saw_accept_encoding,
    }
}

fn qvalue<'a>(params: impl Iterator<Item = &'a str>) -> f32 {
    for param in params {
        let Some((name, value)) = param.split_once('=') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("q") {
            return value.trim().parse::<f32>().unwrap_or(0.0);
        }
    }
    1.0
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn missing_accept_encoding_allows_gzip() {
        assert!(accepts_gzip(&HeaderMap::new()));
    }

    #[test]
    fn gzip_accept_encoding_allows_gzip() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("br, gzip;q=1.0"),
        );

        assert!(accepts_gzip(&headers));
    }

    #[test]
    fn wildcard_accept_encoding_allows_gzip() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("br;q=1.0, *;q=0.5"),
        );

        assert!(accepts_gzip(&headers));
    }

    #[test]
    fn gzip_q_zero_rejects_gzip() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("gzip;q=0, br"),
        );

        assert!(!accepts_gzip(&headers));
    }

    #[test]
    fn explicit_gzip_q_zero_overrides_wildcard() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("gzip;q=0, *;q=1"),
        );

        assert!(!accepts_gzip(&headers));
    }

    #[test]
    fn safe_static_path_joins_normal_components() {
        assert_eq!(
            safe_static_path(FsPath::new("/srv/tmux-web"), "assets/index.js"),
            Some(PathBuf::from("/srv/tmux-web/assets/index.js"))
        );
    }

    #[test]
    fn safe_static_path_rejects_parent_components() {
        assert!(safe_static_path(FsPath::new("/srv/tmux-web"), "../secret").is_none());
        assert!(safe_static_path(FsPath::new("/srv/tmux-web"), "assets/../../secret").is_none());
    }

    #[test]
    fn builtin_theme_preferences_return_theme_config() {
        for theme in ["auto", "dark", "light"] {
            let config = load_theme_config(theme).expect("builtin theme should load");
            assert_eq!(config.get("theme").and_then(Value::as_str), Some(theme));
        }
    }

    #[test]
    fn theme_file_returns_validated_json_object() {
        let file = write_theme_file(
            r##"{
              "theme": "auto",
              "light": {
                "ui": { "--bg": "#eff1f5" },
                "terminal": { "background": "#eff1f5", "foreground": "#4c4f69" }
              }
            }"##,
        );

        let config = load_theme_config(file.path().to_str().unwrap()).expect("theme file loads");

        assert_eq!(config.get("theme").and_then(Value::as_str), Some("auto"));
        assert!(config.get("light").is_some());
    }

    #[test]
    fn theme_file_requires_top_level_theme_field() {
        let file = write_theme_file(r##"{ "light": {} }"##);
        let error = load_theme_config(file.path().to_str().unwrap()).unwrap_err();

        assert!(error
            .to_string()
            .contains("top-level string field \"theme\""));
    }

    #[test]
    fn theme_file_requires_selected_custom_theme_definition() {
        let file = write_theme_file(r##"{ "theme": "missing-theme" }"##);
        let error = load_theme_config(file.path().to_str().unwrap()).unwrap_err();

        assert!(error.to_string().contains("missing-theme"));
    }

    #[test]
    fn theme_file_rejects_invalid_json() {
        let file = write_theme_file(r##"{ "theme": "auto" "##);
        let error = load_theme_config(file.path().to_str().unwrap()).unwrap_err();

        assert!(error.to_string().contains("failed to parse theme file"));
    }

    fn write_theme_file(contents: &str) -> NamedTempFile {
        let mut file = NamedTempFile::new().expect("temp file should be created");
        file.write_all(contents.as_bytes())
            .expect("temp file should be writable");
        file
    }
}
