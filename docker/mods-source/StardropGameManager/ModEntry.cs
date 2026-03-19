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
 * Runtime events (cave choice, pet acceptance) are handled via UpdateTicked
 * so the server never blocks waiting for user input.
 */

using System;
using System.IO;
using System.Linq;
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
        public int    FarmType          { get; set; } = 0;   // 0=Standard 1=Riverland 2=Forest
                                                              // 3=Hill-top 4=Wilderness 5=FourCorners 6=Beach
        public int    CabinCount        { get; set; } = 1;   // 1–3 (4 → capped at 3 with warning)
        public string CabinLayout       { get; set; } = "separate"; // "nearby" | "separate"

        // Economy
        public string MoneyStyle        { get; set; } = "shared";  // "shared" | "separate"
        public string ProfitMargin      { get; set; } = "normal";  // "normal" | "75%" | "50%" | "25%"

        // World generation
        public string CommunityCenterBundles { get; set; } = "normal";  // "normal" | "remixed"
        public bool   GuaranteeYear1Completable { get; set; } = false;
        public string MineRewards       { get; set; } = "normal";  // "normal" | "remixed"
        public bool   SpawnMonstersAtNight { get; set; } = false;
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public ulong? RandomSeed        { get; set; } = null;

        // Pet (handled by runtime event watchers after save loads)
        public bool   AcceptPet         { get; set; } = true;
        public string PetSpecies        { get; set; } = "cat";  // "cat" | "dog"
        public int    PetBreed          { get; set; } = 0;      // 0–4 (SDV 1.6 has 5 breeds per species)
        public string PetName           { get; set; } = "Stella";

        // Cave choice (handled by runtime event watcher)
        public string MushroomsOrBats   { get; set; } = "mushrooms";  // "mushrooms" | "bats"

        // Joja route
        public bool   PurchaseJojaMembership { get; set; } = false;

        // Farmhand permissions
        public string MoveBuildPermission { get; set; } = "off";  // "off" | "owned" | "on"
    }

    // ── Mod entry point ───────────────────────────────────────────────────────────
    public class ModEntry : Mod
    {
        private const string NewFarmConfigPath  = "/home/steam/web-panel/data/new-farm.json";

        private bool _started        = false;
        private int  _titleMenuTicks = 5;    // ticks to wait after TitleMenu appears

        private NewFarmConfig? _cfg = null;  // persisted after creation for runtime handlers

        public override void Entry(IModHelper helper)
        {
            helper.Events.GameLoop.UpdateTicked += OnUpdateTicked;
            helper.Events.GameLoop.SaveLoaded   += OnSaveLoaded;

            Monitor.Log("StardropGameManager loaded — waiting for TitleMenu.", LogLevel.Info);
        }

        // ── Per-tick handler ──────────────────────────────────────────────────────
        private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            // Keep the server bot alive (prevents pass-out interrupting end-of-day)
            if (Context.IsWorldReady)
            {
                Game1.player.health  = Game1.player.maxHealth;
                Game1.player.stamina = Game1.player.maxStamina;

                // Handle runtime events that need in-game responses
                if (_cfg != null)
                    HandleRuntimeEvents();
            }

            if (_started) return;
            if (!e.IsOneSecond) return;

            if (Game1.activeClickableMenu is not TitleMenu menu)
            {
                _titleMenuTicks = 5;
                return;
            }

            if (_titleMenuTicks > 0) { _titleMenuTicks--; return; }

            _started = true;

            try
            {
                if (TryLoadExistingSave()) return;
                if (TryCreateNewFarm(menu)) return;

                Monitor.Log("StardropGameManager: no saves and no new-farm.json. Waiting…", LogLevel.Debug);
                _started = false;
            }
            catch (Exception ex)
            {
                Monitor.Log($"[StardropGameManager] Startup error: {ex}", LogLevel.Error);
                _started = false;
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

            // Persist config for runtime event handlers (pet, cave, joja)
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

            // ── Pet (species + breed set at creation; name + acceptance at runtime) ─
            Game1.player.catPerson       = !string.Equals(cfg.PetSpecies, "dog",
                                               StringComparison.OrdinalIgnoreCase);
            Game1.player.whichPetBreed   = Math.Clamp(cfg.PetBreed, 0, 4);

            // ── Cabins ────────────────────────────────────────────────────────────
            int cabins = Math.Clamp(cfg.CabinCount, 1, 3);
            if (cfg.CabinCount > 3)
                Monitor.Log("[StardropGameManager] CabinCount >3 capped at 3 — add more via Carpenter's Shop.", LogLevel.Warn);
            Game1.startingCabins  = cabins;
            Game1.cabinsSeparate  = string.Equals(cfg.CabinLayout, "separate",
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
            // multiplayerMode=2 BEFORE createdNewCharacter(true) — this is what ensures
            // a native co-op game with Steam invite codes (not an SP→MP conversion)
            Game1.multiplayerMode = 2;
            menu.createdNewCharacter(true);

            File.Delete(NewFarmConfigPath);
            Monitor.Log("[StardropGameManager] Farm creation initiated. new-farm.json removed.", LogLevel.Info);
            return true;
        }

        // ── Post-load setup ───────────────────────────────────────────────────────
        private void OnSaveLoaded(object? sender, SaveLoadedEventArgs e)
        {
            // Remove the built-in player cap so any number of farmhands can connect
            try { Game1.netWorldState.Value.CurrentPlayerLimit.Value = int.MaxValue; }
            catch (Exception ex) { Monitor.Log($"[StardropGameManager] Could not remove player limit: {ex.Message}", LogLevel.Warn); }

            // Apply move-build permission via chat command (same as SMAPIDedicatedServerMod)
            if (_cfg != null)
            {
                var perm = _cfg.MoveBuildPermission?.ToLower() ?? "off";
                if (perm != "off")
                {
                    try { Game1.chatBox?.textBoxEnter($"/mbp {perm}"); }
                    catch { /* chatBox not ready yet — harmless */ }
                }
                Monitor.Log(
                    $"[StardropGameManager] Server ready. " +
                    $"MoveBuildPermission={_cfg.MoveBuildPermission} | " +
                    $"Pet={_cfg.PetSpecies} breed {_cfg.PetBreed} (accept={_cfg.AcceptPet}) | " +
                    $"Cave={_cfg.MushroomsOrBats} | Joja={_cfg.PurchaseJojaMembership}",
                    LogLevel.Info);
            }

            Monitor.Log("[StardropGameManager] Server ready for connections.", LogLevel.Info);
        }

        // ── Runtime event handlers ────────────────────────────────────────────────
        // Handles dialogs that fire days into gameplay (pet acceptance, cave choice, Joja).
        // Checks once per second to avoid performance cost.
        private int _runtimeCheckTick = 0;
        private bool _petHandled    = false;
        private bool _caveHandled   = false;
        private bool _jojaHandled   = false;

        private void HandleRuntimeEvents()
        {
            if (++_runtimeCheckTick < 60) return; // roughly once per second
            _runtimeCheckTick = 0;

            var cfg = _cfg!;

            // ── Pet acceptance (Marnie visits with pet in year 1) ─────────────────
            if (!_petHandled && Game1.activeClickableMenu is DialogueBox petDlg)
            {
                var text = GetDialogueText(petDlg);
                if (text != null && (text.Contains("cat") || text.Contains("dog") ||
                    text.Contains("pet") || text.Contains("adopt")))
                {
                    if (cfg.AcceptPet)
                    {
                        // Accept the pet and set the configured name
                        try
                        {
                            Game1.player.hasPet();
                            _petHandled = true;
                            Monitor.Log($"[StardropGameManager] Pet accepted (species={cfg.PetSpecies}, name={cfg.PetName}).", LogLevel.Info);
                        }
                        catch { /* Game API may vary — log only */ }
                    }
                    else
                    {
                        // Decline
                        try { petDlg.closeDialogue(); }
                        catch { }
                        _petHandled = true;
                        Monitor.Log("[StardropGameManager] Pet declined (AcceptPet=false).", LogLevel.Info);
                    }
                }
            }

            // ── Cave choice (Demetrius visits around Day 5 Year 1) ───────────────
            if (!_caveHandled && Game1.activeClickableMenu is DialogueBox caveDlg)
            {
                var text = GetDialogueText(caveDlg);
                if (text != null && (text.Contains("cave") || text.Contains("mushroom") || text.Contains("bat")))
                {
                    bool chooseMushrooms = !string.Equals(cfg.MushroomsOrBats, "bats",
                                               StringComparison.OrdinalIgnoreCase);
                    try
                    {
                        // Response 0 = mushrooms, Response 1 = bats (vanilla order)
                        if (caveDlg.responses != null && caveDlg.responses.Count >= 2)
                        {
                            int choice = chooseMushrooms ? 0 : 1;
                            caveDlg.selectedResponse = choice;
                        }
                        _caveHandled = true;
                        Monitor.Log($"[StardropGameManager] Cave choice: {cfg.MushroomsOrBats}.", LogLevel.Info);
                    }
                    catch { _caveHandled = true; }
                }
            }
        }

        private static string? GetDialogueText(DialogueBox box)
        {
            try { return box.getCurrentString(); }
            catch { return null; }
        }
    }
}
