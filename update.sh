#!/bin/bash
# ===========================================
# StardropHost | update.sh
# ===========================================
# Pulls the latest code from GitHub and does
# an incremental Docker rebuild — only layers
# that changed are rebuilt, so this is fast
# for most updates (typically 1–3 minutes).
#
# Run this whenever you want to apply the
# latest StardropHost changes to your server.
#
# Usage:
#   sudo bash update.sh
#
# Note: Your server will be offline briefly
# while containers are stopped and restarted.
# Game saves are not affected.
# ===========================================

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

# -- Colors --
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

print_header() {
    echo ""
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}${BOLD}  StardropHost — Update${NC}"
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}
print_success() { echo -e "${GREEN}[OK]   $1${NC}"; }
print_error()   { echo -e "${RED}[ERR]  $1${NC}"; }
print_warning() { echo -e "${YELLOW}[WARN] $1${NC}"; }
print_info()    { echo -e "${BLUE}[>>]   $1${NC}"; }
print_step()    { echo ""; echo -e "${BOLD}$1${NC}"; }

# -- Require root --
if [ "$(id -u)" != "0" ]; then
    exec sudo bash "$0" "$@"
fi

# -- Resolve compose command --
if docker compose version &>/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then
    COMPOSE_CMD="docker-compose"
else
    echo -e "${RED}[ERR]  Docker Compose not found. Is Docker installed?${NC}"
    exit 1
fi

# -- Detect container prefix from .env --
CONTAINER_PREFIX="stardrop"
if [ -f "$SCRIPT_DIR/.env" ]; then
    _prefix=$(grep -E '^CONTAINER_PREFIX=' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
    [ -n "$_prefix" ] && CONTAINER_PREFIX="$_prefix"
fi

cd "$SCRIPT_DIR" || { echo -e "${RED}[ERR]  Cannot cd to $SCRIPT_DIR${NC}"; exit 1; }

print_header
print_info "Directory:  $SCRIPT_DIR"
print_info "Container:  ${CONTAINER_PREFIX}-server"
echo ""

# -- Step 1: Pull latest code from GitHub --
print_step "Step 1: Pulling latest code from GitHub..."
print_info "Fetching any new commits from the main branch..."
if command -v git &>/dev/null && [ -d "$SCRIPT_DIR/.git" ]; then
    BEFORE=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null)
    if git -C "$SCRIPT_DIR" pull; then
        AFTER=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null)
        if [ "$BEFORE" != "$AFTER" ]; then
            print_success "Updated  $BEFORE → $AFTER"
            git -C "$SCRIPT_DIR" log --oneline "${BEFORE}..${AFTER}" 2>/dev/null \
                | while read -r line; do print_info "  $line"; done
        else
            print_success "Already up to date ($AFTER)"
        fi
    else
        print_warning "Git pull failed — building from current local files"
        print_info "Check your network connection or resolve any merge conflicts"
    fi
else
    print_info "Not a git repository or git not installed — skipping pull"
    print_info "Files on disk will be used as-is"
fi

# -- Step 1.5: SMAPI version check --
print_step "Step 1.5: Checking SMAPI version..."

SMAPI_LOG_PATH="$SCRIPT_DIR/data/saves/ErrorLogs/SMAPI-latest.txt"
_SMAPI_NEEDS_UPDATE=false

# Read current installed version from the last SMAPI session log
_CURRENT_SMAPI=""
if [ -f "$SMAPI_LOG_PATH" ]; then
    _CURRENT_SMAPI=$(grep -oE 'SMAPI [0-9]+\.[0-9]+\.[0-9]+' "$SMAPI_LOG_PATH" 2>/dev/null \
        | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
fi

# Fetch latest release tag from GitHub
_LATEST_SMAPI=$(curl -s --max-time 10 \
    https://api.github.com/repos/Pathoschild/SMAPI/releases/latest 2>/dev/null \
    | grep -o '"tag_name": "[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$_LATEST_SMAPI" ]; then
    print_warning "Could not check latest SMAPI version (network unavailable?)"
elif [ -z "$_CURRENT_SMAPI" ]; then
    print_info "SMAPI not yet installed — will install v$_LATEST_SMAPI on first start"
elif [ "$_CURRENT_SMAPI" = "$_LATEST_SMAPI" ]; then
    print_success "SMAPI is up to date (v$_CURRENT_SMAPI)"
else
    print_info "SMAPI update: v$_CURRENT_SMAPI → v$_LATEST_SMAPI"
    _SMAPI_NEEDS_UPDATE=true
    print_success "SMAPI will be updated when the server restarts"
fi

# -- Step 2: Stop containers --
print_step "Step 2: Stopping containers..."
print_info "Gracefully shutting down the server and web panel..."
$COMPOSE_CMD down
print_success "Containers stopped"

# -- Step 2.5: Stardew Valley game update (optional) --
if [ -f "$SCRIPT_DIR/data/game/StardewValley" ]; then
    print_step "Step 2.5: Stardew Valley update check..."

    _CURRENT_SDV=""
    if [ -f "$SMAPI_LOG_PATH" ]; then
        _CURRENT_SDV=$(grep -oE 'Stardew Valley [0-9]+\.[0-9]+\.[0-9]+' "$SMAPI_LOG_PATH" 2>/dev/null \
            | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
    fi
    [ -n "$_CURRENT_SDV" ] && print_info "Installed: Stardew Valley v$_CURRENT_SDV"

    # Check Steam for the latest public build ID (anonymous, no credentials needed)
    _SDV_BUILD_FILE="$SCRIPT_DIR/data/game/.steam_build_id"
    _STORED_BUILD=$(cat "$_SDV_BUILD_FILE" 2>/dev/null || true)
    _LATEST_BUILD=""

    if docker image inspect stardrop-server:local >/dev/null 2>&1; then
        print_info "Checking Steam for Stardew Valley updates..."
        _LATEST_BUILD=$(timeout 30 docker run --rm stardrop-server:local \
            bash -c "/home/steam/steamcmd/steamcmd.sh \
                +login anonymous \
                +app_info_update 1 \
                +app_info_print 413150 \
                +quit 2>/dev/null" 2>/dev/null \
            | grep -A3 '"public"' | grep '"buildid"' | head -1 | grep -oE '[0-9]+' || true)
    fi

    # Seed the stored build ID on first run so future runs skip automatically
    if [ -n "$_LATEST_BUILD" ] && [ -z "$_STORED_BUILD" ]; then
        echo "$_LATEST_BUILD" > "$_SDV_BUILD_FILE"
        _STORED_BUILD="$_LATEST_BUILD"
    fi

    _SDV_UPDATE_AVAILABLE=false
    if [ -z "$_LATEST_BUILD" ]; then
        print_warning "Could not reach Steam to check for SDV updates — skipping game update"
    elif [ "$_STORED_BUILD" != "$_LATEST_BUILD" ]; then
        _SDV_UPDATE_AVAILABLE=true
        print_info "Stardew Valley update available (build $_STORED_BUILD → $_LATEST_BUILD)"
    else
        print_success "Stardew Valley is up to date (build $_LATEST_BUILD)"
    fi

    echo ""
    if [ "$_SDV_UPDATE_AVAILABLE" = "true" ]; then
        read -r -p "  Update Stardew Valley via Steam? (saves, mods, and config are preserved) [y/N] " _UPDATE_SDV
        echo ""
    fi

    if [ "$_SDV_UPDATE_AVAILABLE" = "true" ] && [[ "$_UPDATE_SDV" =~ ^[Yy]$ ]]; then
        if ! docker image inspect stardrop-server:local >/dev/null 2>&1; then
            print_warning "Docker image not yet built — game update skipped."
            print_info "Re-run update.sh after the first build to update the game."
        else
            print_info "Enter your Steam credentials to update Stardew Valley."
            print_info "(Used once for this update only — never stored)"
            echo ""
            read -r  -p "  Steam username: " _STEAM_USER
            read -s -r -p "  Steam password: " _STEAM_PASS
            echo ""
            echo ""
            print_info "Connecting to Steam — this may take a few minutes..."
            _STEAMCMD_LOG=$(mktemp)

            docker run --rm \
                -v "$SCRIPT_DIR/data/game:/home/steam/stardewvalley" \
                stardrop-server:local \
                bash -c "/home/steam/steamcmd/steamcmd.sh \
                    +force_install_dir /home/steam/stardewvalley \
                    +login \"$_STEAM_USER\" \"$_STEAM_PASS\" \
                    +app_update 413150 validate +quit" \
                2>&1 | tee "$_STEAMCMD_LOG"
            _SDV_EXIT=${PIPESTATUS[0]}

            # Handle Steam Guard if prompted
            if grep -qi "two.factor\|steam.guard\|invalid.*auth.*code\|Enter.*Steam Guard\|STEAM_GUARD" \
                    "$_STEAMCMD_LOG" 2>/dev/null; then
                echo ""
                print_warning "Steam Guard code required."
                read -r -p "  Enter Steam Guard code: " _STEAM_CODE
                echo ""
                print_info "Retrying with Steam Guard code..."
                docker run --rm \
                    -v "$SCRIPT_DIR/data/game:/home/steam/stardewvalley" \
                    stardrop-server:local \
                    bash -c "/home/steam/steamcmd/steamcmd.sh \
                        +force_install_dir /home/steam/stardewvalley \
                        +set_steam_guard_code \"$_STEAM_CODE\" \
                        +login \"$_STEAM_USER\" \"$_STEAM_PASS\" \
                        +app_update 413150 validate +quit"
                _SDV_EXIT=$?
            fi

            rm -f "$_STEAMCMD_LOG"

            if [ "$_SDV_EXIT" -eq 0 ]; then
                print_success "Stardew Valley updated"
                _SMAPI_NEEDS_UPDATE=true
                print_info "SMAPI will be reinstalled to match the updated game files"
                # Store the new build ID so we don't prompt again until Steam pushes another update
                [ -n "$_LATEST_BUILD" ] && echo "$_LATEST_BUILD" > "$_SDV_BUILD_FILE"
            else
                print_warning "Game update may not have completed — check output above"
            fi
        fi
    fi
else
    print_info "No game installed yet — skipping game update check"
fi

# Remove old SMAPI binary so entrypoint installs the latest version
if [ "$_SMAPI_NEEDS_UPDATE" = "true" ]; then
    rm -f "$SCRIPT_DIR/data/game/StardewModdingAPI"
    if [ -n "$_LATEST_SMAPI" ]; then
        print_success "Old SMAPI removed — v$_LATEST_SMAPI will be installed on next start"
    else
        print_success "Old SMAPI removed — latest version will be installed on next start"
    fi
fi

# -- Step 3: Rebuild image (incremental) --
print_step "Step 3: Rebuilding Docker image..."
print_info "Docker will reuse cached layers for anything that hasn't changed."
print_info "Only modified files (scripts, web panel, config) are rebuilt — this is fast."
echo ""

if ! $COMPOSE_CMD build stardrop-server; then
    echo ""
    print_error "Build failed — check the output above for the cause."
    echo ""
    echo "  Common causes:"
    echo "    - No internet connection during build"
    echo "    - Not enough disk space (need ~500 MB free for rebuild)"
    echo "    - A syntax error in a recently changed file"
    echo ""
    echo "  Fix the error and re-run:  sudo bash update.sh"
    exit 1
fi

print_success "Image rebuilt successfully"

# -- Step 4: Start containers --
print_step "Step 4: Starting containers..."
print_info "Bringing the server and web panel back online..."

if ! $COMPOSE_CMD up -d; then
    print_error "Failed to start containers!"
    echo ""
    echo "  Check what went wrong:"
    echo -e "    ${CYAN}$COMPOSE_CMD logs${NC}"
    exit 1
fi

print_success "Containers started"

# -- Resolve IP and panel port for the done message --
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$LOCAL_IP" ] && command -v ip &>/dev/null; then
    LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '/src/{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}')
fi
SERVER_IP="${LOCAL_IP:-your-server-ip}"

PANEL_PORT="18642"
if [ -f "$SCRIPT_DIR/.env" ]; then
    _port=$(grep -E '^PANEL_PORT=' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
    [ -n "$_port" ] && PANEL_PORT="$_port"
fi

# -- Done --
echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  Update complete!${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Web panel:"
echo ""
echo -e "    ${CYAN}${BOLD}http://${SERVER_IP}:${PANEL_PORT}${NC}"
echo ""
echo -e "  Streaming live server logs below."
echo -e "  ${YELLOW}Press Ctrl+C to stop watching — the server keeps running.${NC}"
echo ""

sleep 2
docker logs -f "${CONTAINER_PREFIX}-server" 2>/dev/null \
    || docker logs -f "${CONTAINER_PREFIX}" 2>/dev/null \
    || $COMPOSE_CMD logs -f stardrop-server || true

echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "    ${CYAN}${BOLD}cd ./$(basename "$SCRIPT_DIR")${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
