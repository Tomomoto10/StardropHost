#!/bin/bash
# ===========================================
# StardropHost | quick-start.sh
# ===========================================
# One-command setup script. Does everything:
#   1. Installs Docker (if not already present)
#   2. Downloads StardropHost from GitHub
#   3. Configures ports and data directories
#   4. Builds the Docker image and starts the
#      server and web panel
#
# Run it once per server instance. Running it
# again on the same machine creates a second
# independent instance on different ports.
#
# Usage:
#   sudo bash quick-start.sh           # first install
#   sudo bash quick-start.sh           # second run = new instance (different ports)
#
# sudo is sufficient — su - is NOT required.
# If sudo is not installed, the script will
# install it automatically (root password
# prompted once).
#
# Supports: Ubuntu, Debian, Raspberry Pi OS,
#           CentOS, RHEL, Fedora, Amazon Linux
# ===========================================

set +e

# Directory where this script lives — logs go here.
# In pipe mode ($0 is the bash binary itself) fall back to $PWD.
case "$0" in
    bash|*/bash|-bash)
        SCRIPT_DIR="$PWD"
        PIPE_MODE=1
        ;;
    *)
        SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
        PIPE_MODE=0
        ;;
esac
QUICK_START_URL="https://raw.githubusercontent.com/Tomomoto10/StardropHost/main/quick-start.sh"

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
    echo -e "${CYAN}${BOLD}  StardropHost — Quick Start${NC}"
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}
print_success() { echo -e "${GREEN}[OK]   $1${NC}"; }
print_error()   { echo -e "${RED}[ERR]  $1${NC}"; }
print_warning() { echo -e "${YELLOW}[WARN] $1${NC}"; }
print_info()    { echo -e "${BLUE}[>>]   $1${NC}"; }
print_step()    { echo ""; echo -e "${BOLD}$1${NC}"; }

COMPOSE_CMD=""

# ===========================================
# Detect real user BEFORE any root elevation.
#
# Priority:
#  1. SUDO_USER  — set automatically by sudo
#  2. Current UID if non-root
#  3. Root fallback (su - / root login)
# ===========================================
if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != "root" ]; then
    REAL_USER="$SUDO_USER"
    REAL_HOME=$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6 || echo "/home/$SUDO_USER")
elif [ "$(id -u)" != "0" ]; then
    REAL_USER="$(id -un)"
    REAL_HOME="$HOME"
else
    REAL_USER="root"
    REAL_HOME="/root"
fi

# ===========================================
# Root check — elevate with sudo (preferred)
# or install sudo via su if missing, then
# re-exec. sudo is NOT revoked after install;
# the user stays in the sudoers group for
# future management of this directory.
# ===========================================
if [ "$(id -u)" != "0" ]; then
    if command -v sudo &>/dev/null; then
        echo -e "${BLUE}[>>]   Elevating with sudo...${NC}"

        if [ "$PIPE_MODE" = "1" ]; then
            # Piped via "curl ... | bash" — $0 is the bash binary, can't re-exec it.
            # Re-fetch the script and hand it to sudo bash directly.
            echo -e "${BLUE}[>>]   Pipe mode detected — re-fetching script under sudo...${NC}"
            exec sudo bash -c \
                "$(curl -fsSL "$QUICK_START_URL")" \
                quick-start.sh "$@"
        else
            exec sudo bash "$0" "$@"
        fi

    else
        # sudo not present — install it via su, then re-exec
        echo -e "${YELLOW}[WARN] sudo is not installed.${NC}"
        echo -e "${BLUE}[>>]   Attempting to install sudo (root password required)...${NC}"

        if command -v apt-get &>/dev/null; then
            INSTALL_SUDO_CMD="apt-get install -y sudo"
        elif command -v dnf &>/dev/null; then
            INSTALL_SUDO_CMD="dnf install -y sudo"
        elif command -v yum &>/dev/null; then
            INSTALL_SUDO_CMD="yum install -y sudo"
        else
            echo -e "${RED}[ERR]  Cannot detect package manager to install sudo.${NC}"
            echo ""
            echo "  Please install sudo manually, then re-run:"
            echo "    sudo bash quick-start.sh"
            echo "  or: curl -fsSL $QUICK_START_URL | sudo bash"
            exit 1
        fi

        su -c "$INSTALL_SUDO_CMD && usermod -aG sudo $REAL_USER" root
        SUDO_INSTALL_RC=$?

        if [ $SUDO_INSTALL_RC -ne 0 ]; then
            echo -e "${RED}[ERR]  Failed to install sudo (exit code $SUDO_INSTALL_RC).${NC}"
            echo ""
            echo "  Run directly as root: su -c 'curl -fsSL $QUICK_START_URL | bash'"
            exit 1
        fi

        if command -v sudo &>/dev/null; then
            echo -e "${GREEN}[OK]   sudo installed. Continuing...${NC}"
            if [ "$PIPE_MODE" = "1" ]; then
                exec sudo bash -c \
                    "$(curl -fsSL "$QUICK_START_URL")" \
                    quick-start.sh "$@"
            else
                exec sudo bash "$0" "$@"
            fi
        else
            echo -e "${RED}[ERR]  sudo still not found after install.${NC}"
            echo "  Try: su -c 'curl -fsSL $QUICK_START_URL | bash'"
            exit 1
        fi
    fi
fi

# ===========================================
# OS Detection
# ===========================================
detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS_ID="$ID"
        OS_LIKE="${ID_LIKE:-}"
        OS_NAME="${PRETTY_NAME:-$ID}"
    else
        OS_ID="unknown"
        OS_LIKE=""
        OS_NAME="Unknown"
    fi
}

is_debian_based() {
    echo "$OS_ID $OS_LIKE" | grep -qiE "debian|ubuntu|raspbian|linuxmint|pop"
}

is_rhel_based() {
    echo "$OS_ID $OS_LIKE" | grep -qiE "rhel|centos|fedora|amzn|rocky|almalinux"
}

# ===========================================
# Instance detection — find the next
# available install directory and port set.
#
# Instance 1: ~/stardrophost       ports 18642 / 24642 / 5900 / 9090
# Instance 2: ~/stardrophost-2     ports 18643 / 24643 / 5901 / 9091
# Instance N: ~/stardrophost-N     ports 18641+N / 24641+N / 5899+N / 9089+N
# ===========================================
find_instance() {
    BASE="$REAL_HOME/stardrophost"

    # Instance 1 slot free?
    if [ ! -f "$BASE/docker-compose.yml" ]; then
        INSTALL_DIR="$BASE"
        INSTANCE_NUM=1
        return
    fi

    # Find next available slot (cap at 10 instances)
    for n in $(seq 2 10); do
        if [ ! -f "$BASE-$n/docker-compose.yml" ]; then
            INSTALL_DIR="$BASE-$n"
            INSTANCE_NUM=$n
            return
        fi
    done

    # All 10 slots taken
    echo -e "${RED}[ERR]  Maximum of 10 StardropHost instances already installed.${NC}"
    echo ""
    echo "  Existing instances:"
    echo "    $BASE  (instance 1)"
    for n in $(seq 2 10); do
        [ -f "$BASE-$n/docker-compose.yml" ] && echo "    $BASE-$n  (instance $n)"
    done
    echo ""
    echo "  To free a slot: cd ~/stardrophost-N && docker compose down --volumes"
    echo "  Then remove the directory and re-run this script."
    exit 1
}

find_instance

GAME_PORT=$((24641 + INSTANCE_NUM))
PANEL_PORT=$((18641 + INSTANCE_NUM))
VNC_PORT=$((5899  + INSTANCE_NUM))
METRICS_PORT=$((9089 + INSTANCE_NUM))

if [ "$INSTANCE_NUM" -eq 1 ]; then
    CONTAINER_PREFIX="stardrop"
else
    CONTAINER_PREFIX="stardrop${INSTANCE_NUM}"
fi

# ===========================================
# Logging — written to /tmp first so the
# install directory is empty for git clone.
# Once the directory exists, the log is
# copied there on exit so you can review it.
# ===========================================
LOG_STAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="/tmp/stardrop-install-${INSTANCE_NUM}-${LOG_STAMP}.log"
exec > >(tee -a "$LOG_FILE") 2>&1

# ===========================================
# Step 1 — Install Docker
# Adds Docker's official apt/dnf/yum repo and
# installs docker-ce + docker-compose-plugin.
# Falls back to get.docker.com if the distro
# isn't recognised.
# ===========================================
install_docker() {
    print_step "Step 1: Installing Docker..."
    detect_os
    print_info "Detected OS: $OS_NAME"
    print_info "Docker is not installed — fetching from the official Docker repository..."
    echo ""

    if is_debian_based; then
        print_info "Package manager: apt  |  Repo: download.docker.com/linux/${OS_ID}"
        apt-get update -qq
        apt-get install -y -qq \
            ca-certificates curl gnupg lsb-release apt-transport-https
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/${OS_ID}/gpg \
            | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null
        chmod a+r /etc/apt/keyrings/docker.gpg
        DOCKER_ARCH=$(dpkg --print-architecture)
        DOCKER_CODENAME=$(lsb_release -cs 2>/dev/null || (. /etc/os-release && echo "$VERSION_CODENAME"))
        # Docker only publishes repos for stable Debian releases; fall back to bookworm for trixie/sid/etc.
        if [ "$OS_ID" = "debian" ]; then
            case "$DOCKER_CODENAME" in
                buster|bullseye|bookworm) ;;
                *) print_warning "No Docker repo for Debian '$DOCKER_CODENAME', using bookworm packages"
                   DOCKER_CODENAME="bookworm" ;;
            esac
        fi
        echo "deb [arch=${DOCKER_ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${OS_ID} ${DOCKER_CODENAME} stable" \
            > /etc/apt/sources.list.d/docker.list
        apt-get update -qq
        apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin

    elif is_rhel_based && command -v dnf &>/dev/null; then
        print_info "Package manager: dnf  |  Repo: download.docker.com/linux/centos"
        dnf -y install dnf-plugins-core
        dnf config-manager --add-repo \
            https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null \
            || dnf config-manager --add-repo \
            https://download.docker.com/linux/fedora/docker-ce.repo
        dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

    elif is_rhel_based && command -v yum &>/dev/null; then
        print_info "Package manager: yum  |  Repo: download.docker.com/linux/centos"
        yum install -y yum-utils
        yum-config-manager --add-repo \
            https://download.docker.com/linux/centos/docker-ce.repo
        yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

    else
        print_info "Distro not recognised — falling back to get.docker.com universal installer..."
        curl -fsSL https://get.docker.com | sh
        if ! docker compose version &>/dev/null 2>&1; then
            command -v apt-get &>/dev/null && \
                apt-get install -y -qq docker-compose-plugin 2>/dev/null || true
        fi
    fi

    if ! command -v docker &>/dev/null; then
        print_error "Docker installation failed!"
        echo ""
        echo "  Please install Docker manually: https://docs.docker.com/get-docker/"
        exit 1
    fi
    print_success "Docker installed!"
}

# ===========================================
# Step 1 — Check or install Docker
# Checks for an existing install first so
# repeat runs don't re-download Docker.
# Also ensures the daemon is running and
# Docker Compose is available.
# ===========================================
check_docker() {
    print_step "Step 1: Checking Docker..."

    if ! command -v docker &>/dev/null; then
        install_docker
    else
        DOCKER_VER=$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')
        print_info "Docker already installed: v${DOCKER_VER} — skipping install"
    fi

    if ! docker ps &>/dev/null 2>&1; then
        print_info "Docker daemon is not running — starting it now..."
        if command -v systemctl &>/dev/null; then
            systemctl enable docker 2>/dev/null
            systemctl start docker 2>/dev/null
        elif command -v service &>/dev/null; then
            service docker start 2>/dev/null
        fi
        sleep 4
        if ! docker ps &>/dev/null 2>&1; then
            print_error "Docker daemon failed to start!"
            echo "  Try: sudo systemctl start docker"
            exit 1
        fi
    fi

    if docker compose version &>/dev/null 2>&1; then
        COMPOSE_CMD="docker compose"
        COMPOSE_VER=$(docker compose version --short 2>/dev/null)
        print_success "Docker is ready  (Compose v${COMPOSE_VER})"
    elif command -v docker-compose &>/dev/null; then
        COMPOSE_CMD="docker-compose"
        print_success "Docker is ready  (Compose v1 — consider upgrading to v2)"
    else
        print_error "Docker Compose not found!"
        echo ""
        echo "  Try installing it manually:"
        echo "    sudo apt-get install -y docker-compose-plugin"
        exit 1
    fi

    # Add the real user to the docker group so they can run docker
    # commands without sudo. Also open the socket permissions so this
    # takes effect immediately without requiring a logout/re-login.
    if [ "$REAL_USER" != "root" ] && id "$REAL_USER" &>/dev/null; then
        usermod -aG docker "$REAL_USER" 2>/dev/null || true
        # Make the socket accessible to the docker group right now.
        # (Group membership alone only activates on next login.)
        chmod 660 /var/run/docker.sock 2>/dev/null || true
        chgrp docker /var/run/docker.sock 2>/dev/null || true
        print_success "Docker permissions set — '$REAL_USER' can run docker commands immediately"
    fi
}

# ===========================================
# Step 1b — Ensure git is installed
# git is required for cloning the repo and
# for update.sh to pull future releases.
# ===========================================
check_git() {
    if command -v git &>/dev/null; then
        GIT_VER=$(git --version 2>/dev/null | awk '{print $3}')
        print_info "git already installed: v${GIT_VER}"
        return
    fi

    print_info "git not found — installing it now..."
    detect_os

    if is_debian_based; then
        apt-get install -y -qq git
    elif is_rhel_based && command -v dnf &>/dev/null; then
        dnf install -y git
    elif is_rhel_based && command -v yum &>/dev/null; then
        yum install -y git
    else
        print_warning "Could not install git automatically on this OS."
        print_info "Please install git manually, then re-run this script."
        exit 1
    fi

    if command -v git &>/dev/null; then
        print_success "git installed successfully"
    else
        print_error "git installation failed — cannot continue"
        exit 1
    fi
}

# ===========================================
# Step 2 — Download StardropHost
# Clones the GitHub repo into INSTALL_DIR.
# Falls back to curl/wget if git is missing.
# Skips if already installed (re-run safe).
# ===========================================
download_files() {
    print_step "Step 2: Downloading StardropHost..."

    if [ "$INSTANCE_NUM" -gt 1 ]; then
        print_info "Setting up instance $INSTANCE_NUM alongside existing install"
    fi
    print_info "Install directory: $INSTALL_DIR"

    if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
        print_success "StardropHost already present at $INSTALL_DIR — skipping download"
        cd "$INSTALL_DIR" || { print_error "Cannot cd to $INSTALL_DIR"; exit 1; }
        return
    fi

    # A directory with no docker-compose.yml means a previous run failed partway.
    # Remove it so git clone has a clean empty target.
    if [ -d "$INSTALL_DIR" ] && [ "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
        print_warning "Found incomplete install at $INSTALL_DIR — removing and starting fresh..."
        rm -rf "$INSTALL_DIR"
    fi

    mkdir -p "$INSTALL_DIR" || { print_error "Cannot create $INSTALL_DIR"; exit 1; }
    cd "$INSTALL_DIR"      || { print_error "Cannot cd to $INSTALL_DIR"; exit 1; }

    BASE_URL="https://raw.githubusercontent.com/Tomomoto10/StardropHost/main"

    if command -v git &>/dev/null; then
        print_info "Cloning from GitHub (git)..."
        git clone https://github.com/Tomomoto10/StardropHost.git . 2>&1 \
            || { print_error "Git clone failed — check your network and retry"; exit 1; }
    elif command -v curl &>/dev/null; then
        print_info "git not found — downloading key files via curl..."
        curl -fsSL "$BASE_URL/docker-compose.yml" -o docker-compose.yml \
            || { print_error "Failed to download docker-compose.yml"; exit 1; }
        curl -fsSL "$BASE_URL/.env" -o .env 2>/dev/null || true
    elif command -v wget &>/dev/null; then
        print_info "git not found — downloading key files via wget..."
        wget -q "$BASE_URL/docker-compose.yml" -O docker-compose.yml \
            || { print_error "Failed to download docker-compose.yml"; exit 1; }
        wget -q "$BASE_URL/.env" -O .env 2>/dev/null || true
    else
        print_info "No download tool found — installing curl first..."
        if command -v apt-get &>/dev/null; then apt-get install -y -qq curl
        elif command -v yum    &>/dev/null; then yum install -y curl
        elif command -v dnf    &>/dev/null; then dnf install -y curl
        fi
        curl -fsSL "$BASE_URL/docker-compose.yml" -o docker-compose.yml \
            || { print_error "Failed to download docker-compose.yml"; exit 1; }
        curl -fsSL "$BASE_URL/.env" -o .env 2>/dev/null || true
    fi

    [ -f .env ] || touch .env
    print_success "StardropHost downloaded to $INSTALL_DIR"
}

# ===========================================
# Step 3 — Write instance .env and create
# data directories.
#
# Each instance gets unique ports and a
# unique container prefix so multiple servers
# can run side-by-side on one machine.
#
# data/ is owned by UID 1000 (the steam user
# inside the container) so the server can
# read and write saves without permission
# errors.
# ===========================================
setup_instance() {
    print_step "Step 3: Configuring instance..."

    # Append instance-specific port and prefix settings to .env.
    # Docker Compose reads these at startup to name containers and
    # bind the right host ports.
    cat >> .env <<EOF

# --- Instance $INSTANCE_NUM settings (written by quick-start.sh) ---
CONTAINER_PREFIX=${CONTAINER_PREFIX}
GAME_PORT=${GAME_PORT}
PANEL_PORT=${PANEL_PORT}
VNC_PORT=${VNC_PORT}
METRICS_PORT=${METRICS_PORT}
EOF

    print_info "Container prefix: ${CONTAINER_PREFIX}"
    print_info "Ports assigned:"
    print_info "  Web panel:  ${PANEL_PORT}/tcp   (open in your browser)"
    print_info "  Game:       ${GAME_PORT}/udp   (Stardew Valley multiplayer)"
    print_info "  VNC:        ${VNC_PORT}/tcp   (remote desktop, optional)"
    print_info "  Metrics:    ${METRICS_PORT}/tcp   (health monitoring, optional)"

    print_step "Step 3b: Creating data directories..."
    print_info "Saves, logs, mods, and backups all live under $INSTALL_DIR/data/"
    mkdir -p data/{saves,game,logs,backups,custom-mods,panel,steam-session}

    # The container runs as UID 1000 (steam user) so data/ must be owned by
    # that UID. The rest of the install dir stays owned by the real user.
    chown -R 1000:1000 data/ 2>/dev/null || true

    OWNER=$(stat -c '%u' data/game 2>/dev/null || stat -f '%u' data/game 2>/dev/null)
    if [ "$OWNER" != "1000" ]; then
        print_warning "Could not set data directory permissions automatically."
        print_info "If you see write errors at startup, fix them with:"
        echo -e "  ${CYAN}sudo chown -R 1000:1000 $INSTALL_DIR/data/${NC}"
    else
        print_success "Data directories created and permissions set"
    fi

    if [ "$REAL_USER" != "root" ] && id "$REAL_USER" &>/dev/null; then
        chown -R "$REAL_USER":"$REAL_USER" "$INSTALL_DIR" 2>/dev/null || true
        chown -R 1000:1000 "$INSTALL_DIR/data/" 2>/dev/null || true
        print_info "Install directory owned by: $REAL_USER"
    fi

    # Ensure the logs directory exists so the install log can be copied there on exit
    mkdir -p "$INSTALL_DIR/logs" 2>/dev/null || true
}

# ===========================================
# Step 4 — Build and start server
#
# The first build pulls base images and
# installs all dependencies (~4 GB, 10–25
# min). Subsequent builds are much faster
# because Docker caches unchanged layers.
#
# After building, an init container runs
# once to set up config files and directories
# inside the volume, then exits. The main
# server container starts after that.
# ===========================================
start_server() {
    print_step "Step 4: Building Docker image..."
    print_info "First build: downloads Steam, .NET runtime, SMAPI, and Node.js (~4 GB)."
    print_info "This can take 10–25 minutes depending on your connection and hardware."
    print_info "Full build output is being logged to: $LOG_FILE"
    echo ""

    if ! $COMPOSE_CMD build 2>&1; then
        echo ""
        print_error "Docker image build failed — see output above for the exact error."
        echo ""
        echo "  Common causes:"
        echo "    - No internet connection during build"
        echo "    - Not enough disk space (need ~4 GB free)"
        echo "    - Docker daemon stopped mid-build"
        echo ""
        echo "  Full build log: $LOG_FILE"
        echo "  Fix the issue, then re-run:  sudo bash quick-start.sh"
        exit 1
    fi

    print_success "Docker image built successfully"
    echo ""

    # Open firewall ports if ufw is active so players can reach the server
    if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
        print_info "ufw firewall detected — opening required ports..."
        ufw allow "${GAME_PORT}/udp" >/dev/null 2>&1 || true
        ufw allow "${PANEL_PORT}/tcp" >/dev/null 2>&1 || true
        print_success "Firewall rules added  (game: ${GAME_PORT}/udp  |  panel: ${PANEL_PORT}/tcp)"
    fi

    print_step "Step 5: Starting containers..."
    print_info "Starting the web panel, game server, and Steam auth sidecar..."

    if ! $COMPOSE_CMD up -d 2>&1; then
        print_error "Failed to start containers!"
        echo ""
        echo "  Check what went wrong:"
        echo -e "    ${CYAN}cd $INSTALL_DIR && $COMPOSE_CMD logs${NC}"
        exit 1
    fi

    print_success "Containers started"

    # The init container runs once, copies default config, sets up the data
    # volume, then exits with code 0. Stream its logs so the user can watch.
    print_step "Step 6: Waiting for first-run initialisation..."
    print_info "The init container is setting up config files and directories."
    print_info "Streaming its output below  (Ctrl-C is safe — setup continues in background):"
    echo ""

    sleep 2
    docker logs -f "${CONTAINER_PREFIX}-init" 2>/dev/null &
    LOGS_PID=$!

    INIT_DONE=0
    for i in $(seq 1 90); do
        STATUS=$(docker inspect --format='{{.State.Status}}' "${CONTAINER_PREFIX}-init" 2>/dev/null)
        EXIT_CODE=$(docker inspect --format='{{.State.ExitCode}}' "${CONTAINER_PREFIX}-init" 2>/dev/null)

        if [ "$STATUS" = "exited" ]; then
            sleep 1
            kill $LOGS_PID 2>/dev/null
            wait $LOGS_PID 2>/dev/null
            echo ""
            if [ "$EXIT_CODE" = "0" ]; then
                print_success "Initialisation complete!"
                INIT_DONE=1
            else
                print_error "Init container exited with error code $EXIT_CODE"
                echo ""
                echo "  This is usually a permissions issue. Fix it with:"
                echo -e "    ${CYAN}sudo chown -R 1000:1000 $INSTALL_DIR/data/${NC}"
                echo ""
                echo "  Then restart the containers:"
                echo -e "    ${CYAN}cd $INSTALL_DIR && $COMPOSE_CMD up -d${NC}"
                exit 1
            fi
            break
        fi
        sleep 2
    done

    kill $LOGS_PID 2>/dev/null
    wait $LOGS_PID 2>/dev/null

    if [ "$INIT_DONE" = "0" ]; then
        echo ""
        print_warning "Init container is still running after 3 minutes — this is unusual."
        print_info "Monitor it manually:"
        echo -e "    ${CYAN}docker logs -f ${CONTAINER_PREFIX}-init${NC}"
    fi

    # Quick sanity check that the main server container came up
    sleep 3
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_PREFIX}$"; then
        print_success "Server container is up and running!"
    else
        print_warning "Main container not visible yet — it may still be starting."
        print_info "Check its status with:"
        echo -e "    ${CYAN}docker logs -f ${CONTAINER_PREFIX}${NC}"
    fi

    print_info "Full install log saved to: $LOG_FILE"
}

# ===========================================
# Done — show access info
# ===========================================
show_next_steps() {
    LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [ -z "$LOCAL_IP" ] && command -v ip &>/dev/null; then
        LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '/src/{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}')
    fi
    SERVER_IP="${LOCAL_IP:-your-server-ip}"

    echo ""
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    if [ "$INSTANCE_NUM" -gt 1 ]; then
        echo -e "${GREEN}${BOLD}  StardropHost instance $INSTANCE_NUM is up and running!${NC}"
    else
        echo -e "${GREEN}${BOLD}  StardropHost is up and running!${NC}"
    fi
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  Open the web panel from any device on your network:"
    echo ""
    echo -e "    ${CYAN}${BOLD}http://${SERVER_IP}:${PANEL_PORT}${NC}"
    echo ""
    echo -e "  The setup wizard will walk you through:"
    echo -e "    1. Installing your Stardew Valley game files"
    echo -e "       (via Steam login, local copy, or mounted path)"
    echo -e "    2. Setting your admin password"
    echo -e "    3. Configuring server resource limits (CPU / RAM)"
    echo -e "    4. Naming your farm and choosing settings"
    echo -e "    5. Starting the server"
    echo ""

    if [ "$INSTANCE_NUM" -gt 1 ]; then
        echo -e "  Instance $INSTANCE_NUM port summary:"
        echo -e "    Web panel:  ${CYAN}http://${SERVER_IP}:${PANEL_PORT}${NC}"
        echo -e "    Game UDP:   ${SERVER_IP}:${GAME_PORT}"
        echo -e "    VNC:        ${SERVER_IP}:${VNC_PORT}  (remote desktop)"
        echo ""
    fi

    echo -e "${BOLD}  Useful commands:${NC}"
    echo -e "    Live logs:   ${CYAN}docker logs -f ${CONTAINER_PREFIX}${NC}"
    echo -e "    Restart:     ${CYAN}cd $INSTALL_DIR && $COMPOSE_CMD restart${NC}"
    echo -e "    Stop:        ${CYAN}cd $INSTALL_DIR && $COMPOSE_CMD down${NC}"
    echo -e "    Update:      ${CYAN}cd $INSTALL_DIR && sudo bash update.sh${NC}"
    echo -e "    Directory:   ${CYAN}$INSTALL_DIR${NC}"
    echo ""

    if [ "$REAL_USER" != "root" ]; then
        echo -e "${YELLOW}  Tip: You can run docker commands now without sudo.${NC}"
        echo -e "${YELLOW}       If you ever open a new terminal and get a permission error,${NC}"
        echo -e "${YELLOW}       log out and back in to fully activate the 'docker' group.${NC}"
        echo ""
    fi
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

# ===========================================
# Run
# ===========================================

# Copy the full log into the install directory on exit — whether the
# script succeeded or failed. This runs even if the script exits early.
_copy_log_on_exit() {
    sync 2>/dev/null || true   # flush tee buffer
    sleep 1                    # give tee a moment to finish writing
    if [ -f "$LOG_FILE" ] && [ -d "$INSTALL_DIR/logs" ]; then
        cp "$LOG_FILE" "$INSTALL_DIR/logs/$(basename "$LOG_FILE")" 2>/dev/null || true
    fi
}
trap _copy_log_on_exit EXIT

confirm() {
    local answer
    echo -ne "${YELLOW}${BOLD}$1 [y/N]: ${NC}"
    read -r answer </dev/tty
    case "$answer" in
        y|Y|yes|YES) return 0 ;;
        *) return 1 ;;
    esac
}

main() {
    print_header

    # If an instance already exists, confirm before adding another
    if [ "$INSTANCE_NUM" -gt 1 ]; then
        echo -e "${YELLOW}${BOLD}  StardropHost is already installed (instance 1 at $REAL_HOME/stardrophost).${NC}"
        echo ""
        echo -e "  This will install a second independent instance (instance $INSTANCE_NUM):"
        echo -e "    Directory:  ${CYAN}$INSTALL_DIR${NC}"
        echo -e "    Web panel:  port ${PANEL_PORT}"
        echo -e "    Game:       port ${GAME_PORT}"
        echo ""
        if ! confirm "Install StardropHost instance $INSTANCE_NUM?"; then
            echo ""
            print_info "Installation cancelled."
            exit 0
        fi
        echo ""
    fi

    print_info "Instance:     $INSTANCE_NUM"
    print_info "Directory:    $INSTALL_DIR"
    print_info "Install log:  $INSTALL_DIR/logs/$(basename "$LOG_FILE")  (written on exit)"
    echo ""
    check_docker
    print_step "Step 1b: Checking git..."
    check_git
    download_files
    setup_instance
    start_server
    show_next_steps
}

main
