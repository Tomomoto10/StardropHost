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

# -- Load .env so compose has all variables before any docker compose command --
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
    set +a
fi

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

# Remember whether the server was explicitly stopped via the web panel.
# The stop flag on the host filesystem is the source of truth — no need to inspect the container.
_STOP_FLAG="$SCRIPT_DIR/data/panel/server-stopped"
_WAS_EXPLICITLY_STOPPED=false
[ -f "$_STOP_FLAG" ] && _WAS_EXPLICITLY_STOPPED=true

if [ "$_WAS_EXPLICITLY_STOPPED" = "true" ]; then
    print_info "Game server was stopped — will remain stopped after update"
else
    print_info "Game server was running — will start after update"
fi

print_info "Gracefully shutting down the server and web panel..."
$COMPOSE_CMD down
print_success "Containers stopped"


# Schedule SMAPI update — remove old binary and write a marker file so the
# entrypoint downloads the correct version at startup instead of re-using the
# version that was baked into the Docker image at build time.
if [ "$_SMAPI_NEEDS_UPDATE" = "true" ]; then
    rm -f "$SCRIPT_DIR/data/game/StardewModdingAPI"
    mkdir -p "$SCRIPT_DIR/data/panel"
    echo "${_LATEST_SMAPI}" > "$SCRIPT_DIR/data/panel/smapi-update-needed"
    if [ -n "$_LATEST_SMAPI" ]; then
        print_success "SMAPI update queued — v$_LATEST_SMAPI will be downloaded on next start"
    else
        print_success "SMAPI update queued — latest version will be downloaded on next start"
    fi
fi

# -- Step 3: Rebuild image (incremental) --
print_step "Step 3: Rebuilding Docker image..."
print_info "Docker will reuse cached layers for anything that hasn't changed."
print_info "Only modified files (scripts, web panel, config) are rebuilt — this is fast."
echo ""

if ! $COMPOSE_CMD build stardrop-server stardrop-manager stardrop-steam-auth; then
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

# Restore server state — if it wasn't explicitly stopped, clear any stale stop flag
if [ "$_WAS_EXPLICITLY_STOPPED" = "false" ]; then
    rm -f "$_STOP_FLAG"
fi

print_success "Containers started"

# -- Resolve IP and panel port for the done message --
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$LOCAL_IP" ] && command -v ip &>/dev/null; then
    LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '/src/{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}')
fi
SERVER_IP="${LOCAL_IP:-your-server-ip}"
PANEL_PORT="${PANEL_PORT:-18642}"

# -- Done --
echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  Update complete!${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Showing startup logs for 15 seconds..."
echo ""

sleep 2
timeout 15 docker logs -f "${CONTAINER_PREFIX}" 2>/dev/null || true

echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  Server is running in the background.${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Web panel:     ${CYAN}${BOLD}http://${SERVER_IP}:${PANEL_PORT}${NC}"
echo -e "  Watch logs:    ${CYAN}docker logs -f ${CONTAINER_PREFIX}${NC}"
echo ""
