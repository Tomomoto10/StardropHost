#!/bin/bash
# ===========================================
# StardropHost | scripts/crash-monitor.sh
# ===========================================
# Wraps the game process and automatically
# restarts it if it crashes.
#
# Restarts are rate-limited to prevent
# infinite restart loops.
# ===========================================

GAME_DIR="/home/steam/stardewvalley"
MAX_RESTARTS=${MAX_CRASH_RESTARTS:-5}
RESTART_WINDOW=300

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
log()       { echo -e "${GREEN}[Crash-Monitor]${NC} $1"; }
log_error() { echo -e "${RED}[Crash-Monitor]${NC} $1"; }

STOP_FLAG="/home/steam/web-panel/data/server-stopped"
ENABLE_CRASH_RESTART="${ENABLE_CRASH_RESTART:-true}"

RESTART_TIMES=()

can_restart() {
    local now=$(date +%s)
    local recent=0
    for t in "${RESTART_TIMES[@]}"; do
        [ $((now - t)) -lt $RESTART_WINDOW ] && recent=$((recent + 1))
    done
    [ $recent -lt $MAX_RESTARTS ]
}

cd "$GAME_DIR" || exit 1

while true; do
    # Wait while deliberately stopped via web panel Stop button
    while [ -f "$STOP_FLAG" ]; do
        sleep 2
    done

    log "Starting game server..."
    ./StardewModdingAPI --server
    EXIT_CODE=$?

    log_error "Game process exited (exit code: $EXIT_CODE)"

    # If stopped deliberately, don't count as a crash — just loop back to wait
    if [ -f "$STOP_FLAG" ]; then
        log "Server was stopped deliberately. Waiting for start signal..."
        continue
    fi

    # Crash behaviour depends on ENABLE_CRASH_RESTART
    if [ "$ENABLE_CRASH_RESTART" != "true" ]; then
        log_error "Crash restart disabled (ENABLE_CRASH_RESTART=false). Exiting."
        exit 1
    fi

    if ! can_restart; then
        log_error "Too many restarts (${MAX_RESTARTS} within ${RESTART_WINDOW}s)"
        log_error "Container will exit — check logs for the cause"
        exit 1
    fi

    RESTART_TIMES+=("$(date +%s)")
    [ ${#RESTART_TIMES[@]} -gt $MAX_RESTARTS ] && \
        RESTART_TIMES=("${RESTART_TIMES[@]:1}")

    log "Restarting in 10 seconds..."
    sleep 10
done