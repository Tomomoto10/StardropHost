using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Buildings;

namespace StardropDashboard
{
    public class ModEntry : Mod
    {
        // ── Config ─────────────────────────────────────────────────
        private ModConfig Config = null!;

        // ── Dashboard write timer ───────────────────────────────────
        private double _secondsSinceLastWrite = 0;
        private string _outputPath = "";

        private static readonly JsonSerializerOptions _jsonOpts = new()
        {
            PropertyNamingPolicy   = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented          = true,
        };

        // ── Entry ───────────────────────────────────────────────────
        public override void Entry(IModHelper helper)
        {
            Config      = helper.ReadConfig<ModConfig>();
            _outputPath = ResolveOutputPath();
            Directory.CreateDirectory(_outputPath);

            helper.Events.GameLoop.GameLaunched    += (_, _) => WriteOffline();
            helper.Events.GameLoop.SaveLoaded      += (_, _) => ForceWrite();
            helper.Events.GameLoop.UpdateTicked    += OnUpdateTicked;
            helper.Events.GameLoop.ReturnedToTitle += (_, _) => WriteOffline();
            helper.Events.GameLoop.DayEnding       += (_, _) => GC.Collect();

            helper.ConsoleCommands.Add(
                "dashboard_status",
                "Force an immediate write of live-status.json.",
                (_, _) => { ForceWrite(); Monitor.Log("live-status.json written.", LogLevel.Info); }
            );

            Monitor.Log($"StardropDashboard ready. Output: {_outputPath}", LogLevel.Info);
        }

        // ── OnUpdateTicked ────────────────────────────────────────────
        private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            if (!Context.IsWorldReady) return;

            // Network tuning — re-applied each tick as the game reverts these to defaults
            Game1.Multiplayer.defaultInterpolationTicks      = 7;
            Game1.Multiplayer.farmerDeltaBroadcastPeriod     = 1;
            Game1.Multiplayer.locationDeltaBroadcastPeriod   = 1;
            Game1.Multiplayer.worldStateDeltaBroadcastPeriod = 1;

            double elapsed = Game1.currentGameTime.ElapsedGameTime.TotalSeconds;
            _secondsSinceLastWrite += elapsed;
            if (_secondsSinceLastWrite >= Config.UpdateIntervalSeconds)
            {
                _secondsSinceLastWrite = 0;
                WriteStatus();
            }
        }

        // ── Write helpers ─────────────────────────────────────────────
        private void WriteOffline()
        {
            WriteToDisk(new LiveStatus
            {
                Timestamp   = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                ServerState = "offline",
            });
        }

        private void ForceWrite()
        {
            if (Context.IsWorldReady) WriteStatus(); else WriteOffline();
        }

        private void WriteStatus()
        {
            try { WriteToDisk(CollectStatus()); }
            catch (Exception ex) { Monitor.Log($"Failed to write live-status.json: {ex.Message}", LogLevel.Warn); }
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
                catch (Exception ex) { Monitor.Log($"Error reading player {farmer?.Name}: {ex.Message}", LogLevel.Trace); }
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
            string weather = Game1.isRaining       ? "rain"
                           : Game1.isSnowing       ? "snow"
                           : Game1.isLightning     ? "storm"
                           : Game1.isDebrisWeather ? "wind"
                           : "sunny";

            // -- Festival --
            bool isFestival = Game1.isFestival();
            string festivalName = isFestival && Game1.CurrentEvent != null
                ? Game1.CurrentEvent.FestivalName ?? ""
                : "";

            // -- Time --
            int timeInt = Game1.timeOfDay;
            int hours   = timeInt / 100;
            int minutes = timeInt % 100;
            bool isPm   = hours >= 12;
            int hours12 = hours > 12 ? hours - 12 : hours == 0 ? 12 : hours;
            string timeStr = $"{hours12}:{minutes:D2} {(isPm ? "PM" : "AM")}";

            return new LiveStatus
            {
                Timestamp        = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                ServerState      = "running",
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

        // ── Write to disk (atomic via temp file) ─────────────────────
        private void WriteToDisk(LiveStatus status)
        {
            string json    = JsonSerializer.Serialize(status, _jsonOpts);
            string tmpFile = LiveStatusFile + ".tmp";
            File.WriteAllText(tmpFile, json);
            File.Move(tmpFile, LiveStatusFile, overwrite: true);
        }

        // ── Resolve output directory ──────────────────────────────────
        private string ResolveOutputPath()
        {
            if (!string.IsNullOrWhiteSpace(Config.OutputDirectory))
                return Config.OutputDirectory;
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(home, ".local", "share", "stardrop");
        }

        private string LiveStatusFile => Path.Combine(_outputPath, "live-status.json");
    }
}
