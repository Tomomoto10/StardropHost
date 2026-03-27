> [!WARNING]
> **This is an active development build. Do not use in production.**
> The project is not yet ready for general use. Features may be incomplete, broken, or change without notice.

<div align="center">

# StardropHost

### Self-hosted Stardew Valley dedicated server — managed entirely from your browser

*Run a 24/7 Stardew Valley farm your friends can join any time, even when you're offline.*

---

**No Steam account required to run the server**

<sub>Steam is optional — only needed if you don't already have the game files</sub>

</div>

---

## What is StardropHost?

StardropHost is a Dockerized Stardew Valley dedicated server with a full browser-based management panel.

Set it up once on a Linux machine or VM. Everything after that — players, saves, mods, settings, logs — is managed from a clean web interface. No SSH, no terminal, no config file editing required.

---

## Current Features

| Feature | Status |
| --- | --- |
| First-run setup wizard | ✅ Working |
| Web panel (Dashboard, Players, Saves, Mods, Logs, Terminal, Config) | ✅ Working |
| Always-on server (24/7, no host required) | ✅ Working |
| Up to 4 players *per instance | ✅ Working |
| Multiple instances (separate VMs) | ✅ Working |
| LAN multiplayer | ✅ Working |
| Save management — backup, upload, download, switch farms | ✅ Working |
| Live farm data — season, time, active players | ✅ Working |
| Mod uploads via web panel | ✅ Working |
| Real-time SMAPI logs and browser terminal | ✅ Working |
| VNC remote desktop (one-click, auto-shutoff after 30min) | ✅ Working |
| Auto-backup on schedule | ✅ Working |
| Server auto-restart on crash | ✅ Working |
| Quick Actions — configurable shortcut buttons, drag-to-reorder | ✅ Working |
| Update script — git pull, rebuild, state-aware restart | ✅ Working |
| Steam game download via install script | ✅ Working |
| Internet play via Steam invite code | 🔧 In Development |
| Player kick / ban / admin | 🔧 In Development |
| Nexus mod browser and downloader | 🔧 Planned |
| Chat commands in Web UI (`!kick`, `!ban`, `!login`) | 🔧 Planned |
| Crop preservation when owner is offline | 🔧 Planned |
| Password-gated lobby | 🔧 Planned |

---

## Web Panel

```text
┌─────────────────────────────────────────────┐
│  StardropHost                               │
├──────────┬──────────────────────────────────┤
│          │  Server Status    ● Running       │
│ Dashboard│  Players   2 / 4                 │
│ Farm     │  Season    Spring · Day 4        │
│ Players  │  Weather   Sunny                 │
│ Saves    ├──────────────────────────────────┤
│ Mods     │  Quick Actions                   │
│ Logs     │  [ Start ] [ Stop ] [ Restart ]  │
│ Terminal │  [ Logs  ] [ + Add action... ]   │
│ Config   │                                  │
└──────────┴──────────────────────────────────┘
```

---

## Architecture

StardropHost runs as four Docker containers:

```text
┌─────────────────────────────────────────────────┐
│  stardrop            Game + SMAPI + Web Panel   │
│  stardrop-manager    Start / Stop / Restart API │
│  stardrop-init       One-shot permission fix    │
│  stardrop-steam-auth Optional: Steam download   │
└─────────────────────────────────────────────────┘
```

| Port | Purpose |
| --- | --- |
| `18642` | Web management panel |
| `24642` | Game server (UDP — open in firewall) |
| `5900` | VNC (optional, disabled by default) |

---

## Requirements

- Linux (VM or hardware — Proxmox, bare metal, etc.)
- Docker
- 2 GB RAM minimum · 4 GB recommended for 4+ players
- A copy of Stardew Valley (Steam, GOG, or otherwise... aarrr)

---

## Getting Started

> Not recommended for general use yet. Instructions will be finalised at release.

```bash
curl -fsSL https://raw.githubusercontent.com/Tomomoto10/StardropHost-dev/main/quick-start.sh | bash
```

Then open `http://your-server-ip:18642` and follow the setup wizard.

---

## How Friends Connect

**LAN** — Open Stardew Valley → Co-op → Join LAN Game. The server appears automatically.

**Internet** — Steam invite code support is in development. When complete, a shareable code will appear in the web panel — no port forwarding required.

---

## Uninstall

```bash
cd StardropHost
docker compose down
```

Then delete the `StardropHost/` directory. Game saves are stored in `StardropHost/data/saves/` — back these up before deleting if you want to keep them.

---

<div align="center">

Built on [puppy-stardew-server](https://github.com/truman-world/puppy-stardew-server) and [JunimoServer](https://github.com/stardew-valley-dedicated-server/server) · Powered by [Nexus Mods](https://www.nexusmods.com/) and [SMAPI](https://smapi.io/) · Runs on [Docker](https://www.docker.com/)

</div>

---

## License

MIT — see [LICENSE](LICENSE)

Stardew Valley is © ConcernedApe. This project is not affiliated with or endorsed by ConcernedApe.
