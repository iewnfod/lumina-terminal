#!/usr/bin/env bash
#
# install.sh — Lumina Terminal one-shot installer
#
#   curl -fsSL https://raw.githubusercontent.com/iewnfod/lumina-terminal/master/scripts/install.sh | bash
#   # or to skip the confirmation prompt:
#   curl -fsSL https://raw.githubusercontent.com/iewnfod/lumina-terminal/master/scripts/install.sh | bash -s -- -y
#
# Usage: install.sh [-y] [--help]
#   -y, --yes   Skip the confirmation prompt (assume yes)
#   -h, --help  Show this help and exit
#   LUMINA_VERSION=v0.1.1   Pin a specific release tag instead of the latest
#
# Supported platforms:
#   • macOS           — downloads the .dmg and copies the app into /Applications
#   • Debian & derivs — downloads the .deb and installs it (apt pulls deps)
#   • Red Hat / CentOS / Fedora / Rocky / Alma & derivs
#                     — downloads the .rpm and installs it (dnf/yum pulls deps)
#   • Arch & derivs   — installs the published AUR package (lumina-terminal-bin)
#                       via paru/yay, falling back to git clone + makepkg -si
# Linux ARM64 (aarch64) is supported on all three Linux paths.
#
# Asset names are read dynamically from the GitHub Releases API, so this keeps
# working even if the product-name punctuation or the tag/version scheme changes.

set -euo pipefail

REPO="iewnfod/lumina-terminal"
APP_NAME="Lumina Terminal"
APP_ID="lumina-terminal"            # binary name inside the package / Icon= key
MAC_APP="Lumina Terminal.app"
# The AUR package published by .github/workflows/aur.yml. install_arch() pulls
# it through whichever AUR helper (or plain pacman) the user has — no local
# rebuild of the .deb anymore.
AUR_PKG="lumina-terminal-bin"
ASSUME_YES=0                        # set by -y / --yes

# ---- color helpers ----------------------------------------------------------
if [[ -t 1 ]]; then
	C_RESET=$'\033[0m'; BOLD=$'\033[1m'
	C_RED=$'\033[31m';  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
	C_RESET=""; BOLD=""
	C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_CYAN=""
fi

log()  { printf "%s▸%s %s\n"  "$C_CYAN"   "$C_RESET" "$*"; }
warn() { printf "%s▸%s %s%s%s\n" "$C_YELLOW" "$C_RESET" "$C_YELLOW" "$*" "$C_RESET" 1>&2; }
err()  { printf "%s✗%s %s%s%s\n" "$C_RED"    "$C_RESET" "$C_RED"   "$*" "$C_RESET" 1>&2; }
die()  { err "$*"; exit 1; }

# Ask a yes/no question that defaults to YES (Enter = yes). Honors -y.
# Always reads from /dev/tty so it works even when the script body is piped
# via curl (where stdin is the pipe, not the user's terminal). Non-interactive
# callers should pass -y, since there is no TTY to answer from in CI.
confirm_yes() { # <question>
	[[ "$ASSUME_YES" -eq 1 ]] && return 0
	if [[ ! -t 0 && ! -e /dev/tty ]]; then
		die "No TTY available for confirmation. Re-run with -y to auto-confirm."
	fi
	local reply
	read -r -p "$1 [Y/n] " reply </dev/tty
	# empty = yes; anything starting with n/N = no; else yes
	[[ "${reply:-}" =~ ^[Nn] ]] && return 1
	return 0
}

# ---- dependency checks ------------------------------------------------------
need_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "Required command not found: '$1'. Please install it and re-run."
}

ensure_curl() { need_cmd curl; }
ensure_jq_or_py() {
	if command -v jq >/dev/null 2>&1; then return; fi
	if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then return; fi
	die "Neither 'jq' nor 'python' is available — need one to parse the GitHub release API."
}

# ---- GitHub API -------------------------------------------------------------
API_JSON=""

# Resolve the release to install. Honors $LUMINA_VERSION (e.g. "v0.1.1" or
# "v0.1.1-fix"); defaults to the latest published release.
fetch_release() {
	local url
	if [[ -n "${LUMINA_VERSION:-}" ]]; then
		url="https://api.github.com/repos/${REPO}/releases/tags/${LUMINA_VERSION}"
		log "Fetching release ${LUMINA_VERSION}…"
	else
		url="https://api.github.com/repos/${REPO}/releases/latest"
		log "Fetching latest release…"
	fi
	API_JSON="$(curl -fsSL "$url")" || die "Failed to reach GitHub API. Check network / tag name."
	[[ -n "$API_JSON" ]] || die "Empty response from GitHub API."
}

# Pick a value from the release JSON using jq if available, else python.
json_get() { # <jq-path>
	local path="$1"
	if command -v jq >/dev/null 2>&1; then
		jq -r "$path" <<<"$API_JSON"
	else
		python -c '
import json, sys
# strict=False tolerates raw control chars (e.g. \r) that GitHub leaves in
# the release "body" field — jq accepts them, strict-mode python does not.
data = json.load(sys.stdin, strict=False)
p = sys.argv[1].lstrip(".")
val = data
for part in p.replace("[", ".[").split("."):
	if part == "": continue
	if part.startswith("[") and part.endswith("]"):
		val = val[int(part[1:-1])]
	else:
		val = val[part]
print("" if val is None else val)
' "$path" <<<"$API_JSON"
	fi
}

# Return the browser_download_url of the first asset whose name matches a regex.
asset_url() { # <regex>
	local re="$1"
	if command -v jq >/dev/null 2>&1; then
		jq -r --arg re "$re" '.assets[] | select(.name | test($re)) | .browser_download_url' <<<"$API_JSON"
	else
		python -c '
import json, sys, re
data = json.load(sys.stdin, strict=False)
rx = re.compile(sys.argv[1])
for a in data.get("assets", []):
	if rx.search(a.get("name", "")):
		print(a["browser_download_url"])
' "$re" <<<"$API_JSON"
	fi
}

# ---- shared download helper -------------------------------------------------
download() { # <url> <dest>
	curl -fL --retry 3 -o "$2" "$1" || die "Download failed: $1"
}

# ---- Linux architecture mapping ---------------------------------------------
# Asset suffixes differ by ecosystem:
#   • deb filenames use dpkg arch names  → amd64 / arm64
#   • rpm filenames use rpm arch names   → x86_64 / aarch64
#   • macOS dmg uses Rust triple suffix   → x64 / aarch64
# (Arch installs the published AUR package, so it has no per-arch asset suffix
#  to resolve.)
# Resolve once from `uname -m` so each installer picks the right asset.
LINUX_DEB_ARCH=""    # amd64 | arm64
LINUX_RPM_ARCH=""    # x86_64 | aarch64
resolve_linux_arch() {
	case "$(uname -m)" in
		x86_64)  LINUX_DEB_ARCH="amd64";  LINUX_RPM_ARCH="x86_64"  ;;
		aarch64|arm64) LINUX_DEB_ARCH="arm64"; LINUX_RPM_ARCH="aarch64" ;;
		*) die "Unsupported Linux architecture: $(uname -m). Supported: x86_64, aarch64/arm64." ;;
	esac
}

# ============================================================================
#  macOS
# ============================================================================
install_macos() {
	log "Detected ${BOLD}macOS${C_RESET}. Installing from .dmg."

	local arch
	arch="$(uname -m)"
	local dmg_re
	case "$arch" in
		arm64) dmg_re='_aarch64\.dmg$' ;;
		x86_64) dmg_re='_x64\.dmg$' ;;
		*) die "Unsupported macOS architecture: $arch" ;;
	esac

	local dmg_url
	dmg_url="$(asset_url "$dmg_re" | head -n1)"
	[[ -n "$dmg_url" ]] || die "No .dmg asset matching $arch found in the release."

	local tmpdir mountpoint=""
	tmpdir="$(mktemp -d)"
	# tmpdir is captured into the trap string now (set -e may tear down the
	# function frame before EXIT, leaving the local unbound under set -u).
	# mountpoint is set later, so it's evaluated dynamically with a safe default.
	trap "cleanup_macos '$tmpdir' \"\${mountpoint:-}\"" EXIT

	local dmg="$tmpdir/Lumina.dmg"
	log "Downloading $dmg_url"
	download "$dmg_url" "$dmg"

	log "Mounting disk image…"
	mountpoint="$(hdiutil attach -nobrowse -noautoopen "$dmg" | sed -n 's/.*\(\/Volumes\/.*\).*/\1/p' | tail -n1)"
	[[ -n "${mountpoint:-}" ]] || die "Failed to mount the disk image."

	local src="$mountpoint/$MAC_APP"
	[[ -d "$src" ]] || die "$MAC_APP not found inside the mounted disk image."

	local dest="/Applications/$MAC_APP"
	if [[ -d "$dest" ]]; then
		warn "An existing copy exists at $dest — replacing it."
		rm -rf "$dest"
	fi

	log "Copying $MAC_APP to /Applications …"
	cp -R "$src" "$dest"
	xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true

	printf "%s✓%s %s installed into /Applications%s\n" "$C_GREEN" "$C_RESET" "$BOLD$APP_NAME$C_RESET" "$C_RESET"
	echo "  Open it from Launchpad, or run:  open -a \"$APP_NAME\""
}

cleanup_macos() { # <tmpdir> <mountpoint>
	if [[ -n "${2:-}" && -d "$2" ]]; then
		hdiutil detach "$2" >/dev/null 2>&1 || true
	fi
	if [[ -n "${1:-}" && -d "$1" ]]; then
		rm -rf "$1" || true
	fi
}

# ============================================================================
#  Debian & derivatives
# ============================================================================
install_debian() {
	log "Detected ${BOLD}Debian-based${C_RESET} Linux (${LINUX_DEB_ARCH}). Installing the .deb."

	local deb_url
	deb_url="$(asset_url "_${LINUX_DEB_ARCH}\.deb\$" | head -n1)"
	[[ -n "$deb_url" ]] || die "No .deb asset for ${LINUX_DEB_ARCH} found in the release."

	local tmpdir
	tmpdir="$(mktemp -d)"
	# Capture the path into the trap string now; see install_arch for rationale.
	trap "rm -rf '$tmpdir'" EXIT

	local deb="$tmpdir/lumina-terminal.deb"
	log "Downloading $deb_url"
	download "$deb_url" "$deb"

	# `apt install ./file.deb` resolves runtime deps automatically (apt >= 1.1).
	# Fall back to dpkg + apt-get -f on older/minimal systems.
	if command -v apt >/dev/null 2>&1; then
		log "Installing with apt (will pull runtime dependencies)…"
		sudo apt install -y "$deb"
	elif command -v apt-get >/dev/null 2>&1; then
		log "Installing with apt-get (will pull runtime dependencies)…"
		sudo apt-get install -y "$deb"
	else
		log "apt not found — using dpkg directly, then fixing dependencies…"
		sudo dpkg -i "$deb" || true
		sudo apt-get install -f -y || warn "Could not auto-resolve dependencies. Run: sudo apt-get install -f"
	fi

	printf "%s✓%s %s installed%s\n" "$C_GREEN" "$C_RESET" "$BOLD$APP_NAME$C_RESET" "$C_RESET"
	echo "  Start it from your application menu, or run:  $APP_ID"
}

# ============================================================================
#  Red Hat, CentOS, Fedora, Rocky, Alma & derivatives
# ============================================================================
install_redhat() {
	log "Detected ${BOLD}RPM-based${C_RESET} Linux (${LINUX_RPM_ARCH}). Installing the .rpm."

	local rpm_url
	rpm_url="$(asset_url "\.${LINUX_RPM_ARCH}\.rpm\$" | head -n1)"
	[[ -n "$rpm_url" ]] || die "No .rpm asset for ${LINUX_RPM_ARCH} found in the release."

	local tmpdir
	tmpdir="$(mktemp -d)"
	# Capture the path into the trap string now; see install_arch for rationale.
	trap "rm -rf '$tmpdir'" EXIT

	local rpm="$tmpdir/lumina-terminal.rpm"
	log "Downloading $rpm_url"
	download "$rpm_url" "$rpm"

	# `dnf install ./file.rpm` (and `yum install ./file.rpm`) resolve runtime
	# deps from enabled repos automatically. Fall back to rpm directly on
	# minimal systems where neither dnf nor yum is present.
	if command -v dnf >/dev/null 2>&1; then
		log "Installing with dnf (will pull runtime dependencies)…"
		sudo dnf install -y "$rpm"
	elif command -v yum >/dev/null 2>&1; then
		log "Installing with yum (will pull runtime dependencies)…"
		sudo yum install -y "$rpm"
	else
		log "dnf/yum not found — using rpm directly; dependencies may be missing…"
		sudo rpm -Uvh --force "$rpm" || warn "rpm install failed. Install webkit2gtk4.1 / gtk3 manually and retry."
	fi

	printf "%s✓%s %s installed%s\n" "$C_GREEN" "$C_RESET" "$BOLD$APP_NAME$C_RESET" "$C_RESET"
	echo "  Start it from your application menu, or run:  $APP_ID"
}

# ============================================================================
#  Arch & derivatives — install the published AUR package
# ============================================================================
install_arch() {
	log "Detected ${BOLD}Arch-based${C_RESET} Linux. Installing the AUR package ${BOLD}$AUR_PKG${C_RESET}."

	# Prefer an installed AUR helper (it resolves deps and signs/offline-builds
	# the AUR package the way the user expects). Fall back to the universal
	# `pacman -S` path for paru/yay users' repo cache, and finally to a manual
	# `git clone + makepkg -si` for stock Arch without any helper.
	#
	# We pass - --noconfirm through helpers but keep --needed so re-running the
	# installer on an already-installed system is a no-op instead of an error.
	local helper=""
	if   command -v paru >/dev/null 2>&1; then helper="paru"
	elif command -v yay  >/dev/null 2>&1; then helper="yay"
	fi

	if [[ -n "$helper" ]]; then
		log "Using AUR helper: $helper"
		if $helper -S --noconfirm --needed "$AUR_PKG"; then
			: # installed
		else
			die "$helper -S $AUR_PKG failed. You can retry manually:\n    $helper -S $AUR_PKG"
		fi
	else
		# No helper: clone the AUR repo and build it with makepkg. This needs
		# base-devel; if makepkg is missing we stop here rather than guessing.
		need_cmd makepkg
		need_cmd git

		local workdir
		workdir="$(mktemp -d "${TMPDIR:-/tmp}/lumina-aur.XXXXXX")"
		# Capture the path INTO the trap string (expand now) rather than
		# referencing the local var at EXIT time: if a subshell fails under
		# `set -e`, the function frame is already torn down and the local is
		# unbound under `set -u`.
		trap "rm -rf '$workdir'" EXIT
		chmod 755 "$workdir"

		log "Cloning $AUR_PKG from AUR…"
		if ! git clone --depth=1 "https://aur.archlinux.org/${AUR_PKG}.git" "$workdir/$AUR_PKG"; then
			die "Failed to clone $AUR_PKG from AUR. Check your connection or install an AUR helper (paru/yay)."
		fi

		log "Building with makepkg…"
		if ! ( cd "$workdir/$AUR_PKG" && makepkg -si --noconfirm --needed ); then
			die "makepkg failed. You can retry manually:\n    cd \"$workdir/$AUR_PKG\" && makepkg -si"
		fi
	fi

	printf "%s✓%s %s installed from AUR%s\n" "$C_GREEN" "$C_RESET" "$BOLD$APP_NAME$C_RESET" "$C_RESET"
	echo "  Start it from your application menu, or run:  $APP_ID"
	echo "  Upgrade later with:  ${helper:-paru/yay} -Syu $AUR_PKG    (or re-run this script)"
	echo "  Uninstall with:      sudo pacman -R $AUR_PKG"
}

# ============================================================================
#  Platform detection & dispatch
# ============================================================================
detect_platform() {
	case "$(uname -s)" in
		Darwin) echo "macos" ;;
		Linux)
			if [[ -f /etc/arch-release ]]; then
				echo "arch"
			elif command -v pacman >/dev/null 2>&1 && ! command -v apt >/dev/null 2>&1; then
				# pacman present without apt: EndeavourOS, Manjaro, etc.
				echo "arch"
			elif [[ -f /etc/redhat-release || -f /etc/fedora-release ]] \
				|| { command -v rpm >/dev/null 2>&1 && ! command -v dpkg >/dev/null 2>&1; }; then
				# Red Hat / CentOS / Fedora / Rocky / Alma; rpm present without dpkg.
				echo "redhat"
			elif command -v dpkg >/dev/null 2>&1 || command -v apt-get >/dev/null 2>&1; then
				echo "debian"
			else
				echo "unknown"
			fi
			;;
		*) echo "unknown" ;;
	esac
}

usage() {
	sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//' >&2
}

main() {
	# ---- argument parsing ----
	while [[ $# -gt 0 ]]; do
		case "$1" in
			-y|--yes) ASSUME_YES=1; shift ;;
			-h|--help) usage; exit 0 ;;
			--) shift; break ;;
			-*) err "Unknown option: $1"; usage; exit 2 ;;
			*) break ;;
		esac
	done

	echo "${BOLD}Lumina Terminal Installer${C_RESET}"
	echo

	ensure_curl
	ensure_jq_or_py

	local platform
	platform="$(detect_platform)"

	# Resolve the Linux deb/rpm arch suffix once for the deb/rpm-based paths.
	# Arch no longer needs a suffix — it installs the published AUR package.
	[[ "$platform" == "debian" || "$platform" == "redhat" ]] && resolve_linux_arch

	if [[ "$platform" == "unknown" ]]; then
		cat >&2 <<EOF
${C_RED}Unsupported platform.${C_RESET}
This installer supports:
  • macOS  (.dmg)
  • Debian / Ubuntu and derivatives  (.deb)
  • Red Hat / CentOS / Fedora / Rocky / Alma and derivatives  (.rpm)
  • Arch / Manjaro / EndeavourOS and derivatives  (AUR package: $AUR_PKG)
EOF
		exit 1
	fi

	# Fetch the release up front so we can show what will be installed and
	# let the user confirm before touching the system.
	# macOS needs hdiutil to mount the .dmg. The Arch path installs the AUR
	# package and doesn't need any asset-specific tool up front — its own
	# helper-or-makepkg fallback handles tool checks at run time.
	case "$platform" in
		macos) need_cmd hdiutil ;;
	esac
	# Arch doesn't consume the release assets directly, but we still fetch the
	# JSON so the "Version" line below shows the same tag the AUR package tracks.
	fetch_release

	local tag asset_kind target_file
	tag="$(json_get '.tag_name')"
	case "$platform" in
		macos)
			local arch dmg_re
			arch="$(uname -m)"
			case "$arch" in
				arm64) dmg_re='_aarch64\.dmg$' ;;
				x86_64) dmg_re='_x64\.dmg$' ;;
				*) die "Unsupported macOS architecture: $arch" ;;
			esac
			target_file="$(asset_url "$dmg_re" | head -n1 | sed 's#.*/##')"
			asset_kind="disk image"
			;;
		debian)
			target_file="$(asset_url "_${LINUX_DEB_ARCH}\.deb\$" | head -n1 | sed 's#.*/##')"
			asset_kind=".deb package"
			;;
		redhat)
			target_file="$(asset_url "\.${LINUX_RPM_ARCH}\.rpm\$" | head -n1 | sed 's#.*/##')"
			asset_kind=".rpm package"
			;;
		arch)
			target_file=""
			asset_kind="AUR package ($AUR_PKG)"
			;;
	esac
	if [[ "$platform" != "arch" ]]; then
		[[ -n "$target_file" ]] || die "No matching release asset found."
	fi

	echo "${BOLD}Ready to install:${C_RESET}"
	echo "  ${BOLD}App${C_RESET}      $APP_NAME"
	echo "  ${BOLD}Version${C_RESET}  $tag"
	# Arch installs the AUR package, not a release asset — skip the Asset line.
	if [[ "$platform" != "arch" ]]; then
		echo "  ${BOLD}Asset${C_RESET}    $target_file"
	else
		echo "  ${BOLD}Package${C_RESET}  $AUR_PKG"
	fi
	echo "  ${BOLD}Method${C_RESET}   $asset_kind"
	echo

	if ! confirm_yes "Proceed with installation?"; then
		echo "Aborted."
		exit 0
	fi
	echo

	case "$platform" in
		macos) install_macos ;;
		debian) install_debian ;;
		redhat) install_redhat ;;
		arch)   install_arch ;;
	esac
}

main "$@"
