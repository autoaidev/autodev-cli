#!/usr/bin/env bash
#
# setup_dev_env.sh — provision a clean machine to build & TEST the autodev-cli.
#
# Sources / prior art:
#   - headless-coding-vm (v10_copilot_virtualmin_rdp/docker/install.sh):
#       * NodeSource install pattern:  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - ; apt-get install -y nodejs
#       * base apt packages: ca-certificates curl git unzip build-essential (+ wget, jq, etc.)
#     This CLI is pure Node/TypeScript, so the PHP / Composer / XRDP / desktop parts
#     of that image are intentionally NOT reproduced here.
#   - autodev-cli/package.json:
#       * scripts.build = "tsc -p ./"   -> outputs to ./out  (see tsconfig.json outDir)
#       * scripts.test  = node test/*.smoke.mjs ...  (pure Node smoke tests, no browser)
#       * no "engines" field; project memory: the CLI uses node:sqlite which needs Node >= 22.
#     Hence Node 22 is the pinned default (override with NODE_MAJOR).
#
# The autodev-cli tests are plain Node smoke tests and need NO headless browser, so no
# browser is provisioned unless a Playwright dependency is detected in package.json.
#
# Usage:
#   bash scripts/setup_dev_env.sh [--with-external]
#
#   --with-external   after setup, clone + set up the accompanying AutoDev repos
#                     (pixel-office, autodev-app) into external/ (git-ignored).
#
# Env toggles (all optional):
#   NODE_MAJOR=22     Node major version to install via NodeSource (must be >= 22).
#   SKIP_SYSTEM=1     Skip apt package + Node installation (assume system is ready).
#   SKIP_BUILD=1      Skip `npm ci` / build inside the repo.
#   SKIP_BROWSER=1    Skip browser provisioning even if a Playwright dep is present.
#
set -euo pipefail

# --- config ---------------------------------------------------------------
NODE_MAJOR="${NODE_MAJOR:-22}"
SKIP_SYSTEM="${SKIP_SYSTEM:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_BROWSER="${SKIP_BROWSER:-0}"
export DEBIAN_FRONTEND=noninteractive

# --- arg parsing (env toggles above still all work) ------------------------
WITH_EXTERNAL=0
for arg in "$@"; do
  case "$arg" in
    --with-external) WITH_EXTERNAL=1 ;;
    -h|--help)
      echo "Usage: $0 [--with-external]"
      echo "  --with-external   after setup, clone + set up the accompanying AutoDev repos into external/"
      exit 0 ;;
    *) ;;  # ignore unknown args gracefully
  esac
done

# Resolve the repo root (this script lives in <repo>/scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# sudo only if not already root.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

section() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
info()    { printf '    %s\n' "$1"; }

# --- 1. system packages ---------------------------------------------------
install_system() {
  section "Installing base system packages (build tools, git, curl, unzip)"
  $SUDO apt-get update -y
  $SUDO apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    git \
    unzip \
    build-essential
  info "Base packages installed."

  section "Installing Node.js ${NODE_MAJOR}.x via NodeSource"
  if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "${NODE_MAJOR}" ]; then
    info "Node $(node --version) already present (>= ${NODE_MAJOR}); skipping NodeSource install."
  else
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
    info "Installed Node $(node --version), npm $(npm --version)."
  fi
}

# --- 2. project build -----------------------------------------------------
build_project() {
  section "Installing npm dependencies (npm ci)"
  cd "${REPO_DIR}"
  if [ -f package-lock.json ]; then
    npm ci || { info "npm ci failed; falling back to npm install"; npm install; }
  else
    info "No package-lock.json; using npm install"
    npm install
  fi

  section "Building the CLI (npm run build -> ./out)"
  npm run build
  info "Build complete."
}

# --- 3. optional browser (only if a Playwright dep actually exists) -------
maybe_install_browser() {
  cd "${REPO_DIR}"
  if [ "${SKIP_BROWSER}" = "1" ]; then
    section "Skipping browser provisioning (SKIP_BROWSER=1)"
    return 0
  fi
  if grep -q '"playwright' package.json 2>/dev/null; then
    section "Playwright dependency detected — installing Chromium browser"
    npx playwright install --with-deps chromium
    info "Chromium provisioned for tests."
  else
    section "No Playwright dependency — tests need no browser, skipping browser provisioning"
  fi
}

# --- optional: clone + set up accompanying AutoDev repos into external/ ----
# The OTHER product repos that pair with this one. Edit freely (name -> git url).
declare -A EXTERNAL_REPOS=(
  [pixel-office]="https://github.com/autoaidev/pixel-office.git"
  [autodev-app]="https://github.com/autoaidev/autodev-app.git"
)

setup_external_repos() {
  local root
  root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

  echo ""
  echo "=================================================="
  echo " Cloning accompanying repos into external/"
  echo "=================================================="

  mkdir -p "${root}/external"

  # Ensure external/ is git-ignored (idempotent — add the line at most once).
  if [ -f "${root}/.gitignore" ] && grep -qxF 'external/' "${root}/.gitignore"; then
    echo "  .gitignore already ignores external/"
  else
    echo 'external/' >> "${root}/.gitignore"
    echo "  Added 'external/' to .gitignore"
  fi

  local name url dir found
  for name in "${!EXTERNAL_REPOS[@]}"; do
    url="${EXTERNAL_REPOS[$name]}"
    dir="${root}/external/${name}"
    echo ""
    echo "--- ${name} (${url}) ---"
    if [ -d "${dir}/.git" ]; then
      echo "  Exists — pulling latest (ff-only)"
      git -C "${dir}" pull --ff-only || true
    else
      echo "  Cloning..."
      git clone "${url}" "${dir}" || { echo "  ! clone failed for ${name} — skipping"; continue; }
    fi

    # Run the repo's own setup script if present. Pass SKIP_SYSTEM=1 (avoid redundant
    # apt installs) and NEVER pass --with-external so this does not recurse.
    found=""
    if [ -f "${dir}/scripts/setup_dev_env.sh" ]; then
      found="setup_dev_env.sh"
    elif [ -f "${dir}/scripts/install_dev_env.sh" ]; then
      found="install_dev_env.sh"
    fi
    if [ -n "${found}" ]; then
      echo "  Running scripts/${found} (SKIP_SYSTEM=1)"
      ( cd "${dir}" && SKIP_SYSTEM=1 bash "scripts/${found}" ) || echo "  ! setup failed for ${name} (continuing)"
    else
      echo "  No setup script in ${name}/scripts — skipping setup"
    fi
  done

  echo ""
  echo "  External repos ready under ${root}/external/"
}

# --- run ------------------------------------------------------------------
section "autodev-cli dev/CI environment setup"
info "Repo:        ${REPO_DIR}"
info "Node major:  ${NODE_MAJOR}"
info "SKIP_SYSTEM=${SKIP_SYSTEM}  SKIP_BUILD=${SKIP_BUILD}  SKIP_BROWSER=${SKIP_BROWSER}"

if [ "${SKIP_SYSTEM}" = "1" ]; then
  section "Skipping system package installation (SKIP_SYSTEM=1)"
else
  install_system
fi

if [ "${SKIP_BUILD}" = "1" ]; then
  section "Skipping project build (SKIP_BUILD=1)"
else
  build_project
  maybe_install_browser
fi

# --- summary --------------------------------------------------------------
section "Environment ready"
if command -v node >/dev/null 2>&1; then
  info "Node: $(node --version)   npm: $(npm --version)"
fi
info "Repo:      ${REPO_DIR}"
info "Build out: ${REPO_DIR}/out"
info ""
info "Run the test suite with:"
info "    npm test"

if [ "${WITH_EXTERNAL}" = "1" ]; then
  setup_external_repos
fi
