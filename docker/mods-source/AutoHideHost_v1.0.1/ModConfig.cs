namespace AutoHideHost
{
    public class ModConfig
    {
        public bool Enabled { get; set; } = true;
        public bool AutoHideOnLoad { get; set; } = true;
        public bool AutoHideDaily { get; set; } = true;
        public bool PauseWhenEmpty { get; set; } = false;  // Default false — pausing breaks client reconnects
        public bool InstantSleepWhenReady { get; set; } = true;
        public string HideMethod { get; set; } = "warp";
        public string WarpLocation { get; set; } = "Desert";
        public int WarpX { get; set; } = 0;
        public int WarpY { get; set; } = 0;
        public bool DebugMode { get; set; } = true;

        // v1.1.8: Guard window — prevents host being warped to Farm when a player connects
        public bool PreventHostFarmWarp { get; set; } = true;
        public int PeerConnectGuardSeconds { get; set; } = 30;
        public int RehideDelayTicks { get; set; } = 1;
        public bool DebugTraceMenus { get; set; } = false;
    }
}
