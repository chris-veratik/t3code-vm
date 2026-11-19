export const localVmProviders = ["codex", "claude"] as const;

// Each guest owns its provider binaries and logins. Codex uses the complete ARM64 package
// pinned by the guest T3 release. Claude uses Anthropic's checksum for its native ARM64 build.
export const installLocalVmProvider = `set -eu
bin="$HOME/.local/bin"
export PATH="$bin:$PATH"
case "$1" in
  codex)
    version=0.166.0
    url="https://github.com/openai/codex/releases/download/rust-v$version/codex-package-aarch64-unknown-linux-musl.tar.gz"
    digest=7821b77dda2e6283fb1f63f3165177a271da8833e857cf673c6ca1c9db3bfcc6
    directory="$HOME/.local/share/t3-local-vm/codex"
    executable="$directory/$version/bin/codex"
    ;;
  claude)
    version=2.1.328
    url="https://downloads.claude.ai/claude-code-releases/$version/linux-arm64/claude"
    digest=307f8bada27b37db7553fac75e86004e3dbff5a931ffc611b54fe710ce1eb521
    directory="$HOME/.local/share/claude/versions"
    executable="$directory/$version"
    ;;
  *) exit 2 ;;
esac
if command -v "$1" >/dev/null; then exit 0; fi
mkdir -p "$bin" "$directory"
exec 9>"$directory/.t3-install.lock"
flock -w 600 9
if command -v "$1" >/dev/null; then exit 0; fi
if [ ! -x "$executable" ]; then
  stage=$(mktemp -d "$directory/.install.XXXXXX")
  trap 'rm -rf "$stage"' EXIT
  curl -fLsS --retry 3 --connect-timeout 15 --max-time 600 "$url" -o "$stage/download"
  echo "$digest  $stage/download" | sha256sum -c - >&2
  if [ "$1" = codex ]; then
    mkdir "$stage/package"
    tar -xzf "$stage/download" --no-same-owner -C "$stage/package"
    "$stage/package/bin/codex" --version >&2
    mv -T "$stage/package" "$directory/$version"
  else
    chmod 755 "$stage/download"
    "$stage/download" --version >&2
    mv -T "$stage/download" "$executable"
  fi
fi
ln -sfnT "$executable" "$bin/$1"
"$bin/$1" --version >&2
`;
