using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Characters;
using StardewValley.Locations;

namespace ServerDashboard
{
    /// <summary>
    /// ServerDashboard SMAPI Mod
    /// Writes live game state to a JSON file every few seconds so the web panel can display it.
    /// Output: /home/steam/.local/share/puppy-stardew/live-status.json
    /// </summary>
    public class ModEntry : Mod
    {
        // ─── Config ───────────────────────────────────────────────────────────
        private ModConfig _config = null!;

        // ─── State ────────────────────────────────────────────────────────────
        private int _tickCounter = 0;
        private string _outputPath = null!;

        // ─── SMAPI Entry Point ────────────────────────────────────────────────
        public override void Entry(IModHelper helper)
        {
            _config = helper.ReadConfig<ModConfig>();

            // Resolve output path — prefer the shared puppy-stardew data dir, fall back to mod folder
            string defaultDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".local", "share", "puppy-stardew"
            );
            string outputDir = string.IsNullOrWhiteSpace(_config.OutputDirectory)
                ? defaultDir
                : _config.OutputDirectory;

            Directory.CreateDirectory(outputDir);
            _outputPath = Path.Combine(outputDir, "live-status.json");

            Monitor.Log($"ServerDashboard loaded. Writing live status to: {_outputPath}", LogLevel.Info);

            // Hook events
            helper.Events.GameLoop.UpdateTicked    += OnUpdateTicked;
            helper.Events.GameLoop.SaveLoaded      += OnSaveLoaded;
            helper.Events.GameLoop.ReturnedToTitle += OnReturnedToTitle;

            // Console command for manual refresh
            helper.ConsoleCommands.Add(
                "dashboard_status",
                "Force-write the dashboard live-status.json right now.",
                (_, _) => WriteStatus()
            );
        }

        // ─── Event Handlers ───────────────────────────────────────────────────

        private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            // Only run when a save is loaded
            if (!Context.IsWorldReady) return;

            _tickCounter++;

            // 60 ticks = 1 real second. Write every N seconds (default 10).
            int intervalTicks = Math.Max(1, _config.UpdateIntervalSeconds) * 60;
            if (_tickCounter % intervalTicks != 0) return;

            WriteStatus();
        }

        private void OnSaveLoaded(object? sender, SaveLoadedEventArgs e)
        {
            // Write immediately on load so the panel has data right away
            WriteStatus();
        }

        private void OnReturnedToTitle(object? sender, ReturnedToTitleEventArgs e)
        {
            // Write an "offline" status when the game returns to the main menu
            WriteOfflineStatus("returned_to_title");
        }

        // ─── Data Collection ──────────────────────────────────────────────────

        private void WriteStatus()
        {
            try
            {
                var status = BuildStatus();
                string json = JsonSerializer.Serialize(status, new JsonSerializerOptions
                {
                    WriteIndented = true,
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
                });
                File.WriteAllText(_outputPath, json);
            }
            catch (Exception ex)
            {
                Monitor.Log($"ServerDashboard: Failed to write status — {ex.Message}", LogLevel.Warn);
            }
        }

        private void WriteOfflineStatus(string reason)
        {
            try
            {
                var status = new LiveStatus
                {
                    Timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                    ServerState = "offline",
                    OfflineReason = reason
                };
                string json = JsonSerializer.Serialize(status, new JsonSerializerOptions
                {
                    WriteIndented = true,
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
                });
                File.WriteAllText(_outputPath, json);
            }
            catch (Exception ex)
            {
                Monitor.Log($"ServerDashboard: Failed to write offline status — {ex.Message}", LogLevel.Warn);
            }
        }

        private LiveStatus BuildStatus()
        {
            var status = new LiveStatus
            {
                Timestamp         = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                ServerState       = "running",
                // ── World ──
                FarmName          = Game1.player.farmName.Value,
                Season            = Game1.currentSeason,
                Day               = Game1.dayOfMonth,
                Year              = Game1.year,
                GameTimeMinutes   = Game1.timeOfDay,   // e.g. 630 = 6:30 AM, 1300 = 1:00 PM
                DayTimeFormatted  = FormatGameTime(Game1.timeOfDay),
                Weather           = GetWeatherString(),
                IsFestivalDay     = Utility.isFestivalDay(Game1.dayOfMonth, Game1.currentSeason),
                FestivalName      = GetFestivalName(),
                // ── Farm ──
                SharedMoney       = Game1.player.Money,    // host money (shared wallet shows same for all)
                // ── Invite code (Steam share code from Game1.server) ──
                InviteCode        = TryGetInviteCode(),
                // ── Players ──
                Players           = GetPlayersData(),
                // ── Cabins ──
                Cabins            = GetCabinData(),
            };

            return status;
        }

        // ─── Invite code ──────────────────────────────────────────────────────

        private string? TryGetInviteCode()
        {
            try
            {
                var code = Game1.server?.getInviteCode();
                if (!string.IsNullOrEmpty(code))
                {
                    try { System.IO.File.WriteAllText("/tmp/invite-code.txt", code); } catch {}
                }
                return code;
            }
            catch { return null; }
        }

        // ─── Players ──────────────────────────────────────────────────────────

        private List<PlayerData> GetPlayersData()
        {
            var list = new List<PlayerData>();

            foreach (Farmer farmer in Game1.getOnlineFarmers())
            {
                try
                {
                    var skills = new SkillLevels
                    {
                        Farming  = farmer.FarmingLevel,
                        Mining   = farmer.MiningLevel,
                        Foraging = farmer.ForagingLevel,
                        Fishing  = farmer.FishingLevel,
                        Combat   = farmer.CombatLevel,
                        Luck     = farmer.LuckLevel
                    };

                    var data = new PlayerData
                    {
                        Name            = farmer.Name,
                        IsHost          = farmer.IsMainPlayer,
                        IsOnline        = true,
                        Health          = farmer.health,
                        MaxHealth       = farmer.maxHealth,
                        Stamina         = (int)farmer.Stamina,
                        MaxStamina      = farmer.MaxStamina,
                        Money           = farmer.Money,
                        TotalEarned     = (int)farmer.totalMoneyEarned,
                        LocationName    = farmer.currentLocation?.Name ?? "Unknown",
                        Skills          = skills,
                        DaysPlayed      = (int)farmer.stats.DaysPlayed,
                        UniqueId        = farmer.UniqueMultiplayerID.ToString(),
                    };

                    list.Add(data);
                }
                catch (Exception ex)
                {
                    Monitor.Log($"ServerDashboard: Error reading player {farmer?.Name} — {ex.Message}", LogLevel.Trace);
                }
            }

            return list;
        }

        // ─── Cabins ───────────────────────────────────────────────────────────

        private List<CabinData> GetCabinData()
        {
            var list = new List<CabinData>();

            try
            {
                Farm farm = Game1.getFarm();
                if (farm == null) return list;

                foreach (Building building in farm.buildings)
                {
                    if (building.indoors.Value is Cabin cabin)
                    {
                        Farmer? owner = cabin.owner;
                        list.Add(new CabinData
                        {
                            OwnerName   = owner?.Name ?? "Unclaimed",
                            IsOwnerOnline = owner != null && Game1.getOnlineFarmers().Contains(owner),
                            TileX       = building.tileX.Value,
                            TileY       = building.tileY.Value,
                            IsUpgraded  = building.daysOfConstructionLeft.Value <= 0
                        });
                    }
                }
            }
            catch (Exception ex)
            {
                Monitor.Log($"ServerDashboard: Error reading cabins — {ex.Message}", LogLevel.Trace);
            }

            return list;
        }

        // ─── Helpers ──────────────────────────────────────────────────────────

        private static string FormatGameTime(int timeOfDay)
        {
            // timeOfDay is like 630, 1300, 2600
            int hours   = timeOfDay / 100;
            int minutes = timeOfDay % 100;
            string ampm = hours >= 12 ? "PM" : "AM";
            int displayHour = hours > 12 ? hours - 12 : (hours == 0 ? 12 : hours);
            return $"{displayHour}:{minutes:D2} {ampm}";
        }

        private static string GetWeatherString()
        {
            if (Game1.isSnowing)   return "snowing";
            if (Game1.isRaining)   return Game1.isLightning ? "stormy" : "raining";
            if (Game1.isDebrisWeather) return "windy";
            return "sunny";
        }

        private static string GetFestivalName()
        {
            if (!Utility.isFestivalDay(Game1.dayOfMonth, Game1.currentSeason))
                return "";

            // Festival name is stored in the festival data
            try
            {
                string key = $"{Game1.currentSeason}{Game1.dayOfMonth}";
                if (Game1.temporaryContent.Load<Dictionary<string, string>>("Data\\Festivals\\FestivalDates")
                    .TryGetValue(key, out string? name))
                    return name;
            }
            catch { /* festival data may not be loaded yet */ }

            return "Festival";
        }
    }
}
