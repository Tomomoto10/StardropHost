# ===========================================
# StardropHost | docker/Dockerfile
# ===========================================
# Game files are NOT included in this image.
# Provide your own Stardew Valley installation
# via the ./data/game/ volume mount, or use
# the setup wizard to download via Steam.
# ===========================================

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

LABEL maintainer="tomomotto" \
      description="StardropHost - Stardew Valley dedicated server with web UI" \
      version="1.0.0"

# -- Install dependencies --
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core tools
    wget curl unzip ca-certificates \
    # Game rendering
    libsdl2-2.0-0 \
    libgl1-mesa-dri libgl1-mesa-glx libegl1-mesa \
    # X11 display
    xserver-xorg-core xserver-xorg-video-modesetting \
    x11-xserver-utils xvfb x11vnc openbox xdotool \
    # .NET runtime (game) + SDK (building ServerDashboard mod)
    dotnet-runtime-6.0 \
    dotnet-sdk-6.0 \
    # Utilities
    procps net-tools \
    && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
           /usr/share/doc/* /usr/share/man/* /usr/share/info/* \
           /usr/share/lintian/* /usr/share/locale/* \
           /tmp/* /var/tmp/*

# -- Install Node.js 18 (Ubuntu 22.04 ships Node 12 which lacks optional chaining) --
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# -- Create user and directories --
RUN useradd -m -s /bin/bash steam && \
    mkdir -p /home/steam/stardewvalley \
             /home/steam/.config/StardewValley \
             /home/steam/.local/share/stardrop/logs \
             /home/steam/.local/share/stardrop/backups \
             /home/steam/scripts && \
    chown -R steam:steam /home/steam && \
    (usermod -aG video steam || true) && \
    # Xorg modesetting config for GPU acceleration
    mkdir -p /etc/X11/xorg.conf.d && \
    cat > /etc/X11/xorg.conf.d/20-modesetting.conf <<'EOF'
Section "Device"
  Identifier "GPU0"
  Driver "modesetting"
  Option "AccelMethod" "glamor"
  Option "DRI" "3"
EndSection
EOF

WORKDIR /home/steam
USER steam

# -- Download SMAPI --
RUN wget -qO smapi.zip 'https://github.com/Pathoschild/SMAPI/releases/download/4.3.2/SMAPI-4.3.2-installer.zip' && \
    unzip -q smapi.zip -d smapi && \
    rm smapi.zip

# -- Copy pre-built mods (AlwaysOnServer, AutoHideHost, ServerAutoLoad, SkillLevelGuard) --
USER root
COPY mods/ /home/steam/preinstalled-mods/
RUN chown -R steam:steam /home/steam/preinstalled-mods && \
    chmod -R 755 /home/steam/preinstalled-mods

# -- Copy ServerDashboard source + pre-restore NuGet packages --
# The actual dotnet build happens in entrypoint.sh (Step 3.5) after game
# files are mounted, because ModBuildConfig needs StardewValley.dll which
# is only available at runtime, not at image build time.
# Pre-restoring here caches NuGet packages so the runtime build works
# offline (no internet needed inside the running container).
COPY mods-source/ServerDashboard/ /home/steam/mod-source/ServerDashboard/
RUN chown -R root:root /home/steam/mod-source && \
    cd /home/steam/mod-source/ServerDashboard && \
    dotnet restore 2>&1 || true
USER steam

# -- Copy scripts --
COPY --chown=steam:steam scripts/entrypoint.sh /home/steam/entrypoint.sh
COPY --chown=steam:steam scripts/auto-backup.sh \
     scripts/crash-monitor.sh \
     scripts/event-handler.sh \
     scripts/init-container.sh \
     scripts/log-manager.sh \
     scripts/log-monitor.sh \
     scripts/save-selector.sh \
     scripts/set-resolution.sh \
     scripts/status-reporter.sh \
     scripts/vnc-monitor.sh \
     /home/steam/scripts/
RUN chmod +x /home/steam/entrypoint.sh /home/steam/scripts/*.sh

# -- Copy config --
COPY --chown=steam:steam config/startup_preferences /home/steam/startup_preferences.template
COPY --chown=steam:steam config/10-monitor.conf /etc/X11/xorg.conf.d/10-monitor.conf

# -- Copy and install web panel --
COPY --chown=steam:steam web-panel/ /home/steam/web-panel/
RUN cd /home/steam/web-panel && npm ci --omit=dev

# -- Run as root to allow permission fixes on startup --
USER root

# -- Ports --
# 24642/udp  Game server (required)
# 5900/tcp   VNC (optional, toggle via web UI)
# 9090/tcp   Prometheus metrics (optional)
# 18642/tcp  Web panel
EXPOSE 24642/udp 5900/tcp 9090/tcp 18642/tcp

# -- Health check --
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD pgrep -f "StardewModdingAPI" > /dev/null || exit 1

ENTRYPOINT ["/home/steam/entrypoint.sh"]
