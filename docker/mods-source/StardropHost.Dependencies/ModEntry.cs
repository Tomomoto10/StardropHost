/**
 * StardropHost | mods-source/StardropHost.Dependencies/ModEntry.cs
 *
 * Combined server management mod. Replaces:
 *   - AlwaysOnServer      (headless server, auto-sleep, friendship decay)
 *   - AutoHideHost        (host hiding, instant sleep, menu handling, event skipping)
 *   - StardropGameManager (save loading, farm creation)
 *   - SkillLevelGuard     (not needed — we do not set skills to 10)
 *
 * StardropDashboard remains a separate mod (web panel Farm tab data writer).
 *
 * License acknowledgements:
 *   - AlwaysOnServer by funny-snek & Zuberii (Unlicense / public domain)
 *   - WaitCondition helper pattern adapted from SMAPIDedicatedServerMod
 *     by ObjectManagerManager (MIT) — https://github.com/ObjectManagerManager/SMAPIDedicatedServerMod
 */

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Menus;
using StardewValley.Objects;

namespace StardropHostDependencies
{
    public class ModEntry : Mod
    {
        // ── Constants ────────────────────────────────────────────────────────
        private const string NewFarmConfigPath   = "/home/steam/web-panel/data/new-farm.json";
        private const int    AutoSleepTime       = 2600;  // 2:00 AM in-game clock
        private const int    GuardWindowSeconds  = 60;
        private const int    SkipCooldownSeconds = 5;

        // ── Game Loader state ────────────────────────────────────────────────
        private bool           _farmStageEnabled = false;
        private readonly WaitCondition _titleMenuCondition = new(() => Game1.activeClickableMenu is TitleMenu, 5);
        private NewFarmConfig? _cfg         = null;
        private bool           _petHandled  = false;
        private bool           _caveHandled = false;
        private int            _runtimeTick = 0;

        private static readonly FieldInfo _namingMenuTextBoxField =
            typeof(NamingMenu).GetField("textBox", BindingFlags.NonPublic | BindingFlags.Instance)!;

        // ── Host Bot state ───────────────────────────────────────────────────
        private bool      _hasTriggeredSleep  = false;
        private bool      _isSleepInProgress  = false;
        private bool      _handledReadyCheck  = false;
        private DateTime? _guardWindowEnd     = null;
        private bool      _needRehide         = false;
        private int       _rehideTicks        = 0;
        private string?   _lastSkippedEventId = null;
        private DateTime? _lastSkipTime       = null;

        // ── Headless Server state ────────────────────────────────────────────
        private readonly Dictionary<string, int> _prevFriendships = new();

        // ════════════════════════════════════════════════════════════════════
        // ENTRY
        // ════════════════════════════════════════════════════════════════════

        public override void Entry(IModHelper helper)
        {
            helper.Events.GameLoop.SaveLoaded       += OnSaveLoaded;
            helper.Events.GameLoop.DayStarted       += OnDayStarted;
            helper.Events.GameLoop.UpdateTicked     += OnUpdateTicked;
            helper.Events.GameLoop.TimeChanged      += OnTimeChanged;
            helper.Events.GameLoop.Saving           += OnSaving;
            helper.Events.Display.MenuChanged       += OnMenuChanged;
            helper.Events.Multiplayer.PeerConnected    += OnPeerConnected;
            helper.Events.Multiplayer.PeerDisconnected += OnPeerDisconnected;
            helper.Events.Player.Warped             += OnWarped;

            Monitor.Log("StardropHost.Dependencies loaded.", LogLevel.Info);
        }

        // ════════════════════════════════════════════════════════════════════
        // SMAPI EVENTS
        // ════════════════════════════════════════════════════════════════════

        private void OnSaveLoaded(object? sender, SaveLoadedEventArgs e)
        {
            // Remove built-in player cap so any number of farmhands can connect
            try { Game1.netWorldState.Value.CurrentPlayerLimit = int.MaxValue; }
            catch (Exception ex) { Monitor.Log($"Could not remove player limit: {ex.Message}", LogLevel.Warn); }

            // Apply move-build permission from farm config (new-farm.json)
            if (_cfg?.MoveBuildPermission is string perm && perm != "off")
            {
                try { (Game1.chatBox as ChatBox)?.textBoxEnter($"/mbp {perm}"); }
                catch { /* chatBox not ready yet */ }
            }

            if (Context.IsMainPlayer)
            {
                HideHost();
                _hasTriggeredSleep = false;
                _isSleepInProgress = false;
                _handledReadyCheck = false;
            }

            Monitor.Log("[StardropHost.Dependencies] Server ready for connections.", LogLevel.Info);
        }

        private void OnDayStarted(object? sender, DayStartedEventArgs e)
        {
            if (!Context.IsMainPlayer) return;

            HideHost();
            _hasTriggeredSleep  = false;
            _isSleepInProgress  = false;
            _handledReadyCheck  = false;
            _lastSkippedEventId = null;
            _lastSkipTime       = null;

            // Guard window at day start — players may already be online
            _guardWindowEnd = DateTime.Now.AddSeconds(GuardWindowSeconds);
        }

        private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            // Keep host alive (prevents pass-out blocking end-of-day)
            if (Context.IsWorldReady && Context.IsMainPlayer)
            {
                Game1.player.health  = Game1.player.maxHealth;
                Game1.player.stamina = Game1.player.maxStamina.Value;
            }

            // Runtime dialogue handling — pet/cave choice for new farm creation
            if (Context.IsWorldReady && _cfg != null)
            {
                if (++_runtimeTick >= 60) { _runtimeTick = 0; HandleRuntimeDialogues(); }
            }

            // Title screen: detect and run farm stage once TitleMenu is stable
            if (!_farmStageEnabled && _titleMenuCondition.IsMet())
            {
                _farmStageEnabled = true;
                RunFarmStage();
            }

            if (!Context.IsMainPlayer) return;

            // Delayed re-hide after peer connect
            if (_needRehide && _rehideTicks > 0 && --_rehideTicks == 0)
            {
                HideHost();
                _needRehide = false;
            }

            // Sleep state maintenance — keep host in bed during overnight transition
            if (_isSleepInProgress)
            {
                if (!Game1.player.isInBed.Value || Game1.player.timeWentToBed.Value == 0)
                {
                    Game1.player.isInBed.Value       = true;
                    Game1.player.timeWentToBed.Value = Game1.timeOfDay;
                }
                EnsureSleepLocation();
                return;
            }

            // ReadyCheck + event skip (every 0.5s)
            if (e.Ticks % 30 == 0)
            {
                HandleReadyCheck();
                SkipCurrentEvent();
            }

            // Auto-sleep when all players in bed (every 0.25s)
            if (e.Ticks % 15 == 0)
                CheckAndSleepWhenPlayersReady();

            // Friendship decay prevention (every second)
            if (e.IsOneSecond && Context.IsWorldReady)
                PreventFriendshipDecay();
        }

        private void OnTimeChanged(object? sender, TimeChangedEventArgs e)
        {
            if (!Context.IsMainPlayer || !Context.IsWorldReady) return;

            // Auto-sleep at 2AM regardless of player state
            if (Game1.timeOfDay >= AutoSleepTime && !_hasTriggeredSleep && !_isSleepInProgress)
            {
                Monitor.Log($"[HeadlessServer] Auto-sleep at {AutoSleepTime}.", LogLevel.Info);
                GoToBed();
                _hasTriggeredSleep = true;
            }
        }

        private void OnSaving(object? sender, SavingEventArgs e)
        {
            if (!Context.IsMainPlayer) return;

            // Ensure host wakes in FarmHouse, not the Desert
            if (Game1.player.currentLocation?.Name != "FarmHouse")
            {
                var (bx, by) = GetBedCoords();
                Game1.player.lastSleepLocation.Value = "FarmHouse";
                Game1.player.lastSleepPoint.Value    = new Point(bx, by);
            }

            // Auto-close ShippingMenu if it's open during save
            if (Game1.activeClickableMenu is ShippingMenu)
            {
                try { Helper.Reflection.GetMethod(Game1.activeClickableMenu, "okClicked").Invoke(); }
                catch (Exception ex) { Monitor.Log($"ShippingMenu close failed: {ex.Message}", LogLevel.Warn); }
            }

            // Auto-dismiss any blocking DialogueBox during save
            if (Game1.activeClickableMenu is DialogueBox)
                Game1.activeClickableMenu.receiveLeftClick(10, 10);
        }

        private void OnMenuChanged(object? sender, MenuChangedEventArgs e)
        {
            if (!Context.IsMainPlayer) return;

            // Reset ready-check flag when the dialog closes
            if (e.OldMenu?.GetType().Name == "ReadyCheckDialog")
                _handledReadyCheck = false;

            if (e.NewMenu == null) return;

            // ShippingMenu → auto-click OK
            if (e.NewMenu is ShippingMenu sm)
            {
                try { Helper.Reflection.GetMethod(sm, "okClicked").Invoke(); }
                catch (Exception ex) { Monitor.Log($"ShippingMenu: {ex.Message}", LogLevel.Warn); }
                return;
            }

            // LevelUpMenu → do NOT auto-handle (auto-clicking causes skill auto-level to 10)
            if (e.NewMenu is LevelUpMenu) return;

            // DialogueBox → auto-dismiss
            if (e.NewMenu is DialogueBox db)
            {
                try
                {
                    db.receiveKeyPress(Microsoft.Xna.Framework.Input.Keys.Escape);
                    Game1.activeClickableMenu = null;
                }
                catch { /* ignore */ }
                return;
            }

            // LetterViewerMenu → auto-close
            if (e.NewMenu is LetterViewerMenu lv)
            {
                try
                {
                    lv.receiveKeyPress(Microsoft.Xna.Framework.Input.Keys.Escape);
                    Game1.activeClickableMenu = null;
                }
                catch { /* ignore */ }
            }
        }

        private void OnPeerConnected(object? sender, PeerConnectedEventArgs e)
        {
            // Start guard window to prevent host being warped back to Farm on connect
            _guardWindowEnd = DateTime.Now.AddSeconds(GuardWindowSeconds);
            _needRehide     = true;
            _rehideTicks    = 1;
        }

        private void OnPeerDisconnected(object? sender, PeerDisconnectedEventArgs e)
        {
            Monitor.Log($"farmhand {e.Peer.PlayerID} disconnected", LogLevel.Info);
        }

        private void OnWarped(object? sender, WarpedEventArgs e)
        {
            if (!Context.IsMainPlayer || !e.IsLocalPlayer) return;
            if (_guardWindowEnd.HasValue && DateTime.Now < _guardWindowEnd.Value)
            {
                _needRehide  = true;
                _rehideTicks = 1;
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // HOST BOT HELPERS
        // ════════════════════════════════════════════════════════════════════

        private void HideHost()
        {
            if (!Context.IsMainPlayer) return;
            Game1.warpFarmer("Desert", 0, 0, false);
        }

        private void HandleReadyCheck()
        {
            if (Game1.player?.team == null || _handledReadyCheck) return;
            try
            {
                string? name = GetActiveReadyCheckName();
                if (string.IsNullOrEmpty(name)) return;

                var method = Helper.Reflection.GetMethod(Game1.player.team, "SetLocalReady", required: false);
                if (method != null)
                {
                    method.Invoke(name, true);
                    _handledReadyCheck = true;
                    Monitor.Log($"[HostBot] ReadyCheck '{name}' accepted.", LogLevel.Info);
                }
                else
                {
                    TryClickReadyCheckDialog();
                }
            }
            catch (Exception ex) { Monitor.Log($"[HostBot] ReadyCheck: {ex.Message}", LogLevel.Trace); }
        }

        private void SkipCurrentEvent()
        {
            if (Game1.CurrentEvent == null || !Game1.CurrentEvent.skippable) return;

            string id  = Game1.CurrentEvent.id;
            bool same  = id == _lastSkippedEventId;
            bool onCd  = _lastSkipTime.HasValue &&
                         (DateTime.Now - _lastSkipTime.Value).TotalSeconds < SkipCooldownSeconds;
            if (same && onCd) return;

            Game1.CurrentEvent.skipEvent();
            _lastSkippedEventId = id;
            _lastSkipTime       = DateTime.Now;
            Monitor.Log($"[HostBot] Skipped event {id}.", LogLevel.Info);
        }

        private void CheckAndSleepWhenPlayersReady()
        {
            if (!Context.IsWorldReady || _hasTriggeredSleep || _isSleepInProgress) return;
            if (Game1.activeClickableMenu != null) return;

            var farmhands = Game1.getOnlineFarmers()
                .Where(f => f.UniqueMultiplayerID != Game1.player.UniqueMultiplayerID)
                .ToList();

            if (farmhands.Count == 0) return;
            if (!farmhands.All(f => f.isInBed.Value && f.timeWentToBed.Value > 0)) return;

            Monitor.Log($"[HostBot] All {farmhands.Count} player(s) in bed — sleeping.", LogLevel.Info);
            GoToBed();
            _hasTriggeredSleep = true;
        }

        private void GoToBed()
        {
            try
            {
                var (bx, by) = GetBedCoords();
                PreventSleepEvents();
                _isSleepInProgress = true;

                Game1.warpFarmer("FarmHouse", bx, by, false);

                // Call startSleep synchronously — same pattern as original AlwaysOnServer and AutoHideHost
                var startSleep = Helper.Reflection.GetMethod(Game1.currentLocation, "startSleep", required: false);
                if (startSleep != null)
                    startSleep.Invoke();
                else
                {
                    Game1.player.isInBed.Value       = true;
                    Game1.player.timeWentToBed.Value = Game1.timeOfDay;
                }

                // Set AFTER startSleep in case it overwrites (AutoHideHost v1.3.3 note)
                Game1.player.lastSleepLocation.Value = "FarmHouse";
                Game1.player.lastSleepPoint.Value    = new Point(bx, by);
                Game1.displayHUD = true;

                Monitor.Log($"[HostBot] Going to bed at FarmHouse ({bx},{by}).", LogLevel.Info);
            }
            catch (Exception ex)
            {
                Monitor.Log($"[HostBot] GoToBed error: {ex.Message}", LogLevel.Error);
            }
        }

        private void EnsureSleepLocation()
        {
            if (Game1.player.lastSleepLocation.Value == "FarmHouse") return;
            var (bx, by) = GetBedCoords();
            Game1.player.lastSleepLocation.Value = "FarmHouse";
            Game1.player.lastSleepPoint.Value    = new Point(bx, by);
        }

        private void PreventSleepEvents()
        {
            foreach (var id in new[] { "60367", "558291", "831125", "502261", "26", "27", "733330" })
                if (!Game1.player.eventsSeen.Contains(id))
                    Game1.player.eventsSeen.Add(id);
        }

        private static (int x, int y) GetBedCoords() => Game1.player.HouseUpgradeLevel switch
        {
            0 => (9,  9),
            1 => (21, 4),
            _ => (27, 13),
        };

        private string? GetActiveReadyCheckName()
        {
            try
            {
                // Use IDictionary to avoid a hard reference to the internal NetReady type
                var field = Helper.Reflection.GetField<System.Collections.IDictionary>(
                    Game1.player.team, "readyChecks", required: false);
                var dict = field?.GetValue();
                if (dict == null) return null;
                foreach (var key in dict.Keys)
                    return key?.ToString();
                return null;
            }
            catch { return null; }
        }

        private void TryClickReadyCheckDialog()
        {
            try
            {
                if (Game1.activeClickableMenu?.GetType().Name == "ReadyCheckDialog")
                    Game1.activeClickableMenu.receiveLeftClick(300, 300);
            }
            catch { /* ignore */ }
        }

        // ════════════════════════════════════════════════════════════════════
        // HEADLESS SERVER HELPERS
        // ════════════════════════════════════════════════════════════════════

        private void PreventFriendshipDecay()
        {
            if (!Context.IsWorldReady || !Context.IsMainPlayer) return;

            if (_prevFriendships.Count > 0)
            {
                foreach (string key in Game1.player.friendshipData.Keys)
                {
                    var f = Game1.player.friendshipData[key];
                    if (_prevFriendships.TryGetValue(key, out int prev) && prev > f.Points)
                        f.Points = prev;
                }
            }

            _prevFriendships.Clear();
            foreach (var pair in Game1.player.friendshipData.FieldDict)
                _prevFriendships[pair.Key] = pair.Value.Value.Points;
        }

        // ════════════════════════════════════════════════════════════════════
        // GAME LOADER
        // ════════════════════════════════════════════════════════════════════

        private void RunFarmStage()
        {
            if (Game1.activeClickableMenu is not TitleMenu menu)
            {
                _farmStageEnabled = false;
                _titleMenuCondition.Reset();
                return;
            }
            try
            {
                if (TryLoadExistingSave()) return;
                if (TryCreateNewFarm(menu)) return;

                Monitor.Log("[GameLoader] No saves and no new-farm.json — waiting.", LogLevel.Debug);
                _farmStageEnabled = false;
                _titleMenuCondition.Reset();
            }
            catch (Exception ex)
            {
                Monitor.Log($"[GameLoader] Error: {ex}", LogLevel.Error);
                _farmStageEnabled = false;
                _titleMenuCondition.Reset();
            }
        }

        private bool TryLoadExistingSave()
        {
            var savesPath = Constants.SavesPath;
            if (!Directory.Exists(savesPath)) return false;

            string? slotName   = null;
            var     requested  = Environment.GetEnvironmentVariable("SAVE_NAME");

            if (!string.IsNullOrWhiteSpace(requested))
            {
                slotName = Directory.GetDirectories(savesPath)
                    .Select(Path.GetFileName)
                    .FirstOrDefault(d => d != null &&
                        (d.Equals(requested, StringComparison.OrdinalIgnoreCase) ||
                         d.StartsWith(requested + "_", StringComparison.OrdinalIgnoreCase)));

                if (slotName == null)
                    Monitor.Log($"[GameLoader] SAVE_NAME='{requested}' not found — using most recent.", LogLevel.Warn);
            }

            slotName ??= Directory.GetDirectories(savesPath)
                .Where(Directory.Exists)
                .OrderByDescending(Directory.GetLastWriteTimeUtc)
                .Select(Path.GetFileName)
                .FirstOrDefault();

            if (slotName == null) return false;

            Monitor.Log($"[GameLoader] Loading '{slotName}' as co-op host.", LogLevel.Info);
            Game1.multiplayerMode = 2;
            SaveGame.Load(slotName);
            Game1.exitActiveMenu();
            return true;
        }

        private bool TryCreateNewFarm(TitleMenu menu)
        {
            if (!File.Exists(NewFarmConfigPath)) return false;

            NewFarmConfig? cfg;
            try
            {
                cfg = JsonSerializer.Deserialize<NewFarmConfig>(
                    File.ReadAllText(NewFarmConfigPath),
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            }
            catch (Exception ex)
            {
                Monitor.Log($"[GameLoader] Failed to parse new-farm.json: {ex.Message}", LogLevel.Error);
                File.Delete(NewFarmConfigPath);
                return false;
            }

            if (cfg == null)
            {
                Monitor.Log("[GameLoader] new-farm.json deserialised to null.", LogLevel.Warn);
                File.Delete(NewFarmConfigPath);
                return false;
            }

            Monitor.Log(
                $"[GameLoader] Creating farm '{cfg.FarmName}' " +
                $"(type={cfg.FarmType}, cabins={cfg.CabinCount}).",
                LogLevel.Info);
            _cfg = cfg;

            Game1.resetPlayer();
            Game1.player.Name                = cfg.FarmerName;
            Game1.player.displayName         = cfg.FarmerName;
            Game1.player.farmName.Value      = cfg.FarmName;
            Game1.player.favoriteThing.Value = string.IsNullOrWhiteSpace(cfg.FavoriteThing) ? "Farming" : cfg.FavoriteThing;
            Game1.player.isCustomized.Value  = true;
            Game1.player.whichPetType        = cfg.PetSpecies.Equals("dog", StringComparison.OrdinalIgnoreCase) ? "dog" : "cat";
            Game1.player.whichPetBreed       = cfg.PetBreed.ToString();
            Game1.startingCabins             = Math.Clamp(cfg.CabinCount, 1, 4);
            Game1.cabinsSeparate             = cfg.CabinLayout.Equals("separate", StringComparison.OrdinalIgnoreCase);

            Game1.player.team.useSeparateWallets.Value =
                cfg.MoneyStyle.Equals("separate", StringComparison.OrdinalIgnoreCase);

            Game1.player.difficultyModifier = cfg.ProfitMargin switch
            {
                "75%"  => 0.75f,
                "50%"  => 0.50f,
                "25%"  => 0.25f,
                _      => 1.00f,
            };

            Game1.whichFarm  = Math.Clamp(cfg.FarmType, 0, 6);
            Game1.bundleType = cfg.CommunityCenterBundles.Equals("remixed", StringComparison.OrdinalIgnoreCase)
                               ? Game1.BundleType.Remixed : Game1.BundleType.Default;

            Game1.game1.SetNewGameOption("MineChests",
                cfg.MineRewards.Equals("remixed", StringComparison.OrdinalIgnoreCase)
                    ? Game1.MineChestType.Remixed : Game1.MineChestType.Default);
            Game1.game1.SetNewGameOption("YearOneCompletable", cfg.GuaranteeYear1Completable);

            Game1.spawnMonstersAtNight = cfg.SpawnMonstersAtNight;
            Game1.game1.SetNewGameOption("SpawnMonstersAtNight", cfg.SpawnMonstersAtNight);

            if (cfg.RandomSeed.HasValue)
                Game1.startingGameSeed = cfg.RandomSeed;

            // multiplayerMode=2 BEFORE createdNewCharacter — required for proper co-op farm
            Game1.multiplayerMode = 2;
            menu.createdNewCharacter(true);

            File.Delete(NewFarmConfigPath);
            Monitor.Log("[GameLoader] Farm creation initiated. new-farm.json removed.", LogLevel.Info);
            return true;
        }

        private void HandleRuntimeDialogues()
        {
            if (Game1.activeClickableMenu == null || _cfg == null) return;

            // Cave choice (Demetrius ~Day 5 Year 1) and pet question (Marnie ~Day 3 Year 1)
            if (Game1.activeClickableMenu is DialogueBox db && db.isQuestion && db.responses != null)
            {
                int mushIdx = -1, batsIdx = -1, yesIdx = -1, noIdx = -1;
                for (int i = 0; i < db.responses.Count(); i++)
                {
                    var t = db.responses[i].responseText?.ToLowerInvariant() ?? "";
                    if (t == "mushrooms") mushIdx = i;
                    else if (t == "bats") batsIdx = i;
                    else if (t == "yes")  yesIdx  = i;
                    else if (t == "no")   noIdx   = i;
                }

                if (!_caveHandled && mushIdx >= 0 && batsIdx >= 0)
                {
                    db.selectedResponse = _cfg.MushroomsOrBats.Equals("bats", StringComparison.OrdinalIgnoreCase)
                        ? batsIdx : mushIdx;
                    db.receiveLeftClick(0, 0);
                    _caveHandled = true;
                    Monitor.Log($"[GameLoader] Cave choice: {_cfg.MushroomsOrBats}.", LogLevel.Info);
                }
                else if (!_petHandled && yesIdx >= 0 && noIdx >= 0)
                {
                    db.selectedResponse = _cfg.AcceptPet ? yesIdx : noIdx;
                    db.receiveLeftClick(0, 0);
                    if (!_cfg.AcceptPet) _petHandled = true;
                    Monitor.Log($"[GameLoader] Pet question answered (accept={_cfg.AcceptPet}).", LogLevel.Info);
                }
            }

            // NamingMenu — pet name entry after accepting pet
            if (!_petHandled && Game1.activeClickableMenu is NamingMenu nm)
            {
                try
                {
                    var textBox = _namingMenuTextBoxField.GetValue(nm) as TextBox;
                    if (textBox != null)
                    {
                        textBox.Text = string.IsNullOrWhiteSpace(_cfg.PetName) ? "Stella" : _cfg.PetName;
                        textBox.RecieveCommandInput('\r');
                        _petHandled = true;
                        Monitor.Log($"[GameLoader] Pet named '{_cfg.PetName}'.", LogLevel.Info);
                    }
                }
                catch (Exception ex)
                {
                    Monitor.Log($"[GameLoader] Pet naming failed: {ex.Message}", LogLevel.Warn);
                    _petHandled = true; // don't get stuck
                }
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // WAIT CONDITION HELPER
        // ════════════════════════════════════════════════════════════════════

        private sealed class WaitCondition
        {
            private readonly Func<bool> _condition;
            private readonly int        _initial;
            private int                 _counter;

            public WaitCondition(Func<bool> condition, int initial)
            { _condition = condition; _initial = initial; _counter = initial; }

            /// <summary>Returns true once the condition has been met for
            /// <c>initial</c> consecutive ticks.</summary>
            public bool IsMet()
            {
                if (_counter <= 0 && _condition()) return true;
                _counter--;
                return false;
            }

            public void Reset() => _counter = _initial;
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // NEW FARM CONFIG — matches wizard.js submitNewFarm() JSON output
    // ════════════════════════════════════════════════════════════════════════

    internal sealed class NewFarmConfig
    {
        public string FarmName                  { get; set; } = "Stardrop Farm";
        public string FarmerName                { get; set; } = "Host";
        public string FavoriteThing             { get; set; } = "Farming";
        public int    FarmType                  { get; set; } = 0;
        public int    CabinCount                { get; set; } = 1;
        public string CabinLayout               { get; set; } = "separate";
        public string MoneyStyle                { get; set; } = "shared";
        public string ProfitMargin              { get; set; } = "normal";
        public string CommunityCenterBundles    { get; set; } = "normal";
        public bool   GuaranteeYear1Completable { get; set; } = false;
        public string MineRewards               { get; set; } = "normal";
        public bool   SpawnMonstersAtNight      { get; set; } = false;
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public ulong? RandomSeed                { get; set; } = null;
        public bool   AcceptPet                 { get; set; } = true;
        public string PetSpecies                { get; set; } = "cat";
        public int    PetBreed                  { get; set; } = 0;
        public string PetName                   { get; set; } = "Stella";
        public string MushroomsOrBats           { get; set; } = "mushrooms";
        public bool   PurchaseJojaMembership    { get; set; } = false;
        public string MoveBuildPermission       { get; set; } = "off";
    }
}
