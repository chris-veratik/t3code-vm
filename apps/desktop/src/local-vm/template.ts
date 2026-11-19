// Plain mode keeps the guest off the host filesystem and disables automatic guest port forwards.
export const localVmTemplate = `vmType: vz
arch: aarch64
cpus: 2
memory: 4GiB
disk: 24GiB
plain: true
mounts: []
ssh:
  loadDotSSHPubKeys: false
  forwardAgent: false
containerd:
  system: false
  user: false
images:
  - location: "https://cloud-images.ubuntu.com/releases/noble/release-20261017/ubuntu-24.04-server-cloudimg-arm64.img"
    arch: aarch64
    digest: "sha256:50e24e1fb79e89116e939d90aa7738f7af48c442fa1bc2510131e0b39c50348e"
`;

export const installGuestTools = `set -eu
if ! (command -v git && command -v curl && command -v flock) >/dev/null; then
  sudo env DEBIAN_FRONTEND=noninteractive apt-get -qy update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get -qy install git ca-certificates curl util-linux
fi
`;

export const installGuestService = `set -eu
t3="$HOME/.local/bin/t3"
if [ ! -x "$t3" ]; then
  installer=$(mktemp)
  trap 'rm -f "$installer"' EXIT
  curl -fsSL --retry 3 https://raw.githubusercontent.com/pingdotgg/t3code/7d32075e3757ded707914e2450c3e392a9665765/scripts/install.sh -o "$installer"
  echo "f7414a7e4a3e216534ed0a3b68e6f408352fb3d6621f87376d2932efb2b9e1c2  $installer" | sha256sum -c - >&2
  T3CODE_VERSION=0.1.10 sh "$installer" >&2
fi
if [ ! -f "$HOME/.t3/local-vm-service-installed" ]; then
  mkdir -p "$HOME/.t3"
  printf '%s\\n' 'T3CODE_HOST=127.0.0.1' > "$HOME/.t3/service.env"
  sudo loginctl enable-linger "$(id -un)"
  "$t3" service install >&2
  touch "$HOME/.t3/local-vm-service-installed"
fi
systemctl --user start t3code.service
# The service may still be starting after the VM reports Running.
for attempt in $(seq 1 60); do
  if test -s "$HOME/.t3/userdata/environment-id" && "$t3" status >/dev/null 2>&1; then exit 0; fi
  sleep 1
done
echo 'The guest T3 service did not become ready.' >&2
exit 1
`;

// Lima can regenerate the cloud image's default host keys on boot. Keep the project's
// SSH identity on the persistent disk, outside cloud-init's host key directory.
export const installGuestHostKey = `set -eu
key=/var/lib/t3-local-vm/ssh_host_ed25519_key
install -d -m 700 /var/lib/t3-local-vm
if [ ! -f "$key" ]; then ssh-keygen -q -N '' -t ed25519 -f "$key"; fi
conf=/etc/ssh/sshd_config.d/00-t3-local-vm.conf
if [ ! -f "$conf" ]; then
  printf 'HostKey %s\\n' "$key" > "$conf"
fi
sshd -t
systemctl reload ssh
cat "$key.pub"
`;
