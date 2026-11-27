#!/usr/bin/env bash
# detect-easyeda-cli.sh
#
# Locate EasyEDA Pro / JLCEDA Pro desktop-client installations and identify
# which distribution is installed. Supports Linux, macOS and Windows
# (Git Bash / MSYS2 / Cygwin / WSL).
#
# Only these executables are considered CLI-capable:
#   lceda-pro   -> mainland China edition (嘉立创EDA专业版)
#   easyeda-pro -> international edition (EasyEDA Pro)
# Legacy standard editions (lceda.exe / easyeda.exe 6.x) are ignored, and
# uninstallers / simulation engines are never executed.
#
# Usage:
#   bash detect-easyeda-cli.sh [--json] [--text] [--no-probe] [--doctor]
#                              [--timeout SECONDS]
#
# Output: a single JSON object on stdout by default. Exit 0 when at least one
# installation is found, 1 when none is found, 2 on usage errors.

set -u

PROBE_TIMEOUT=20
OUTPUT_MODE=json
PROBE=1
DOCTOR=0
MAX_PROBE=8

usage() {
  cat <<'EOF'
Usage: bash detect-easyeda-cli.sh [options]

Options:
  --json            Print JSON (default)
  --text            Print a human-readable summary
  --no-probe        Do not run `<exe> --help` (faster; version may be unknown)
  --doctor          Also run `<exe> doctor` to probe the running bridge
  --timeout SEC     Per-probe timeout in seconds (default: 20)
  -h, --help        Show this help

Exit codes: 0 = installation found, 1 = none found, 2 = usage error.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --json) OUTPUT_MODE=json ;;
    --text) OUTPUT_MODE=text ;;
    --no-probe) PROBE=0 ;;
    --doctor) DOCTOR=1 ;;
    --timeout)
      shift
      [ $# -gt 0 ] || { echo "Missing value for --timeout" >&2; exit 2; }
      PROBE_TIMEOUT="$1"
      ;;
    --timeout=*) PROBE_TIMEOUT="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

case "$PROBE_TIMEOUT" in
  ''|*[!0-9]*)
    echo "Invalid --timeout value: $PROBE_TIMEOUT" >&2
    exit 2
    ;;
esac

TMPD=$(mktemp -d 2>/dev/null || mktemp -d -t easyeda-detect)
trap 'rm -rf "$TMPD"' EXIT INT TERM
RECORDS="$TMPD/records"
UNIQUE="$TMPD/unique"
RESULTS="$TMPD/results"
WARNINGS="$TMPD/warnings"
: > "$RECORDS"
: > "$WARNINGS"
: > "$RESULTS"

# ---------------------------------------------------------------- basics ----

OS=unknown
case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux*) OS=linux ;;
  Darwin*) OS=macos ;;
  MINGW*|MSYS*|CYGWIN*) OS=windows ;;
esac

WSL=0
if [ "$OS" = linux ] && [ -r /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
  WSL=1
fi

ARCH=$(uname -m 2>/dev/null || echo unknown)
case "$ARCH" in
  x86_64|amd64|AMD64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  i386|i686) ARCH=x86 ;;
esac

now_utc() {
  date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo ""
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

base_name() {
  printf '%s' "$1" | sed 's:.*/::'
}

# Convert a Windows-style path (C:\...) to a shell path when possible.
to_posix() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$1" 2>/dev/null || printf '%s' "$1"
  else
    printf '%s' "$1"
  fi
}

# Emit a forward-slash path suitable for JSON and for CLI arguments.
to_output() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1" 2>/dev/null || printf '%s' "$1"
  else
    printf '%s' "$1"
  fi
}

canon() {
  if command -v realpath >/dev/null 2>&1; then
    local rp
    rp=$(realpath "$1" 2>/dev/null) && { printf '%s' "$rp"; return 0; }
  fi
  local d b
  d=$(cd "$(dirname "$1")" 2>/dev/null && pwd -P) || return 1
  b=$(basename "$1")
  printf '%s/%s' "$d" "$b"
}

resolve_exe() {
  local p="$1"
  if [ "$OS" = windows ] && [ -e "$p.exe" ] && [ ! -d "$p.exe" ]; then
    printf '%s' "$p.exe"
    return 0
  fi
  if [ -e "$p" ] && [ ! -d "$p" ]; then
    printf '%s' "$p"
    return 0
  fi
  if [ -e "$p.exe" ] && [ ! -d "$p.exe" ]; then
    printf '%s' "$p.exe"
    return 0
  fi
  return 1
}

json_escape() {
  printf '%s' "$1" \
    | tr -d '\r' \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
    | awk 'BEGIN { ORS = "" } NR > 1 { printf "\\n" } { print }'
}

json_string() {
  printf '"%s"' "$(json_escape "$1")"
}

sanitize_field() {
  printf '%s' "$1" | tr '\t\n\r\037' '    '
}

# ------------------------------------------------------------- discovery ----

# Distribution id from an exact executable name (lceda-pro / easyeda-pro).
classify_exe() {
  local b
  b=$(lower "$(base_name "$1")")
  b=${b%.exe}
  case "$b" in
    lceda-pro) printf 'lceda-pro' ;;
    easyeda-pro) printf 'easyeda-pro' ;;
  esac
}

# Distribution id from an AppImage file name (versioned names allowed).
classify_appimage() {
  local b
  b=$(lower "$(base_name "$1")")
  case "$b" in
    *unins*|*server*|*sim*) return 0 ;;
  esac
  b=${b%.appimage}
  case "$b" in
    lceda-pro|lceda-pro[-_.]*) printf 'lceda-pro' ;;
    easyeda-pro|easyeda-pro[-_.]*) printf 'easyeda-pro' ;;
  esac
}

dist_edition() {
  case "$1" in
    lceda-pro) printf 'mainland' ;;
    easyeda-pro) printf 'international' ;;
    *) printf 'unknown' ;;
  esac
}

dist_product() {
  case "$1" in
    lceda-pro) printf 'JLCEDA Pro' ;;
    easyeda-pro) printf 'EasyEDA Pro' ;;
    *) printf 'EasyEDA Pro' ;;
  esac
}

add_candidate() { # source, path, [distribution]
  local src="$1" raw="$2" dist="${3:-}" p base
  [ -n "$raw" ] || return 0
  raw=$(printf '%s' "$raw" | tr -d '\r' | sed -e 's/^"//' -e 's/"$//')
  p=$(resolve_exe "$raw") || return 0
  base=$(lower "$(base_name "$p")")
  case "$base" in
    unins*|*uninstall*|*server*|*sim.exe) return 0 ;;
  esac
  if [ -z "$dist" ]; then
    dist=$(classify_exe "$p")
  fi
  [ -n "$dist" ] || return 0
  p=$(canon "$p") || p="$p"
  if awk -F'\t' -v p="$p" '$2 == p { found = 1 } END { exit !found }' "$RECORDS" 2>/dev/null; then
    return 0
  fi
  printf '%s\t%s\t%s\n' "$src" "$p" "$dist" >> "$RECORDS"
}

warn() {
  printf '%s\n' "$1" >> "$WARNINGS"
}

# 1) Anything already on PATH (this is what a bare `lceda-pro` resolves to).
for cmd in lceda-pro easyeda-pro; do
  hit=$(command -v "$cmd" 2>/dev/null) || continue
  case "$hit" in
    /*|[A-Za-z]:[\\/]*) add_candidate "path" "$hit" ;;
  esac
done

# 2) Platform-specific known locations.

if [ "$OS" = windows ]; then
  PF=$(printenv ProgramFiles 2>/dev/null || true)
  [ -n "$PF" ] || PF='C:\Program Files'
  PF86=$(printenv 'ProgramFiles(x86)' 2>/dev/null || true)
  PF_X=$(to_posix "$PF")
  PF86_X=""
  [ -n "$PF86" ] && PF86_X=$(to_posix "$PF86")
  LOCALAPPDATA_X=""
  if [ -n "${LOCALAPPDATA:-}" ]; then
    LOCALAPPDATA_X=$(to_posix "$LOCALAPPDATA")
  elif [ -n "${USERPROFILE:-}" ]; then
    LOCALAPPDATA_X="$USERPROFILE/AppData/Local"
  fi

  ROOTS="$PF_X"
  [ -n "$PF86_X" ] && ROOTS="$ROOTS|$PF86_X"
  OLD_IFS=$IFS
  IFS='|'
  for root in $ROOTS; do
    for exe in lceda-pro easyeda-pro; do
      add_candidate "known-dir" "$root/$exe/$exe.exe"
      add_candidate "known-dir" "$root/JLCEDA Pro/$exe.exe"
      add_candidate "known-dir" "$root/EasyEDA Pro/$exe.exe"
    done
  done
  IFS=$OLD_IFS

  if [ -n "$LOCALAPPDATA_X" ]; then
    for exe in lceda-pro easyeda-pro; do
      add_candidate "known-dir" "$LOCALAPPDATA_X/Programs/$exe/$exe.exe"
      add_candidate "known-dir" "$LOCALAPPDATA_X/Programs/JLCEDA Pro/$exe.exe"
      add_candidate "known-dir" "$LOCALAPPDATA_X/Programs/EasyEDA Pro/$exe.exe"
    done
  fi
fi

if [ "$OS" = macos ]; then
  for base in "/Applications" "$HOME/Applications"; do
    [ -d "$base" ] || continue
    for app in "$base"/*.app; do
      [ -d "$app" ] || continue
      al=$(lower "$(base_name "$app")")
      case "$al" in
        *lceda*pro*|*easyeda*pro*|*jlc*pro*) ;;
        *) continue ;;
      esac

      exe_name=""
      plist="$app/Contents/Info.plist"
      if command -v plutil >/dev/null 2>&1 && [ -f "$plist" ]; then
        exe_name=$(plutil -extract CFBundleExecutable raw -o - "$plist" 2>/dev/null || true)
      fi
      if [ -z "$exe_name" ] && command -v defaults >/dev/null 2>&1 && [ -f "$plist" ]; then
        exe_name=$(defaults read "$app/Contents/Info" CFBundleExecutable 2>/dev/null || true)
      fi
      if [ -n "$exe_name" ]; then
        add_candidate "app-bundle" "$app/Contents/MacOS/$exe_name"
      fi
      for exe in lceda-pro easyeda-pro; do
        add_candidate "app-bundle" "$app/Contents/MacOS/$exe"
      done
    done
  done

  for p in \
    /usr/local/bin/lceda-pro /usr/local/bin/easyeda-pro \
    /opt/homebrew/bin/lceda-pro /opt/homebrew/bin/easyeda-pro \
    "$HOME/.local/bin/lceda-pro" "$HOME/.local/bin/easyeda-pro"; do
    add_candidate "known-dir" "$p"
  done
fi

if [ "$OS" = linux ] && [ "$WSL" = 0 ]; then
  for p in \
    /opt/lceda-pro/lceda-pro /opt/easyeda-pro/easyeda-pro \
    "/opt/JLCEDA Pro/lceda-pro" "/opt/EasyEDA Pro/easyeda-pro" \
    /usr/lib/lceda-pro/lceda-pro /usr/lib/easyeda-pro/easyeda-pro \
    /usr/bin/lceda-pro /usr/bin/easyeda-pro \
    /usr/local/bin/lceda-pro /usr/local/bin/easyeda-pro \
    "$HOME/.local/bin/lceda-pro" "$HOME/.local/bin/easyeda-pro"; do
    add_candidate "known-dir" "$p"
  done

  # .desktop launchers are the most reliable signal for custom install dirs.
  for d in "$HOME/.local/share/applications" /usr/share/applications /usr/local/share/applications; do
    [ -d "$d" ] || continue
    for f in "$d"/*.desktop; do
      [ -f "$f" ] || continue
      line=$(grep -m1 -iE '^(Exec|TryExec)[[:space:]]*=' "$f" 2>/dev/null || true)
      [ -n "$line" ] || continue
      case "$(lower "$line")" in
        *lceda-pro*|*easyeda-pro*) ;;
        *) continue ;;
      esac
      cmd=${line#*=}
      cmd=$(printf '%s' "$cmd" | sed -e 's/%[fFuUdDnNickvm]//g')
      # shellcheck disable=SC2086
      set -- $cmd
      while [ $# -gt 0 ]; do
        case "$1" in
          env) shift ;;
          [A-Za-z_]*=*) shift ;;
          *) break ;;
        esac
      done
      cmd="${1:-}"
      cmd=$(printf '%s' "$cmd" | sed -e 's/^"//' -e 's/"$//')
      [ -n "$cmd" ] || continue
      case "$cmd" in
        /*) add_candidate "desktop-file" "$cmd" ;;
        *)
          hp=$(command -v "$cmd" 2>/dev/null || true)
          [ -n "$hp" ] && add_candidate "desktop-file" "$hp"
          ;;
      esac
    done
  done

  # AppImages are commonly dropped in user folders.
  for d in "$HOME/Applications" "$HOME/Downloads" "$HOME/Desktop" /opt; do
    [ -d "$d" ] || continue
    for f in \
      "$d"/*lceda*.AppImage "$d"/*Lceda*.AppImage "$d"/*LCEDA*.AppImage \
      "$d"/*easyeda*.AppImage "$d"/*EasyEDA*.AppImage; do
      [ -f "$f" ] || continue
      dist=$(classify_appimage "$f")
      [ -n "$dist" ] || continue
      add_candidate "appimage" "$f" "$dist"
    done
  done
fi

# 3) WSL: the Windows client is reachable through /mnt/c.
if [ "$WSL" = 1 ]; then
  for root in "/mnt/c/Program Files" "/mnt/c/Program Files (x86)"; do
    [ -d "$root" ] || continue
    for exe in lceda-pro easyeda-pro; do
      add_candidate "wsl-windows" "$root/$exe/$exe.exe"
      add_candidate "wsl-windows" "$root/JLCEDA Pro/$exe.exe"
      add_candidate "wsl-windows" "$root/EasyEDA Pro/$exe.exe"
    done
  done
  for exe in lceda-pro easyeda-pro; do
    add_candidate "wsl-windows" "/mnt/c/Users/$USER/AppData/Local/Programs/$exe/$exe.exe"
  done
fi

# --------------------------------------------------------------- probing ----

run_with_timeout() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
    return $?
  fi

  "$@" &
  local pid=$!
  (
    sleep "$secs"
    kill -TERM "$pid" 2>/dev/null
    sleep 1
    kill -KILL "$pid" 2>/dev/null
  ) >/dev/null 2>&1 &
  local watcher=$!
  wait "$pid"
  local rc=$?
  kill -TERM "$watcher" 2>/dev/null
  return $rc
}

PROBE_RC=0
PROBE_HEADER=""
PROBE_VERSION=""
PROBE_OK=0
PROBE_ERR=""

probe_exe() {
  local exe="$1" out header
  PROBE_RC=0
  PROBE_HEADER=""
  PROBE_VERSION=""
  PROBE_OK=0
  PROBE_ERR=""

  out=$(run_with_timeout "$PROBE_TIMEOUT" "$exe" --help 2>&1)
  PROBE_RC=$?
  out=$(printf '%s' "$out" | tr -d '\r')

  if [ "$PROBE_RC" -eq 0 ] && printf '%s\n' "$out" | grep -qE '^(Usage:|Commands:)'; then
    PROBE_OK=1
    header=$(printf '%s\n' "$out" | sed -n '1,12p' | grep -m1 -E '(JLCEDA|EasyEDA|EASYEDA|JLCEDA)[^0-9]*[0-9]' || true)
    if [ -z "$header" ]; then
      header=$(printf '%s\n' "$out" | sed -n '/[^[:space:]]/{p;q;}')
    fi
    header=$(printf '%s' "$header" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    PROBE_HEADER="$header"
    PROBE_VERSION=$(printf '%s' "$PROBE_HEADER" | sed -E 's/^.*[[:space:]]+([0-9][0-9A-Za-z._-]*)$/\1/')
    if [ "$PROBE_VERSION" = "$PROBE_HEADER" ]; then
      PROBE_VERSION=""
    fi
  else
    PROBE_ERR=$(printf '%s\n' "$out" | sed -n '/[^[:space:]]/{p;q;}')
    [ -n "$PROBE_ERR" ] || PROBE_ERR="probe failed (exit $PROBE_RC)"
  fi
}

read_build_id() {
  local f
  f="$(dirname "$1")/version"
  if [ -f "$f" ]; then
    head -n 1 "$f" 2>/dev/null | tr -d '\r'
  fi
}

version_gt() { # exit 0 when $1 > $2
  awk -v a="$1" -v b="$2" 'BEGIN {
    if (a == b) exit 1
    na = split(a, A, /[^0-9]+/)
    nb = split(b, B, /[^0-9]+/)
    n = (na > nb ? na : nb)
    for (i = 1; i <= n; i++) {
      x = (i <= na ? A[i] + 0 : 0)
      y = (i <= nb ? B[i] + 0 : 0)
      if (x > y) exit 0
      if (x < y) exit 1
    }
    exit 1
  }'
}

version_ge_4_1_70() {
  local v="$1"
  [ -n "$v" ] || return 0
  awk -v v="$v" 'BEGIN {
    n = split(v, A, /[^0-9]+/)
    major = (n >= 1 ? A[1] + 0 : 0)
    minor = (n >= 2 ? A[2] + 0 : 0)
    patch = (n >= 3 ? A[3] + 0 : 0)
    if (major > 4) exit 0
    if (major < 4) exit 1
    if (minor > 1) exit 0
    if (minor < 1) exit 1
    if (patch >= 70) exit 0
    exit 1
  }'
}

# --------------------------------------------------------------- results ----

awk -F'\t' '!seen[$2]++' "$RECORDS" > "$UNIQUE" 2>/dev/null || : > "$UNIQUE"

TOTAL=0
BEST_PATH_LINE=""
BEST_ANY_LINE=""
FIRST_LINE=""
SEEN_DISTS=" "
PROBED=0
HAD_WSL_WINDOWS=0
ANY_NOT_ON_PATH=0
ANY_OLD=0

while IFS=$'\t' read -r src exe dist; do
  [ -n "$exe" ] || continue
  TOTAL=$((TOTAL + 1))
  [ "$src" = "wsl-windows" ] && HAD_WSL_WINDOWS=1

  on_path=false
  [ "$src" = "path" ] && on_path=true

  cli_ok=unknown
  version=""
  build_id=$(read_build_id "$exe")
  version_source="unknown"
  header=""
  err=""

  if [ "$PROBE" -eq 1 ] && [ "$PROBED" -lt "$MAX_PROBE" ]; then
    PROBED=$((PROBED + 1))
    probe_exe "$exe"
    if [ "$PROBE_OK" -eq 1 ]; then
      cli_ok=true
      version="$PROBE_VERSION"
      header="$PROBE_HEADER"
      [ -n "$version" ] && version_source="help"
    else
      err="$PROBE_ERR"
    fi
  elif [ "$PROBE" -eq 1 ]; then
    err="skipped probe (too many candidates)"
  fi
  if [ -z "$version" ] && [ -n "$build_id" ]; then
    version_source="version-file-only"
  fi

  if [ "$cli_ok" = true ]; then
    case "$SEEN_DISTS" in
      *" $dist "*) ;;
      *) SEEN_DISTS="$SEEN_DISTS$dist " ;;
    esac
  fi

  sanitized_src=$(sanitize_field "$src")
  sanitized_exe=$(sanitize_field "$exe")
  sanitized_dist=$(sanitize_field "$dist")
  sanitized_version=$(sanitize_field "$version")
  sanitized_build=$(sanitize_field "$build_id")
  sanitized_vsrc=$(sanitize_field "$version_source")
  sanitized_header=$(sanitize_field "$header")
  sanitized_err=$(sanitize_field "$err")

  printf '%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\n' \
    "$sanitized_src" "$sanitized_exe" "$sanitized_dist" "$on_path" "$cli_ok" \
    "$sanitized_version" "$sanitized_build" "$sanitized_vsrc" \
    "$sanitized_header" "$sanitized_err" >> "$RESULTS"

  if [ "$on_path" = false ]; then
    ANY_NOT_ON_PATH=1
  fi
  if [ "$cli_ok" = true ] && [ -n "$version" ] && ! version_ge_4_1_70 "$version"; then
    ANY_OLD=1
  fi

  # Remember candidates for selection.
  if [ -z "$BEST_ANY_LINE" ]; then
    BEST_ANY_LINE="$sanitized_src	$sanitized_exe	$sanitized_dist	$on_path	$cli_ok	$sanitized_version	$sanitized_build	$sanitized_vsrc	$sanitized_header	$sanitized_err"
  else
    old_version=$(printf '%s' "$BEST_ANY_LINE" | awk -F'\t' '{ print $6 }')
    old_cli=$(printf '%s' "$BEST_ANY_LINE" | awk -F'\t' '{ print $5 }')
    if [ "$cli_ok" = true ] && [ "$old_cli" != true ]; then
      BEST_ANY_LINE="$sanitized_src	$sanitized_exe	$sanitized_dist	$on_path	$cli_ok	$sanitized_version	$sanitized_build	$sanitized_vsrc	$sanitized_header	$sanitized_err"
    elif [ "$cli_ok" = true ] && [ "$old_cli" = true ]; then
      if version_gt "$version" "$old_version"; then
        BEST_ANY_LINE="$sanitized_src	$sanitized_exe	$sanitized_dist	$on_path	$cli_ok	$sanitized_version	$sanitized_build	$sanitized_vsrc	$sanitized_header	$sanitized_err"
      fi
    fi
  fi

  if [ "$on_path" = true ]; then
    if [ -z "$BEST_PATH_LINE" ]; then
      BEST_PATH_LINE="$sanitized_src	$sanitized_exe	$sanitized_dist	$on_path	$cli_ok	$sanitized_version	$sanitized_build	$sanitized_vsrc	$sanitized_header	$sanitized_err"
    else
      old_version=$(printf '%s' "$BEST_PATH_LINE" | awk -F'\t' '{ print $6 }')
      old_cli=$(printf '%s' "$BEST_PATH_LINE" | awk -F'\t' '{ print $5 }')
      if [ "$cli_ok" = true ] && [ "$old_cli" != true ]; then
        BEST_PATH_LINE="$sanitized_src	$sanitized_exe	$sanitized_dist	$on_path	$cli_ok	$sanitized_version	$sanitized_build	$sanitized_vsrc	$sanitized_header	$sanitized_err"
      elif [ "$cli_ok" = true ] && [ "$old_cli" = true ]; then
        if version_gt "$version" "$old_version"; then
          BEST_PATH_LINE="$sanitized_src	$sanitized_exe	$sanitized_dist	$on_path	$cli_ok	$sanitized_version	$sanitized_build	$sanitized_vsrc	$sanitized_header	$sanitized_err"
        fi
      fi
    fi
  fi
  [ -z "$FIRST_LINE" ] && FIRST_LINE="$sanitized_src	$sanitized_exe	$sanitized_dist	$on_path	$cli_ok	$sanitized_version	$sanitized_build	$sanitized_vsrc	$sanitized_header	$sanitized_err"
done < "$UNIQUE"

SELECTED_LINE=""
SELECTED_REASON=""
if [ -n "$BEST_PATH_LINE" ]; then
  SELECTED_LINE="$BEST_PATH_LINE"
  SELECTED_REASON="on PATH"
elif [ -n "$BEST_ANY_LINE" ]; then
  SELECTED_LINE="$BEST_ANY_LINE"
  SELECTED_REASON="highest version (not on PATH)"
elif [ -n "$FIRST_LINE" ]; then
  SELECTED_LINE="$FIRST_LINE"
  SELECTED_REASON="first candidate (not verified)"
fi

AMBIGUOUS=false
DIST_COUNT=$(printf '%s' "$SEEN_DISTS" | wc -w | tr -d ' ')
[ "$DIST_COUNT" -gt 1 ] && AMBIGUOUS=true

OK=false
[ "$TOTAL" -gt 0 ] && OK=true

if [ "$OK" = false ]; then
  warn "No EasyEDA Pro CLI installation found. Install the desktop client v4.1.70 or newer (lceda.cn for the mainland edition, easyeda.com for the international edition), then re-run this script."
fi
if [ "$ANY_NOT_ON_PATH" -eq 1 ] && [ -z "$BEST_PATH_LINE" ]; then
  warn "The client is installed but not on PATH. Use the absolute executable path, or add the install directory to PATH."
fi
if [ "$AMBIGUOUS" = true ]; then
  warn "Both lceda-pro (mainland) and easyeda-pro (international) are available. Ask the user which edition to drive; do not mix sessions from different editions."
fi
if [ "$ANY_OLD" -eq 1 ]; then
  warn "At least one detected client is older than 4.1.70. The CLI requires v4.1.70+; ask the user to update before relying on it."
fi
if [ "$HAD_WSL_WINDOWS" -eq 1 ]; then
  warn "A Windows client was found from WSL. Prefer running the CLI from Windows (or Git Bash) so it can attach to the desktop editor."
fi

# Optional bridge probe on the selected executable.
DOCTOR_JSON="null"
if [ "$DOCTOR" -eq 1 ] && [ -n "$SELECTED_LINE" ]; then
  sel_exe=$(printf '%s' "$SELECTED_LINE" | awk -F'\t' '{ print $2 }')
  if [ -n "$sel_exe" ]; then
    doc_out=$(run_with_timeout "$PROBE_TIMEOUT" "$sel_exe" doctor 2>&1 || true)
    doc_out=$(printf '%s' "$doc_out" | tr -d '\r')
    doc_ok=false
    doc_connected=false
    doc_endpoint=""
    doc_bridge=""
    case "$doc_out" in
      *'"ok":true'*|*'"ok": true'*) doc_ok=true ;;
    esac
    case "$doc_out" in
      *'"connected":true'*|*'"connected": true'*) doc_connected=true ;;
    esac
    doc_endpoint=$(printf '%s' "$doc_out" | sed -n 's/.*"endpoint"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
    doc_bridge=$(printf '%s' "$doc_out" | sed -n 's/.*"bridgeVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
    DOCTOR_JSON=$(printf '{"ok":%s,"connected":%s,"endpoint":%s,"bridgeVersion":%s,"raw":%s}' \
      "$doc_ok" "$doc_connected" "$(json_string "$doc_endpoint")" \
      "$(json_string "$doc_bridge")" "$(json_string "$doc_out")")
  fi
fi

# ----------------------------------------------------------------- output ---

emit_installation_json() { # 10 fields
  local src="$1" exe="$2" dist="$3" on_path="$4" cli_ok="$5"
  local version="$6" build_id="$7" version_source="$8" header="$9" err="${10}"
  local install_dir command_line edition product cli_json probed
  case "$exe" in
    *.app/Contents/MacOS/*) install_dir="${exe%%/Contents/MacOS/*}" ;;
    *) install_dir=$(dirname "$exe") ;;
  esac
  install_dir=$(to_output "$install_dir")
  exe=$(to_output "$exe")
  command_line="$dist"
  edition=$(dist_edition "$dist")
  product=$(dist_product "$dist")
  cli_json="$cli_ok"
  probed=true
  if [ "$cli_ok" = unknown ]; then
    cli_json=null
    probed=false
  fi

  printf '{"distribution":%s,"edition":%s,"product":%s,' \
    "$(json_string "$dist")" "$(json_string "$edition")" "$(json_string "$product")"
  printf '"command":%s,"installDir":%s,"executable":%s,' \
    "$(json_string "$command_line")" "$(json_string "$install_dir")" "$(json_string "$exe")"
  printf '"onPath":%s,"cliCapable":%s,"probed":%s,"version":%s,"buildId":%s,' \
    "$on_path" "$cli_json" "$probed" "$(json_string "$version")" "$(json_string "$build_id")"
  printf '"versionSource":%s,"versionHeader":%s,"probeError":%s,"source":%s}' \
    "$(json_string "$version_source")" "$(json_string "$header")" \
    "$(json_string "$err")" "$(json_string "$src")"
}

emit_text_installation() { # 10 fields
  local src="$1" exe="$2" dist="$3" on_path="$4" cli_ok="$5"
  local version="$6" build_id="$7" version_source="$8" header="$9" err="${10}"
  local install_dir
  case "$exe" in
    *.app/Contents/MacOS/*) install_dir="${exe%%/Contents/MacOS/*}" ;;
    *) install_dir=$(dirname "$exe") ;;
  esac
  printf '  edition    : %s (%s)\n' "$dist" "$(dist_edition "$dist")"
  printf '  installDir : %s\n' "$(to_output "$install_dir")"
  printf '  executable : %s\n' "$(to_output "$exe")"
  printf '  version    : %s\n' "${version:-unknown}"
  [ -n "$build_id" ] && printf '  buildId    : %s\n' "$build_id"
  printf '  on PATH    : %s\n' "$on_path"
  case "$cli_ok" in
    unknown) printf '  CLI usable : not probed\n' ;;
    *) printf '  CLI usable : %s\n' "$cli_ok" ;;
  esac
  printf '  source     : %s\n' "$src"
  [ -n "$err" ] && printf '  probe error: %s\n' "$err"
}

if [ "$OUTPUT_MODE" = text ]; then
  printf 'EasyEDA Pro CLI detection\n'
  printf 'OS: %s (%s)%s\n' "$OS" "$ARCH" "$( [ "$WSL" = 1 ] && printf ', WSL' )"
  if [ "$OK" = true ]; then
    printf 'Found %s installation(s)\n' "$TOTAL"
    while IFS=$'\037' read -r src exe dist on_path cli_ok version build_id version_source header err; do
      printf '\n'
      emit_text_installation "$src" "$exe" "$dist" "$on_path" "$cli_ok" "$version" "$build_id" "$version_source" "$header" "$err"
    done < "$RESULTS"
    printf '\nSelected: %s\n' "$SELECTED_REASON"
    s_exe=$(printf '%s' "$SELECTED_LINE" | awk -F'\t' '{ print $2 }')
    s_dist=$(printf '%s' "$SELECTED_LINE" | awk -F'\t' '{ print $3 }')
    printf '  %s  ->  %s\n' "$s_dist" "$(to_output "$s_exe")"
  else
    printf 'No EasyEDA Pro CLI installation found.\n'
  fi
  if [ -s "$WARNINGS" ]; then
    printf '\nWarnings:\n'
    sed 's/^/  - /' "$WARNINGS"
  fi
  printf '\n'
  exit $([ "$OK" = true ] && echo 0 || echo 1)
fi

# JSON output
printf '{'
printf '"ok":%s,"skill":"easyeda-cli","detectedAt":%s,' \
  "$OK" "$(json_string "$(now_utc)")"
printf '"os":%s,"arch":%s,"wsl":%s,"ambiguous":%s,' \
  "$(json_string "$OS")" "$(json_string "$ARCH")" \
  "$( [ "$WSL" = 1 ] && echo true || echo false)" "$AMBIGUOUS"

if [ -n "$SELECTED_LINE" ]; then
  s_src=$(printf '%s' "$SELECTED_LINE" | awk -F'\t' '{ print $1 }')
  s_exe=$(printf '%s' "$SELECTED_LINE" | awk -F'\t' '{ print $2 }')
  s_dist=$(printf '%s' "$SELECTED_LINE" | awk -F'\t' '{ print $3 }')
  s_onpath=$(printf '%s' "$SELECTED_LINE" | awk -F'\t' '{ print $4 }')
  s_cli=$(printf '%s' "$SELECTED_LINE" | awk -F'\t' '{ print $5 }')
  s_version=$(printf '%s' "$SELECTED_LINE" | awk -F'\t' '{ print $6 }')
  s_build=$(printf '%s' "$SELECTED_LINE" | awk -F'\t' '{ print $7 }')
  s_vsrc=$(printf '%s' "$SELECTED_LINE" | awk -F'\t' '{ print $8 }')
  s_header=$(printf '%s' "$SELECTED_LINE" | awk -F'\t' '{ print $9 }')
  s_err=$(printf '%s' "$SELECTED_LINE" | awk -F'\t' '{ print $10 }')
  s_install="${s_exe%%/Contents/MacOS/*}"
  [ "$s_install" = "$s_exe" ] && s_install=$(dirname "$s_exe")

  printf '"distribution":%s,"edition":%s,"product":%s,' \
    "$(json_string "$s_dist")" "$(json_string "$(dist_edition "$s_dist")")" \
    "$(json_string "$(dist_product "$s_dist")")"
  printf '"command":%s,"installDir":%s,"executable":%s,' \
    "$(json_string "$s_dist")" "$(json_string "$(to_output "$s_install")")" \
    "$(json_string "$(to_output "$s_exe")")"
  printf '"version":%s,"buildId":%s,"onPath":%s,' \
    "$(json_string "$s_version")" "$(json_string "$s_build")" "$s_onpath"
  printf '"selected":'
  emit_installation_json "$s_src" "$s_exe" "$s_dist" "$s_onpath" "$s_cli" \
    "$s_version" "$s_build" "$s_vsrc" "$s_header" "$s_err"
  printf ','
else
  printf '"distribution":"","edition":"","product":"","command":"",'
  printf '"installDir":"","executable":"","version":"","buildId":"",'
  printf '"onPath":false,"selected":null,'
fi

printf '"selectedReason":%s,' "$(json_string "$SELECTED_REASON")"

printf '"installations":['
first_item=1
while IFS=$'\037' read -r src exe dist on_path cli_ok version build_id version_source header err; do
  [ "$first_item" -eq 1 ] || printf ','
  first_item=0
  emit_installation_json "$src" "$exe" "$dist" "$on_path" "$cli_ok" "$version" "$build_id" "$version_source" "$header" "$err"
done < "$RESULTS"
printf '],'

printf '"warnings":['
first_item=1
while IFS= read -r w; do
  [ "$first_item" -eq 1 ] || printf ','
  first_item=0
  json_string "$w"
done < "$WARNINGS"
printf '],'

printf '"doctor":%s' "$DOCTOR_JSON"
printf '}\n'

[ "$OK" = true ] && exit 0
exit 1
