using System;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;

namespace AutoHideHost
{
    /// <summary>AutoHideHost mod entry point - v1.2.2: LevelUpMenu auto-handling fully disabled</summary>
    public class ModEntry : Mod
    {
        private ModConfig Config;
        private bool isHostHidden = false;
        private bool hasTriggeredSleep = false;
        private bool needToSleep = false;
        private int sleepDelayTicks = 0;
        private bool isSleepInProgress = false;
        private bool handledReadyCheck = false;  // v1.4.0: Prevent handling the same ReadyCheck twice

        // v1.4.1: Always On Server auto-enable
        private bool alwaysOnServerChecked = false;
        private int alwaysOnServerCheckTicks = 0;
        private bool needToCheckAlwaysOnServer = false;

        // v1.1.8: Guard window — prevents host being warped to Farm when a player connects
        private DateTime? guardWindowEnd = null;
        private DateTime? lastRehideTime = null;
        private bool needRehide = false;
        private int rehideTicks = 0;

        // v1.2.0: Prevent infinite event-skip loops
        private string lastSkippedEventId = null;
        private DateTime? lastSkipTime = null;
        private int skipCooldownSeconds = 5;

        public override void Entry(IModHelper helper)
        {
            this.Config = helper.ReadConfig<ModConfig>();
            this.Monitor.Log($"AutoHideHost v{this.ModManifest.Version} loaded", LogLevel.Info);
            this.Monitor.Log($"Config: hide={Config.HideMethod}, pause={Config.PauseWhenEmpty}, instant-sleep={Config.InstantSleepWhenReady}", LogLevel.Info);

            helper.Events.GameLoop.SaveLoaded += OnSaveLoaded;
            helper.Events.GameLoop.DayStarted += OnDayStarted;
            helper.Events.GameLoop.UpdateTicked += OnUpdateTicked;
            helper.Events.GameLoop.Saving += OnSaving;
            helper.Events.Display.MenuChanged += OnMenuChanged;

            // v1.1.8: Guard window
            helper.Events.Multiplayer.PeerConnected += OnPeerConnected;
            helper.Events.Player.Warped += OnWarped;

            RegisterCommands();
        }

        private void OnSaveLoaded(object sender, SaveLoadedEventArgs e)
        {
            if (!Context.IsMainPlayer || !Config.Enabled)
                return;

            // v1.4.1: Schedule Always On Server check (delay 3s to let ServerAutoLoad set multiplayer mode)
            needToCheckAlwaysOnServer = true;
            alwaysOnServerCheckTicks = 0;
            alwaysOnServerChecked = false;
            this.Monitor.Log("Save loaded — checking Always On Server status in 3 seconds", LogLevel.Info);

            if (Config.AutoHideOnLoad)
            {
                HideHost();
                this.Monitor.Log("Host auto-hidden on load", LogLevel.Info);
            }
        }

        private void OnDayStarted(object sender, DayStartedEventArgs e)
        {
            if (!Context.IsMainPlayer || !Config.Enabled || !Config.AutoHideDaily)
                return;
            HideHost();
            hasTriggeredSleep = false;
            isSleepInProgress = false;
            handledReadyCheck = false;  // v1.4.0: Reset ReadyCheck flag

            // v1.2.0: Reset event-skip tracking
            lastSkippedEventId = null;
            lastSkipTime = null;

            // v1.1.9: Start guard window at day start (players may already be online)
            if (Config.PreventHostFarmWarp)
            {
                guardWindowEnd = DateTime.Now.AddSeconds(Config.PeerConnectGuardSeconds);
                this.Monitor.Log($"[GuardWindow] New day — guard window active for {Config.PeerConnectGuardSeconds}s", LogLevel.Info);
                LogDebug($"[GuardWindow] Window ends at: {guardWindowEnd:HH:mm:ss}");
            }

            LogDebug("New day — host re-hidden");
        }

        /// <summary>
        /// v1.4.0: Handle menu changes — auto-handle ShippingMenu and LevelUpMenu
        /// </summary>
        private void OnMenuChanged(object sender, MenuChangedEventArgs e)
        {
            if (!Context.IsMainPlayer || !Config.Enabled)
                return;

            // Reset ReadyCheck flag when a new menu appears
            if (e.OldMenu != null && e.OldMenu.GetType().Name == "ReadyCheckDialog")
            {
                handledReadyCheck = false;
            }

            if (e.NewMenu == null)
                return;

            string menuType = e.NewMenu.GetType().Name;
            this.Monitor.Log($"Menu changed: {e.OldMenu?.GetType().Name ?? "null"} → {menuType}", LogLevel.Debug);

            // 1. ShippingMenu — auto-click OK
            if (e.NewMenu is StardewValley.Menus.ShippingMenu shippingMenu)
            {
                this.Monitor.Log("ShippingMenu detected — auto-clicking OK", LogLevel.Info);
                try
                {
                    this.Helper.Reflection.GetMethod(shippingMenu, "okClicked").Invoke();
                    this.Monitor.Log("✓ ShippingMenu closed", LogLevel.Info);
                }
                catch (Exception ex)
                {
                    this.Monitor.Log($"Failed to close ShippingMenu: {ex.Message}", LogLevel.Error);
                }
                return;
            }

            // 2. LevelUpMenu — v1.2.2: DO NOT auto-handle
            // Reason: any auto-click triggers skill selection, causing host skills to auto-level to 10.
            // LevelUpMenu doesn't block game flow; host is hidden so players can't see it anyway.
            if (e.NewMenu is StardewValley.Menus.LevelUpMenu levelUpMenu)
            {
                this.Monitor.Log("LevelUpMenu detected — leaving visible (not auto-handled to avoid skill auto-level)", LogLevel.Info);
                return;
            }

            // 3. DialogueBox — handle blocking dialogues (quest notifications etc.)
            if (e.NewMenu is StardewValley.Menus.DialogueBox dialogueBox)
            {
                try
                {
                    var dialogue = this.Helper.Reflection.GetField<StardewValley.Dialogue>(
                        dialogueBox, "characterDialogue", required: false)?.GetValue();

                    string dialogueText = dialogue?.getCurrentDialogue() ?? "";

                    this.Monitor.Log($"DialogueBox content: {dialogueText.Substring(0, Math.Min(100, dialogueText.Length))}", LogLevel.Debug);

                    // Quest notification dialogue
                    if (dialogueText.Contains("Accept Quest") ||
                        dialogueText.Contains("accept") ||
                        dialogueText.Contains("lost") ||
                        dialogueText.Contains("find") ||
                        dialogueText.Contains("250g") ||
                        dialogueText.Contains("MISSING"))
                    {
                        this.Monitor.Log("Quest notification dialogue detected — auto-dismissing", LogLevel.Info);
                        dialogueBox.receiveKeyPress(Microsoft.Xna.Framework.Input.Keys.Escape);
                        Game1.activeClickableMenu = null;
                        this.Monitor.Log("✓ Quest notification dismissed", LogLevel.Info);
                        return;
                    }

                    // Non-quest dialogues — also close to avoid blocking game flow
                    this.Monitor.Log("Non-quest DialogueBox detected — auto-confirming via left click", LogLevel.Info);
                    dialogueBox.receiveKeyPress(Microsoft.Xna.Framework.Input.Keys.Escape);
                    Game1.activeClickableMenu = null;
                }
                catch (Exception ex)
                {
                    this.Monitor.Log($"Failed to handle DialogueBox: {ex.Message}", LogLevel.Debug);
                }
            }

            // 4. LetterViewerMenu — auto-close to avoid blocking sleep
            if (e.NewMenu is StardewValley.Menus.LetterViewerMenu letterMenu)
            {
                this.Monitor.Log("LetterViewerMenu detected — auto-closing", LogLevel.Info);
                try
                {
                    letterMenu.receiveKeyPress(Microsoft.Xna.Framework.Input.Keys.Escape);
                    Game1.activeClickableMenu = null;
                    this.Monitor.Log("✓ LetterViewerMenu closed", LogLevel.Info);
                }
                catch (Exception ex)
                {
                    this.Monitor.Log($"Failed to close LetterViewerMenu: {ex.Message}", LogLevel.Error);
                }
                return;
            }
        }

        /// <summary>
        /// v1.3.4: OnSaving — ensure host position is correct and handle menus
        /// </summary>
        private void OnSaving(object sender, SavingEventArgs e)
        {
            if (!Context.IsMainPlayer || !Config.Enabled)
                return;

            this.Monitor.Log($"OnSaving — current location: {Game1.player.currentLocation?.Name}", LogLevel.Info);
            this.Monitor.Log($"lastSleepLocation: {Game1.player.lastSleepLocation.Value}, lastSleepPoint: {Game1.player.lastSleepPoint.Value}", LogLevel.Info);

            // v1.3.4: If host is not in FarmHouse, force correct sleep/wake location
            if (Game1.player.currentLocation?.Name != "FarmHouse")
            {
                this.Monitor.Log($"Warning: host is at {Game1.player.currentLocation?.Name} — forcing sleep wake location", LogLevel.Warn);

                int bedX = 9, bedY = 9;
                int houseUpgradeLevel = Game1.player.HouseUpgradeLevel;
                if (houseUpgradeLevel == 1)
                {
                    bedX = 21; bedY = 4;
                }
                else if (houseUpgradeLevel >= 2)
                {
                    bedX = 27; bedY = 13;
                }

                Game1.player.lastSleepLocation.Value = "FarmHouse";
                Game1.player.lastSleepPoint.Value = new Point(bedX, bedY);
                this.Monitor.Log($"✓ Forced sleep wake location: FarmHouse ({bedX}, {bedY})", LogLevel.Info);
            }

            // Auto-click ShippingMenu OK
            if (Game1.activeClickableMenu is StardewValley.Menus.ShippingMenu)
            {
                this.Monitor.Log("ShippingMenu detected during save — auto-clicking OK", LogLevel.Info);
                try
                {
                    this.Helper.Reflection.GetMethod(Game1.activeClickableMenu, "okClicked").Invoke();
                    this.Monitor.Log("✓ ShippingMenu closed", LogLevel.Info);
                }
                catch (Exception ex)
                {
                    this.Monitor.Log($"Failed to close ShippingMenu: {ex.Message}", LogLevel.Error);
                }
            }

            // DialogueBox that appears after ShippingMenu closes
            if (Game1.activeClickableMenu is StardewValley.Menus.DialogueBox)
            {
                this.Monitor.Log("DialogueBox detected during save — auto-closing", LogLevel.Info);
                Game1.activeClickableMenu.receiveLeftClick(10, 10);
            }
        }

        private void OnUpdateTicked(object sender, UpdateTickedEventArgs e)
        {
            if (!Config.Enabled || !Context.IsMainPlayer)
                return;

            // v1.1.8: Delayed re-hide
            if (needRehide && rehideTicks > 0)
            {
                rehideTicks--;
                if (rehideTicks == 0)
                {
                    this.Monitor.Log("[GuardWindow] Executing re-hide", LogLevel.Info);
                    HideHost();
                    lastRehideTime = DateTime.Now;
                    needRehide = false;
                    this.Monitor.Log("[GuardWindow] ✓ Host re-hidden", LogLevel.Info);
                }
            }

            // v1.4.1: Check and auto-enable Always On Server
            if (needToCheckAlwaysOnServer && !alwaysOnServerChecked)
            {
                alwaysOnServerCheckTicks++;

                // Delay 180 ticks (3s) to give ServerAutoLoad time to set multiplayer mode
                if (alwaysOnServerCheckTicks >= 180)
                {
                    alwaysOnServerChecked = true;
                    needToCheckAlwaysOnServer = false;
                    CheckAndEnableAlwaysOnServer();
                }
            }

            // v1.4.0: Global menu and ready-state handling (every 0.5s)
            if (e.Ticks % 30 == 0)
            {
                // v1.4.0: Use Team Ready API
                try
                {
                    if (Game1.player?.team != null)
                    {
                        var readyCheckName = GetActiveReadyCheckName();

                        if (!string.IsNullOrEmpty(readyCheckName) && !handledReadyCheck)
                        {
                            this.Monitor.Log($"Active ReadyCheck detected: '{readyCheckName}'", LogLevel.Info);

                            try
                            {
                                var setReadyMethod = this.Helper.Reflection.GetMethod(
                                    Game1.player.team, "SetLocalReady", required: false);

                                if (setReadyMethod != null)
                                {
                                    setReadyMethod.Invoke(readyCheckName, true);
                                    this.Monitor.Log("✓ Host marked ready (SetLocalReady)", LogLevel.Info);
                                    handledReadyCheck = true;
                                }
                                else
                                {
                                    LogDebug("SetLocalReady not found — falling back to UI click");
                                    TryClickReadyCheckDialog();
                                }
                            }
                            catch (Exception ex)
                            {
                                this.Monitor.Log($"SetLocalReady failed: {ex.Message} — trying UI click", LogLevel.Debug);
                                TryClickReadyCheckDialog();
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    this.Monitor.Log($"ReadyCheck handling error: {ex.Message}", LogLevel.Trace);
                }

                // Auto-skip skippable events (v1.2.0: dedup + cooldown to prevent infinite loops)
                if (Game1.CurrentEvent != null && Game1.CurrentEvent.skippable)
                {
                    string currentEventId = Game1.CurrentEvent.id;
                    bool isSameEvent = (currentEventId == lastSkippedEventId);
                    bool inCooldown = false;

                    if (lastSkipTime.HasValue)
                    {
                        var timeSinceLastSkip = (DateTime.Now - lastSkipTime.Value).TotalSeconds;
                        inCooldown = timeSinceLastSkip < skipCooldownSeconds;

                        if (inCooldown && isSameEvent)
                        {
                            LogDebug($"[EventSkipCooldown] Event {currentEventId} handled {timeSinceLastSkip:F1}s ago — skipping");
                            return;
                        }
                    }

                    this.Monitor.Log($"Skipping skippable event: {currentEventId}", LogLevel.Info);
                    Game1.CurrentEvent.skipEvent();
                    lastSkippedEventId = currentEventId;
                    lastSkipTime = DateTime.Now;
                }
            }

            // v1.3.5: Maintain host sleep state during sleep transition
            if (isSleepInProgress)
            {
                if (!Game1.player.isInBed.Value || Game1.player.timeWentToBed.Value == 0)
                {
                    Game1.player.isInBed.Value = true;
                    Game1.player.timeWentToBed.Value = Game1.timeOfDay;
                    LogDebug("Maintaining host sleep state");
                }

                // v1.3.5: Force correct sleep location every tick
                if (Game1.player.lastSleepLocation.Value != "FarmHouse")
                {
                    int bedX = 9, bedY = 9;
                    int houseUpgradeLevel = Game1.player.HouseUpgradeLevel;
                    if (houseUpgradeLevel == 1)
                    {
                        bedX = 21; bedY = 4;
                    }
                    else if (houseUpgradeLevel >= 2)
                    {
                        bedX = 27; bedY = 13;
                    }

                    Game1.player.lastSleepLocation.Value = "FarmHouse";
                    Game1.player.lastSleepPoint.Value = new Point(bedX, bedY);
                    this.Monitor.Log($"Corrected sleep location during sleep: FarmHouse ({bedX}, {bedY})", LogLevel.Warn);
                }

                return;
            }

            // Delayed sleep logic
            if (needToSleep)
            {
                sleepDelayTicks++;
                if (sleepDelayTicks >= 1)
                {
                    ExecuteSleep();
                    needToSleep = false;
                    sleepDelayTicks = 0;
                }
                return;
            }

            if (e.Ticks % 15 == 0 && Config.InstantSleepWhenReady)
            {
                CheckAndAutoSleep();
            }

            if (e.Ticks % 60 == 0)
            {
                CheckAndAutoPause();
            }
        }

        private void HideHost()
        {
            if (!Context.IsMainPlayer)
                return;

            switch (Config.HideMethod.ToLower())
            {
                case "warp":
                    Game1.warpFarmer(Config.WarpLocation, Config.WarpX, Config.WarpY, false);
                    LogDebug($"Host warped to {Config.WarpLocation} ({Config.WarpX}, {Config.WarpY})");
                    break;
                case "invisible":
                    this.Monitor.Log("Invisible mode not available in v1.6 — using warp instead", LogLevel.Warn);
                    Game1.warpFarmer("Desert", 0, 0, false);
                    break;
                case "offmap":
                    Game1.player.Position = new Vector2(-999999, -999999);
                    LogDebug("Host moved off-map");
                    break;
                default:
                    Game1.warpFarmer("Desert", 0, 0, false);
                    break;
            }
            isHostHidden = true;
        }

        private void CheckAndAutoPause()
        {
            // v1.0.3: Auto-pause disabled — causes clients to fail connecting after server restart
            return;

            /*
            if (!Context.IsMainPlayer || !Config.PauseWhenEmpty || !Context.IsWorldReady)
                return;

            int onlineFarmhands = Game1.getOnlineFarmers()
                .Count(f => f.UniqueMultiplayerID != Game1.player.UniqueMultiplayerID);
            bool shouldPause = (onlineFarmhands == 0);

            if (shouldPause && !Game1.paused)
            {
                Game1.paused = true;
                this.Monitor.Log("No players online — server auto-paused", LogLevel.Info);
            }
            else if (!shouldPause && Game1.paused)
            {
                Game1.paused = false;
                hasTriggeredSleep = false;
                this.Monitor.Log($"{onlineFarmhands} player(s) online — server resumed", LogLevel.Info);
            }
            */
        }

        /// <summary>
        /// v1.2.2: Borrowed from Always On Server — uses startSleep()
        /// Key: startSleep is a method on the Location object, not Farmer
        /// </summary>
        private void CheckAndAutoSleep()
        {
            if (!Context.IsMainPlayer || !Config.InstantSleepWhenReady)
                return;

            if (!Context.IsWorldReady || hasTriggeredSleep || needToSleep)
                return;

            // Skip if a menu is open
            if (Game1.activeClickableMenu != null)
            {
                LogDebug($"[SleepCheck] Skipping — active menu: {Game1.activeClickableMenu.GetType().Name}");
                return;
            }

            var onlineFarmhands = Game1.getOnlineFarmers()
                .Where(f => f.UniqueMultiplayerID != Game1.player.UniqueMultiplayerID)
                .ToList();

            if (onlineFarmhands.Count == 0)
                return;

            try
            {
                bool allFarmhandsInBed = onlineFarmhands.All(farmer =>
                    farmer.isInBed.Value && farmer.timeWentToBed.Value > 0);

                if (!allFarmhandsInBed)
                    return;

                this.Monitor.Log($"All {onlineFarmhands.Count} player(s) in bed — triggering host sleep", LogLevel.Info);
                GoToBed();
                hasTriggeredSleep = true;
                this.Monitor.Log("✓ Host sleep sequence initiated", LogLevel.Info);
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"Error triggering sleep: {ex.Message}", LogLevel.Error);
                this.Monitor.Log($"Stack: {ex.StackTrace}", LogLevel.Debug);
            }
        }

        /// <summary>
        /// v1.3.2: Fix Desert wake-up issue — ensure host wakes in FarmHouse
        /// </summary>
        private void GoToBed()
        {
            try
            {
                int bedX, bedY;
                int houseUpgradeLevel = Game1.player.HouseUpgradeLevel;

                if (houseUpgradeLevel == 0)
                {
                    bedX = 9; bedY = 9;
                }
                else if (houseUpgradeLevel == 1)
                {
                    bedX = 21; bedY = 4;
                }
                else
                {
                    bedX = 27; bedY = 13;
                }

                this.Monitor.Log($"Warping host to FarmHouse bed ({bedX}, {bedY})", LogLevel.Info);
                PreventSleepEvents();
                isSleepInProgress = true;

                Game1.warpFarmer("FarmHouse", bedX, bedY, false);

                var startSleepMethod = this.Helper.Reflection.GetMethod(Game1.currentLocation, "startSleep");
                startSleepMethod.Invoke();

                // v1.3.3: Set sleep location AFTER startSleep() in case it overwrites it
                Game1.player.lastSleepLocation.Value = "FarmHouse";
                Game1.player.lastSleepPoint.Value = new Point(bedX, bedY);

                this.Monitor.Log("✓ startSleep() called", LogLevel.Info);
                this.Monitor.Log($"✓ Sleep wake location set: FarmHouse ({bedX}, {bedY})", LogLevel.Info);

                Game1.displayHUD = true;
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"GoToBed error: {ex.Message}", LogLevel.Error);
                this.Monitor.Log($"Stack: {ex.StackTrace}", LogLevel.Error);
            }
        }

        /// <summary>
        /// Mark common sleep-interrupting events as already seen to prevent them disrupting sleep
        /// </summary>
        private void PreventSleepEvents()
        {
            try
            {
                // Earthquake event (Spring 3) — most common cause of sleep disruption
                if (!Game1.player.eventsSeen.Contains("60367"))
                {
                    Game1.player.eventsSeen.Add("60367");
                    this.Monitor.Log("Prevented earthquake event (60367)", LogLevel.Info);
                }

                var commonSleepEvents = new[]
                {
                    "558291",  // Marnie letter event
                    "831125",  // Upgrade hint
                    "502261",  // Dream event
                    "26",      // Shane 1-heart event
                    "27",      // Shane 2-heart event
                    "733330",  // Other sleep event
                };

                foreach (var eventId in commonSleepEvents)
                {
                    if (!Game1.player.eventsSeen.Contains(eventId))
                    {
                        Game1.player.eventsSeen.Add(eventId);
                        this.Monitor.Log($"Prevented sleep event ({eventId})", LogLevel.Debug);
                    }
                }

                this.Monitor.Log("✓ Sleep event prevention complete", LogLevel.Info);
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"PreventSleepEvents error: {ex.Message}", LogLevel.Warn);
            }
        }

        /// <summary>
        /// Set bed position info without warping host (avoids warp-induced black-screen delay)
        /// </summary>
        private void PrepareToBed()
        {
            try
            {
                string homeLocationName = Game1.player.homeLocation.Value;
                this.Monitor.Log($"Host homeLocation: {homeLocationName}", LogLevel.Info);

                int bedX, bedY;
                int houseUpgradeLevel = Game1.player.HouseUpgradeLevel;
                this.Monitor.Log($"House upgrade level: {houseUpgradeLevel}", LogLevel.Info);

                if (houseUpgradeLevel == 0)
                {
                    bedX = 9; bedY = 9;
                }
                else if (houseUpgradeLevel == 1)
                {
                    bedX = 21; bedY = 4;
                }
                else
                {
                    bedX = 27; bedY = 13;
                }

                this.Monitor.Log($"Setting bed position: {homeLocationName} ({bedX}, {bedY})", LogLevel.Info);
                Game1.player.mostRecentBed = new Microsoft.Xna.Framework.Vector2(bedX * 64, bedY * 64);
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"PrepareToBed error: {ex.Message}", LogLevel.Error);
            }
        }

        /// <summary>
        /// Execute sleep: v1.1.5 — warp host to bed and simulate clicking it
        /// </summary>
        private void ExecuteSleep()
        {
            try
            {
                this.Monitor.Log("=== v1.1.5: Executing sleep sequence ===", LogLevel.Info);

                string homeLocationName = Game1.player.homeLocation.Value;
                int bedX, bedY;
                int houseUpgradeLevel = Game1.player.HouseUpgradeLevel;

                if (houseUpgradeLevel == 0)
                {
                    bedX = 9; bedY = 9;
                }
                else if (houseUpgradeLevel == 1)
                {
                    bedX = 21; bedY = 4;
                }
                else
                {
                    bedX = 27; bedY = 13;
                }

                this.Monitor.Log($"House level {houseUpgradeLevel}, bed at: ({bedX}, {bedY})", LogLevel.Info);
                PreventSleepEvents();

                if (Game1.activeClickableMenu != null)
                {
                    this.Monitor.Log($"Closing menu: {Game1.activeClickableMenu.GetType().Name}", LogLevel.Debug);
                    Game1.activeClickableMenu = null;
                }

                this.Monitor.Log($"Warping host from {Game1.currentLocation.Name} to {homeLocationName}", LogLevel.Info);
                Game1.warpFarmer(homeLocationName, bedX, bedY, false);

                void HandleAfterWarp(object s, EventArgs ev)
                {
                    try
                    {
                        this.Monitor.Log("Warp complete — looking for bed object...", LogLevel.Debug);

                        var farmHouse = Game1.currentLocation as StardewValley.Locations.FarmHouse;
                        if (farmHouse != null)
                        {
                            var bed = farmHouse.furniture.FirstOrDefault(f =>
                                f is StardewValley.Objects.BedFurniture &&
                                f.TileLocation.X == bedX &&
                                f.TileLocation.Y == bedY);

                            if (bed != null)
                            {
                                this.Monitor.Log($"Found bed: {bed.GetType().Name} at ({bedX}, {bedY})", LogLevel.Info);

                                var bedFurniture = bed as StardewValley.Objects.BedFurniture;
                                if (bedFurniture != null)
                                {
                                    bool clicked = bedFurniture.checkForAction(Game1.player, false);
                                    this.Monitor.Log($"Simulated bed click: {clicked}", LogLevel.Info);
                                }
                            }
                            else
                            {
                                this.Monitor.Log($"× Bed not found at ({bedX}, {bedY}) — using fallback", LogLevel.Warn);
                                this.Monitor.Log($"FarmHouse furniture count: {farmHouse.furniture.Count}", LogLevel.Debug);

                                // Fallback: set sleep state directly
                                Game1.player.isInBed.Value = true;
                                Game1.player.timeWentToBed.Value = Game1.timeOfDay;
                                Game1.player.lastSleepLocation.Value = homeLocationName;
                                Game1.player.lastSleepPoint.Value = new Microsoft.Xna.Framework.Point(bedX, bedY);
                                this.Monitor.Log("Fallback: sleep state set directly", LogLevel.Warn);
                            }
                        }
                        else
                        {
                            this.Monitor.Log("× Current location is not FarmHouse", LogLevel.Error);
                        }

                        isSleepInProgress = true;
                        this.Helper.Events.GameLoop.UpdateTicked -= HandleAfterWarp;
                    }
                    catch (Exception ex)
                    {
                        this.Monitor.Log($"HandleAfterWarp error: {ex.Message}", LogLevel.Error);
                        this.Monitor.Log($"Stack: {ex.StackTrace}", LogLevel.Error);
                        this.Helper.Events.GameLoop.UpdateTicked -= HandleAfterWarp;
                    }
                }

                this.Helper.Events.GameLoop.UpdateTicked += HandleAfterWarp;
                this.Monitor.Log("✓ Warp triggered — bed click will execute next tick", LogLevel.Info);
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"ExecuteSleep error: {ex.Message}", LogLevel.Error);
                this.Monitor.Log($"Stack: {ex.StackTrace}", LogLevel.Error);
            }
        }

        private void ShowHost()
        {
            if (!Context.IsMainPlayer)
                return;
            Game1.warpFarmer("Farm", 64, 15, false);
            Game1.player.temporarilyInvincible = false;
            isHostHidden = false;
            this.Monitor.Log("Host shown on Farm", LogLevel.Debug);
        }

        private void RegisterCommands()
        {
            this.Helper.ConsoleCommands.Add("hidehost",       "Immediately hide the host",         OnCommand_HideHost);
            this.Helper.ConsoleCommands.Add("showhost",       "Show the host",                      OnCommand_ShowHost);
            this.Helper.ConsoleCommands.Add("togglehost",     "Toggle host visibility",             OnCommand_ToggleHost);
            this.Helper.ConsoleCommands.Add("autohide_status","Show mod status",                    OnCommand_Status);
            this.Helper.ConsoleCommands.Add("autohide_reload","Reload config",                      OnCommand_Reload);
        }

        private void OnCommand_HideHost(string command, string[] args)
        {
            if (!Context.IsMainPlayer)
            {
                this.Monitor.Log("Only the host can run this command", LogLevel.Error);
                return;
            }
            HideHost();
            this.Monitor.Log("Host hidden", LogLevel.Info);
        }

        private void OnCommand_ShowHost(string command, string[] args)
        {
            if (!Context.IsMainPlayer)
            {
                this.Monitor.Log("Only the host can run this command", LogLevel.Error);
                return;
            }
            ShowHost();
            this.Monitor.Log("Host shown", LogLevel.Info);
        }

        private void OnCommand_ToggleHost(string command, string[] args)
        {
            if (!Context.IsMainPlayer)
            {
                this.Monitor.Log("Only the host can run this command", LogLevel.Error);
                return;
            }
            if (isHostHidden)
                ShowHost();
            else
                HideHost();
        }

        private void OnCommand_Status(string command, string[] args)
        {
            this.Monitor.Log("=== AutoHideHost Status ===", LogLevel.Info);
            this.Monitor.Log($"Version: {this.ModManifest.Version}", LogLevel.Info);
            this.Monitor.Log($"Enabled: {Config.Enabled}", LogLevel.Info);
            this.Monitor.Log($"Host hidden: {isHostHidden}", LogLevel.Info);
            if (Context.IsWorldReady)
            {
                int onlinePlayers = Game1.getOnlineFarmers()
                    .Count(f => f.UniqueMultiplayerID != Game1.player.UniqueMultiplayerID);
                int totalCabins = Game1.otherFarmers.Count();
                this.Monitor.Log($"Online players: {onlinePlayers} (total cabins: {totalCabins})", LogLevel.Info);
                this.Monitor.Log($"Game paused: {Game1.paused}", LogLevel.Info);
            }
            this.Monitor.Log($"Hide method: {Config.HideMethod}", LogLevel.Info);
            this.Monitor.Log($"Auto-pause: {Config.PauseWhenEmpty}", LogLevel.Info);
            this.Monitor.Log($"Instant sleep: {Config.InstantSleepWhenReady}", LogLevel.Info);
        }

        private void OnCommand_Reload(string command, string[] args)
        {
            this.Config = this.Helper.ReadConfig<ModConfig>();
            this.Monitor.Log("Config reloaded", LogLevel.Info);
            OnCommand_Status(command, args);
        }

        /// <summary>
        /// v1.4.0: Get the name of the currently active ReadyCheck (e.g. "sleep")
        /// </summary>
        private string GetActiveReadyCheckName()
        {
            try
            {
                if (Game1.activeClickableMenu != null &&
                    Game1.activeClickableMenu.GetType().Name == "ReadyCheckDialog")
                {
                    var idField = this.Helper.Reflection.GetField<string>(
                        Game1.activeClickableMenu, "checkId", required: false);

                    if (idField != null)
                        return idField.GetValue();

                    var altField = this.Helper.Reflection.GetField<string>(
                        Game1.activeClickableMenu, "readyCheckId", required: false);

                    if (altField != null)
                        return altField.GetValue();

                    return "sleep"; // Most common case
                }

                return null;
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"GetActiveReadyCheckName failed: {ex.Message}", LogLevel.Trace);
                return null;
            }
        }

        /// <summary>
        /// v1.4.0: Fallback — click ReadyCheckDialog via UI
        /// </summary>
        private void TryClickReadyCheckDialog()
        {
            try
            {
                if (Game1.activeClickableMenu == null ||
                    Game1.activeClickableMenu.GetType().Name != "ReadyCheckDialog")
                    return;

                var okButton = this.Helper.Reflection.GetField<object>(
                    Game1.activeClickableMenu, "okButton", required: false)?.GetValue();

                if (okButton is StardewValley.Menus.ClickableTextureComponent button)
                {
                    Game1.activeClickableMenu.receiveLeftClick(
                        button.bounds.Center.X,
                        button.bounds.Center.Y,
                        true);
                    this.Monitor.Log("✓ ReadyCheckDialog clicked via reflection", LogLevel.Info);
                    handledReadyCheck = true;
                    return;
                }

                // Last resort: estimated coordinates
                Game1.activeClickableMenu.receiveLeftClick(640, 460, true);
                this.Monitor.Log("✓ ReadyCheckDialog clicked via estimated coordinates (fallback)", LogLevel.Info);
                handledReadyCheck = true;
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"TryClickReadyCheckDialog failed: {ex.Message}", LogLevel.Error);
            }
        }

        /// <summary>
        /// v1.4.1: Check and auto-enable Always On Server
        /// </summary>
        private void CheckAndEnableAlwaysOnServer()
        {
            try
            {
                if (!Game1.IsServer)
                {
                    this.Monitor.Log("Not in server mode — skipping Always On Server check", LogLevel.Debug);
                    return;
                }

                var alwaysOnServerMod = this.Helper.ModRegistry.Get("mikko.Always_On_Server");
                if (alwaysOnServerMod == null)
                {
                    this.Monitor.Log("Always On Server mod not detected", LogLevel.Warn);
                    return;
                }

                this.Monitor.Log("Always On Server mod detected", LogLevel.Info);
                this.Monitor.Log("Attempting to auto-enable Always On Server mode...", LogLevel.Info);

                bool enabledViaReflection = false;
                try
                {
                    var loadedMods = this.Helper.Reflection.GetField<System.Collections.Generic.IDictionary<string, object>>(
                        this.Helper.ModRegistry,
                        "Mods",
                        required: false);

                    if (loadedMods != null)
                    {
                        var modsDict = loadedMods.GetValue();
                        if (modsDict != null && modsDict.ContainsKey("mikko.Always_On_Server"))
                        {
                            var modMetadata = modsDict["mikko.Always_On_Server"];
                            var modField = this.Helper.Reflection.GetProperty<object>(modMetadata, "Mod", required: false);

                            if (modField != null)
                            {
                                var modInstance = modField.GetValue();
                                if (modInstance != null)
                                {
                                    var isEnabledField = this.Helper.Reflection.GetField<bool>(modInstance, "IsEnabled", required: false);
                                    if (isEnabledField != null)
                                    {
                                        isEnabledField.SetValue(true);
                                        this.Monitor.Log("✓ Always On Server enabled via reflection", LogLevel.Info);

                                        if (Game1.chatBox != null)
                                            Game1.chatBox.addInfoMessage("The Host is in Server Mode!");

                                        enabledViaReflection = true;
                                    }
                                }
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    this.Monitor.Log($"Reflection method failed: {ex.Message}", LogLevel.Debug);
                }

                if (!enabledViaReflection)
                {
                    this.Monitor.Log("Reflection not available — trying simulated key press...", LogLevel.Info);
                    try
                    {
                        var keyboardState = Microsoft.Xna.Framework.Input.Keyboard.GetState();
                        this.Helper.Reflection.GetMethod(Game1.game1, "checkForEscapeKeys").Invoke();
                        System.Threading.Thread.Sleep(100);
                        this.Monitor.Log("Simulated key press sent to enable Always On Server", LogLevel.Info);
                        enabledViaReflection = true;
                    }
                    catch (Exception ex)
                    {
                        this.Monitor.Log($"Simulated key press failed: {ex.Message}", LogLevel.Debug);
                    }
                }

                if (!enabledViaReflection)
                {
                    ShowManualEnableInstructions();
                }
                else
                {
                    this.Monitor.Log("✓ Auto-pause enabled (pauses when empty, resumes when players join)", LogLevel.Info);
                }
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"CheckAndEnableAlwaysOnServer error: {ex.Message}", LogLevel.Error);
            }
        }

        private void ShowManualEnableInstructions()
        {
            this.Monitor.Log("Could not auto-enable Always On Server", LogLevel.Warn);
            this.Monitor.Log("To enable manually: press F9 in-game or set ServerMode=true in Always On Server config", LogLevel.Info);
        }

        private void OnPeerConnected(object sender, PeerConnectedEventArgs e)
        {
            if (!Context.IsMainPlayer || !Config.Enabled || !Config.PreventHostFarmWarp)
                return;

            guardWindowEnd = DateTime.Now.AddSeconds(Config.PeerConnectGuardSeconds);
            this.Monitor.Log($"[GuardWindow] Player connected — guard window active for {Config.PeerConnectGuardSeconds}s", LogLevel.Info);
        }

        private void OnWarped(object sender, WarpedEventArgs e)
        {
            if (!Context.IsMainPlayer || !Config.Enabled || !Config.PreventHostFarmWarp)
                return;

            if (!e.IsLocalPlayer)
                return;

            this.Monitor.Log($"[WarpMonitor] {e.OldLocation?.Name} → {e.NewLocation?.Name}", LogLevel.Debug);

            // If host warps to Farm during guard window, re-hide them
            if (e.NewLocation?.Name == "Farm" && guardWindowEnd.HasValue && DateTime.Now < guardWindowEnd)
            {
                this.Monitor.Log($"[GuardWindow] Host warped to Farm during guard window — scheduling re-hide", LogLevel.Info);

                // Debounce: don't re-hide more than once per second
                if (!lastRehideTime.HasValue || (DateTime.Now - lastRehideTime.Value).TotalSeconds >= 1)
                {
                    needRehide = true;
                    rehideTicks = Config.RehideDelayTicks;
                }
                else
                {
                    LogDebug("[GuardWindow] Re-hide debounced");
                }
            }
        }

        private void LogDebug(string message)
        {
            if (Config.DebugMode)
                this.Monitor.Log(message, LogLevel.Debug);
        }
    }
}
