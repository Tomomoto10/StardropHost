#!/bin/bash
# ===========================================
# StardropHost | scripts/entrypoint.sh
# ===========================================
# Main container startup script.
# Runs as root first, then switches to steam
# user for all game operations.
# ===========================================

# DO NOT use set -e - we need manual error handling

# -- Colors --
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# -- Panel env file --
PANEL_ENV_FILE=${ENV_FILE:-/home/steam/web-panel/data/runtime.env}
if [ ! -f "$PANEL_ENV_FILE" ] && [ -f "/home/steam/.env" ]; then
    PANEL_ENV_FILE="/home/steam/.env"
fi

load_panel_env_overrides() {
    local env_file=${1:-$PANEL_ENV_FILE}
    [ -f "$env_file" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in ''|\#*) continue ;; esac
        local key=${line%%=*}
        local value=${line#*=}
        case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
        export "$key=$value"
    done < "$env_file"
}

load_panel_env_overrides

# -- Resolution defaults --
DEFAULT_RESOLUTION_WIDTH=1280
DEFAULT_RESOLUTION_HEIGHT=720
DEFAULT_REFRESH_RATE=60
LOW_PERF_DEFAULT_WIDTH=800
LOW_PERF_DEFAULT_HEIGHT=600
LOW_PERF_DEFAULT_FPS=30
LOW_PERF_DEFAULT_COLOR_DEPTH=16

LOW_PERF_MODE=${LOW_PERF_MODE:-false}
TARGET_FPS_RAW=${TARGET_FPS:-}
RESOLUTION_WIDTH=${RESOLUTION_WIDTH:-$DEFAULT_RESOLUTION_WIDTH}
RESOLUTION_HEIGHT=${RESOLUTION_HEIGHT:-$DEFAULT_RESOLUTION_HEIGHT}
REFRESH_RATE=${REFRESH_RATE:-${TARGET_FPS_RAW:-$DEFAULT_REFRESH_RATE}}
TARGET_FPS=${TARGET_FPS_RAW:-$REFRESH_RATE}
XVFB_COLOR_DEPTH=24
XVFB_FB_DIR=""
XVFB_FB_ARGS=()

# -- Logging --
log_info()  { echo -e "${GREEN}[StardropHost]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[StardropHost]${NC} $1"; }
log_error() { echo -e "${RED}[StardropHost]${NC} $1"; }
log_step()  { echo -e "${BLUE}${1}${NC}"; }

# -- Audio driver config --
configure_audio_driver() {
    if [ -z "${SDL_AUDIODRIVER:-}" ]; then
        export SDL_AUDIODRIVER=dummy
        log_info "No audio driver configured, defaulting SDL_AUDIODRIVER=dummy"
    fi
    if [ -z "${ALSOFT_DRIVERS:-}" ]; then
        export ALSOFT_DRIVERS=null
        log_info "No OpenAL driver configured, defaulting ALSOFT_DRIVERS=null"
    fi
}

# -- Performance mode --
configure_performance_mode() {
    [ "$LOW_PERF_MODE" = "true" ] || return 0

    RESOLUTION_WIDTH=${LOW_PERF_RESOLUTION_WIDTH:-$LOW_PERF_DEFAULT_WIDTH}
    RESOLUTION_HEIGHT=${LOW_PERF_RESOLUTION_HEIGHT:-$LOW_PERF_DEFAULT_HEIGHT}

    if [ -z "$TARGET_FPS_RAW" ]; then
        TARGET_FPS=$LOW_PERF_DEFAULT_FPS
    fi
    REFRESH_RATE=${LOW_PERF_REFRESH_RATE:-$TARGET_FPS}
    XVFB_COLOR_DEPTH=${LOW_PERF_COLOR_DEPTH:-$LOW_PERF_DEFAULT_COLOR_DEPTH}

    export SDL_VIDEODRIVER=${SDL_VIDEODRIVER:-x11}
    export SDL_AUDIODRIVER=${SDL_AUDIODRIVER:-dummy}
    export MONO_GC_PARAMS=${MONO_GC_PARAMS:-nursery-size=8m}
    export DOTNET_GCHeapHardLimit=${DOTNET_GCHeapHardLimit:-0x30000000}

    if [ "${USE_GPU:-false}" != "true" ]; then
        export LIBGL_ALWAYS_SOFTWARE=${LIBGL_ALWAYS_SOFTWARE:-1}
    fi

    XVFB_FB_DIR=${XVFB_FB_DIR:-/dev/shm/xvfb}
    if mkdir -p "$XVFB_FB_DIR" 2>/dev/null; then
        XVFB_FB_ARGS=(-fbdir "$XVFB_FB_DIR")
    else
        XVFB_FB_DIR=""
        XVFB_FB_ARGS=()
    fi

    log_info "Low performance mode enabled"
    log_info "  Render: ${RESOLUTION_WIDTH}x${RESOLUTION_HEIGHT} @ ${REFRESH_RATE}fps"
    log_info "  Color depth: ${XVFB_COLOR_DEPTH}bit"
}

# -- Startup preferences tuning --
apply_startup_preferences_tuning() {
    local config_file=$1
    [ -f "$config_file" ] || return 0
    [ "$LOW_PERF_MODE" = "true" ] || return 0

    perl -0pi -e "
        s#<fullscreenResolutionX>.*?</fullscreenResolutionX>#<fullscreenResolutionX>${RESOLUTION_WIDTH}</fullscreenResolutionX>#s;
        s#<fullscreenResolutionY>.*?</fullscreenResolutionY>#<fullscreenResolutionY>${RESOLUTION_HEIGHT}</fullscreenResolutionY>#s;
        s#<preferredResolutionX>.*?</preferredResolutionX>#<preferredResolutionX>${RESOLUTION_WIDTH}</preferredResolutionX>#s;
        s#<preferredResolutionY>.*?</preferredResolutionY>#<preferredResolutionY>${RESOLUTION_HEIGHT}</preferredResolutionY>#s;
        s#<vsyncEnabled>.*?</vsyncEnabled>#<vsyncEnabled>true</vsyncEnabled>#s;
        s#<startMuted>.*?</startMuted>#<startMuted>true</startMuted>#s;
        s#<musicVolumeLevel>.*?</musicVolumeLevel>#<musicVolumeLevel>0</musicVolumeLevel>#s;
        s#<soundVolumeLevel>.*?</soundVolumeLevel>#<soundVolumeLevel>0</soundVolumeLevel>#s;
    " "$config_file"
}

# -- Game file setup --
# Handles three cases:
#   1. Local files already in /home/steam/stardewvalley (volume mount)
#   2. GAME_PATH set - copy from specified path
#   3. STEAM_DOWNLOAD=true - download via Steam (credentials via web UI)
setup_game_files() {
    # Case 1: Game already present
    if [ -f "/home/steam/stardewvalley/StardewValley" ]; then
        log_info "✅ Game files found, skipping setup"
        return 0
    fi

    # Case 2: Copy from GAME_PATH
    if [ -n "$GAME_PATH" ] && [ -d "$GAME_PATH" ]; then
        log_info "Copying game files from: $GAME_PATH"
        cp -r "$GAME_PATH/." /home/steam/stardewvalley/
        if [ -f "/home/steam/stardewvalley/StardewValley" ]; then
            log_info "✅ Game files copied successfully"
            return 0
        else
            log_error "❌ Game files copy failed - StardewValley binary not found"
            return 1
        fi
    fi

    # Case 3: Download via Steam
    if [ "$STEAM_DOWNLOAD" = "true" ]; then
        log_info "Steam download requested"
        download_game_via_steam
        return $?
    fi

    # No game files found and no setup method configured
    log_warn "❌ No game files found — waiting for setup wizard to provide them."
    log_warn "   Open the web panel and complete the Game Files step."

    # Wait loop: re-reads env every 30s and retries Steam download when
    # credentials appear (wizard may have written them while we loop).
    while [ ! -f "/home/steam/stardewvalley/StardewValley" ]; do
        sleep 30
        load_panel_env_overrides

        if [ "$STEAM_DOWNLOAD" = "true" ] && [ -n "${STEAM_USERNAME:-}" ]; then
            log_info "Steam credentials detected — attempting download..."
            if download_game_via_steam; then
                break
            fi
            # Reset so we don't retry immediately on the same bad credentials
            unset STEAM_DOWNLOAD STEAM_USERNAME STEAM_PASSWORD STEAM_GUARD_CODE
            log_warn "Download failed — waiting for new credentials via the web panel..."
        fi
    done
    log_info "✅ Game files detected, continuing startup..."
    return 0
}

# -- Steam download --
download_game_via_steam() {
    log_info "Starting Steam download..."
    log_info "This may take 5-15 minutes depending on your connection"

    local STEAMCMD_LOG="/tmp/steamcmd_out.log"

    # Build args array so spaces in values are handled correctly
    local STEAMCMD_ARGS=(
        +force_install_dir /home/steam/stardewvalley
    )
    if [ -n "${STEAM_GUARD_CODE:-}" ]; then
        log_info "Using Steam Guard code"
        STEAMCMD_ARGS+=(+set_steam_guard_code "$STEAM_GUARD_CODE")
    fi
    STEAMCMD_ARGS+=(
        +login "$STEAM_USERNAME" "$STEAM_PASSWORD"
        +app_update 413150 validate
        +quit
    )

    # Pipe steamcmd output to: container stdout, temp file (for error detection),
    # and setup.log (so the web panel can show live progress in step 3).
    # ANSI escape codes are stripped before writing to setup.log.
    /home/steam/steamcmd/steamcmd.sh "${STEAMCMD_ARGS[@]}" 2>&1 | \
        tee "$STEAMCMD_LOG" | \
        while IFS= read -r line; do
            clean=$(printf '%s' "$line" | sed 's/\x1b\[[0-9;]*m//g' | tr -d '\r')
            [ -n "$clean" ] && _log_to_file "[STEAM] $clean"
        done

    # Always clear credentials from env file after attempt — never persist them
    ENV_FILE="${ENV_FILE:-/home/steam/web-panel/data/runtime.env}"
    if [ -f "$ENV_FILE" ]; then
        sed -i '/^STEAM_USERNAME=/d' "$ENV_FILE" 2>/dev/null || true
        sed -i '/^STEAM_PASSWORD=/d' "$ENV_FILE" 2>/dev/null || true
        sed -i '/^STEAM_GUARD_CODE=/d' "$ENV_FILE" 2>/dev/null || true
        log_info "Steam credentials cleared from env file"
    fi

    if [ -f "/home/steam/stardewvalley/StardewValley" ]; then
        log_info "✅ Game downloaded successfully"
        if [ -f "$ENV_FILE" ]; then
            sed -i '/^STEAM_DOWNLOAD=/d' "$ENV_FILE" 2>/dev/null || true
        fi
        rm -f "$STEAMCMD_LOG"
        return 0
    fi

    # Inspect steamcmd output to give the user a specific reason
    if grep -qi "steam guard\|steamguard\|two-factor\|enter.*code\|Invalid Login AuthCode\|STEAM_GUARD_CODE" "$STEAMCMD_LOG" 2>/dev/null; then
        log_warn "⚠️  STEAM_GUARD_REQUIRED — enter the code from your email or authenticator app"
        log_warn "    Enter the code in the web panel and click 'Submit Guard Code & Download' to retry"
    elif grep -qi "Invalid Password\|INVALID_PASSWORD\|incorrect password" "$STEAMCMD_LOG" 2>/dev/null; then
        log_error "❌ STEAM_WRONG_PASSWORD — check your Steam username and password"
    elif grep -qi "rate.limit\|too many\|RATE_LIMIT" "$STEAMCMD_LOG" 2>/dev/null; then
        log_warn "⚠️  STEAM_RATE_LIMIT — Steam has rate-limited this login, wait a few minutes then retry"
    else
        log_error "❌ STEAM_DOWNLOAD_FAILED — download failed, check credentials and try again"
    fi

    rm -f "$STEAMCMD_LOG"
    return 1
}

# -- GPU Xorg startup --
start_gpu_xorg() {
    local context=${1:-"unknown"}
    [ "$USE_GPU" = "true" ] || return 3

    log_info "USE_GPU=true - Attempting Xorg startup (context: $context)"
    rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true

    if [ -e /dev/dri/renderD128 ] || ls /dev/dri 2>/dev/null | grep -q .; then
        log_info "Detected /dev/dri, starting Xorg :99"

        mkdir -p /tmp/.X11-unix
        chmod 1777 /tmp/.X11-unix
        mkdir -p /home/steam/.local/share/xorg

        if [ "$(id -u)" = "0" ]; then
            chown root:root /home/steam/.local/share/xorg 2>/dev/null || true
        fi

        Xorg -noreset +extension GLX +extension RANDR :99 \
            -logfile /home/steam/.local/share/xorg/Xorg.0.log &
        sleep 2

        DISPLAY=:99 /home/steam/scripts/set-resolution.sh \
            "${RESOLUTION_WIDTH}" "${RESOLUTION_HEIGHT}" "${REFRESH_RATE}" || \
            log_warn "Failed to set resolution, using defaults"
        sleep 1

        if pgrep -x Xorg >/dev/null 2>&1; then
            export DISPLAY=${DISPLAY:-:99}
            log_info "✅ Xorg started on :99"
            return 0
        else
            log_warn "Xorg failed to start, will fallback to Xvfb"
            return 2
        fi
    else
        log_warn "/dev/dri not detected, skipping Xorg"
        return 1
    fi
}

# ===========================================
# Phase 1 - Root Initialization
# ===========================================

configure_audio_driver
configure_performance_mode

if [ "$(id -u)" = "0" ]; then
    log_step "================================================"
    log_step "  Phase 1: Root Initialization"
    log_step "================================================"

    # Try GPU Xorg if enabled (requires root for /dev/dri access)
    if [ "$USE_GPU" = "true" ]; then
        start_gpu_xorg "root" || log_warn "GPU startup failed, will fallback to Xvfb"
    fi

    # Create runtime directories
    mkdir -p /home/steam/.local/share/stardrop \
             /home/steam/.local/share/stardrop/logs \
             /home/steam/.local/share/stardrop/backups \
             /home/steam/web-panel/data
    chown -R 1000:1000 \
        /home/steam/.local/share/stardrop \
        /home/steam/web-panel/data 2>/dev/null || true

    log_info "Switching to steam user..."
    exec runuser -u steam -- env DISPLAY="$DISPLAY" "$0" "$@"
fi

# ===========================================
# Phase 2 - Steam User Operations
# ===========================================

# -- Setup log for web panel visibility --
# Written to a file the web panel can serve so the wizard can show
# live progress even before SMAPI (and its log file) exists.
SETUP_LOG_FILE="/home/steam/.local/share/stardrop/logs/setup.log"
mkdir -p "$(dirname "$SETUP_LOG_FILE")" 2>/dev/null || true
> "$SETUP_LOG_FILE" 2>/dev/null || true   # clear on fresh start

_log_to_file() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$1" >> "$SETUP_LOG_FILE" 2>/dev/null || true; }

# Re-declare log helpers so every message also goes to the file
log_info()  { echo -e "${GREEN}[StardropHost]${NC} $1"; _log_to_file "[INFO]  $1"; }
log_warn()  { echo -e "${YELLOW}[StardropHost]${NC} $1"; _log_to_file "[WARN]  $1"; }
log_error() { echo -e "${RED}[StardropHost]${NC} $1";    _log_to_file "[ERROR] $1"; }
log_step()  { echo -e "${BLUE}${1}${NC}";                _log_to_file "[STEP]  $1"; }

log_step "================================================"
log_step "  StardropHost v1.0.0 Starting..."
log_step "================================================"

# Verify steam user
if [ "$(id -u)" != "1000" ]; then
    log_error "Script must run as steam user (UID 1000)"
    exit 1
fi

# -- Step 0: Start web panel early --
# Must start before game file setup so the setup wizard is reachable
# even when no game files are present (the while-loop in setup_game_files
# would otherwise block the panel from ever starting).
log_step "Step 0: Starting web panel..."
cd /home/steam/web-panel
node server.js &
WEB_PANEL_PID=$!
log_info "✅ Web panel started (PID: $WEB_PANEL_PID, port: ${PANEL_PORT:-18642})"
cd /home/steam

# -- Step 1: Validate configuration --
log_step "Step 1: Validating configuration..."

# Load any runtime env overrides from web panel
load_panel_env_overrides

log_info "Configuration loaded"

# -- Step 2: Setup game files --
log_step "Step 2: Setting up game files..."
if ! setup_game_files; then
    log_error "Game setup failed. Container will exit."
    exit 1
fi

# -- Step 3: Install SMAPI --
log_step "Step 3: Installing SMAPI mod loader..."

# If update.sh queued a SMAPI update, download the requested version from
# GitHub and overwrite the version baked into the image at build time.
SMAPI_UPDATE_MARKER="/home/steam/web-panel/data/smapi-update-needed"
if [ -f "$SMAPI_UPDATE_MARKER" ]; then
    _TARGET_SMAPI=$(cat "$SMAPI_UPDATE_MARKER" | tr -d '[:space:]')
    log_info "SMAPI update queued: downloading v${_TARGET_SMAPI}..."
    _SMAPI_URL="https://github.com/Pathoschild/SMAPI/releases/download/${_TARGET_SMAPI}/SMAPI-${_TARGET_SMAPI}-installer.zip"
    _SMAPI_TMP="/home/steam/smapi-download-tmp"
    rm -rf "$_SMAPI_TMP" && mkdir -p "$_SMAPI_TMP"
    if curl -fsSL --max-time 120 "$_SMAPI_URL" -o "$_SMAPI_TMP/SMAPI-installer.zip" 2>/dev/null; then
        # Replace bundled installer only on successful download
        rm -rf /home/steam/smapi
        mv "$_SMAPI_TMP" /home/steam/smapi
        rm -f "$SMAPI_UPDATE_MARKER"
        log_info "✅ SMAPI v${_TARGET_SMAPI} downloaded"
    else
        rm -rf "$_SMAPI_TMP"
        rm -f "$SMAPI_UPDATE_MARKER"
        log_warning "Could not download SMAPI v${_TARGET_SMAPI} — using bundled version"
    fi
fi

if [ ! -f "/home/steam/stardewvalley/StardewModdingAPI" ]; then
    log_info "Installing SMAPI..."
    cd /home/steam
    # SMAPI changed their zip structure — the installer zip may be nested inside an outer zip
    (cd smapi && for f in *.zip; do [ -f "$f" ] && unzip -q "$f" && rm "$f"; done) 2>/dev/null || true
    echo "1" | dotnet smapi/SMAPI*/internal/linux/SMAPI.Installer.dll \
        --install \
        --game-path /home/steam/stardewvalley

    if [ $? -ne 0 ]; then
        log_error "Failed to install SMAPI!"
        exit 1
    fi
    log_info "✅ SMAPI installed successfully"
else
    log_info "✅ SMAPI already installed"
fi

# -- Step 3.5: Build ServerDashboard mod --
# Runs here because game files + SMAPI are now in place, providing the
# DLLs (StardewValley.dll, StardewModdingAPI.dll) that ModBuildConfig
# needs. NuGet packages were pre-restored into the image during docker build
# so this works without internet access.
log_step "Step 3.5: Building ServerDashboard mod..."

SD_SRC="/home/steam/mod-source/ServerDashboard"
SD_DEST="/home/steam/preinstalled-mods/ServerDashboard"

if [ -f "$SD_DEST/ServerDashboard.dll" ]; then
    log_info "✅ ServerDashboard already built"
elif [ -d "$SD_SRC" ]; then
    log_info "Building ServerDashboard against game files..."
    dotnet build "$SD_SRC" -c Release \
        /p:GamePath=/home/steam/stardewvalley \
        /p:EnableModDeploy=false \
        /p:EnableModZip=false \
        2>&1

    SD_OUT="$SD_SRC/bin/Release/net6.0"
    if [ -f "$SD_OUT/ServerDashboard.dll" ]; then
        mkdir -p "$SD_DEST"
        cp "$SD_OUT/ServerDashboard.dll" "$SD_DEST/"
        cp "$SD_SRC/manifest.json"       "$SD_DEST/"
        chown -R steam:steam "$SD_DEST" 2>/dev/null || true
        log_info "✅ ServerDashboard built and staged"
    else
        log_warn "⚠️  ServerDashboard build failed — live dashboard data won't update"
        log_warn "    The server will still run normally"
    fi
else
    log_warn "⚠️  ServerDashboard source not found at $SD_SRC — skipping"
fi

# -- Step 3.55: Build AutoHideHost mod (translated source replaces pre-built DLL) --
log_step "Step 3.55: Building AutoHideHost mod..."

AHH_SRC="/home/steam/mod-source/AutoHideHost"
AHH_DEST="/home/steam/preinstalled-mods/AutoHideHost"

if [ -f "$AHH_DEST/AutoHideHost.dll" ]; then
    log_info "✅ AutoHideHost already built"
elif [ -d "$AHH_SRC" ]; then
    log_info "Building AutoHideHost against game files..."
    dotnet build "$AHH_SRC" -c Release \
        /p:GamePath=/home/steam/stardewvalley \
        /p:EnableModDeploy=false \
        /p:EnableModZip=false \
        2>&1

    AHH_OUT="$AHH_SRC/bin/Release/net6.0"
    if [ -f "$AHH_OUT/AutoHideHost.dll" ]; then
        mkdir -p "$AHH_DEST"
        cp "$AHH_OUT/AutoHideHost.dll" "$AHH_DEST/"
        chown -R steam:steam "$AHH_DEST" 2>/dev/null || true
        log_info "✅ AutoHideHost built and staged"
    else
        log_warn "⚠️  AutoHideHost build failed — using pre-built version"
    fi
else
    log_warn "⚠️  AutoHideHost source not found at $AHH_SRC — using pre-built version"
fi

# -- Step 3.6: Build StardropGameManager mod --
# Headless co-op startup orchestrator — replaces both FarmAutoCreate and ServerAutoLoad.
# Loads the most recent save as co-op host, or creates a new native co-op farm from
# new-farm.json using the CoopMenu.HostNewFarmSlot path (Steam invite codes work correctly).
log_step "Step 3.6: Building StardropGameManager mod..."

SGM_SRC="/home/steam/mod-source/StardropGameManager"
SGM_DEST="/home/steam/preinstalled-mods/StardropGameManager"

if [ -f "$SGM_DEST/StardropGameManager.dll" ]; then
    log_info "✅ StardropGameManager already built"
elif [ -d "$SGM_SRC" ]; then
    log_info "Building StardropGameManager against game files..."
    dotnet build "$SGM_SRC" -c Release \
        /p:GamePath=/home/steam/stardewvalley \
        /p:EnableModDeploy=false \
        /p:EnableModZip=false \
        2>&1

    SGM_OUT="$SGM_SRC/bin/Release/net6.0"
    if [ -f "$SGM_OUT/StardropGameManager.dll" ]; then
        mkdir -p "$SGM_DEST"
        cp "$SGM_OUT/StardropGameManager.dll" "$SGM_DEST/"
        cp "$SGM_SRC/manifest.json"           "$SGM_DEST/"
        chown -R steam:steam "$SGM_DEST" 2>/dev/null || true
        log_info "✅ StardropGameManager built and staged"
    else
        log_warn "⚠️  StardropGameManager build failed — server will not auto-load or create farms"
        log_warn "    Check the build output above for C# compile errors"
    fi
else
    log_warn "⚠️  StardropGameManager source not found at $SGM_SRC — skipping"
fi

# -- Step 4: Install mods --
log_step "Step 4: Installing mods..."

mkdir -p /home/steam/stardewvalley/Mods

# Remove mods that have been replaced in this version, so stale DLLs
# from a previous install on the volume-mounted game directory don't linger.
rm -rf /home/steam/stardewvalley/Mods/FarmAutoCreate  2>/dev/null || true
rm -rf /home/steam/stardewvalley/Mods/ServerAutoLoad   2>/dev/null || true

if [ -d "/home/steam/preinstalled-mods" ]; then
    log_info "Installing mods..."
    cp -r /home/steam/preinstalled-mods/* /home/steam/stardewvalley/Mods/
    log_info "✅ Mods installed"

    log_info "Installed mods:"
    ls -1 /home/steam/stardewvalley/Mods/ | while read mod; do
        log_info "  ✅ $mod"
    done
fi

# -- Step 4.5: Install custom mods --
CUSTOM_MODS_DIR="/home/steam/custom-mods"
if [ -d "$CUSTOM_MODS_DIR" ] && [ "$(ls -A "$CUSTOM_MODS_DIR" 2>/dev/null)" ]; then
    log_step "Step 4.5: Installing custom mods..."

    for mod_entry in "$CUSTOM_MODS_DIR"/*; do
        mod_name=$(basename "$mod_entry")
        [[ "$mod_name" == .* ]] && continue

        if [ -d "$mod_entry" ]; then
            log_info "  Installing: $mod_name"
            cp -r "$mod_entry" "/home/steam/stardewvalley/Mods/$mod_name"
        elif [[ "$mod_entry" == *.zip ]]; then
            log_info "  Extracting: $mod_name"
            unzip -q -o "$mod_entry" -d "/home/steam/stardewvalley/Mods/" 2>/dev/null || \
                log_warn "  Failed to extract: $mod_name"
        fi
    done
    log_info "✅ Custom mods installed"
fi

# -- Step 4.7: Steam SDK setup --
# Downloads Steamworks SDK Redist (App 1007, anonymous) to obtain steamclient.so,
# links it to ~/.steam/sdk64/ so the game's libsteam_api.so can connect to Steam,
# and writes steam_appid.txt so the SDK targets Stardew Valley (413150).
# Without this, Game1.server.getInviteCode() always returns null.
log_step "Step 4.7: Setting up Steam SDK for multiplayer..."

STEAM_SDK_CACHE="/home/steam/steam-sdk"
STEAM_SDK_SO="$STEAM_SDK_CACHE/linux64/steamclient.so"
STEAM_SDK_DEST_DIR="/home/steam/.steam/sdk64"
STEAM_APPID_FILE="/home/steam/stardewvalley/steam_appid.txt"

if [ ! -f "$STEAM_SDK_SO" ]; then
    log_info "Downloading Steamworks SDK Redist (App 1007, anonymous)..."
    mkdir -p "$STEAM_SDK_CACHE"
    /home/steam/steamcmd/steamcmd.sh \
        +force_install_dir "$STEAM_SDK_CACHE" \
        +login anonymous \
        +app_update 1007 \
        +quit 2>&1 | tail -5
fi

if [ -f "$STEAM_SDK_SO" ]; then
    mkdir -p "$STEAM_SDK_DEST_DIR"
    ln -sf "$STEAM_SDK_SO" "$STEAM_SDK_DEST_DIR/steamclient.so"
    log_info "✅ Steam SDK linked ($STEAM_SDK_DEST_DIR/steamclient.so)"
else
    log_warn "⚠️  Could not obtain steamclient.so — Steam invite codes will not work"
fi

echo "413150" > "$STEAM_APPID_FILE"
log_info "✅ steam_appid.txt written (413150)"

# -- Step 5: Virtual display --
log_step "Step 5: Starting virtual display..."

START_XVFB_FALLBACK=false

if pgrep -x Xorg >/dev/null 2>&1; then
    export DISPLAY=${DISPLAY:-:99}
    log_info "Xorg already running, using DISPLAY=${DISPLAY}"
else
    if [ "$USE_GPU" = "true" ]; then
        log_warn "Xorg not running, falling back to Xvfb"
    fi
    START_XVFB_FALLBACK=true
fi

if [ "$START_XVFB_FALLBACK" = "true" ]; then
    log_info "Starting Xvfb (software rendering)..."
    rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
    Xvfb :99 \
        -screen 0 "${RESOLUTION_WIDTH}x${RESOLUTION_HEIGHT}x${XVFB_COLOR_DEPTH}" \
        -ac +extension GLX +render -noreset \
        "${XVFB_FB_ARGS[@]}" &
    export DISPLAY=${DISPLAY:-:99}
    sleep 3
    log_info "✅ Virtual display started on ${DISPLAY} (${RESOLUTION_WIDTH}x${RESOLUTION_HEIGHT}x${XVFB_COLOR_DEPTH})"
fi

# -- Step 6: VNC server (optional) --
if [ "$ENABLE_VNC" = "true" ]; then
    log_step "Step 6: Starting VNC server..."

    VNC_PASSWORD=${VNC_PASSWORD:-"stardew1"}
    if [ ${#VNC_PASSWORD} -gt 8 ]; then
        log_warn "VNC password > 8 chars, truncating"
        VNC_PASSWORD="${VNC_PASSWORD:0:8}"
    fi

    sleep 2
    log_info "Starting x11vnc on display ${DISPLAY} (port 5900)..."
    x11vnc -display "${DISPLAY}" -forever -shared \
        -passwd "$VNC_PASSWORD" -rfbport 5900 \
        -noxdamage -bg 2>&1 | grep -v "^$"
    sleep 2

    if pgrep -x "x11vnc" >/dev/null; then
        log_info "✅ VNC server started on port 5900"
        log_info "  Toggle via web UI to enable/disable"

        if [ -f "/home/steam/scripts/vnc-monitor.sh" ]; then
            log_info "Starting VNC health monitor..."
            /home/steam/scripts/vnc-monitor.sh &
            log_info "✅ VNC monitor started"
        fi
    else
        log_error "VNC server failed to start"
    fi
else
    log_step "Step 6: VNC disabled (toggle via web UI)"
fi

# -- Step 7: Game display config --
log_step "Step 7: Configuring game display settings..."

CONFIG_DIR="/home/steam/.config/StardewValley"
CONFIG_FILE="$CONFIG_DIR/startup_preferences"
TEMPLATE="/home/steam/startup_preferences.template"

mkdir -p "$CONFIG_DIR"

if [ ! -f "$CONFIG_FILE" ]; then
    if [ -f "$TEMPLATE" ]; then
        cp "$TEMPLATE" "$CONFIG_FILE"
        log_info "✅ Applied display config"
    else
        log_warn "Template not found, using game defaults"
    fi
else
    log_info "✅ Game config exists, keeping user settings"
fi

apply_startup_preferences_tuning "$CONFIG_FILE"

# -- Step 7.5: Save selection --
if [ -n "$SAVE_NAME" ]; then
    log_step "Step 7.5: Selecting save file..."
    /home/steam/scripts/save-selector.sh
fi

# -- Step 8: Log monitoring --
if [ "$ENABLE_LOG_MONITOR" = "true" ]; then
    log_step "Step 8: Starting log monitoring..."
    if [ -f "/home/steam/scripts/log-monitor.sh" ]; then
        /home/steam/scripts/log-monitor.sh &
        log_info "✅ Log monitoring started"
    fi
else
    log_step "Step 8: Log monitoring disabled"
fi

# -- Step 8.5: Steam authentication wait (steam mode only) --
if [ "${SERVER_MODE:-lan}" = "steam" ]; then
    log_step "Step 8.5: Steam mode — waiting for Steam authentication..."
    if [ -f "/tmp/steam-ready" ]; then
        log_info "✅ Steam session found — starting in Steam mode"
    else
        log_info "Steam mode enabled. Open the web panel to authenticate with Steam."
        log_info "The server will start after login, or fall back to LAN after 5 minutes."
        log_info "  You can also click 'Start as LAN' in the web panel to skip."
        _steam_wait=0
        while [ ! -f "/tmp/steam-ready" ] && [ ! -f "/tmp/steam-skip" ] && [ $_steam_wait -lt 300 ]; do
            sleep 5
            _steam_wait=$((_steam_wait + 5))
        done
        if [ -f "/tmp/steam-ready" ]; then
            log_info "✅ Steam authenticated — starting in Steam mode"
        else
            log_warn "⚠️  Steam auth timed out or skipped — starting in LAN mode"
            touch /tmp/steam-skip
        fi
    fi
fi

# -- Step 9: Start game server --
log_step "Step 9: Starting game server..."
log_info "================================================"
log_info "  StardropHost is starting!"
log_info "================================================"
log_info ""
log_info "  Web panel:  http://localhost:18642"
log_info "  Game port:  24642/UDP"
log_info ""
log_info "  Players connect via:"
log_info "    Open Stardew Valley → CO-OP → Join LAN Game"
log_info "    Or enter server IP directly"
log_info ""
log_info "================================================"
log_info ""

cd /home/steam/stardewvalley

# Start event handler
log_info "Starting event handler..."
/home/steam/scripts/event-handler.sh &

# New farm config — StardropGameManager SMAPI mod handles creation automatically.
# The mod reads new-farm.json once the title screen appears and creates
# the farm using Stardew's own C# API (native co-op, Steam invite codes work).
NEW_FARM_CONFIG="/home/steam/web-panel/data/new-farm.json"
SAVES_DIR="/home/steam/.config/StardewValley/Saves"
if [ -f "$NEW_FARM_CONFIG" ]; then
    if [ ! "$(ls -A "$SAVES_DIR" 2>/dev/null)" ]; then
        log_info "New farm config detected — StardropGameManager will create farm on title screen"
    else
        log_info "Save files already exist — removing new-farm.json"
        rm -f "$NEW_FARM_CONFIG"
    fi
fi

# Start auto-backup if enabled
if [ "$ENABLE_AUTO_BACKUP" = "true" ]; then
    log_info "Starting auto-backup service..."
    /home/steam/scripts/auto-backup.sh &
fi

# Start status reporter
log_info "Starting status reporter (port: ${METRICS_PORT:-9090})..."
/home/steam/scripts/status-reporter.sh &

# Start with or without crash monitor
if [ "$ENABLE_CRASH_RESTART" = "true" ]; then
    log_info "Starting game with crash auto-restart..."
    exec /home/steam/scripts/crash-monitor.sh
else
    exec ./StardewModdingAPI --server
fi