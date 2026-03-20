/**
 * StardropHost | mods-source/StardropGameManager/ModEntry.cs
 *
 * Headless co-op startup orchestrator.
 *
 * Boot sequence (priority order):
 *   1. LOAD  — saves exist → load most-recent (or SAVE_NAME env) as co-op host
 *   2. CREATE — no saves, new-farm.json present → create native co-op farm
 *   3. WAIT  — neither condition met → keep polling until wizard writes config
 *
 * Farm creation follows CoopMenu.HostNewFarmSlot (multiplayerMode=2 set BEFORE
 * menu.createdNewCharacter(true)) so Steam invite codes are generated correctly.
 * Save loading follows CoopMenu.HostFileSlot (multiplayerMode=2 BEFORE SaveGame.Load).
 *
 * Runtime events (cave choice, pet acceptance, pet naming) are handled via
 * UpdateTicked so the server never blocks waiting for user input.
 *
 * Dialogue handling mirrors SMAPIDedicatedServerMod ProcessDialogueBehaviorLink:
 *   - Question dialogues: match response text, set selectedResponse, receiveLeftClick
 *   - NamingMenu: reflection to set textBox.Text, RecieveCommandInput('\r')
 */

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Menus;

namespace StardropGameManager
{
    // ── Config model ──────────────────────────────────────────────────────────────
    // All fields match the wizard new-farm.json (written by wizard.js submitNewFarm)
    internal sealed class NewFarmConfig
    {
        // Identity
        public string FarmName          { get; set; } = "Stardrop Farm";
        public string FarmerName        { get; set; } = "Host";
        public string FavoriteThing     { get; set; } = "Farming";

        // Farm layout
        public int    FarmType          { get; set; } = 0;
        public int    CabinCount        { get; set; } = 1;
        public string CabinLayout       { get; set; } = "separate";

        // Economy
        public string MoneyStyle        { get; set; } = "shared";
        public string ProfitMargin      { get; set; } = "normal";

        // World generation
        public string CommunityCenterBundles    { get; set; } = "normal";
        public bool   GuaranteeYear1Completable { get; set; } = false;
        public string MineRewards       { get; set; } = "normal";
        public bool   SpawnMonstersAtNight { get; set; } = false;
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public ulong? RandomSeed        { get; set; } = null;

        // Pet
        public bool   AcceptPet         { get; set; } = true;
        public string PetSpecies        { get; set; } = "cat";
        public int    PetBreed          { get; set; } = 0;
        public string PetName           { get; set; } = "Stella";

        // Cave choice
        public string MushroomsOrBats   { get; set; } = "mushrooms";

        // Joja route
        public bool   PurchaseJojaMembership { get; set; } = false;

        // Farmhand permissions
        public string MoveBuildPermission { get; set; } = "off";
    }

    // ── Mod entry point ───────────────────────────────────────────────────────────
    public class ModEntry : Mod
    {
        private const string NewFarmConfigPath = "/home/steam/web-panel/data/new-farm.json";

        // Reflection cache for NamingMenu.textBox (used for pet name entry)
        private static readonly FieldInfo NamingMenuTextBoxField =
            typeof(NamingMenu).GetField("textBox", BindingFlags.NonPublic | BindingFlags.Instance)!;

        // WaitCondition: require TitleMenu to be active for N consecutive ticks
        private bool _farmStageEnabled = false;
        private readonly WaitCondition _titleMenuCondition =
            new WaitCondition(() => Game1.activeClickableMenu is TitleMenu, 5);

        // Persisted after farm creation / save load for runtime handlers
        private NewFarmConfig? _cfg = null;

        // Runtime event flags — each handled only once per server session
        private bool _petHandled    = false;
        private bool _caveHandled   = false;
        private int  _runtimeTick   = 0;

        public override void Entry(IModHelper helper)
        {
            helper.Events.GameLoop.UpdateTicked += OnUpdateTicked;
            helper.Events.GameLoop.SaveLoaded   += OnSaveLoaded;
            Monitor.Log("StardropGameManager loaded — waiting for TitleMenu.", LogLevel.Info);
        }

        // ── Per-tick handler ──────────────────────────────────────────────────────
        private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            // Keep server bot alive (prevents pass-out blocking end-of-day)
            if (Context.IsWorldReady)
            {
                Game1.player.health  = Game1.player.maxHealth;
                Game1.player.stamina = Game1.player.maxStamina.Value;
            }

            // Once world is ready, handle any blocking runtime dialogues
            if (Context.IsWorldReady && _cfg != null)
            {
                if (++_runtimeTick >= 60) // ~once per second
                {
                    _runtimeTick = 0;
                    HandleRuntimeDialogues();
                }
            }

            // Farm stage: wait until TitleMenu is stable, then run once
            if (!_farmStageEnabled && _titleMenuCondition.IsMet())
            {
                _farmStageEnabled = true;
                RunFarmStage();
            }
        }

        // ── Farm stage — called once after TitleMenu is stable ────────────────────
        private void RunFarmStage()
        {
            if (Game1.activeClickableMenu is not TitleMenu menu)
            {
                // TitleMenu disappeared between IsMet() and here — retry next tick
                _farmStageEnabled = false;
                _titleMenuCondition.Reset();
                return;
            }

            try
            {
                if (TryLoadExistingSave()) return;
                if (TryCreateNewFarm(menu)) return;

                // Neither condition met — reset and keep polling
                Monitor.Log("[StardropGameManager] No saves and no new-farm.json. Waiting…", LogLevel.Debug);
                _farmStageEnabled = false;
                _titleMenuCondition.Reset();
            }
            catch (Exception ex)
            {
                Monitor.Log($"[StardropGameManager] Startup error: {ex}", LogLevel.Error);
                _farmStageEnabled = false;
                _titleMenuCondition.Reset();
            }
        }

        // ── Load an existing save as co-op host ───────────────────────────────────
        // Pattern: CoopMenu.HostFileSlot — multiplayerMode=2 BEFORE SaveGame.Load
        private bool TryLoadExistingSave()
        {
            var savesPath = Constants.SavesPath;
            if (!Directory.Exists(savesPath)) return false;

            string? slotName;
            var requestedName = Environment.GetEnvironmentVariable("SAVE_NAME");

            if (!string.IsNullOrWhiteSpace(requestedName))
            {
                slotName = Directory.GetDirectories(savesPath)
                    .Select(Path.GetFileName)
                    .FirstOrDefault(d => d != null &&
                        (d.Equals(requestedName, StringComparison.OrdinalIgnoreCase) ||
                         d.StartsWith(requestedName + "_", StringComparison.OrdinalIgnoreCase)));

                if (slotName == null)
                    Monitor.Log($"[StardropGameManager] SAVE_NAME='{requestedName}' not found. Falling back to most-recent.", LogLevel.Warn);
            }
            else
            {
                slotName = null;
            }

            slotName ??= Directory.GetDirectories(savesPath)
                .Where(Directory.Exists)
                .OrderByDescending(Directory.GetLastWriteTimeUtc)
                .Select(Path.GetFileName)
                .FirstOrDefault();

            if (slotName == null) return false;

            Monitor.Log($"[StardropGameManager] Loading save '{slotName}' as co-op host.", LogLevel.Info);
            Game1.multiplayerMode = 2;
            SaveGame.Load(slotName);
            Game1.exitActiveMenu();
            return true;
        }

        // ── Create a new native co-op farm ────────────────────────────────────────
        // Pattern: CoopMenu.HostNewFarmSlot — multiplayerMode=2 BEFORE createdNewCharacter(true)
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
                Monitor.Log($"[StardropGameManager] Failed to parse new-farm.json: {ex.Message}", LogLevel.Error);
                File.Delete(NewFarmConfigPath);
                return false;
            }

            if (cfg == null)
            {
                Monitor.Log("[StardropGameManager] new-farm.json deserialised to null — skipping.", LogLevel.Warn);
                File.Delete(NewFarmConfigPath);
                return false;
            }

            Monitor.Log(
                $"[StardropGameManager] Creating new co-op farm '{cfg.FarmName}' " +
                $"(type={cfg.FarmType}, cabins={cfg.CabinCount}, pet={cfg.PetSpecies}/{cfg.PetBreed})",
                LogLevel.Info);

            // Persist config for runtime event handlers
            _cfg = cfg;

            // ── Reset player state (mirrors CoopMenu.HostNewFarmSlot) ─────────────
            Game1.resetPlayer();

            // ── Identity ──────────────────────────────────────────────────────────
            Game1.player.Name                = cfg.FarmerName;
            Game1.player.displayName         = cfg.FarmerName;
            Game1.player.farmName.Value      = cfg.FarmName;
            Game1.player.favoriteThing.Value = string.IsNullOrWhiteSpace(cfg.FavoriteThing)
                                                    ? "Farming" : cfg.FavoriteThing;
            Game1.player.isCustomized.Value  = true;

            // ── Pet ───────────────────────────────────────────────────────────────
            Game1.player.whichPetType  = string.Equals(cfg.PetSpecies, "dog",
                                             StringComparison.OrdinalIgnoreCase) ? "dog" : "cat";
            Game1.player.whichPetBreed = cfg.PetBreed.ToString();

            // ── Cabins ────────────────────────────────────────────────────────────
            int cabins = Math.Clamp(cfg.CabinCount, 1, 4);
            if (cfg.CabinCount > 4)
                Monitor.Log("[StardropGameManager] CabinCount >4 capped at 4.", LogLevel.Warn);
            Game1.startingCabins = cabins;
            Game1.cabinsSeparate = string.Equals(cfg.CabinLayout, "separate",
                                        StringComparison.OrdinalIgnoreCase);

            // ── Economy ───────────────────────────────────────────────────────────
            Game1.player.team.useSeparateWallets.Value =
                string.Equals(cfg.MoneyStyle, "separate", StringComparison.OrdinalIgnoreCase);

            Game1.player.difficultyModifier = cfg.ProfitMargin switch
            {
                "75%"  => 0.75f,
                "50%"  => 0.50f,
                "25%"  => 0.25f,
                _      => 1.00f,
            };

            // ── Farm type ─────────────────────────────────────────────────────────
            Game1.whichFarm = Math.Clamp(cfg.FarmType, 0, 6);

            // ── World generation ──────────────────────────────────────────────────
            Game1.bundleType = string.Equals(cfg.CommunityCenterBundles, "remixed",
                                   StringComparison.OrdinalIgnoreCase)
                               ? Game1.BundleType.Remixed : Game1.BundleType.Default;

            Game1.game1.SetNewGameOption("MineChests",
                string.Equals(cfg.MineRewards, "remixed", StringComparison.OrdinalIgnoreCase)
                    ? Game1.MineChestType.Remixed : Game1.MineChestType.Default);

            Game1.game1.SetNewGameOption("YearOneCompletable", cfg.GuaranteeYear1Completable);

            Game1.spawnMonstersAtNight = cfg.SpawnMonstersAtNight;
            Game1.game1.SetNewGameOption("SpawnMonstersAtNight", cfg.SpawnMonstersAtNight);

            if (cfg.RandomSeed.HasValue)
                Game1.startingGameSeed = cfg.RandomSeed;

            // ── Trigger native co-op farm creation ────────────────────────────────
            // multiplayerMode=2 BEFORE createdNewCharacter(true) — ensures a proper
            // co-op game with Steam invite codes (not an SP→MP conversion).
            Game1.multiplayerMode = 2;
            menu.createdNewCharacter(true);

            File.Delete(NewFarmConfigPath);
            Monitor.Log("[StardropGameManager] Farm creation initiated. new-farm.json removed.", LogLevel.Info);
            return true;
        }

        // ── Post-load setup ───────────────────────────────────────────────────────
        private void OnSaveLoaded(object? sender, SaveLoadedEventArgs e)
        {
            // Remove built-in player cap so any number of farmhands can connect
            try { Game1.netWorldState.Value.CurrentPlayerLimit = int.MaxValue; }
            catch (Exception ex) { Monitor.Log($"[StardropGameManager] Could not remove player limit: {ex.Message}", LogLevel.Warn); }

            // Apply move-build permission via chat command
            if (_cfg != null)
            {
                var perm = _cfg.MoveBuildPermission?.ToLowerInvariant() ?? "off";
                if (perm != "off")
                {
                    try { (Game1.chatBox as ChatBox)?.textBoxEnter($"/mbp {perm}"); }
                    catch { /* chatBox not ready — harmless */ }
                }
                Monitor.Log(
                    $"[StardropGameManager] Server ready. " +
                    $"MoveBuildPermission={_cfg.MoveBuildPermission} | " +
                    $"Pet={_cfg.PetSpecies}/{_cfg.PetBreed} (accept={_cfg.AcceptPet}) | " +
                    $"Cave={_cfg.MushroomsOrBats} | Joja={_cfg.PurchaseJojaMembership}",
                    LogLevel.Info);
            }

            Monitor.Log("[StardropGameManager] Server ready for connections.", LogLevel.Info);
        }

        // ── Runtime dialogue handler ──────────────────────────────────────────────
        // Handles blocking menus that appear mid-gameplay: pet question, pet naming,
        // cave choice. Mirrors SMAPIDedicatedServerMod ProcessDialogueBehaviorLink.
        private void HandleRuntimeDialogues()
        {
            if (Game1.activeClickableMenu == null) return;
            var cfg = _cfg!;

            // ── DialogueBox (question menus) ──────────────────────────────────────
            if (Game1.activeClickableMenu is DialogueBox db && db.isQuestion && db.responses != null)
            {
                int mushroomsIdx = -1, batsIdx = -1, yesIdx = -1, noIdx = -1;
                for (int i = 0; i < db.responses.Count(); i++)
                {
                    var text = db.responses[i].responseText?.ToLowerInvariant() ?? "";
                    if (text == "mushrooms") mushroomsIdx = i;
                    else if (text == "bats")  batsIdx = i;
                    else if (text == "yes")   yesIdx  = i;
                    else if (text == "no")    noIdx   = i;
                }

                // Cave question (Demetrius ~Day 5 Year 1)
                if (!_caveHandled && mushroomsIdx >= 0 && batsIdx >= 0)
                {
                    db.selectedResponse = string.Equals(cfg.MushroomsOrBats, "bats",
                        StringComparison.OrdinalIgnoreCase) ? batsIdx : mushroomsIdx;
                    db.receiveLeftClick(0, 0);
                    _caveHandled = true;
                    Monitor.Log($"[StardropGameManager] Cave choice: {cfg.MushroomsOrBats}.", LogLevel.Info);
                }
                // Pet question (Marnie ~Day 3 Year 1)
                else if (!_petHandled && yesIdx >= 0 && noIdx >= 0)
                {
                    db.selectedResponse = cfg.AcceptPet ? yesIdx : noIdx;
                    db.receiveLeftClick(0, 0);
                    if (!cfg.AcceptPet) _petHandled = true;
                    Monitor.Log($"[StardropGameManager] Pet question answered (accept={cfg.AcceptPet}).", LogLevel.Info);
                }
            }

            // ── NamingMenu (pet name entry, appears after accepting pet) ──────────
            if (!_petHandled && Game1.activeClickableMenu is NamingMenu nm)
            {
                try
                {
                    var textBox = NamingMenuTextBoxField.GetValue(nm) as TextBox;
                    if (textBox != null)
                    {
                        textBox.Text = string.IsNullOrWhiteSpace(cfg.PetName) ? "Stella" : cfg.PetName;
                        textBox.RecieveCommandInput('\r');
                        _petHandled = true;
                        Monitor.Log($"[StardropGameManager] Pet named '{cfg.PetName}'.", LogLevel.Info);
                    }
                }
                catch (Exception ex)
                {
                    Monitor.Log($"[StardropGameManager] Pet naming failed: {ex.Message}", LogLevel.Warn);
                    _petHandled = true; // don't get stuck
                }
            }
        }

        // ── WaitCondition helper ──────────────────────────────────────────────────
        private sealed class WaitCondition
        {
            private readonly Func<bool> _condition;
            private readonly int        _initialWait;
            private int                 _counter;

            public WaitCondition(Func<bool> condition, int initialWait)
            {
                _condition   = condition;
                _initialWait = initialWait;
                _counter     = initialWait;
            }

            /// <summary>Returns true once the condition has been continuously met for
            /// <c>initialWait</c> consecutive ticks.</summary>
            public bool IsMet()
            {
                if (_counter <= 0 && _condition()) return true;
                _counter--;
                return false;
            }

            public void Reset() => _counter = _initialWait;
        }
    }
}
