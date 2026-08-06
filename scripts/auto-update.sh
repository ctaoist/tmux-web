#!/bin/sh

set -eu

REPOSITORY_URL="https://github.com/ctaoist/tmux-web"
RESTART_ENABLED=${TMUX_WEB_RESTART_ENABLED:-false}
RESTART_COMMAND=${TMUX_WEB_RESTART_COMMAND:-}
BINARY=${TMUX_WEB_BINARY:-}

WORK_DIR=
STAGED_BINARY=

log() {
    printf '%s\n' "tmux-web-update: $*"
}

die() {
    printf '%s\n' "tmux-web-update: error: $*" >&2
    exit 1
}

cleanup() {
    if [ -n "$STAGED_BINARY" ]; then
        rm -f -- "$STAGED_BINARY"
    fi
    if [ -n "$WORK_DIR" ]; then
        rm -rf -- "$WORK_DIR"
    fi
}

trap cleanup 0
trap 'exit 130' HUP INT TERM

case "$RESTART_ENABLED" in
    1 | true | yes | on)
        RESTART_ENABLED=true
        [ -n "$RESTART_COMMAND" ] || die \
            "TMUX_WEB_RESTART_COMMAND is required when restart is enabled"
        ;;
    0 | false | no | off | '')
        RESTART_ENABLED=false
        ;;
    *)
        die "TMUX_WEB_RESTART_ENABLED must be true or false"
        ;;
esac

if [ -z "$BINARY" ]; then
    BINARY=$(command -v tmux-web 2>/dev/null || true)
fi
[ -n "$BINARY" ] || die \
    "tmux-web was not found; set TMUX_WEB_BINARY to its path"

for REQUIRED_COMMAND in awk chmod cp curl dirname mktemp mv readlink rm \
    sha256sum sort tail tar uname; do
    command -v "$REQUIRED_COMMAND" >/dev/null 2>&1 || \
        die "$REQUIRED_COMMAND is required"
done

BINARY=$(readlink -f -- "$BINARY") || die "failed to resolve binary path"
[ -f "$BINARY" ] || die "binary is not a regular file: $BINARY"
[ -x "$BINARY" ] || die "binary is not executable: $BINARY"

VERSION_OUTPUT=$("$BINARY" -V 2>/dev/null) || die "failed to query current version"
case "$VERSION_OUTPUT" in
    'tmux-web '*) CURRENT_VERSION=${VERSION_OUTPUT#tmux-web } ;;
    *) die "unexpected version output: $VERSION_OUTPUT" ;;
esac
[ -n "$CURRENT_VERSION" ] || die "current version is empty"

case "$(uname -s)" in
    Linux) ;;
    *) die "automatic updates are supported only on Linux" ;;
esac

case "$(uname -m)" in
    x86_64 | amd64) ASSET=tmux-web-linux-x86_64-musl ;;
    aarch64 | arm64) ASSET=tmux-web-linux-arm64-musl ;;
    *) die "unsupported architecture: $(uname -m)" ;;
esac

LATEST_URL=$(curl -fsSIL --retry 3 --connect-timeout 15 \
    -o /dev/null -w '%{url_effective}' "$REPOSITORY_URL/releases/latest") || \
    die "failed to check the latest release"
LATEST_VERSION=${LATEST_URL##*/}
[ -n "$LATEST_VERSION" ] || die "failed to determine the latest release version"

CURRENT_NORMALIZED=${CURRENT_VERSION#v}
LATEST_NORMALIZED=${LATEST_VERSION#v}
case "$CURRENT_NORMALIZED" in
    '' | *[!0-9A-Za-z.+-]*) die "current version contains unsupported characters" ;;
esac
case "$LATEST_NORMALIZED" in
    '' | *[!0-9A-Za-z.+-]*) die "latest version contains unsupported characters" ;;
esac

if [ "$CURRENT_NORMALIZED" = "$LATEST_NORMALIZED" ]; then
    log "already up to date ($CURRENT_VERSION)"
    exit 0
fi

HIGHEST_VERSION=$(printf '%s\n%s\n' "$CURRENT_NORMALIZED" "$LATEST_NORMALIZED" | \
    sort -V | tail -n 1)
if [ "$HIGHEST_VERSION" != "$LATEST_NORMALIZED" ]; then
    log "current version $CURRENT_VERSION is newer than latest stable $LATEST_VERSION; skipping"
    exit 0
fi

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tmux-web-update.XXXXXX") || \
    die "failed to create temporary directory"
STAGED_BINARY=$(mktemp "${BINARY}.update.XXXXXX") || \
    die "binary directory is not writable: $(dirname "$BINARY")"

ARCHIVE="$WORK_DIR/$ASSET.tar.gz"
CHECKSUM_FILE="$WORK_DIR/$ASSET.tar.gz.sha256"
DOWNLOAD_BASE="$REPOSITORY_URL/releases/download/$LATEST_VERSION"

log "updating $CURRENT_VERSION -> $LATEST_VERSION"
curl -fL --retry 3 --connect-timeout 15 \
    -o "$CHECKSUM_FILE" "$DOWNLOAD_BASE/$ASSET.tar.gz.sha256" || \
    die "failed to download checksum"
curl -fL --retry 3 --connect-timeout 15 \
    -o "$ARCHIVE" "$DOWNLOAD_BASE/$ASSET.tar.gz" || \
    die "failed to download release asset"

EXPECTED_SHA256=$(awk 'NR == 1 { print $1; exit }' "$CHECKSUM_FILE")
case "$EXPECTED_SHA256" in
    '' | *[!0-9A-Fa-f]*) die "release checksum is invalid" ;;
esac
[ "${#EXPECTED_SHA256}" -eq 64 ] || die "release checksum is invalid"
ACTUAL_SHA256=$(sha256sum "$ARCHIVE" | awk '{ print $1 }')
[ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] || die "release checksum mismatch"

tar -xzf "$ARCHIVE" -C "$WORK_DIR" "$ASSET" || \
    die "failed to extract release asset"
[ -f "$WORK_DIR/$ASSET" ] || die "release archive does not contain $ASSET"

cp -- "$WORK_DIR/$ASSET" "$STAGED_BINARY" || die "failed to stage new binary"
chmod --reference="$BINARY" "$STAGED_BINARY" || die "failed to preserve binary permissions"
mv -f -- "$STAGED_BINARY" "$BINARY" || die "failed to replace $BINARY"
STAGED_BINARY=

log "replaced $BINARY; restart is required to use $LATEST_VERSION"

if [ "$RESTART_ENABLED" = true ]; then
    log "running restart command: $RESTART_COMMAND"
    /bin/sh -c "$RESTART_COMMAND" || die "restart command failed"
    log "restart command completed"
fi
