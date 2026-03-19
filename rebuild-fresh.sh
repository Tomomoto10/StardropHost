#!/bin/bash
# ===========================================
# StardropHost | rebuild-fresh.sh
# ===========================================
# Full clean rebuild — discards all cached
# layers and re-downloads everything from
# scratch. Use this when:
#   - Normal update.sh isn't fixing an issue
#   - Dockerfile dependencies have changed
#   - Something is broken at the system level
#
# Warning: takes 10-20 minutes on first run.
#
# Usage:
#   sudo bash rebuild-fresh.sh
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

print_header()  {
    echo ""
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}${BOLD}  StardropHost — Full Clean Rebuild${NC}"
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
print_warning "All cached layers will be discarded. This takes 10-20 minutes."
echo ""

# -- Step 1: Stop containers --
print_step "Step 1: Stopping containers..."
$COMPOSE_CMD down
print_success "Containers stopped"

# -- Step 2: Remove old image to fully free disk space --
print_step "Step 2: Removing old server image..."
docker rmi stardrop-server:local 2>/dev/null && print_success "Old image removed" || print_info "No existing image to remove"

# -- Step 3: Full rebuild --
print_step "Step 3: Rebuilding server image from scratch..."
print_info "Re-downloading all dependencies (apt, steamcmd, Node.js, SMAPI, NuGet)..."
echo ""

if ! $COMPOSE_CMD build --no-cache stardrop-server; then
    echo ""
    print_error "Build failed! Check the output above for errors."
    exit 1
fi

print_success "Image built successfully"

# -- Step 4: Start containers --
print_step "Step 4: Starting containers..."

if ! $COMPOSE_CMD up -d; then
    print_error "Failed to start containers!"
    echo "  Check logs: $COMPOSE_CMD logs"
    exit 1
fi

print_success "Containers started"

# -- Done --
echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  Fresh rebuild complete! Streaming server logs...${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${YELLOW}Press Ctrl+C to stop watching logs (server keeps running)${NC}"
echo ""

sleep 2
docker logs -f "${CONTAINER_PREFIX}-server" 2>/dev/null \
    || docker logs -f "${CONTAINER_PREFIX}" 2>/dev/null \
    || $COMPOSE_CMD logs -f stardrop-server
