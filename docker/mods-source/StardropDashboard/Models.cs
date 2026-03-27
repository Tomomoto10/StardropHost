using System.Collections.Generic;

namespace StardropDashboard
{
    public class LiveStatus
    {
        public long   Timestamp          { get; set; }
        public string ServerState        { get; set; } = "offline";
        public string FarmName           { get; set; } = "";
        public string Season             { get; set; } = "";
        public int    Day                { get; set; }
        public int    Year               { get; set; }
        public int    GameTimeMinutes    { get; set; }
        public string DayTimeFormatted   { get; set; } = "";
        public string Weather            { get; set; } = "";
        public bool   IsFestivalDay      { get; set; }
        public string FestivalName       { get; set; } = "";
        public int    SharedMoney        { get; set; }
        public List<PlayerData> Players  { get; set; } = new();
        public List<CabinData>  Cabins   { get; set; } = new();
    }

    public class PlayerData
    {
        public string Name          { get; set; } = "";
        public string UniqueId      { get; set; } = "";
        public bool   IsHost        { get; set; }
        public bool   IsOnline      { get; set; }
        public int    Health        { get; set; }
        public int    MaxHealth     { get; set; }
        public float  Stamina       { get; set; }
        public float  MaxStamina    { get; set; }
        public int    Money         { get; set; }
        public long   TotalEarned   { get; set; }
        public string LocationName  { get; set; } = "";
        public SkillData Skills     { get; set; } = new();
        public int    DaysPlayed    { get; set; }
    }

    public class SkillData
    {
        public int Farming  { get; set; }
        public int Mining   { get; set; }
        public int Foraging { get; set; }
        public int Fishing  { get; set; }
        public int Combat   { get; set; }
        public int Luck     { get; set; }
    }

    public class CabinData
    {
        public string OwnerName     { get; set; } = "";
        public bool   IsOwnerOnline { get; set; }
        public int    TileX         { get; set; }
        public int    TileY         { get; set; }
        public bool   IsUpgraded    { get; set; }
    }
}