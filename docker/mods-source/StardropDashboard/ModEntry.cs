using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using HarmonyLib;
using Steamworks;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Buildings;

namespace StardropDashboard
{
    public class ModEntry : Mod
    {
        // ── Config ────────────────────────────────────────────────
        private ModConfig Config = null!;

        // ── State ─────────────────────────────────────────────────
        private double _secondsSinceLastWrite = 0;
        private string _outputPath = "";

        // ── Invite code (captured via Harmony hook) ───────────────
        private static string? _cachedInviteCode = null;
        private static ModEntry? _instance = null;

        // ── Steam Game Server (Path B — SDR relay) ───────────────
        private bool _steamServerInitialized = false;
        private static readonly bool _steamMode =
            string.Equals(Environment.GetEnvironmentVariable("SERVER_MODE"), "steam",
                StringComparison.OrdinalIgnoreCase);

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy        = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition      = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented               = true,
        };

        // ── Entry point ───────────────────────────────────────────
        public override void Entry(IModHelper helper)
        {
            _instance = this;

            Config = helper.ReadConfig<ModConfig>();

            _outputPath = ResolveOutputPath();
            Directory.CreateDirectory(_outputPath);

            helper.Events.GameLoop.UpdateTicked    += OnUpdateTicked;
            helper.Events.GameLoop.GameLaunched    += OnGameLaunched;
            helper.Events.GameLoop.SaveLoaded      += (_, _) => ForceWrite();
            helper.Events.GameLoop.ReturnedToTitle += (_, _) => WriteOffline();
            helper.Events.GameLoop.DayEnding       += (_, _) => GC.Collect();

            // Hook GalaxySocket.GetInviteCode to capture the invite code the instant
            // the game generates it — more reliable than waiting for the next polling cycle.
            try
            {
                var harmony = new Harmony(ModManifest.UniqueID);
                harmony.Patch(
                    original: AccessTools.Method("StardewValley.Network.GalaxySocket:GetInviteCode"),
                    postfix:  new HarmonyMethod(typeof(ModEntry), nameof(GalaxySocket_GetInviteCode_Postfix))
                );
                Monitor.Log("Invite code hook applied.", LogLevel.Trace);
            }
            catch (Exception ex)
            {
                Monitor.Log($"Invite code hook failed (non-fatal): {ex.Message}", LogLevel.Warn);
            }

            helper.ConsoleCommands.Add(
                "dashboard_status",
                "Force an immediate write of live-status.json.",
                (_, _) => {
                    ForceWrite();
                    Monitor.Log("live-status.json written.", LogLevel.Info);
                }
            );

            Monitor.Log($"StardropDashboard ready. Output: {_outputPath}", LogLevel.Info);
        }

        // ── Harmony postfix — fires when game generates invite code ──
        private static void GalaxySocket_GetInviteCode_Postfix(string __result)
        {
            if (string.IsNullOrEmpty(__result)) return;
            if (__result == _cachedInviteCode) return;

            _cachedInviteCode = __result;
            _instance?.Monitor.Log($"[InviteCode] Captured: {__result}", LogLevel.Debug);

            // Write immediately rather than waiting for the next polling cycle
            _instance?.ForceWrite();
        }

        // ── Resolve output directory ──────────────────────────────
        private string ResolveOutputPath()
        {
            if (!string.IsNullOrWhiteSpace(Config.OutputDirectory))
                return Config.OutputDirectory;

            // Default: ~/.local/share/stardrop/
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(home, ".local", "share", "stardrop");
        }

        private string LiveStatusFile => Path.Combine(_outputPath, "live-status.json");

        // ── Tick update ───────────────────────────────────────────
        private void OnGameLaunched(object? sender, GameLaunchedEventArgs e)
        {
            // Write an initial offline status immediately on launch
            WriteOffline();

            if (_steamMode)
                InitSteamGameServer();
        }

        // ── Steam Game Server init (Path B — anonymous, no credentials) ──
        private void InitSteamGameServer()
        {
            try
            {
                bool ok = GameServer.Init(
                    unIP:           0,
                    usGamePort:     24642,
                    usQueryPort:    27015,
                    eServerMode:    EServerMode.eServerModeAuthenticationAndSecure,
                    pchVersionString: Game1.version ?? "1.6.15"
                );

                if (!ok)
                {
                    Monitor.Log("Steam Game Server Init returned false — SDR unavailable.", LogLevel.Warn);
                    return;
                }

                SteamGameServer.LogOnAnonymous();
                SteamGameServerNetworkingUtils.InitRelayNetworkAccess();
                _steamServerInitialized = true;
                Monitor.Log("Steam Game Server initialized (anonymous). SDR relay active.", LogLevel.Info);
            }
            catch (Exception ex)
            {
                Monitor.Log($"Steam Game Server init failed (non-fatal): {ex.Message}", LogLevel.Warn);
            }
        }

        private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            // Pump Steam Game Server callbacks every tick (Path B — must run even before world ready)
            if (_steamServerInitialized)
            {
                try { GameServer.RunCallbacks(); } catch { }
            }

            if (!Context.IsWorldReady) return;

            // Keep multiplayer network settings tuned for low latency.
            // These revert to defaults if not re-applied each tick.
            Game1.Multiplayer.defaultInterpolationTicks      = 7;  // default: 15
            Game1.Multiplayer.farmerDeltaBroadcastPeriod     = 1;  // default: 3
            Game1.Multiplayer.locationDeltaBroadcastPeriod   = 1;  // default: 3
            Game1.Multiplayer.worldStateDeltaBroadcastPeriod = 1;  // default: 3

            _secondsSinceLastWrite += (double)Game1.currentGameTime.ElapsedGameTime.TotalSeconds;

            if (_secondsSinceLastWrite >= Config.UpdateIntervalSeconds)
            {
                _secondsSinceLastWrite = 0;
                WriteStatus();
            }
        }

        // ── Write offline tombstone ───────────────────────────────
        private void WriteOffline()
        {
            _cachedInviteCode = null;
            var status = new LiveStatus
            {
                Timestamp   = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                ServerState = "offline",
            };
            WriteToDisk(status);
        }

        // ── Force write ───────────────────────────────────────────
        private void ForceWrite()
        {
            if (Context.IsWorldReady)
                WriteStatus();
            else
                WriteOffline();
        }

        // ── Collect and write full status ─────────────────────────
        private void WriteStatus()
        {
            try
            {
                var status = CollectStatus();
                WriteToDisk(status);
            }
            catch (Exception ex)
            {
                Monitor.Log($"Failed to write live-status.json: {ex.Message}", LogLevel.Warn);
            }
        }

        private LiveStatus CollectStatus()
        {
            // -- Players --
            var players = new List<PlayerData>();
            foreach (var farmer in Game1.getOnlineFarmers())
            {
                try
                {
                    players.Add(new PlayerData
                    {
                        Name         = farmer.Name,
                        UniqueId     = farmer.UniqueMultiplayerID.ToString(),
                        IsHost       = farmer.IsMainPlayer,
                        IsOnline     = true,
                        Health       = farmer.health,
                        MaxHealth    = farmer.maxHealth,
                        Stamina      = farmer.stamina,
                        MaxStamina   = farmer.maxStamina.Value,
                        Money        = farmer.Money,
                        TotalEarned  = (long)farmer.totalMoneyEarned,
                        LocationName = farmer.currentLocation?.Name ?? "",
                        DaysPlayed   = (int)farmer.stats.DaysPlayed,
                        Skills       = new SkillData
                        {
                            Farming  = farmer.FarmingLevel,
                            Mining   = farmer.MiningLevel,
                            Foraging = farmer.ForagingLevel,
                            Fishing  = farmer.FishingLevel,
                            Combat   = farmer.CombatLevel,
                            Luck     = farmer.LuckLevel,
                        },
                    });
                }
                catch (Exception ex)
                {
                    Monitor.Log($"StardropDashboard: Error reading player {farmer?.Name} — {ex.Message}", LogLevel.Trace);
                }
            }

            // -- Cabins --
            var cabins = new List<CabinData>();
            foreach (var building in Game1.getFarm().buildings)
            {
                if (building.indoors.Value is StardewValley.Locations.Cabin cabin)
                {
                    var owner    = cabin.owner;
                    bool isOnline = false;
                    if (owner != null)
                        foreach (var f in Game1.getOnlineFarmers())
                            if (f.UniqueMultiplayerID == owner.UniqueMultiplayerID)
                                { isOnline = true; break; }

                    cabins.Add(new CabinData
                    {
                        OwnerName     = owner?.Name ?? "",
                        IsOwnerOnline = isOnline,
                        TileX         = building.tileX.Value,
                        TileY         = building.tileY.Value,
                        IsUpgraded    = building.daysOfConstructionLeft.Value <= 0,
                    });
                }
            }

            // -- Weather --
            string weather = Game1.isRaining  ? "rain"
                           : Game1.isSnowing  ? "snow"
                           : Game1.isLightning ? "storm"
                           : Game1.isDebrisWeather ? "wind"
                           : "sunny";

            // -- Festival --
            bool isFestival = Game1.isFestival();
            string festivalName = "";
            if (isFestival && Game1.CurrentEvent != null)
                festivalName = Game1.CurrentEvent.FestivalName ?? "";

            // -- Time formatting --
            int   timeInt  = Game1.timeOfDay;
            int   hours    = timeInt / 100;
            int   minutes  = timeInt % 100;
            bool  isPm     = hours >= 12;
            int   hours12  = hours > 12 ? hours - 12 : hours == 0 ? 12 : hours;
            string timeStr = $"{hours12}:{minutes:D2} {(isPm ? "PM" : "AM")}";

            // Use the invite code captured by the Harmony hook.
            // Falls back to polling getInviteCode() if the hook hasn't fired yet.
            string? inviteCode = _cachedInviteCode;
            if (string.IsNullOrEmpty(inviteCode))
            {
                try { inviteCode = Game1.server?.getInviteCode(); } catch { }
                if (!string.IsNullOrEmpty(inviteCode))
                    _cachedInviteCode = inviteCode;
            }

            return new LiveStatus
            {
                Timestamp        = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                ServerState      = "running",
                InviteCode       = inviteCode,
                FarmName         = Game1.player.farmName.Value ?? "",
                Season           = Game1.currentSeason ?? "",
                Day              = Game1.dayOfMonth,
                Year             = Game1.year,
                GameTimeMinutes  = timeInt,
                DayTimeFormatted = timeStr,
                Weather          = weather,
                IsFestivalDay    = isFestival,
                FestivalName     = festivalName,
                SharedMoney      = Game1.player.Money,
                Players          = players,
                Cabins           = cabins,
            };
        }

        // ── Write to disk (atomic via temp file) ──────────────────
        private void WriteToDisk(LiveStatus status)
        {
            string json    = JsonSerializer.Serialize(status, JsonOptions);
            string tmpFile = LiveStatusFile + ".tmp";

            File.WriteAllText(tmpFile, json);
            File.Move(tmpFile, LiveStatusFile, overwrite: true);
        }
    }
}