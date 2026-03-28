#!/bin/bash
# ===========================================
# StardropHost | scripts/game-update-check.sh
# ===========================================
# Runs daily in the background. Compares the
# installed game build ID against the latest
# on Steam and writes a status file that the
# web panel reads to show a dashboard notice.
#
# Output: /home/steam/web-panel/data/game-update-available.json
# ===========================================

STATUS_FILE="/home/steam/web-panel/data/game-update-available.json"
MANIFEST="/home/steam/stardewvalley/steamapps/appmanifest_413150.acf"
CHECK_INTERVAL=86400   # 24 hours

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[GameUpdateCheck]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[GameUpdateCheck]${NC} $1"; }

mkdir -p "$(dirname "$STATUS_FILE")"

write_status() {
    echo "$1" > "$STATUS_FILE"
}

check_for_update() {
    # Only meaningful if game was Steam-downloaded (manifest exists)
    if [ ! -f "$MANIFEST" ]; then
        write_status '{"available":false,"reason":"no_manifest","checkedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}'
        return
    fi

    # Prefer installedBuild from the check file (written by game-update.sh after a
    # successful download). This records the Steam API build number rather than the
    # ACF buildid, which on Linux may differ from the cross-platform Steam build ID
    # even when the game is fully up to date.
    local installed_build=""
    if [ -f "$STATUS_FILE" ]; then
        installed_build=$(python3 -c "
import json, sys
try:
    d = json.load(open('$STATUS_FILE'))
    print(d.get('installedBuild') or d.get('currentBuild') or '')
except Exception:
    print('')
" 2>/dev/null || true)
    fi

    # Fall back to ACF if no stored build
    if [ -z "$installed_build" ]; then
        installed_build=$(grep '"buildid"' "$MANIFEST" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
    fi

    if [ -z "$installed_build" ]; then
        write_status '{"available":false,"reason":"no_manifest","checkedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}'
        return
    fi

    log_info "Installed build: $installed_build"
    log_info "Checking Steam API for latest build..."

    local latest_build=""

    # Use Python3 to parse the Steam API response properly.
    # The JSON contains multiple "buildid" fields (one per depot + one per branch).
    # Grepping for the first match returns a depot-level ID, not the public branch ID.
    # We must navigate the full JSON path to get the correct value.
    if command -v python3 &>/dev/null; then
        latest_build=$(python3 - 2>/dev/null <<'EOF'
import urllib.request, json, sys
try:
    req = urllib.request.Request(
        'https://api.steamcmd.net/v1/info/413150',
        headers={'User-Agent': 'StardropHost/1.0'}
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        d = json.loads(r.read())
        print(d['data']['413150']['appinfo']['depots']['branches']['public']['buildid'])
except Exception:
    sys.exit(1)
EOF
        )
    fi

    if [ -z "$latest_build" ]; then
        log_warn "Could not reach Steam API — skipping check"
        write_status '{"available":false,"reason":"check_failed","checkedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}'
        return
    fi

    log_info "Latest build: $latest_build"

    if [ "$installed_build" = "$latest_build" ]; then
        log_info "Game is up to date"
        write_status '{"available":false,"installedBuild":"'"$installed_build"'","latestBuild":"'"$latest_build"'","checkedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}'
    else
        log_info "Update available: $installed_build → $latest_build"
        write_status '{"available":true,"installedBuild":"'"$installed_build"'","latestBuild":"'"$latest_build"'","checkedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}'
    fi
}

trap 'log_info "Stopping."; exit 0' SIGTERM SIGINT

log_info "Starting daily game update checker..."

# Run immediately on start
check_for_update

# Then check once per day
while true; do
    sleep $CHECK_INTERVAL
    check_for_update
done
