#!/bin/bash
# ===========================================
# StardropHost | quick-start.sh
# ===========================================
# Fully automated setup — installs Docker if
# needed, downloads StardropHost, and launches
# the server.
#
# Usage:
#   sudo bash quick-start.sh           # first install
#   sudo bash quick-start.sh           # second run = new instance
#
# sudo is sufficient — su - is NOT required.
# If sudo is not installed, the script will
# install it automatically (root password
# will be prompted once).
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
    echo -e "${CYAN}${BOLD}  StardropHost — Automated Setup${NC}"
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
# Logging — tee all output to a timestamped
# log file in logs/ next to this script.
# Access logs any time with: ls ./logs/
# ===========================================
LOG_STAMP=$(date +%Y%m%d-%H%M%S)
LOG_DIR="${INSTALL_DIR}/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || LOG_DIR="/tmp"
LOG_FILE="${LOG_DIR}/install-instance${INSTANCE_NUM}-${LOG_STAMP}.log"
exec > >(tee -a "$LOG_FILE") 2>&1

# ===========================================
# Step 1 — Install Docker
# ===========================================
install_docker() {
    print_step "Step 1: Installing Docker..."
    detect_os
    print_info "OS: $OS_NAME"

    if is_debian_based; then
        print_info "Using apt + official Docker repository..."
        apt-get update -qq
        apt-get install -y -qq \
            ca-certificates curl gnupg lsb-release apt-transport-https
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/${OS_ID}/gpg \
            | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null
        chmod a+r /etc/apt/keyrings/docker.gpg
        echo \
            "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
            https://download.docker.com/linux/${OS_ID} \
            $(lsb_release -cs 2>/dev/null || . /etc/os-release && echo "$VERSION_CODENAME") stable" \
            > /etc/apt/sources.list.d/docker.list
        apt-get update -qq
        apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin

    elif is_rhel_based && command -v dnf &>/dev/null; then
        print_info "Using dnf + official Docker repository..."
        dnf -y install dnf-plugins-core
        dnf config-manager --add-repo \
            https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null \
            || dnf config-manager --add-repo \
            https://download.docker.com/linux/fedora/docker-ce.repo
        dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

    elif is_rhel_based && command -v yum &>/dev/null; then
        print_info "Using yum + official Docker repository..."
        yum install -y yum-utils
        yum-config-manager --add-repo \
            https://download.docker.com/linux/centos/docker-ce.repo
        yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

    else
        print_info "Using get.docker.com universal install script..."
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
# ===========================================
check_docker() {
    print_step "Step 1: Checking Docker..."

    if ! command -v docker &>/dev/null; then
        install_docker
    else
        DOCKER_VER=$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')
        print_info "Docker already installed: v${DOCKER_VER}"
    fi

    if ! docker ps &>/dev/null 2>&1; then
        print_info "Starting Docker daemon..."
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
        print_success "Docker is ready (Compose v${COMPOSE_VER})"
    elif command -v docker-compose &>/dev/null; then
        COMPOSE_CMD="docker-compose"
        print_success "Docker is ready (Compose v1 — consider upgrading)"
    else
        print_error "Docker Compose not found!"
        echo "  Try: sudo apt-get install -y docker-compose-plugin"
        exit 1
    fi

    # Add real user to docker group (no sudo needed after next login)
    if [ "$REAL_USER" != "root" ] && id "$REAL_USER" &>/dev/null; then
        usermod -aG docker "$REAL_USER" 2>/dev/null || true
    fi
}

# ===========================================
# Step 2 — Download StardropHost
# ===========================================
download_files() {
    print_step "Step 2: Downloading StardropHost..."

    if [ "$INSTANCE_NUM" -gt 1 ]; then
        print_info "Creating instance $INSTANCE_NUM"
    fi
    print_info "Install directory: $INSTALL_DIR"

    if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
        print_success "StardropHost already present at $INSTALL_DIR"
        cd "$INSTALL_DIR" || { print_error "Cannot cd to $INSTALL_DIR"; exit 1; }
        return
    fi

    mkdir -p "$INSTALL_DIR" || { print_error "Cannot create $INSTALL_DIR"; exit 1; }
    cd "$INSTALL_DIR"      || { print_error "Cannot cd to $INSTALL_DIR"; exit 1; }

    BASE_URL="https://raw.githubusercontent.com/Tomomoto10/StardropHost/main"

    if command -v git &>/dev/null; then
        print_info "Cloning repository..."
        git clone https://github.com/Tomomoto10/StardropHost.git . 2>&1 \
            || { print_error "Git clone failed — check network and retry"; exit 1; }
    elif command -v curl &>/dev/null; then
        print_info "Downloading via curl..."
        curl -fsSL "$BASE_URL/docker-compose.yml" -o docker-compose.yml \
            || { print_error "Failed to download docker-compose.yml"; exit 1; }
        curl -fsSL "$BASE_URL/.env" -o .env 2>/dev/null || true
    elif command -v wget &>/dev/null; then
        print_info "Downloading via wget..."
        wget -q "$BASE_URL/docker-compose.yml" -O docker-compose.yml \
            || { print_error "Failed to download docker-compose.yml"; exit 1; }
        wget -q "$BASE_URL/.env" -O .env 2>/dev/null || true
    else
        print_info "No download tool found — installing curl..."
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
# data directories
# ===========================================
setup_instance() {
    print_step "Step 3: Configuring instance..."

    # Write instance-specific settings into .env.
    # Ports and container prefix let multiple instances
    # run side-by-side on the same host.
    cat >> .env <<EOF

# --- Instance settings (written by quick-start.sh) ---
CONTAINER_PREFIX=${CONTAINER_PREFIX}
GAME_PORT=${GAME_PORT}
PANEL_PORT=${PANEL_PORT}
VNC_PORT=${VNC_PORT}
METRICS_PORT=${METRICS_PORT}
EOF

    if [ "$INSTANCE_NUM" -gt 1 ]; then
        print_info "Instance $INSTANCE_NUM ports:"
        print_info "  Web panel:  $PANEL_PORT"
        print_info "  Game:       $GAME_PORT/udp"
        print_info "  VNC:        $VNC_PORT"
        print_info "  Metrics:    $METRICS_PORT"
    fi

    print_step "Step 3b: Setting up data directories..."
    mkdir -p data/{saves,game,logs,backups,custom-mods,panel,steam-session}

    chown -R 1000:1000 data/ 2>/dev/null || true

    OWNER=$(stat -c '%u' data/game 2>/dev/null || stat -f '%u' data/game 2>/dev/null)
    if [ "$OWNER" != "1000" ]; then
        print_warning "Could not set permissions automatically."
        print_info "If you see write errors, run:"
        echo -e "  ${CYAN}sudo chown -R 1000:1000 $INSTALL_DIR/data/${NC}"
    else
        print_success "Data directories ready!"
    fi

    # Return install dir to real user; keep data/ at 1000:1000 for container
    if [ "$REAL_USER" != "root" ] && id "$REAL_USER" &>/dev/null; then
        chown -R "$REAL_USER":"$REAL_USER" "$INSTALL_DIR" 2>/dev/null || true
        chown -R 1000:1000 "$INSTALL_DIR/data/" 2>/dev/null || true
        print_info "Directory owned by: $REAL_USER"
    fi
}

# ===========================================
# Step 4 — Build and start server
# ===========================================
start_server() {
    print_step "Step 4: Building Docker images..."
    print_info "First build downloads ~4 GB and may take 10–25 minutes."
    print_info "Everything is logged to: $LOG_FILE"
    echo ""

    if ! $COMPOSE_CMD build 2>&1; then
        echo ""
        print_error "Docker image build failed!"
        echo ""
        echo "  Common causes:"
        echo "    - No internet during build"
        echo "    - Not enough disk space (need ~4 GB free)"
        echo "    - Docker daemon not running"
        echo ""
        echo "  Full build log: $LOG_FILE"
        echo "  Fix the error then re-run: sudo bash quick-start.sh"
        exit 1
    fi

    print_success "Images built!"
    echo ""
    print_step "Step 5: Starting containers..."

    if ! $COMPOSE_CMD up -d 2>&1; then
        print_error "Failed to start containers!"
        echo "  Try: cd $INSTALL_DIR && $COMPOSE_CMD logs"
        exit 1
    fi

    # Stream init container output so the user can see first-run activity
    print_step "Step 6: Waiting for init container..."
    print_info "Streaming init logs (Ctrl-C is safe — setup continues in background):"
    echo ""

    # Give Docker a moment to create the container
    sleep 2
    docker logs -f "${CONTAINER_PREFIX}-init" 2>/dev/null &
    LOGS_PID=$!

    INIT_DONE=0
    for i in $(seq 1 90); do
        STATUS=$(docker inspect --format='{{.State.Status}}' "${CONTAINER_PREFIX}-init" 2>/dev/null)
        EXIT_CODE=$(docker inspect --format='{{.State.ExitCode}}' "${CONTAINER_PREFIX}-init" 2>/dev/null)

        if [ "$STATUS" = "exited" ]; then
            sleep 1           # let the log stream flush
            kill $LOGS_PID 2>/dev/null
            wait $LOGS_PID 2>/dev/null
            echo ""
            if [ "$EXIT_CODE" = "0" ]; then
                print_success "Init complete!"
                INIT_DONE=1
            else
                print_error "Init container exited with code $EXIT_CODE"
                echo ""
                echo "  Quick fix — reset data directory permissions:"
                echo -e "  ${CYAN}sudo chown -R 1000:1000 $INSTALL_DIR/data/${NC}"
                echo ""
                echo "  Then restart:"
                echo -e "  ${CYAN}cd $INSTALL_DIR && $COMPOSE_CMD up -d${NC}"
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
        print_warning "Init container still running after 3 minutes."
        print_info "Monitor it with:  docker logs -f ${CONTAINER_PREFIX}-init"
    fi

    # Verify main container is up
    sleep 3
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_PREFIX}$"; then
        print_success "Server container is running!"
    else
        print_warning "Main container not visible yet — may still be starting."
        print_info "Check:  docker logs -f ${CONTAINER_PREFIX}"
    fi

    print_info "Install log: $LOG_FILE"
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
        echo -e "${GREEN}${BOLD}  StardropHost instance $INSTANCE_NUM is running!${NC}"
    else
        echo -e "${GREEN}${BOLD}  StardropHost is running!${NC}"
    fi
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  Open the web panel from any device on this network:"
    echo ""
    echo -e "  ${CYAN}${BOLD}http://${SERVER_IP}:${PANEL_PORT}${NC}"
    echo ""
    echo -e "  The setup wizard will guide you through:"
    echo -e "    - Installing your game files"
    echo -e "    - Creating your admin password"
    echo -e "    - Configuring server resources"
    echo -e "    - Setting up Steam invite codes (optional)"
    echo ""

    if [ "$INSTANCE_NUM" -gt 1 ]; then
        echo -e "  Instance $INSTANCE_NUM ports:"
        echo -e "    Web panel: ${CYAN}http://${SERVER_IP}:${PANEL_PORT}${NC}"
        echo -e "    Game UDP:  ${PANEL_PORT%?}$((GAME_PORT))"
        echo ""
    fi

    echo -e "${BOLD}  Useful commands:${NC}"
    echo -e "    Logs:      ${CYAN}docker logs -f ${CONTAINER_PREFIX}${NC}"
    echo -e "    Restart:   ${CYAN}cd $INSTALL_DIR && $COMPOSE_CMD restart${NC}"
    echo -e "    Stop:      ${CYAN}cd $INSTALL_DIR && $COMPOSE_CMD down${NC}"
    echo -e "    Directory: ${CYAN}$INSTALL_DIR${NC}"
    echo ""

    if [ "$REAL_USER" != "root" ]; then
        echo -e "${YELLOW}  Note: Log out and back in for docker commands to work without sudo.${NC}"
        echo -e "${YELLOW}  (Your account was added to the docker group.)${NC}"
        echo ""
    fi
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

# ===========================================
# Run
# ===========================================
main() {
    print_header
    print_info "Instance:   $INSTANCE_NUM"
    print_info "Directory:  $INSTALL_DIR"
    print_info "Install log: $LOG_FILE"
    echo ""
    check_docker
    download_files
    setup_instance
    start_server
    show_next_steps
}

main
