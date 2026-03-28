#!/bin/bash
# ===========================================
# StardropHost | scripts/game-update.sh
# ===========================================
# Downloads/updates Stardew Valley via steamcmd.
# Called by the web panel API — never run directly.
#
# Credentials are read from:
#   /home/steam/web-panel/data/game-update-creds.json
# (written by the API, cleared immediately after use)
#
# Status written to:
#   /home/steam/web-panel/data/game-update-status.json
#
# Log written to:
#   /home/steam/web-panel/data/game-update.log
# ===========================================

CREDS_FILE="/home/steam/web-panel/data/game-update-creds.json"
STATUS_FILE="/home/steam/web-panel/data/game-update-status.json"
LOG_FILE="/home/steam/web-panel/data/game-update.log"
STEAMCMD="/home/steam/steamcmd/steamcmd.sh"
CHECK_FILE="/home/steam/web-panel/data/game-update-available.json"

write_status() { echo "$1" > "$STATUS_FILE"; }
write_log()    { echo "[$(date '+%H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

# -- Read credentials from JSON --
if [ ! -f "$CREDS_FILE" ]; then
    write_status '{"state":"error","message":"No credentials file found"}'
    exit 1
fi

STEAM_USERNAME=$(python3 -c "import json; d=json.load(open('$CREDS_FILE')); print(d.get('username',''))" 2>/dev/null)
STEAM_PASSWORD=$(python3 -c "import json; d=json.load(open('$CREDS_FILE')); print(d.get('password',''))" 2>/dev/null)
STEAM_GUARD=$(python3 -c "import json; d=json.load(open('$CREDS_FILE')); print(d.get('guardCode',''))" 2>/dev/null)

if [ -z "$STEAM_USERNAME" ] || [ -z "$STEAM_PASSWORD" ]; then
    write_status '{"state":"error","message":"Missing Steam credentials"}'
    rm -f "$CREDS_FILE"
    exit 1
fi

# -- Reset log and set initial status --
> "$LOG_FILE"
write_log "Starting game update..."
write_status '{"state":"downloading","message":"Connecting to Steam..."}'

# -- Build steamcmd argument list --
ARGS=(+force_install_dir /home/steam/stardewvalley)
if [ -n "$STEAM_GUARD" ]; then
    write_log "Using Steam Guard code"
    ARGS+=(+set_steam_guard_code "$STEAM_GUARD")
fi
ARGS+=(+login "$STEAM_USERNAME" "$STEAM_PASSWORD" +app_update 413150 validate +quit)

STEAMCMD_TMP=$(mktemp)

# -- Run steamcmd, strip ANSI, write to log --
write_log "Connecting to Steam — this may take a few minutes..."
"$STEAMCMD" "${ARGS[@]}" 2>&1 | tee "$STEAMCMD_TMP" | while IFS= read -r line; do
    clean=$(printf '%s' "$line" | sed 's/\x1b\[[0-9;]*m//g' | tr -d '\r')
    [ -n "$clean" ] && write_log "$clean"
done

# -- Always clear credentials immediately after attempt --
rm -f "$CREDS_FILE"

# -- Interpret result --
if [ -f "/home/steam/stardewvalley/StardewValley" ]; then
    # Double-check: did steamcmd ask for a guard code and then somehow succeed anyway?
    if grep -qi "steam guard\|steamguard\|two.factor\|enter.*steam guard code\|Steam Guard code" \
            "$STEAMCMD_TMP" 2>/dev/null && \
       ! grep -qi "app_update.*fully.*installed\|success\|app already up to date" "$STEAMCMD_TMP" 2>/dev/null; then
        write_status '{"state":"guard_required","message":"Steam Guard code required — check your email or authenticator app"}'
        write_log "Steam Guard code required — enter the code from your email or authenticator"
        rm -f "$STEAMCMD_TMP"
        exit 0
    fi

    write_log "✅ Game updated successfully"
    write_status '{"state":"done","message":"Game updated successfully — restart the server to apply"}'

    # Update the availability check file so the notification clears
    MANIFEST="/home/steam/stardewvalley/steamapps/appmanifest_413150.acf"
    NEW_BUILD=$(grep '"buildid"' "$MANIFEST" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
    if [ -n "$NEW_BUILD" ]; then
        echo '{"available":false,"currentBuild":"'"$NEW_BUILD"'","latestBuild":"'"$NEW_BUILD"'","checkedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' > "$CHECK_FILE"
    fi

    rm -f "$STEAMCMD_TMP"
    exit 0
fi

# -- Download failed — diagnose why --
if grep -qi "steam guard\|steamguard\|two.factor\|enter.*steam guard code\|Steam Guard code" \
        "$STEAMCMD_TMP" 2>/dev/null; then
    write_status '{"state":"guard_required","message":"Steam Guard code required — check your email or authenticator app"}'
    write_log "Steam Guard code required — enter the code from your email or authenticator"
elif grep -qi "Invalid Password\|INVALID_PASSWORD\|incorrect password" "$STEAMCMD_TMP" 2>/dev/null; then
    write_status '{"state":"error","message":"Invalid Steam password — check your credentials"}'
    write_log "❌ Invalid Steam password"
elif grep -qi "rate.limit\|too many\|RATE_LIMIT" "$STEAMCMD_TMP" 2>/dev/null; then
    write_status '{"state":"error","message":"Steam rate limit — wait a few minutes and try again"}'
    write_log "❌ Steam rate limit hit — wait a few minutes"
else
    write_status '{"state":"error","message":"Update failed — check the log for details"}'
    write_log "❌ Update failed"
fi

rm -f "$STEAMCMD_TMP"
exit 1
