#!/usr/bin/env bash
# Owner-authorized tool installation only. Installs Docker Engine/Compose from
# Docker's signed Ubuntu repository; never starts an AssetTracker application.
set -euo pipefail
if [[ ${EUID} -ne 0 ]]; then
  echo 'Run this reviewed script using sudo in your VM terminal.' >&2
  exit 1
fi
# Refuse unsupported hosts and existing engines instead of removing packages,
# replacing daemon configuration or disrupting an existing installation.
source /etc/os-release
if [[ ${ID} != ubuntu || ! ${VERSION_CODENAME} =~ ^(jammy|noble|resolute)$ ]]; then
  echo 'This installer supports Ubuntu 22.04, 24.04 and 26.04 only.' >&2
  exit 1
fi
if command -v docker >/dev/null; then
  echo 'Docker already exists; inspect its Engine/Compose configuration separately.'
  exit 0
fi
for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
  if [[ $(dpkg-query -W -f='${Status}' "${package}" 2>/dev/null || true) == 'install ok installed' ]]; then
    echo 'A conflicting container package exists; review it before installing Docker.' >&2
    exit 1
  fi
done
apt-get update
apt-get install --yes --no-install-recommends ca-certificates curl gnupg
install -d -m 0755 /etc/apt/keyrings
key_file=$(mktemp)
trap 'rm -f "$key_file"' EXIT
curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg --output "$key_file"
# Verify Docker's public signing-key fingerprint before trusting the repository.
fingerprint=$(gpg --show-keys --with-colons "$key_file" 2>/dev/null | awk -F: '$1 == "fpr" {print $10; exit}')
if [[ ${fingerprint} != 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 ]]; then
  echo 'Unexpected Docker repository signing key; installation stopped.' >&2
  exit 1
fi
install -m 0644 "$key_file" /etc/apt/keyrings/docker.asc
architecture=$(dpkg --print-architecture)
cat > /etc/apt/sources.list.d/assettracker-docker.sources <<SOURCES
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: ${architecture}
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES
apt-get update
apt-get install --yes --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
# Keep administration through sudo; do not grant passwordless root-equivalent
# access by adding interactive users to the docker group.
docker version
docker compose version
echo 'Docker tools installed. No AssetTracker stack deployed.'
