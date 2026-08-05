use anyhow::{anyhow, bail, Context, Result};
use semver::Version;
use sha2::{Digest, Sha256};
use std::{
    env,
    fmt::Write as _,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
};
use ureq::Agent;
use uuid::Uuid;

const REPOSITORY_URL: &str = "https://github.com/ctaoist/tmux-web";
const MAX_CHECKSUM_BYTES: u64 = 4 * 1024;
const MAX_BINARY_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Eq, PartialEq)]
struct Release {
    tag: String,
    encoded_tag: String,
}

#[derive(Debug, Eq, PartialEq)]
enum UpdateOutcome {
    NoUpdate { current: String, latest: String },
    Updated { from: String, to: String },
}

pub fn run() -> Result<()> {
    let target = env::current_exe().context("failed to locate the current executable")?;
    let asset = release_asset(env::consts::OS, env::consts::ARCH)?;
    let current_version = executable_version(&target)?;
    let agent = update_agent();

    eprintln!("tmux-web executable: {}", target.display());
    eprintln!("tmux-web current version: {current_version}");

    match update_target(&agent, REPOSITORY_URL, &target, asset, &current_version)? {
        UpdateOutcome::NoUpdate { current, latest } => {
            eprintln!("no update needed (current: {current}, latest stable: {latest})");
        }
        UpdateOutcome::Updated { from, to } => {
            eprintln!("tmux-web updated {from} -> {to}");
            eprintln!("updated executable: {}", target.display());
            eprintln!("the running service was not restarted; restart it to use the new release");
        }
    }

    Ok(())
}

fn update_agent() -> Agent {
    ureq::AgentBuilder::new()
        .user_agent(concat!("tmux-web/", env!("CARGO_PKG_VERSION")))
        .redirects(10)
        .build()
}

fn release_asset(os: &str, arch: &str) -> Result<&'static str> {
    match (os, arch) {
        ("linux", "x86_64") => Ok("tmux-web-linux-x86_64-musl"),
        ("linux", "aarch64") => Ok("tmux-web-linux-arm64-musl"),
        _ => bail!("automatic updates are not supported on {os}/{arch}"),
    }
}

fn executable_version(path: &Path) -> Result<String> {
    let output = Command::new(path)
        .arg("-V")
        .output()
        .with_context(|| format!("failed to query version from {}", path.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "failed to query version from {}: {}",
            path.display(),
            stderr.trim()
        );
    }
    let stdout = std::str::from_utf8(&output.stdout)
        .with_context(|| format!("version output from {} is not valid UTF-8", path.display()))?;
    parse_version_output(stdout)
        .with_context(|| format!("invalid version output from {}", path.display()))
}

fn parse_version_output(output: &str) -> Result<String> {
    let version = output
        .trim()
        .strip_prefix("tmux-web ")
        .map(str::trim)
        .filter(|version| !version.is_empty() && !version.chars().any(char::is_whitespace))
        .ok_or_else(|| anyhow!("expected `tmux-web <version>`, got `{}`", output.trim()))?;
    Ok(version.to_string())
}

fn update_target(
    agent: &Agent,
    repository_url: &str,
    target: &Path,
    asset: &str,
    current_version: &str,
) -> Result<UpdateOutcome> {
    let release = latest_release(agent, repository_url)?;
    eprintln!("tmux-web latest stable release: {}", release.tag);

    let current = parse_release_version(current_version).with_context(|| {
        format!("current version reported by `tmux-web -V` is invalid: {current_version}")
    })?;
    let latest = parse_release_version(&release.tag)
        .with_context(|| format!("latest release tag is not a valid version: {}", release.tag))?;
    if latest <= current {
        return Ok(UpdateOutcome::NoUpdate {
            current: current_version.to_string(),
            latest: release.tag,
        });
    }

    let metadata = std::fs::metadata(target)
        .with_context(|| format!("failed to inspect executable {}", target.display()))?;
    if !metadata.is_file() {
        bail!(
            "executable path is not a regular file: {}",
            target.display()
        );
    }

    let checksum_url = release_asset_url(repository_url, &release, &format!("{asset}.sha256"));
    let expected_checksum = fetch_checksum(agent, &checksum_url, asset)?;
    let binary_url = release_asset_url(repository_url, &release, asset);
    let temporary_path = temporary_path(target)?;
    let mut temporary = TemporaryDownload::new(temporary_path);

    download_binary(agent, &binary_url, temporary.path(), &expected_checksum)?;
    std::fs::set_permissions(temporary.path(), metadata.permissions()).with_context(|| {
        format!(
            "failed to set permissions on downloaded executable {}",
            temporary.path().display()
        )
    })?;
    std::fs::rename(temporary.path(), target)
        .with_context(|| format!("failed to replace executable {}", target.display()))?;
    temporary.keep();

    Ok(UpdateOutcome::Updated {
        from: current_version.to_string(),
        to: release.tag,
    })
}

fn parse_release_version(version: &str) -> Result<Version> {
    let normalized = version.strip_prefix('v').unwrap_or(version);
    Version::parse(normalized).with_context(|| format!("invalid semantic version `{version}`"))
}

fn latest_release(agent: &Agent, repository_url: &str) -> Result<Release> {
    let latest_url = format!("{}/releases/latest", repository_url.trim_end_matches('/'));
    let response = agent
        .head(&latest_url)
        .call()
        .with_context(|| format!("failed to check latest release at {latest_url}"))?;

    release_from_redirect(repository_url, response.get_url())
}

fn release_from_redirect(repository_url: &str, final_url: &str) -> Result<Release> {
    let prefix = format!("{}/releases/tag/", repository_url.trim_end_matches('/'));
    let encoded_tag = final_url
        .strip_prefix(&prefix)
        .filter(|tag| !tag.is_empty() && !tag.contains(['?', '#']))
        .ok_or_else(|| anyhow!("could not determine latest release tag from {final_url}"))?;
    let tag = percent_decode(encoded_tag)
        .with_context(|| format!("invalid release tag in redirect URL {final_url}"))?;

    Ok(Release {
        tag,
        encoded_tag: encoded_tag.to_string(),
    })
}

fn release_asset_url(repository_url: &str, release: &Release, asset: &str) -> String {
    format!(
        "{}/releases/download/{}/{}",
        repository_url.trim_end_matches('/'),
        release.encoded_tag,
        asset
    )
}

fn fetch_checksum(agent: &Agent, url: &str, asset: &str) -> Result<String> {
    let response = agent
        .get(url)
        .call()
        .with_context(|| format!("failed to download checksum from {url}"))?;
    if content_length(&response)?.is_some_and(|size| size > MAX_CHECKSUM_BYTES) {
        bail!("checksum file is unexpectedly large");
    }
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_CHECKSUM_BYTES + 1)
        .read_to_end(&mut bytes)
        .context("failed to read downloaded checksum")?;
    if bytes.len() as u64 > MAX_CHECKSUM_BYTES {
        bail!("checksum file is unexpectedly large");
    }
    let text = std::str::from_utf8(&bytes).context("checksum file is not valid UTF-8")?;
    parse_checksum(text, asset)
}

fn content_length(response: &ureq::Response) -> Result<Option<u64>> {
    response
        .header("content-length")
        .map(|value| {
            value
                .parse::<u64>()
                .with_context(|| format!("invalid Content-Length header `{value}`"))
        })
        .transpose()
}

fn parse_checksum(contents: &str, asset: &str) -> Result<String> {
    let mut fields = contents.split_whitespace();
    let checksum = fields
        .next()
        .ok_or_else(|| anyhow!("checksum file is empty"))?;
    if checksum.len() != 64 || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("checksum file does not contain a valid SHA-256 digest");
    }

    let filename = fields
        .next()
        .map(|name| name.trim_start_matches('*'))
        .ok_or_else(|| anyhow!("checksum file does not contain an asset filename"))?;
    let checksum_asset = Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("checksum file contains an invalid asset filename"))?;
    if checksum_asset != asset {
        bail!("checksum is for {checksum_asset}, expected {asset}");
    }

    Ok(checksum.to_ascii_lowercase())
}

fn download_binary(agent: &Agent, url: &str, path: &Path, expected: &str) -> Result<()> {
    let response = agent
        .get(url)
        .call()
        .with_context(|| format!("failed to download release asset from {url}"))?;
    if content_length(&response)?.is_some_and(|size| size > MAX_BINARY_BYTES) {
        bail!("release asset is unexpectedly large");
    }

    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .with_context(|| format!("failed to create temporary file {}", path.display()))?;
    let mut reader = response.into_reader();
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let read = reader
            .read(&mut buffer)
            .context("failed while downloading release asset")?;
        if read == 0 {
            break;
        }
        downloaded = downloaded
            .checked_add(read as u64)
            .ok_or_else(|| anyhow!("release asset size overflow"))?;
        if downloaded > MAX_BINARY_BYTES {
            bail!("release asset is unexpectedly large");
        }
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read])
            .context("failed to write downloaded executable")?;
    }

    if downloaded == 0 {
        bail!("downloaded release asset is empty");
    }
    file.flush()
        .context("failed to flush downloaded executable")?;
    file.sync_all()
        .context("failed to sync downloaded executable")?;
    drop(file);

    let actual = hex_digest(hasher.finalize().as_slice());
    if actual != expected {
        bail!("release asset checksum mismatch: expected {expected}, got {actual}");
    }

    Ok(())
}

fn temporary_path(target: &Path) -> Result<PathBuf> {
    let parent = target
        .parent()
        .ok_or_else(|| anyhow!("executable path has no parent: {}", target.display()))?;
    let filename = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            anyhow!(
                "executable filename is not valid UTF-8: {}",
                target.display()
            )
        })?;
    Ok(parent.join(format!(".{filename}.update-{}", Uuid::new_v4().simple())))
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("writing to a string cannot fail");
    }
    output
}

fn percent_decode(value: &str) -> Result<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                bail!("incomplete percent escape");
            }
            let high =
                hex_value(bytes[index + 1]).ok_or_else(|| anyhow!("invalid percent escape"))?;
            let low =
                hex_value(bytes[index + 2]).ok_or_else(|| anyhow!("invalid percent escape"))?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).context("percent-decoded tag is not valid UTF-8")
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

struct TemporaryDownload {
    path: PathBuf,
    remove_on_drop: bool,
}

impl TemporaryDownload {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            remove_on_drop: true,
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn keep(&mut self) {
        self.remove_on_drop = false;
    }
}

impl Drop for TemporaryDownload {
    fn drop(&mut self) {
        if self.remove_on_drop {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{header, Response, StatusCode},
        response::IntoResponse,
        routing::get,
        Router,
    };
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    #[test]
    fn maps_supported_release_assets() {
        assert_eq!(
            release_asset("linux", "x86_64").unwrap(),
            "tmux-web-linux-x86_64-musl"
        );
        assert_eq!(
            release_asset("linux", "aarch64").unwrap(),
            "tmux-web-linux-arm64-musl"
        );
        assert!(release_asset("macos", "aarch64").is_err());
    }

    #[test]
    fn parses_sha256sum_output() {
        let digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let contents = format!("{digest}  dist/tmux-web-linux-x86_64-musl\n");
        assert_eq!(
            parse_checksum(&contents, "tmux-web-linux-x86_64-musl").unwrap(),
            digest
        );
        assert!(parse_checksum(&contents, "another-asset").is_err());
        assert!(parse_checksum("not-a-digest file", "file").is_err());
    }

    #[test]
    fn parses_cli_version_output() {
        assert_eq!(parse_version_output("tmux-web 2.0.0\n").unwrap(), "2.0.0");
        assert!(parse_version_output("another-program 1.0.0\n").is_err());
        assert!(parse_version_output("tmux-web\n").is_err());
    }

    #[test]
    fn compares_semantic_versions_with_optional_v_prefix() {
        assert!(parse_release_version("2.0.0").unwrap() > parse_release_version("1.9.9").unwrap());
        assert_eq!(
            parse_release_version("v2.0.0").unwrap(),
            parse_release_version("2.0.0").unwrap()
        );
        assert!(parse_release_version("release-2").is_err());
    }

    #[test]
    fn parses_encoded_release_tag() {
        let final_url = "https://github.com/ctaoist/tmux-web/releases/tag/release%202026.08";
        assert_eq!(
            release_from_redirect(REPOSITORY_URL, final_url).unwrap(),
            Release {
                tag: "release 2026.08".to_string(),
                encoded_tag: "release%202026.08".to_string(),
            }
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn update_downloads_valid_binary_and_preserves_permissions() {
        let asset = "tmux-web-linux-x86_64-musl";
        let new_binary = b"new executable contents".to_vec();
        let checksum = sha256(&new_binary);
        let (repository_url, server) =
            mock_release_server(asset, new_binary.clone(), checksum).await;
        let directory = tempdir().unwrap();
        let target = directory.path().join("tmux-web");
        tokio::fs::write(&target, b"old executable contents")
            .await
            .unwrap();
        tokio::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o751))
            .await
            .unwrap();

        let outcome =
            update_target(&update_agent(), &repository_url, &target, asset, "1.0.0").unwrap();

        assert_eq!(
            outcome,
            UpdateOutcome::Updated {
                from: "1.0.0".to_string(),
                to: "2.0.0".to_string(),
            }
        );
        assert_eq!(tokio::fs::read(&target).await.unwrap(), new_binary);
        assert_eq!(
            tokio::fs::metadata(&target)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o751
        );
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn matching_cli_version_skips_the_download() {
        let asset = "tmux-web-linux-x86_64-musl";
        let binary = b"unused release contents".to_vec();
        let checksum = sha256(&binary);
        let (repository_url, server) = mock_release_server(asset, binary, checksum).await;
        let missing_target = Path::new("/this/path/does/not/exist");

        let outcome = update_target(
            &update_agent(),
            &repository_url,
            missing_target,
            asset,
            "2.0.0",
        )
        .unwrap();

        assert_eq!(
            outcome,
            UpdateOutcome::NoUpdate {
                current: "2.0.0".to_string(),
                latest: "2.0.0".to_string(),
            }
        );
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn newer_current_version_skips_the_download() {
        let asset = "tmux-web-linux-x86_64-musl";
        let binary = b"unused release contents".to_vec();
        let checksum = sha256(&binary);
        let (repository_url, server) = mock_release_server(asset, binary, checksum).await;

        let outcome = update_target(
            &update_agent(),
            &repository_url,
            Path::new("/this/path/does/not/exist"),
            asset,
            "3.0.0",
        )
        .unwrap();

        assert_eq!(
            outcome,
            UpdateOutcome::NoUpdate {
                current: "3.0.0".to_string(),
                latest: "2.0.0".to_string(),
            }
        );
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn checksum_failure_leaves_original_binary_unchanged() {
        let asset = "tmux-web-linux-x86_64-musl";
        let new_binary = b"new executable contents".to_vec();
        let invalid_checksum = "0".repeat(64);
        let (repository_url, server) =
            mock_release_server(asset, new_binary, invalid_checksum).await;
        let directory = tempdir().unwrap();
        let target = directory.path().join("tmux-web");
        tokio::fs::write(&target, b"old executable contents")
            .await
            .unwrap();

        let error =
            update_target(&update_agent(), &repository_url, &target, asset, "1.0.0").unwrap_err();

        assert!(error.to_string().contains("checksum mismatch"));
        assert_eq!(
            tokio::fs::read(&target).await.unwrap(),
            b"old executable contents"
        );
        let entries = std::fs::read_dir(directory.path()).unwrap().count();
        assert_eq!(entries, 1);
        server.abort();
    }

    async fn mock_release_server(
        asset: &'static str,
        binary: Vec<u8>,
        checksum: String,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let checksum_path = format!("/repo/releases/download/2.0.0/{asset}.sha256");
        let binary_path = format!("/repo/releases/download/2.0.0/{asset}");
        let checksum_body = format!("{checksum}  dist/{asset}\n");
        let app = Router::new()
            .route(
                "/repo/releases/latest",
                get(|| async {
                    Response::builder()
                        .status(StatusCode::FOUND)
                        .header(header::LOCATION, "/repo/releases/tag/2.0.0")
                        .body(Body::empty())
                        .unwrap()
                        .into_response()
                }),
            )
            .route("/repo/releases/tag/2.0.0", get(|| async { StatusCode::OK }))
            .route(
                &checksum_path,
                get(move || {
                    let checksum_body = checksum_body.clone();
                    async move { checksum_body }
                }),
            )
            .route(
                &binary_path,
                get(move || {
                    let binary = binary.clone();
                    async move { binary }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}/repo"), server)
    }

    fn sha256(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hex_digest(hasher.finalize().as_slice())
    }
}
