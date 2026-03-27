using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Galaxy.Api;
using HarmonyLib;
using Steamworks;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Network;
using StardewValley.SDKs;
using StardewValley.SDKs.GogGalaxy;
using StardewValley.SDKs.GogGalaxy.Internal;
using StardewValley.SDKs.GogGalaxy.Listeners;
using StardewValley.SDKs.Steam;

namespace StardropDashboard
{
    public class ModEntry : Mod
    {
        // ── Galaxy credentials (Stardew Valley's registered values) ──
        private const string GalaxyClientId     = "48767653913349277";
        private const string GalaxyClientSecret = "58be5c2e55d7f535cf8c4b6bbc09d185de90b152c8c42703cc13502465f0d04a";
        private const string ServerName         = "StardropHost";

        // ── Config ─────────────────────────────────────────────────
        private ModConfig Config = null!;

        // ── Dashboard write timers ──────────────────────────────────
        private double _secondsSinceLastWrite = 0;
        private double _secondsSinceRetry     = 0;
        private string _outputPath = "";

        // ── Static refs for Harmony patches ────────────────────────
        private static ModEntry?   _instance = null;
        private static IModHelper? _helper   = null;

        // ── Invite code ─────────────────────────────────────────────
        private static string? _cachedInviteCode = null;

        // ── Galaxy init state ───────────────────────────────────────
        private static bool _galaxyInitComplete = false;
        private static bool _galaxySignedIn     = false;
        private static IAuthListener?                    _authListener        = null;
        private static IOperationalStateChangeListener?  _stateChangeListener = null;

        // ── HTTP client for app-ticket endpoint ─────────────────────
        private static readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(30) };
        private static readonly string _steamAuthUrl =
            (Environment.GetEnvironmentVariable("STEAM_AUTH_URL") ?? "").TrimEnd('/');

        private static readonly JsonSerializerOptions _jsonOpts = new()
        {
            PropertyNamingPolicy   = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented          = true,
        };

        // ── Entry ───────────────────────────────────────────────────
        public override void Entry(IModHelper helper)
        {
            _instance = this;
            _helper   = helper;
            Config      = helper.ReadConfig<ModConfig>();
            _outputPath = ResolveOutputPath();
            Directory.CreateDirectory(_outputPath);

            helper.Events.GameLoop.GameLaunched    += OnGameLaunched;
            helper.Events.GameLoop.SaveLoaded      += OnSaveLoaded;
            helper.Events.GameLoop.UpdateTicked    += OnUpdateTicked;
            helper.Events.GameLoop.ReturnedToTitle += (_, _) => WriteOffline();
            helper.Events.GameLoop.DayEnding       += (_, _) => GC.Collect();

            var harmony = new Harmony(ModManifest.UniqueID);

            // GalaxySocket.GetInviteCode — capture invite code the moment Galaxy generates it
            try
            {
                harmony.Patch(
                    original: AccessTools.Method(typeof(GalaxySocket), nameof(GalaxySocket.GetInviteCode)),
                    postfix:  new HarmonyMethod(typeof(ModEntry), nameof(GalaxySocket_GetInviteCode_Postfix))
                );
            }
            catch (Exception ex) { Monitor.Log($"GetInviteCode patch failed: {ex.Message}", LogLevel.Warn); }

            // SteamHelper — redirect Client API calls to GameServer mode
            try
            {
                harmony.Patch(
                    original: AccessTools.Method(typeof(SteamHelper), nameof(SteamHelper.Initialize)),
                    prefix:   new HarmonyMethod(typeof(ModEntry), nameof(SteamHelper_Initialize_Prefix))
                );
                harmony.Patch(
                    original: AccessTools.Method(typeof(SteamHelper), nameof(SteamHelper.Update)),
                    prefix:   new HarmonyMethod(typeof(ModEntry), nameof(SteamHelper_Update_Prefix))
                );
                harmony.Patch(
                    original: AccessTools.Method(typeof(SteamHelper), nameof(SteamHelper.Shutdown)),
                    prefix:   new HarmonyMethod(typeof(ModEntry), nameof(SteamHelper_Shutdown_Prefix))
                );
            }
            catch (Exception ex) { Monitor.Log($"SteamHelper patches failed: {ex.Message}", LogLevel.Warn); }

            // SteamNetServer.initialize — skip (uses Steam Client API, incompatible with GameServer mode)
            try
            {
                var steamNetServerType = AccessTools.TypeByName("StardewValley.SDKs.Steam.SteamNetServer");
                if (steamNetServerType != null)
                    harmony.Patch(
                        original: AccessTools.Method(steamNetServerType, "initialize"),
                        prefix:   new HarmonyMethod(typeof(ModEntry), nameof(SteamNetServer_Initialize_Prefix))
                    );
            }
            catch (Exception ex) { Monitor.Log($"SteamNetServer patch failed: {ex.Message}", LogLevel.Warn); }

            // SteamUser/SteamFriends — fake out Steam Client API calls that crash without SteamAPI.Init()
            try
            {
                harmony.Patch(
                    original: AccessTools.Method(typeof(SteamUser), nameof(SteamUser.GetSteamID)),
                    prefix:   new HarmonyMethod(typeof(ModEntry), nameof(SteamUser_GetSteamID_Prefix))
                );
                harmony.Patch(
                    original: AccessTools.Method(typeof(SteamFriends), nameof(SteamFriends.GetPersonaName)),
                    prefix:   new HarmonyMethod(typeof(ModEntry), nameof(SteamFriends_GetPersonaName_Prefix))
                );
            }
            catch (Exception ex) { Monitor.Log($"SteamUser/SteamFriends patches failed: {ex.Message}", LogLevel.Warn); }

            helper.ConsoleCommands.Add(
                "dashboard_status",
                "Force an immediate write of live-status.json.",
                (_, _) => { ForceWrite(); Monitor.Log("live-status.json written.", LogLevel.Info); }
            );

            Monitor.Log($"StardropDashboard ready. Output: {_outputPath}", LogLevel.Info);
        }

        // ── GameLaunched ────────────────────────────────────────────
        // Get SteamHelper directly via Program.sdk — don't wait for SteamHelper.Initialize
        // since the game may have already called it before our patches were registered.
        private void OnGameLaunched(object? sender, GameLaunchedEventArgs e)
        {
            WriteOffline();
            var sdk = GetCurrentSdk();
            if (sdk is SteamHelper steamHelper)
            {
                Monitor.Log("Obtained SteamHelper via Program.sdk.", LogLevel.Debug);
                PerformGalaxyInit(steamHelper);
            }
            else
            {
                Monitor.Log("Could not get SteamHelper from Program.sdk.", LogLevel.Warn);
            }
        }

        // ── SaveLoaded ──────────────────────────────────────────────
        // User may have logged into steam-auth between server start and save load — retry immediately.
        private void OnSaveLoaded(object? sender, SaveLoadedEventArgs e)
        {
            ForceWrite();
            if (_galaxyInitComplete && !_galaxySignedIn && !string.IsNullOrEmpty(_steamAuthUrl))
            {
                Monitor.Log("SaveLoaded — retrying Galaxy sign-in.", LogLevel.Info);
                Task.Run(FetchAndSignIn);
            }
        }

        // ── PerformGalaxyInit ───────────────────────────────────────
        // Initialise the Galaxy SDK and attempt sign-in if steam-auth is available.
        // Called from OnGameLaunched (direct) or SteamHelper_Initialize_Prefix (safety net).
        private void PerformGalaxyInit(SteamHelper steamHelper)
        {
            if (_galaxyInitComplete) return;

            try
            {
                Monitor.Log("Initializing Galaxy SDK for invite codes...", LogLevel.Info);
                GalaxyInstance.Init(new InitParams(GalaxyClientId, GalaxyClientSecret, "."));

                _authListener        = CreateAuthListener(steamHelper);
                _stateChangeListener = CreateStateChangeListener(steamHelper);
                _galaxyInitComplete  = true;

                Monitor.Log("Galaxy SDK initialized. Attempting sign-in...", LogLevel.Info);

                if (!string.IsNullOrEmpty(_steamAuthUrl))
                {
                    Task.Run(FetchAndSignIn);
                }
                else
                {
                    Monitor.Log("STEAM_AUTH_URL not set — invite codes need steam-auth logged in.", LogLevel.Warn);
                    if (steamHelper.Networking == null)
                    {
                        SetSteamNetworking(steamHelper, CreateSteamNetHelper());
                        SetSteamConnectionFinished(steamHelper, true);
                    }
                }
            }
            catch (Exception ex)
            {
                Monitor.Log($"Galaxy SDK init failed (non-fatal): {ex.Message}", LogLevel.Warn);
                if (steamHelper.Networking == null)
                {
                    SetSteamNetworking(steamHelper, CreateSteamNetHelper());
                    SetSteamConnectionFinished(steamHelper, true);
                }
            }
        }

        // ── FetchAndSignIn ──────────────────────────────────────────
        // Fetch encrypted app ticket from steam-auth and sign into Galaxy.
        // Called at startup and retried every 30s until successful.
        private async Task FetchAndSignIn()
        {
            try
            {
                Monitor.Log("Fetching Steam app ticket from steam-auth...", LogLevel.Info);
                var resp = await _http.GetAsync($"{_steamAuthUrl}/steam/app-ticket");

                if (!resp.IsSuccessStatusCode)
                {
                    var body = await resp.Content.ReadAsStringAsync();
                    Monitor.Log($"steam-auth returned {(int)resp.StatusCode}: {body}", LogLevel.Warn);
                    Monitor.Log("Log in via the Steam panel to enable invite codes.", LogLevel.Warn);
                    return;
                }

                var json   = await resp.Content.ReadAsStringAsync();
                var doc    = JsonDocument.Parse(json);
                var b64    = doc.RootElement.GetProperty("app_ticket").GetString() ?? "";
                var ticket = Convert.FromBase64String(b64);

                Monitor.Log($"App ticket received ({ticket.Length} bytes). Signing into Galaxy...", LogLevel.Info);
                GalaxyInstance.User().SignInSteam(ticket, (uint)ticket.Length, ServerName);
                _galaxySignedIn = true;
                // Galaxy result arrives via _authListener / _stateChangeListener callbacks
            }
            catch (Exception ex)
            {
                Monitor.Log($"App ticket fetch failed: {ex.Message}", LogLevel.Warn);
            }
        }

        // ── Harmony: SteamHelper.Initialize ────────────────────────
        // Safety net: if this fires before OnGameLaunched (or after), init Galaxy here too.
        private static bool SteamHelper_Initialize_Prefix(SteamHelper __instance)
        {
            _instance?.Monitor.Log("SteamHelper.Initialize intercepted.", LogLevel.Debug);
            SetSteamActive(__instance, true);
            if (!_galaxyInitComplete)
                _instance?.PerformGalaxyInit(__instance);
            return false; // skip original
        }

        // ── Harmony: SteamHelper.Update ─────────────────────────────
        private static bool SteamHelper_Update_Prefix(SteamHelper __instance)
        {
            if (_helper == null) return false;
            bool active = _helper.Reflection.GetField<bool>(__instance, "active").GetValue();
            if (active && _galaxyInitComplete)
                try { GalaxyInstance.ProcessData(); } catch { }
            Game1.game1.IsMouseVisible = Game1.paused || Game1.options.hardwareCursor;
            return false; // skip original
        }

        // ── Harmony: SteamHelper.Shutdown ───────────────────────────
        private static bool SteamHelper_Shutdown_Prefix()
        {
            _instance?.Monitor.Log("SteamHelper.Shutdown — resetting Galaxy state.", LogLevel.Debug);
            _cachedInviteCode    = null;
            _galaxySignedIn      = false;
            _galaxyInitComplete  = false;
            _authListener        = null;
            _stateChangeListener = null;
            return false; // skip original
        }

        // ── Harmony: SteamNetServer.initialize ──────────────────────
        private static bool SteamNetServer_Initialize_Prefix()
        {
            _instance?.Monitor.Log("SteamNetServer.initialize skipped (incompatible with GameServer mode).", LogLevel.Debug);
            return false; // skip original
        }

        // ── Harmony: SteamUser.GetSteamID ───────────────────────────
        // SteamAPI.Init() was never called — return a stable fake ID to prevent crashes.
        private static bool SteamUser_GetSteamID_Prefix(ref CSteamID __result)
        {
            __result = new CSteamID(123456789UL);
            return false;
        }

        // ── Harmony: SteamFriends.GetPersonaName ────────────────────
        private static bool SteamFriends_GetPersonaName_Prefix(ref string __result)
        {
            __result = ServerName;
            return false;
        }

        // ── Galaxy auth listener ─────────────────────────────────────
        private IAuthListener CreateAuthListener(SteamHelper steamHelper)
        {
            var t = AccessTools.TypeByName("StardewValley.SDKs.GogGalaxy.Listeners.GalaxyAuthListener");

            Action onSuccess = () =>
                Monitor.Log("Galaxy auth success.", LogLevel.Info);

            Action<IAuthListener.FailureReason> onFailure = (reason) =>
            {
                Monitor.Log($"Galaxy auth failure: {reason} — will retry when logged in.", LogLevel.Warn);
                _galaxySignedIn = false; // allow retry loop to re-attempt
                if (steamHelper.Networking == null)
                    SetSteamNetworking(steamHelper, CreateSteamNetHelper());
                SetSteamConnectionFinished(steamHelper, true);
            };

            Action onLost = () =>
            {
                Monitor.Log("Galaxy auth lost — will retry.", LogLevel.Warn);
                _galaxySignedIn = false;
            };

            return (IAuthListener)Activator.CreateInstance(t, onSuccess, onFailure, onLost)!;
        }

        // ── Galaxy state change listener ─────────────────────────────
        // Mirrors JunimoServer's SteamHelper-mode state change listener exactly.
        private IOperationalStateChangeListener CreateStateChangeListener(SteamHelper steamHelper)
        {
            var t = AccessTools.TypeByName("StardewValley.SDKs.GogGalaxy.Listeners.GalaxyOperationalStateChangeListener");

            Action<uint> onChange = (state) =>
            {
                Monitor.Log($"Galaxy state changed: {state}", LogLevel.Info);

                if ((state & 2) != 0)
                {
                    Monitor.Log("Galaxy logged on — invite codes active.", LogLevel.Info);
                    // Order matters (per JunimoServer): set networking → ConnectionFinished → GalaxyConnected → late-add
                    if (steamHelper.Networking == null)
                        SetSteamNetworking(steamHelper, CreateSteamNetHelper());
                    SetSteamConnectionFinished(steamHelper, true);
                    SetSteamGalaxyConnected(steamHelper, true);
                    TryLateAddGalaxyServer();
                }
            };

            return (IOperationalStateChangeListener)Activator.CreateInstance(t, onChange)!;
        }

        // ── TryLateAddGalaxyServer ────────────────────────────────────
        // Adds a GalaxyNetServer to the running game server when Galaxy logs on after
        // the server was already created (the normal race condition on a dedicated server).
        // Must be called AFTER SetSteamGalaxyConnected(true) — that switches sdk.Networking
        // to GalaxyNetHelper so CreateServer() produces the correct type.
        private static void TryLateAddGalaxyServer()
        {
            try
            {
                if (Game1.server == null)
                {
                    _instance?.Monitor.Log("TryLateAddGalaxyServer: no server running yet.", LogLevel.Debug);
                    return;
                }

                var sdk = GetCurrentSdk();
                if (sdk?.Networking == null)
                {
                    _instance?.Monitor.Log("TryLateAddGalaxyServer: sdk.Networking is null.", LogLevel.Debug);
                    return;
                }

                var serversField = _helper!.Reflection.GetField<List<Server>>(Game1.server, "servers");
                var servers      = serversField.GetValue();

                foreach (var s in servers)
                    if (s.GetType().Name == "GalaxyNetServer")
                    {
                        _instance?.Monitor.Log("GalaxyNetServer already present.", LogLevel.Debug);
                        return;
                    }

                _instance?.Monitor.Log("Late-adding GalaxyNetServer...", LogLevel.Info);
                var galaxyServer = sdk.Networking.CreateServer(Game1.server);
                if (galaxyServer != null)
                {
                    servers.Add(galaxyServer);
                    galaxyServer.initialize();
                    _instance?.Monitor.Log("GalaxyNetServer added — invite code should appear shortly.", LogLevel.Info);
                }
                else
                {
                    _instance?.Monitor.Log("TryLateAddGalaxyServer: CreateServer returned null.", LogLevel.Warn);
                }
            }
            catch (Exception ex)
            {
                _instance?.Monitor.Log($"TryLateAddGalaxyServer failed: {ex.Message}", LogLevel.Warn);
            }
        }

        // ── Harmony: GalaxySocket.GetInviteCode postfix ──────────────
        private static void GalaxySocket_GetInviteCode_Postfix(string __result)
        {
            if (string.IsNullOrEmpty(__result) || __result == _cachedInviteCode) return;
            _cachedInviteCode = __result;
            _instance?.Monitor.Log($"[InviteCode] Captured: {__result}", LogLevel.Info);
            _instance?.ForceWrite();
        }

        // ── SteamHelper reflection helpers ────────────────────────────
        private static SDKHelper? GetCurrentSdk()
        {
            var getter = AccessTools.PropertyGetter(AccessTools.TypeByName("StardewValley.Program"), "sdk");
            return getter?.Invoke(null, null) as SDKHelper;
        }

        private static void SetSteamActive(SteamHelper h, bool v) =>
            _helper!.Reflection.GetField<bool>(h, "active").SetValue(v);
        private static void SetSteamConnectionFinished(SteamHelper h, bool v) =>
            _helper!.Reflection.GetProperty<bool>(h, "ConnectionFinished").SetValue(v);
        private static void SetSteamGalaxyConnected(SteamHelper h, bool v) =>
            _helper!.Reflection.GetProperty<bool>(h, "GalaxyConnected").SetValue(v);
        private static void SetSteamNetworking(SteamHelper h, SDKNetHelper n) =>
            _helper!.Reflection.GetField<SDKNetHelper>(h, "networking").SetValue(n);

        private static SDKNetHelper CreateSteamNetHelper()
        {
            var t = AccessTools.TypeByName("StardewValley.SDKs.Steam.SteamNetHelper");
            return (SDKNetHelper)Activator.CreateInstance(t)!;
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

            // Retry Galaxy sign-in every 30s.
            // Covers the case where the user logs into steam-auth after the server started.
            if (_galaxyInitComplete && !_galaxySignedIn && !string.IsNullOrEmpty(_steamAuthUrl))
            {
                _secondsSinceRetry += elapsed;
                if (_secondsSinceRetry >= 30)
                {
                    _secondsSinceRetry = 0;
                    Task.Run(FetchAndSignIn);
                }
            }
        }

        // ── Write helpers ─────────────────────────────────────────────
        private void WriteOffline()
        {
            _cachedInviteCode  = null;
            _galaxySignedIn    = false;
            _secondsSinceRetry = 0;
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

            // -- Invite code (Harmony postfix is primary; poll as fallback) --
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

        // ── Write to disk (atomic via temp file) ─────────────────────
        private void WriteToDisk(LiveStatus status)
        {
            string json    = JsonSerializer.Serialize(status, _jsonOpts);
            string tmpFile = LiveStatusFile + ".tmp";
            File.WriteAllText(tmpFile, json);
            File.Move(tmpFile, LiveStatusFile, overwrite: true);
        }
    }
}
