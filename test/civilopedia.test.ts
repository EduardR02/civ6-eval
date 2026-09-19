import { expect, test } from "bun:test";
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from "fengari";
import { parse } from "luaparse";

// lua/civilopedia.lua reads the *loaded* native Civilopedia screen: its cache, its page
// layouts and the active locale. These tests pin the facts a wrong implementation would get
// wrong silently:
//
//   * a page is produced by the real layout builder for its PageLayoutId, not by a
//     hand-written per-family extractor, so leader/civ abilities (including inherited traits
//     and attached unique units/infrastructure), unit/building costs and requirements, tech
//     unlocks and plain concept pages all come through the same path;
//   * localized text is resolved at call time, so a mod's replacement (Better Balanced Game's
//     LOC_TRAIT_LEADER_TRAJANS_COLUMN_DESCRIPTION rewrite) is what the reader returns;
//   * narrative/flavor chapters are dropped by native ChapterId (HISTORY/CAPSULE) and the
//     geography/social stat box by its native title key - never by matching English words;
//   * the reader never touches the live screen (no Controls/UIManager/instance call), and a
//     layout that reaches for the screen fails visibly instead of mutating it;
//   * the page id repeats across sections (INTRO), so an ambiguous id is reported with its
//     candidates instead of resolving to whichever section happens to be first;
//   * hidden pedia entries (CivilopediaPageExcludes, e.g. BBG's dummy resource) are invisible
//     because the reader searches the native cache rather than the raw ruleset tables;
//   * unsupported layouts, missing native helpers and failing builders are reported with the
//     captured prefix labelled partial, and every swapped global reads back afterwards.
//
// The fixture below models the *contracts* of the installed support file and page builders
// (Base/Assets/UI/Civilopedia/CivilopediaSupport.lua and CivilopediaPage_*.lua). It is not the
// game's source, and a pass here proves what the reader asked the native screen for and how it
// shaped the answer - not how a live game would render every page.
const [shimSource, commonSource, moduleSource] = await Promise.all(
  ["test/lua/shim.lua", "lua/common.lua", "lua/civilopedia.lua"].map(path => Bun.file(path).text()),
);


const FIXTURE = `
-- =====================================================================================
-- CivilopediaScreen fixture: a portable model of the installed Civilopedia contracts.
--
-- Reproduced faithfully:
--   * CacheData's exclusion rules and cache shape (_Sections/_PagesBySection/_PagesById/
--     _ChaptersByPageLayout/_PageLayoutScriptTemplates/PageLayouts) and the accessor contract
--     GetSections/GetPages/GetPage/GetPageChapters/GetChapterHeader/GetChapterBody with the
--     Find*TextKey key patterns and the generic LOC_PEDIA_PAGE_CHAPTER_*_TITLE headers
--     (Base/Assets/Text/en_US/Civilopedia_Text.xml:69-77).
--   * The layout-helper contract of CivilopediaSupport.lua:1441-1794, including the "header and
--     paragraphs are both required" guards and the two-column inference that decides whether
--     AddHeaderBody reaches a renderer at all.
--   * Every helper MUTATES recorded UI state (STUB_UI_TOUCHES) and the _PageContentLayout
--     global exactly like the shipped helpers, so a call the reader fails to intercept is
--     visible to the tests instead of silently passing.
--   * Page builders for FrontPage, Simple, Leader, Civilization, Unit and Technology keeping
--     the shipped call shapes (GameInfo iteration, stat boxes with ':' methods, chapter loop,
--     LocalizeAndSetText). Where a shipped builder is abridged (belief/espionage scan,
--     modifier-derived stats) the fixture says so; layouts it does not re-implement go through
--     the same generic path in the reader.
--   * Pages produced by the shipped SQL PageQueries arrive here as ordinary page rows: the
--     reader itself never runs SQL, only the cache the screen already built.
-- =====================================================================================

STUB_UI_TOUCHES = {}
local function touch(name)
  STUB_UI_TOUCHES[#STUB_UI_TOUCHES + 1] = name
end
function STUB_RESET()
  STUB_UI_TOUCHES = {}
  _PageContentLayout = nil
end

-- -------------------------------------------------------------------------------------
-- Locale (active locale en_US, with mod replacements applied on top)
-- -------------------------------------------------------------------------------------
STUB_LANGUAGE = "en_US"
STUB_TEXT = {
  LOC_PEDIA_CONCEPTS_TITLE = "Concepts",
  LOC_PEDIA_LEADERS_TITLE = "Leaders",
  LOC_PEDIA_CIVILIZATIONS_TITLE = "Civilizations",
  LOC_PEDIA_UNITS_TITLE = "Units",
  LOC_PEDIA_TECHNOLOGIES_TITLE = "Technologies",
  LOC_PEDIA_RESOURCES_TITLE = "Resources",

  LOC_PEDIA_PAGE_CHAPTER_HISTORY_TITLE = "Historical Context",
  LOC_PEDIA_PAGE_CHAPTER_CAPSULE_TITLE = "Summary",
  LOC_PEDIA_PAGE_CHAPTER_DETAILED_TITLE = "Detailed Approach",
  LOC_PEDIA_PAGE_CHAPTER_INTRO_TITLE = "Introduction",

  LOC_PEDIA_CONCEPTS_GETTING_STARTED_TITLE = "Getting Started",
  LOC_PEDIA_PAGE_INTRO_TITLE = "Introduction",
  LOC_PEDIA_CONCEPTS_PAGE_CITIES_1_CHAPTER_CONTENT_TITLE = "Cities",
  LOC_PEDIA_CONCEPTS_PAGE_NUKES_1_CHAPTER_CONTENT_TITLE = "Nuclear Weapons",

  LOC_LEADER_TRAJAN_NAME = "Trajan",
  LOC_LEADER_MINOR_CIV_ATHENS_NAME = "Athens",
  LOC_CIVILIZATION_ROME_NAME = "Rome",
  LOC_CIVILIZATION_ATHENS_NAME = "Athens",
  LOC_UNIT_ROMAN_LEGION_NAME = "Roman Legion",
  LOC_UNIT_ROMAN_LEGION_DESCRIPTION = "Roman unique melee unit.",
  LOC_UNIT_ROMAN_VETERAN_NAME = "Roman Veteran",
  LOC_UNIT_INFANTRY_NAME = "Infantry",
  LOC_UNIT_ROMAN_VETERAN_DESCRIPTION = "Veteran legionaries.",
  LOC_UNIT_INFANTRY_DESCRIPTION = "Industrial era melee unit.",
  LOC_PEDIA_UNITS_PAGE_UNIT_ROMAN_VETERAN_CHAPTER_CONTENT_BODY = "Veteran legionaries hold the line. (mechanics)",
  LOC_PEDIA_UNITS_PAGE_UNIT_ROMAN_VETERAN_CHAPTER_HISTORY_PARA_1 = "The veteran cohort was the backbone. (narrative history)",
  LOC_DISTRICT_BATHS_NAME = "Bath",
  LOC_DISTRICT_BATHS_DESCRIPTION = "Roman replacement for the Aqueduct. (mechanics)",
  LOC_TECH_WRITING_NAME = "Writing",
  LOC_TECH_PHILOSOPHY_NAME = "Philosophy",
  LOC_TECHNOLOGY_NAME = "Technology",
  LOC_BUILDING_NAME = "Building",
  LOC_BUILDING_LIBRARY_NAME = "Library",
  LOC_BUILDING_RUHR_VALLEY_NAME = "Ruhr Valley",
  LOC_BUILDING_RUHR_VALLEY_DESCRIPTION = "+20% [ICON_Production] Production in this city. (wonder effect)",
  LOC_BUILDING_RUHR_VALLEY_QUOTE = "The industrial heart of Germany. (flavor quote)",
  LOC_DISTRICT_CAMPUS_NAME = "Campus",
  LOC_UI_PEDIA_BASE_COST = "Base Cost: {1_Amount} {2_YieldIcon} {3_YieldName}",

  LOC_TRAIT_LEADER_TRAJANS_COLUMN_NAME = "Trajan's Column",
  LOC_TRAIT_LEADER_TRAJANS_COLUMN_DESCRIPTION = "All cities start with an additional City Center building. (base ruleset text)",
  LOC_TRAIT_CIVILIZATION_ALL_ROADS_TO_ROME_NAME = "All Roads Lead to Rome",
  LOC_TRAIT_CIVILIZATION_ALL_ROADS_TO_ROME_DESCRIPTION = "All cities start with a Trading Post. (base ruleset text)",
  LOC_TRAIT_MINOR_CIV_MILITARISTIC_NAME = "Militaristic",
  LOC_TRAIT_MINOR_CIV_MILITARISTIC_DESCRIPTION = "This city-state maintains a standing army. (inherited trait text)",

  LOC_AGENDA_OPTIMUS_PRINCEPS_NAME = "Optimus Princeps",
  LOC_AGENDA_OPTIMUS_PRINCEPS_DESCRIPTION = "Likes civilizations with large empires.",
  LOC_RELIGION_CATHOLICISM_NAME = "Catholicism",

  LOC_PEDIA_LEADER_TRAJAN_GEOGRAPHY_HEADER = "Geography",
  LOC_PEDIA_LEADER_TRAJAN_GEOGRAPHY_CAPTION = "Rome, Italy",
  LOC_LEADER_TRAJAN_QUOTE = "Divide and conquer!",

  LOC_UI_PEDIA_TRAITS = "Traits",
  LOC_UI_PEDIA_SPECIAL_UNITS = "Special Units",
  LOC_UI_PEDIA_SPECIAL_INFRASTRUCTURE = "Special Infrastructure",
  LOC_UI_PEDIA_CIVILIZATIONS = "Civilizations",
  LOC_UI_PEDIA_LEADERS = "Leaders",
  LOC_UI_PEDIA_PREFERENCES = "Preferences",
  LOC_UI_PEDIA_AGENDAS = "Agendas",
  LOC_UI_PEDIA_PREFERRED_RELIGION = "Preferred Religion",
  LOC_UI_PEDIA_GEOGRAPHY_AND_SOCIAL_DATA = "Geography and Social Data",
  LOC_UI_PEDIA_UNIQUE_ABILITY = "Unique Ability",
  LOC_UI_PEDIA_DESCRIPTION = "Description",
  LOC_UI_PEDIA_REQUIREMENTS = "Requirements",
  LOC_UI_PEDIA_PRODUCTION_COST = "Production Cost",
  LOC_UI_PEDIA_PURCHASE_COST = "Purchase Cost",
  LOC_UI_PEDIA_MAITENANCE_COST = "Maintenance Cost",
  LOC_UI_PEDIA_MOVEMENT_POINTS = "Movement Points",
  LOC_UI_PEDIA_MELEE_STRENGTH = "Melee Strength",
  LOC_UI_PEDIA_UNIQUE_TO = "Unique To",
  LOC_UI_PEDIA_RESEARCH_COST = "Research Cost",
  LOC_UI_PEDIA_UNLOCKS = "Unlocks",
  LOC_UI_PEDIA_LEADS_TO_TECHS = "Leads To",
  LOC_UI_PEDIA_PROGRESSION = "Progression",
  LOC_UI_PEDIA_UPGRADES_TO = "Upgrades To",
  LOC_UI_PEDIA_REPLACED_BY = "Replaced By",
  LOC_UI_PEDIA_REQUIRED_TECHNOLOGIES = "Required Technologies",
  LOC_UI_PEDIA_USAGE_CAN_CONSTRUCT = "Can Construct",
  LOC_UI_PEDIA_USAGE = "Usage",
  LOC_UI_PEDIA_BOOSTS = "Boost",

  LOC_PEDIA_SEARCH_TERM_NUCLEAR = "Atomic weapons",
  LOC_PEDIA_SEARCH_TERM_THERMONUCLEAR = "Fusion bombs",

  LOC_PEDIA_CONCEPTS_PAGE_INTRO_CHAPTER_INTRO_PARA_1 = "This encyclopedia describes the rules in play. (front page)",
  LOC_PEDIA_CONCEPTS_PAGE_CITIES_1_CHAPTER_CONTENT_PARA_1 = "Cities are founded by Settlers. (mechanics)",
  LOC_PEDIA_CONCEPTS_PAGE_CITIES_1_CHAPTER_CONTENT_PARA_2 = string.rep("City mechanics filler. ", 160),
  LOC_PEDIA_CONCEPTS_PAGE_NUKES_1_CHAPTER_CONTENT_PARA_1 = "Nuclear devices are delivered by projects. (mechanics)",
  LOC_PEDIA_PAGE_CHAPTER_VOLCANOES_TITLE = "Volcanoes",
  LOC_PEDIA_CONCEPTS_PAGE_DISASTERS_1_CHAPTER_VOLCANOES_BODY = "Volcanic eruptions damage tiles and units. (mechanics)",
  LOC_PEDIA_CONCEPTS_PAGE_DISASTERS_1_CHAPTER_HISTORY_PARA_1 = "Vesuvius erupted in 79 AD. (narrative history)",

  LOC_PEDIA_LEADERS_PAGE_LEADER_TRAJAN_CHAPTER_CAPSULE_BODY = "Rome is the one civilization you can trust. (flavor)",
  LOC_PEDIA_LEADERS_PAGE_LEADER_TRAJAN_CHAPTER_DETAILED_BODY = "Rome wants to get cities down quickly. (playstyle overview)",
  LOC_PEDIA_LEADERS_PAGE_LEADER_TRAJAN_CHAPTER_HISTORY_PARA_1 = "The Emperor Trajan took the empire to its apex. (narrative history)",
  LOC_PEDIA_LEADERS_PAGE_LEADER_TRAJAN_CHAPTER_HISTORY_PARA_2 = "Born in the Roman province of Hispania Baetica. (narrative history)",
  LOC_PEDIA_LEADERS_PAGE_LEADER_MINOR_CIV_ATHENS_CHAPTER_HISTORY_PARA_1 = "Athens was a city-state. (narrative history)",

  LOC_PEDIA_CIVILIZATIONS_PAGE_CIVILIZATION_ROME_CHAPTER_DETAILED_BODY = "Rome expands by conquest and roads. (playstyle overview)",
  LOC_PEDIA_CIVILIZATIONS_PAGE_CIVILIZATION_ROME_CHAPTER_HISTORY_PARA_1 = "According to legend, Rome was founded in 753 BC. (narrative history)",
  LOC_PEDIA_UNITS_PAGE_UNIT_ROMAN_LEGION_CHAPTER_HISTORY_PARA_1 = "The legion evolved from the manipular army. (narrative history)",
  LOC_PEDIA_TECHNOLOGIES_PAGE_TECH_WRITING_CHAPTER_HISTORY_PARA_1 = "Writing appeared independently in several places. (narrative history)",
}
STUB_OVERRIDES = {}
function STUB_MOD_BBG()
  -- The Better Balanced Game mod replaces this tag in its own localization file
  -- (workshop content 2865001760 lang/english.xml): the ability text differs from the ruleset's.
  STUB_OVERRIDES["LOC_TRAIT_LEADER_TRAJANS_COLUMN_DESCRIPTION"] =
    "All founded cities receive a free building in the City Center after unlocking Early Empire."
end

local function interpolate(template, ...)
  local args = { ... }
  return (template:gsub("{(%d+)_[^}]*}", function(index)
    local value = args[tonumber(index)]
    if value == nil then return "" end
    return tostring(value)
  end))
end
Locale = {}
function Locale.Lookup(key, ...)
  local template = STUB_OVERRIDES[key] or STUB_TEXT[key]
  if template == nil then return key end
  if select("#", ...) > 0 then return interpolate(template, ...) end
  return template
end
function Locale.HasTextKey(key) return STUB_OVERRIDES[key] ~= nil or STUB_TEXT[key] ~= nil end
function Locale.StripTags(value) return (tostring(value):gsub("%[[^%]]*%]", "")) end
function Locale.Compare(left, right)
  if left == right then return 0 end
  return left < right and -1 or 1
end
function Locale.ToLower(value) return string.lower(value) end
function Locale.ToUpper(value) return string.upper(value) end
function Locale.GetCurrentLanguage() return STUB_LANGUAGE end

-- -------------------------------------------------------------------------------------
-- Live screen: every access is recorded, so an intercepted layout cannot hide a mutation.
-- -------------------------------------------------------------------------------------
-- A control and its members are both touchable: reading a member records it and yields a child
-- control, calling one records the call. So Controls.PageContentFrame:SetHide(true) is recorded
-- from the screen table down, and a reader that passes a live control around is visible.
local function control(name)
  return setmetatable({}, {
    __index = function(_, member)
      touch(name..":"..member)
      return control(name..":"..member)
    end,
    __call = function() touch(name.."()") end,
  })
end
Controls = setmetatable({}, { __index = function(_, field)
  touch("Controls."..field)
  return control("Controls."..field)
end })
UI = setmetatable({}, { __index = function(_, member)
  touch("UI."..member)
  return function() touch("UI."..member.."()") end
end })
UIManager = {
  DequeuePopup = function() touch("UIManager:DequeuePopup") end,
  QueuePopup = function() touch("UIManager:QueuePopup") end,
}
InstanceManager = { new = function()
  touch("InstanceManager:new")
  return {
    GetInstance = function() touch("InstanceManager:GetInstance"); return control("Instance") end,
    ResetInstances = function() touch("InstanceManager:ResetInstances") end,
  }
end }
ContextPtr = control("ContextPtr")
Input = { GetActionId = function() touch("Input:GetActionId"); return 0 end }
Mouse = { eLClick = 0, eMouseEnter = 1 }
Keys = {}
LuaEvents = { Add = function() touch("LuaEvents:Add") end }
Events = { Add = function() touch("Events:Add") end }
GameEvents = { Add = function() touch("GameEvents:Add") end }

local function localizeAndSet(value)
  if type(value) == "string" and Locale.HasTextKey(value) then return Locale.Lookup(value) end
  return value
end

-- -------------------------------------------------------------------------------------
-- Ruleset tables. Only the columns the fixture's builders read are present (the real rows
-- carry more); Index is assigned the way the engine's rows carry it.
-- -------------------------------------------------------------------------------------
local function rows(list, keyField)
  local byIndex, byKey = {}, {}
  for index, row in ipairs(list) do
    if row.Index == nil then row.Index = index end
    byIndex[row.Index] = row
    if keyField then byKey[row[keyField]] = row end
  end
  return setmetatable(list, {
    __call = function()
      local position = 0
      -- The engine's GameInfo iterators yield the row alone (native code writes
      -- "for row in GameInfo.X() do"), never an index/row pair.
      return function()
        position = position + 1
        return list[position]
      end
    end,
    __index = function(_, key)
      if type(key) == "number" then return byIndex[key] end
      return byKey[key]
    end,
  })
end

STUB_DB = {
  CivilopediaSections = {
    { SectionId = "CONCEPTS", Name = "LOC_PEDIA_CONCEPTS_TITLE", Icon = "ICON_CIVILOPEDIA_CONCEPTS", SortIndex = 0 },
    { SectionId = "CIVILIZATIONS", Name = "LOC_PEDIA_CIVILIZATIONS_TITLE", Icon = "ICON_CIVILOPEDIA_CIVILIZATIONS", SortIndex = 10 },
    { SectionId = "LEADERS", Name = "LOC_PEDIA_LEADERS_TITLE", Icon = "ICON_CIVILOPEDIA_LEADERS", SortIndex = 20 },
    { SectionId = "DISTRICTS", Name = "LOC_PEDIA_DISTRICTS_TITLE", Icon = "ICON_CIVILOPEDIA_DISTRICTS", SortIndex = 35 },
    { SectionId = "UNITS", Name = "LOC_PEDIA_UNITS_TITLE", Icon = "ICON_CIVILOPEDIA_UNITS", SortIndex = 40 },
    { SectionId = "WONDERS", Name = "LOC_PEDIA_WONDERS_TITLE", Icon = "ICON_CIVILOPEDIA_WONDERS", SortIndex = 45 },
    { SectionId = "TECHNOLOGIES", Name = "LOC_PEDIA_TECHNOLOGIES_TITLE", Icon = "ICON_CIVILOPEDIA_TECHNOLOGIES", SortIndex = 50 },
    { SectionId = "RESOURCES", Name = "LOC_PEDIA_RESOURCES_TITLE", Icon = "ICON_CIVILOPEDIA_RESOURCES", SortIndex = 60 },
  },
  CivilopediaPages = {
    { SectionId = "CONCEPTS", PageId = "INTRO", PageLayoutId = "FrontPage", Name = "LOC_PEDIA_CONCEPTS_GETTING_STARTED_TITLE", SortIndex = 0 },
    { SectionId = "CONCEPTS", PageId = "CITIES_1", PageGroupId = "CITIES", PageLayoutId = "Simple", Name = "LOC_PEDIA_CONCEPTS_PAGE_CITIES_1_CHAPTER_CONTENT_TITLE", SortIndex = 10 },
    { SectionId = "CONCEPTS", PageId = "NUKES_1", PageGroupId = "NUKES", PageLayoutId = "Simple", Name = "LOC_PEDIA_CONCEPTS_PAGE_NUKES_1_CHAPTER_CONTENT_TITLE", SortIndex = 20 },
    { SectionId = "CONCEPTS", PageId = "DISASTERS_1", PageGroupId = "DISASTERS", PageLayoutId = "EnvironmentalEffects",
      Name = "LOC_PEDIA_PAGE_INTRO_TITLE", SortIndex = 21 },
    { SectionId = "CONCEPTS", PageId = "MOD_PANEL", PageLayoutId = "ModControls", Name = "LOC_PEDIA_PAGE_INTRO_TITLE", SortIndex = 30 },
    { SectionId = "CONCEPTS", PageId = "MOD_SILENT", PageLayoutId = "ModSilent", Name = "LOC_PEDIA_PAGE_INTRO_TITLE", SortIndex = 29 },
    { SectionId = "CONCEPTS", PageId = "MOD_BROKEN", PageLayoutId = "ModBroken", Name = "LOC_PEDIA_PAGE_INTRO_TITLE", SortIndex = 31 },
    { SectionId = "CONCEPTS", PageId = "MOD_HELPER", PageLayoutId = "ModHelper", Name = "LOC_PEDIA_PAGE_INTRO_TITLE", SortIndex = 32 },
    { SectionId = "CONCEPTS", PageId = "GHOST", PageLayoutId = "Ghost", Name = "LOC_PEDIA_PAGE_INTRO_TITLE", SortIndex = 33 },
    { SectionId = "CONCEPTS", PageId = "NOWHERE", PageLayoutId = "Unregistered", Name = "LOC_PEDIA_PAGE_INTRO_TITLE", SortIndex = 34 },
    { SectionId = "LEADERS", PageId = "INTRO", PageLayoutId = "Simple", Name = "LOC_PEDIA_PAGE_INTRO_TITLE", SortIndex = 0 },
    { SectionId = "LEADERS", PageId = "LEADER_TRAJAN", PageLayoutId = "Leader", Name = "LOC_LEADER_TRAJAN_NAME", SortIndex = 10 },
    { SectionId = "LEADERS", PageId = "LEADER_MINOR_CIV_ATHENS", PageLayoutId = "Leader", Name = "LOC_LEADER_MINOR_CIV_ATHENS_NAME", SortIndex = 20 },
    { SectionId = "CIVILIZATIONS", PageId = "CIVILIZATION_ROME", PageLayoutId = "Civilization", Name = "LOC_CIVILIZATION_ROME_NAME", SortIndex = 10 },
    { SectionId = "UNITS", PageId = "INTRO", PageLayoutId = "Simple", Name = "LOC_PEDIA_PAGE_INTRO_TITLE", SortIndex = 0 },
    { SectionId = "DISTRICTS", PageId = "DISTRICT_BATHS", PageLayoutId = "Simple", Name = "LOC_DISTRICT_BATHS_NAME", SortIndex = 10 },
    { SectionId = "UNITS", PageId = "UNIT_ROMAN_LEGION", PageGroupId = "FORMATION_CLASS_LAND_COMBAT", PageLayoutId = "Unit", Name = "LOC_UNIT_ROMAN_LEGION_NAME", SortIndex = 10 },
    { SectionId = "WONDERS", PageId = "BUILDING_RUHR_VALLEY", PageGroupId = "Wonders", PageLayoutId = "Building",
      Name = "LOC_BUILDING_RUHR_VALLEY_NAME", SortIndex = 10 },
    { SectionId = "TECHNOLOGIES", PageId = "TECH_WRITING", PageGroupId = "ERA_ANCIENT", PageLayoutId = "Technology", Name = "LOC_TECH_WRITING_NAME", SortIndex = 10 },
    { SectionId = "UNITS", PageId = "UNIT_ROMAN_VETERAN", PageGroupId = "FORMATION_CLASS_LAND_COMBAT", PageLayoutId = "UnitNoBuilder", Name = "LOC_UNIT_ROMAN_VETERAN_NAME", SortIndex = 20 },
    { SectionId = "RESOURCES", PageId = "BBG_DUMMY_RESOURCE_MACEDON", PageLayoutId = "Simple", Name = "LOC_PEDIA_PAGE_INTRO_TITLE", SortIndex = 10 },
  },
  CivilopediaPageLayouts = {
    { PageLayoutId = "FrontPage", ScriptTemplate = "FrontPage" },
    { PageLayoutId = "Simple", ScriptTemplate = "Simple" },
    { PageLayoutId = "Leader", ScriptTemplate = "Leader" },
    { PageLayoutId = "Civilization", ScriptTemplate = "Civilization" },
    { PageLayoutId = "Unit", ScriptTemplate = "Unit" },
    { PageLayoutId = "Technology", ScriptTemplate = "Technology" },
    { PageLayoutId = "Building", ScriptTemplate = "Building" },
    -- A GS-only layout: Expansion2/Data/Expansion2_Civilopedia.xml registers it the same way.
    { PageLayoutId = "EnvironmentalEffects", ScriptTemplate = "EnvironmentalEffects" },
    -- Registered template with no builder in PageLayouts: a mod page whose page file is missing.
    { PageLayoutId = "UnitNoBuilder", ScriptTemplate = "UnitNoBuilder" },
    { PageLayoutId = "Ghost", ScriptTemplate = "GhostPage" },
    { PageLayoutId = "ModSilent", ScriptTemplate = "ModSilent" },
    { PageLayoutId = "ModControls", ScriptTemplate = "ModControls" },
    { PageLayoutId = "ModBroken", ScriptTemplate = "ModBroken" },
    { PageLayoutId = "ModHelper", ScriptTemplate = "ModHelper" },
  },
  CivilopediaPageLayoutChapters = {
    { PageLayoutId = "FrontPage", ChapterId = "INTRO", SortIndex = 10 },
    { PageLayoutId = "Simple", ChapterId = "CONTENT", SortIndex = 10 },
    -- GS chapter ids are mechanics, not narrative: only HISTORY/CAPSULE are flavor.
    { PageLayoutId = "EnvironmentalEffects", ChapterId = "VOLCANOES", SortIndex = 20 },
    { PageLayoutId = "EnvironmentalEffects", ChapterId = "HISTORY", SortIndex = 10 },
    { PageLayoutId = "UnitNoBuilder", ChapterId = "CONTENT", SortIndex = 5 },
    { PageLayoutId = "UnitNoBuilder", ChapterId = "HISTORY", SortIndex = 10 },
    { PageLayoutId = "Leader", ChapterId = "CAPSULE", SortIndex = 8 },
    { PageLayoutId = "Leader", ChapterId = "DETAILED", SortIndex = 9 },
    { PageLayoutId = "Leader", ChapterId = "HISTORY", SortIndex = 10 },
    { PageLayoutId = "Civilization", ChapterId = "HISTORY", SortIndex = 10 },
    { PageLayoutId = "Unit", ChapterId = "HISTORY", SortIndex = 10 },
    { PageLayoutId = "Technology", ChapterId = "HISTORY", SortIndex = 10 },
  },
  CivilopediaSectionExcludes = {},
  -- The Better Balanced Game mod hides its dummy resource this way
  -- (workshop content 2865001760 sql/DLC_Macedon_Persia/Macedon.sql).
  CivilopediaPageExcludes = { { SectionId = "RESOURCES", PageId = "BBG_DUMMY_RESOURCE_MACEDON" } },
  CivilopediaPageGroupExcludes = {},
  CivilopediaPageSearchTerms = {
    { SectionId = "CONCEPTS", PageId = "NUKES_1", Term = "LOC_PEDIA_SEARCH_TERM_NUCLEAR" },
    { SectionId = "CONCEPTS", PageId = "NUKES_1", Term = "LOC_PEDIA_SEARCH_TERM_THERMONUCLEAR" },
  },
}

GameInfo = {
  Leaders = rows({
    { LeaderType = "LEADER_DEFAULT" },
    { LeaderType = "LEADER_TRAJAN", Name = "LOC_LEADER_TRAJAN_NAME", InheritFrom = "LEADER_DEFAULT" },
    { LeaderType = "LEADER_MINOR_CIV_MILITARISTIC", Name = "LOC_LEADER_MINOR_CIV_ATHENS_NAME" },
    { LeaderType = "LEADER_MINOR_CIV_ATHENS", Name = "LOC_LEADER_MINOR_CIV_ATHENS_NAME", InheritFrom = "LEADER_MINOR_CIV_MILITARISTIC" },
  }, "LeaderType"),
  Traits = rows({
    { TraitType = "TRAJANS_COLUMN_TRAIT", Name = "LOC_TRAIT_LEADER_TRAJANS_COLUMN_NAME", Description = "LOC_TRAIT_LEADER_TRAJANS_COLUMN_DESCRIPTION" },
    { TraitType = "TRAIT_LEADER_EXPANSIONIST", InternalOnly = true },
    { TraitType = "TRAIT_CIVILIZATION_ALL_ROADS_TO_ROME", Name = "LOC_TRAIT_CIVILIZATION_ALL_ROADS_TO_ROME_NAME", Description = "LOC_TRAIT_CIVILIZATION_ALL_ROADS_TO_ROME_DESCRIPTION" },
    { TraitType = "TRAIT_CIVILIZATION_UNIT_ROMAN_LEGION" },
    { TraitType = "TRAIT_CIVILIZATION_DISTRICT_BATHS" },
    { TraitType = "TRAIT_MINOR_CIV_MILITARISTIC", Name = "LOC_TRAIT_MINOR_CIV_MILITARISTIC_NAME", Description = "LOC_TRAIT_MINOR_CIV_MILITARISTIC_DESCRIPTION" },
  }, "TraitType"),
  Units = rows({
    -- Column families shaped like the live Units rows (a real UNIT_ROMAN_LEGION dump has 62 columns:
    -- 29 informative, 33 false/0, 0 narrative), so the pruning is validated on a military unit too.
    { UnitType = "UNIT_ROMAN_LEGION", Name = "LOC_UNIT_ROMAN_LEGION_NAME", Description = "LOC_UNIT_ROMAN_LEGION_DESCRIPTION",
      TraitType = "TRAIT_CIVILIZATION_UNIT_ROMAN_LEGION", Cost = 110, Maintenance = 2, BaseMoves = 2, Combat = 40,
      Domain = "DOMAIN_LAND", FormationClass = "FORMATION_CLASS_LAND_COMBAT", PromotionClass = "PROMOTION_CLASS_MELEE",
      PurchaseYield = "YIELD_GOLD", PrereqTech = "TECH_WRITING", CanTrain = true, BaseSightRange = 2, BuildCharges = 1,
      InitialLevel = 1, CanCapture = true, CanEarnExperience = true, ZoneOfControl = true,
      CostProgressionModel = "NO_COST_PROGRESSION", MandatoryObsoleteTech = "TECH_GUNPOWDER",
      StrategicResource = "RESOURCE_IRON", AdvisorType = "ADVISOR_CONQUEST",
      PrimaryKey = "UNIT_ROMAN_LEGION", RowId = 37, rowid = 37, Hash = -2083333359,
      AirSlots = 0, FoundCity = false, Spy = false, NumRandomChoices = 0, RangedCombat = 0, Range = 0,
      MustPurchase = false, EnabledByReligion = false, IgnoreMoves = false, Stackable = false },
    -- The upgrade target of the Legion (schema: UnitUpgrades.Unit -> Units.UpgradeUnit), so the
    -- data path can carry the upgrade relation the row itself does not hold.
    { UnitType = "UNIT_INFANTRY", Name = "LOC_UNIT_INFANTRY_NAME", Description = "LOC_UNIT_INFANTRY_DESCRIPTION",
      Cost = 430, Maintenance = 4, BaseMoves = 2, Combat = 70, Domain = "DOMAIN_LAND",
      FormationClass = "FORMATION_CLASS_LAND_COMBAT", PromotionClass = "PROMOTION_CLASS_MELEE",
      PurchaseYield = "YIELD_GOLD", CanTrain = true, Range = 0, Spy = false },
    -- A mod-added unit whose page layout builder is not registered in this context: the page still
    -- answers from its chapter data and this row.
    { UnitType = "UNIT_ROMAN_VETERAN", Name = "LOC_UNIT_ROMAN_VETERAN_NAME", Description = "LOC_UNIT_ROMAN_VETERAN_DESCRIPTION",
      Cost = 150, Maintenance = 3, BaseMoves = 2, Combat = 45, Domain = "DOMAIN_LAND",
      FormationClass = "FORMATION_CLASS_LAND_COMBAT", PrereqTech = "TECH_WRITING", CanTrain = true, InternalOnly = false },
  }, "UnitType"),
  Buildings = rows({
    { BuildingType = "BUILDING_LIBRARY", Name = "LOC_BUILDING_LIBRARY_NAME" },
    -- Shaped like the live BUILDING_RUHR_VALLEY row: informative values, false/0 defaults,
    -- narrative Quote/QuoteAudio, the key echo and engine rowids.
    { BuildingType = "BUILDING_RUHR_VALLEY", Name = "LOC_BUILDING_RUHR_VALLEY_NAME",
      Description = "LOC_BUILDING_RUHR_VALLEY_DESCRIPTION", Cost = 1240,
      PrereqTech = "TECH_INDUSTRIALIZATION", ObsoleteEra = "ERA_ATOMIC", MaxWorldInstances = 1, MaxPlayerInstances = -1,
      IsWonder = true, AdjacentDistrict = "DISTRICT_INDUSTRIAL_ZONE", RequiresPlacement = true, RequiresRiver = true,
      Housing = 0, Entertainment = 0, Maintenance = 0, DefenseModifier = 0, OuterDefenseStrength = 0,
      RegionalRange = 0, GrantFortification = 0, Capital = false, AdjacentCapital = false, MustPurchase = false,
      InternalOnly = false, UnlocksGovernmentPolicy = false, RequiresReligion = false, EnabledByReligion = false,
      MustBeLake = false, MustNotBeLake = false, MustBeAdjacentLand = false, AdjacentToMountain = false,
      RequiresAdjacentRiver = false, AllowsHolyCity = false, Quote = "LOC_BUILDING_RUHR_VALLEY_QUOTE",
      QuoteAudio = "Play_RUHRVALLEY_QUOTE", PrimaryKey = "BUILDING_RUHR_VALLEY", RowId = 68, rowid = 68,
      -- The engine row binding also exposes nested collections (the live Buildings row reported 18
      -- such columns, e.g. Building_GreatPersonPoints); their values are not scalars this reader can
      -- serialize, so they are counted in fields.omittedColumns rather than emitted.
      GreatPersonPointsReference = { { GreatPersonClassType = "GREAT_PERSON_CLASS_ENGINEER", Amount = 1 } } },
  }, "BuildingType"),
  Districts = rows({
    { DistrictType = "DISTRICT_BATHS", Name = "LOC_DISTRICT_BATHS_NAME", Description = "LOC_DISTRICT_BATHS_DESCRIPTION",
      TraitType = "TRAIT_CIVILIZATION_DISTRICT_BATHS", Cost = 290, PrereqTech = "TECH_ENGINEERING",
      RequiresPlacement = true, CostProgressionModel = "NO_COST_PROGRESSION", TravelTime = -1, Housing = 2,
      Entertainment = 1, Maintenance = 1, Appeal = 0, Coast = false, ZOC = false, InternalOnly = false },
  }, "DistrictType"),
  Improvements = rows({}, "ImprovementType"),
  Civilizations = rows({
    { CivilizationType = "CIVILIZATION_ROME", Name = "LOC_CIVILIZATION_ROME_NAME", StartingCivilizationLevelType = "CIVILIZATION_LEVEL_FULL_CIV" },
    { CivilizationType = "CIVILIZATION_ATHENS", Name = "LOC_CIVILIZATION_ATHENS_NAME", StartingCivilizationLevelType = "CIVILIZATION_LEVEL_CITY_STATE" },
  }, "CivilizationType"),
  CivilizationLeaders = rows({
    { CivilizationType = "CIVILIZATION_ROME", LeaderType = "LEADER_TRAJAN" },
    { CivilizationType = "CIVILIZATION_ATHENS", LeaderType = "LEADER_MINOR_CIV_ATHENS" },
  }, nil),
  CivilizationTraits = rows({
    { CivilizationType = "CIVILIZATION_ROME", TraitType = "TRAIT_CIVILIZATION_ALL_ROADS_TO_ROME" },
    { CivilizationType = "CIVILIZATION_ROME", TraitType = "TRAIT_CIVILIZATION_UNIT_ROMAN_LEGION" },
    { CivilizationType = "CIVILIZATION_ROME", TraitType = "TRAIT_CIVILIZATION_DISTRICT_BATHS" },
  }, nil),
  LeaderTraits = rows({
    { LeaderType = "LEADER_TRAJAN", TraitType = "TRAJANS_COLUMN_TRAIT" },
    { LeaderType = "LEADER_TRAJAN", TraitType = "TRAIT_LEADER_EXPANSIONIST" },
    { LeaderType = "LEADER_MINOR_CIV_MILITARISTIC", TraitType = "TRAIT_MINOR_CIV_MILITARISTIC" },
  }, nil),
  CivilopediaSections = rows(STUB_DB.CivilopediaSections, "SectionId"),
  CivilopediaPages = rows(STUB_DB.CivilopediaPages, nil),
  CivilopediaPageLayouts = rows(STUB_DB.CivilopediaPageLayouts, "PageLayoutId"),
  CivilopediaPageLayoutChapters = rows(STUB_DB.CivilopediaPageLayoutChapters, nil),
  CivilopediaSectionExcludes = rows(STUB_DB.CivilopediaSectionExcludes, nil),
  CivilopediaPageExcludes = rows(STUB_DB.CivilopediaPageExcludes, nil),
  CivilopediaPageGroupExcludes = rows(STUB_DB.CivilopediaPageGroupExcludes, nil),
  CivilopediaPageSearchTerms = rows(STUB_DB.CivilopediaPageSearchTerms, nil),
  Agendas = rows({ { AgendaType = "AGENDA_OPTIMUS_PRINCEPS", Name = "LOC_AGENDA_OPTIMUS_PRINCEPS_NAME", Description = "LOC_AGENDA_OPTIMUS_PRINCEPS_DESCRIPTION" } }, "AgendaType"),
  HistoricalAgendas = rows({ { LeaderType = "LEADER_TRAJAN", AgendaType = "AGENDA_OPTIMUS_PRINCEPS" } }, nil),
  LeaderInfo = rows({ { LeaderType = "LEADER_TRAJAN", Header = "LOC_PEDIA_LEADER_TRAJAN_GEOGRAPHY_HEADER", Caption = "LOC_PEDIA_LEADER_TRAJAN_GEOGRAPHY_CAPTION", SortIndex = 10 } }, nil),
  CivilizationInfo = rows({}, nil),
  LeaderQuotes = rows({ { LeaderType = "LEADER_TRAJAN", Quote = "LOC_LEADER_TRAJAN_QUOTE", QuoteAudio = "Play_ROME_TR" } }, nil),
  FavoredReligions = rows({ { CivilizationType = "CIVILIZATION_ROME", ReligionType = "RELIGION_CATHOLICISM" } }, nil),
  Religions = rows({ { ReligionType = "RELIGION_CATHOLICISM", Name = "LOC_RELIGION_CATHOLICISM_NAME" } }, "ReligionType"),
  UnitReplaces = rows({}, nil),
  UnitUpgrades = rows({ { Unit = "UNIT_ROMAN_LEGION", UpgradeUnit = "UNIT_INFANTRY" } }, nil),
  Unit_BuildingPrereqs = rows({}, nil),
  Improvement_ValidBuildUnits = rows({}, nil),
  Route_ValidBuildUnits = rows({}, nil),
  UnitPromotionClasses = rows({}, nil),
  Technologies = rows({
    { Index = 1, TechnologyType = "TECH_WRITING", Name = "LOC_TECH_WRITING_NAME", Description = "LOC_UI_PEDIA_DESCRIPTION",
      Cost = 25, EraType = "ERA_ANCIENT", Repeatable = false, Critical = false, EmbarkAll = false },
    { Index = 2, TechnologyType = "TECH_PHILOSOPHY", Name = "LOC_TECH_PHILOSOPHY_NAME" },
  }, "TechnologyType"),
  TechnologyQuotes = rows({}, nil),
  Eras = rows({ { EraType = "ERA_ANCIENT", Name = "Ancient Era" } }, "EraType"),
  Yields = rows({
    { YieldType = "YIELD_PRODUCTION", Name = "Production", IconString = "[ICON_Production]" },
    { YieldType = "YIELD_GOLD", Name = "Gold", IconString = "[ICON_Gold]" },
    { YieldType = "YIELD_SCIENCE", Name = "Science", IconString = "[ICON_Science]" },
  }, "YieldType"),
  Types = rows({}, "Type"),
  Boosts = rows({ { TechnologyType = "TECH_WRITING", TriggerDescription = "Meet another civilization." } }, nil),
  TechnologyModifiers = rows({}, nil),
  CivicModifiers = rows({}, nil),
  Modifiers = rows({}, "ModifierId"),
  DynamicModifiers = rows({}, "ModifierType"),
  ModifierArguments = rows({}, nil),
  UnitOperations = rows({}, nil),
}

STUB_UNLOCKABLES = {
  TECH_WRITING = {
    { "DISTRICT_CAMPUS", "LOC_DISTRICT_CAMPUS_NAME", "DISTRICT_CAMPUS" },
    { "BUILDING_LIBRARY", "LOC_BUILDING_LIBRARY_NAME", "BUILDING_LIBRARY" },
  },
}
function GetUnlockablesForTech(techType)
  local out = {}
  for _, item in ipairs(STUB_UNLOCKABLES[techType] or {}) do table.insert(out, item) end
  return out
end

GlobalParameters = { GOLD_PURCHASE_MULTIPLIER = 2, GOLD_EQUIVALENT_OTHER_YIELDS = 2 }
UnitManager = { GetUnitTypeBaseLifespan = function() return 0 end }
STUB_TECH_NODES = {
  { TechType = 1, PrereqTechTypes = {} },
  { TechType = 2, PrereqTechTypes = { 1 } },
}
Game = {
  GetLocalPlayer = function() return 0 end,
  GetTechs = function()
    return { GetActiveTechNodes = function() return STUB_TECH_NODES end }
  end,
}
Players = setmetatable({}, { __index = function()
  return {
    GetTechs = function()
      return {
        IsTechRevealed = function() return true end,
        GetResearchingTech = function() return -1 end,
      }
    end,
  }
end })

-- -------------------------------------------------------------------------------------
-- Native cache (CacheData_FetchData/ProcessData/SortData, abridged to what it must produce)
-- -------------------------------------------------------------------------------------
function FindSectionTextKey(sectionId, tag)
  local key = "LOC_PEDIA_"..sectionId.."_"..tag
  if Locale.HasTextKey(key) then return key end
end
function FindPageTextKey(sectionId, pageId, tag)
  local keys = {
    "LOC_PEDIA_"..sectionId.."_PAGE_"..pageId.."_"..tag,
    "LOC_PEDIA_PAGE_"..pageId.."_"..tag,
    "LOC_PEDIA_PAGE_"..tag,
  }
  for _, key in ipairs(keys) do if Locale.HasTextKey(key) then return key end end
end
function FindChapterTextKey(sectionId, pageId, chapterId, tag)
  local suffix = "_CHAPTER_"..chapterId.."_"..tag
  local keys = {
    "LOC_PEDIA_"..sectionId.."_PAGE_"..pageId..suffix,
    "LOC_PEDIA_"..sectionId.."_PAGE"..suffix,
    "LOC_PEDIA_PAGE_"..pageId..suffix,
    "LOC_PEDIA_PAGE"..suffix,
  }
  for _, key in ipairs(keys) do if Locale.HasTextKey(key) then return key end end
end

function CacheData()
  _HasSection, _Sections, _PagesBySection, _PagesById = {}, {}, {}, {}
  _PageGroupsBySection, _ChaptersByPageLayout, _ChapterOverrides = {}, {}, {}
  _PageLayoutScriptTemplates = {}

  local exclude = {}
  for row in GameInfo.CivilopediaSectionExcludes() do exclude[row.SectionId] = true end
  for row in GameInfo.CivilopediaPageExcludes() do exclude[row.SectionId.."::"..row.PageId] = true end
  for row in GameInfo.CivilopediaPageGroupExcludes() do exclude[row.SectionId.."|:"..row.PageGroupId] = true end

  for row in GameInfo.CivilopediaSections() do
    if exclude[row.SectionId] ~= true then
      _HasSection[row.SectionId] = true
      table.insert(_Sections, { SectionId = row.SectionId, Name = row.Name, Icon = row.Icon, SortIndex = row.SortIndex })
    end
  end
  for row in GameInfo.CivilopediaPages() do
    local sectionId = row.SectionId
    if exclude[sectionId] ~= true and exclude[sectionId.."::"..row.PageId] ~= true
      and (row.PageGroupId == nil or exclude[sectionId.."|:"..row.PageGroupId] ~= true) and _HasSection[sectionId] then
      local page = {
        SectionId = sectionId, PageId = row.PageId, PageGroupId = row.PageGroupId, PageLayoutId = row.PageLayoutId,
        Name = row.Name, Tooltip = row.Tooltip, SortIndex = row.SortIndex, Collapsed = true,
      }
      _PagesBySection[sectionId] = _PagesBySection[sectionId] or {}
      table.insert(_PagesBySection[sectionId], page)
      _PagesById[sectionId.."::"..row.PageId] = page
    end
  end
  for row in GameInfo.CivilopediaPageLayouts() do
    _PageLayoutScriptTemplates[row.PageLayoutId] = row.ScriptTemplate
  end
  for row in GameInfo.CivilopediaPageLayoutChapters() do
    _ChaptersByPageLayout[row.PageLayoutId] = _ChaptersByPageLayout[row.PageLayoutId] or {}
    table.insert(_ChaptersByPageLayout[row.PageLayoutId], row)
  end

  for _, section in ipairs(_Sections) do
    section.TabName = Locale.Lookup(FindSectionTextKey(section.SectionId, "TAB_NAME") or section.Name)
  end
  for _, pages in pairs(_PagesBySection) do
    for _, page in ipairs(pages) do
      page.TabName = Locale.Lookup(FindPageTextKey(page.SectionId, page.PageId, "TAB_NAME") or page.Name)
      page.Title = Locale.Lookup(FindPageTextKey(page.SectionId, page.PageId, "TITLE") or page.Name)
      local subtitle = FindPageTextKey(page.SectionId, page.PageId, "SUBTITLE")
      if subtitle then page.SubTitle = Locale.Lookup(subtitle) end
    end
  end

  local function sortNumberOrNil(a, b)
    if a == nil and b ~= nil then return true end
    if b == nil then return false end
    return a < b
  end
  table.sort(_Sections, function(a, b) return sortNumberOrNil(a.SortIndex, b.SortIndex) end)
  for _, pages in pairs(_PagesBySection) do
    table.sort(pages, function(a, b)
      if a.SortIndex ~= b.SortIndex then return sortNumberOrNil(a.SortIndex, b.SortIndex) end
      return Locale.Compare(a.TabName, b.TabName) == -1
    end)
  end
end

-- STUB_ISOLATE_GLOBALS models a state where each UI file has its own environment delegating to a
-- shared parent: the support function below then reads a snapshot taken when the file loaded, so a
-- global written by another chunk is invisible to it (the failure mode the reader must detect).
local fileLocalChapters = nil
function STUB_ISOLATE_GLOBALS() fileLocalChapters = _ChaptersByPageLayout end

function GetSections() return _Sections end
function GetPages(sectionId) return _PagesBySection[sectionId] end
function GetPage(sectionId, pageId)
  if sectionId and pageId then return _PagesById[sectionId.."::"..pageId] end
end
function GetPageChapters(layoutId)
  if fileLocalChapters ~= nil then return fileLocalChapters[layoutId] end
  return _ChaptersByPageLayout[layoutId]
end
function GetChapterHeader(sectionId, pageId, chapterId)
  local key = sectionId.."|"..pageId.."|"..chapterId
  local chapter = _ChapterOverrides[key]
  if chapter and chapter.Header then return chapter.Header end
  return FindChapterTextKey(sectionId, pageId, chapterId, "TITLE")
end
function GetChapterBody(sectionId, pageId, chapterId)
  local key = sectionId.."|"..pageId.."|"..chapterId
  local chapter = _ChapterOverrides[key]
  if chapter and chapter.Body and #chapter.Body > 0 then return chapter.Body end
  local body = FindChapterTextKey(sectionId, pageId, chapterId, "BODY")
  if body ~= nil then return { body } end
  local keys, index = {}, 1
  while true do
    local para = FindChapterTextKey(sectionId, pageId, chapterId, "PARA_"..index)
    if para == nil then break end
    table.insert(keys, para)
    index = index + 1
  end
  if #keys > 0 then return keys end
end

-- -------------------------------------------------------------------------------------
-- Layout helpers (CivilopediaSupport.lua:1441-1794 contract). Each one mutates recorded UI.
-- -------------------------------------------------------------------------------------
local function addInstance(manager)
  return manager:GetInstance()
end
function Do_AddChapterWithParagraphs(chapterManager, paragraphManager, header, paragraphs)
  if header ~= nil and paragraphs ~= nil then
    addInstance(chapterManager).Caption:LocalizeAndSetText(localizeAndSet(header))
    if type(paragraphs) == "table" then
      for _, para in ipairs(paragraphs) do
        addInstance(paragraphManager).Paragraph:LocalizeAndSetText(localizeAndSet(para))
      end
    else
      addInstance(paragraphManager).Paragraph:LocalizeAndSetText(localizeAndSet(paragraphs))
    end
  end
end
function Do_AddHeader(manager, caption)
  addInstance(manager).Caption:LocalizeAndSetText(localizeAndSet(caption))
end
function Do_AddParagraph(manager, paragraph)
  addInstance(manager).Paragraph:LocalizeAndSetText(localizeAndSet(paragraph))
end
function Do_AddParagraphs(manager, paragraphs)
  if type(paragraphs) == "table" then
    for _, para in ipairs(paragraphs) do Do_AddParagraph(manager, para) end
  else
    Do_AddParagraph(manager, paragraphs)
  end
end
function Do_AddHeaderBody(manager, header, body)
  local instance = addInstance(manager)
  instance.Header:LocalizeAndSetText(localizeAndSet(header))
  instance.Body:LocalizeAndSetText(localizeAndSet(body))
end
function Do_AddIconHeaderBody(manager, icon, header, body)
  local instance = addInstance(manager)
  HookupIcon(icon, instance.Icon, instance.Button)
  instance.Header:LocalizeAndSetText(localizeAndSet(header))
  instance.Body:LocalizeAndSetText(localizeAndSet(body))
end
function HookupIcon(icon_data, icon_control, button_control)
  touch("HookupIcon")
  if type(icon_data) == "table" and icon_data[3] ~= nil then touch("HookupIcon:RegisterCallback") end
end

local chapterManager = InstanceManager:new("CivilopediaChapter")
local chapterParagraphManager = InstanceManager:new("CivilopediaChapterParagraph")
local leftChapterManager = InstanceManager:new("CivilopediaLeftColumnChapter")
local leftParagraphManager = InstanceManager:new("CivilopediaLeftColumnChapterParagraph")
local leftHeaderBodyManager = InstanceManager:new("CivilopediaLeftColumnHeaderBody")
local leftIconHeaderBodyManager = InstanceManager:new("CivilopediaLeftColumnIconHeaderBody")
local rightPortraitManager = InstanceManager:new("RightColumnPortrait")
local rightTallPortraitManager = InstanceManager:new("RightColumnPortraitTall")
local rightQuoteManager = InstanceManager:new("RightColumnQuote")
local statBoxManager = InstanceManager:new("RightColumnStatBox")
local statSeparatorManager = InstanceManager:new("RightColumnStatSeparator")
local statHeaderManager = InstanceManager:new("RightColumnStatHeader")
local statLabelManager = InstanceManager:new("RightColumnStatLabel")
local statIconLabelManager = InstanceManager:new("RightColumnStatIconLabel")
local statIconNumberManager = InstanceManager:new("RightColumnStatIconNumberLabel")
local statIconListManager = InstanceManager:new("RightColumnStatIconList")

function ShowFrontPageHeader() touch("ShowFrontPageHeader") end
function SetPageHeader(caption)
  touch("Controls.PageHeader")
  if caption ~= nil then touch("Controls.PageHeaderCaption") end
end
function SetPageSubHeader(caption)
  touch("Controls.PageSubHeader")
  if caption ~= nil then touch("Controls.PageSubHeaderCaption") end
end
function AddFullWidthChapter(header, paragraphs)
  return Do_AddChapterWithParagraphs(chapterManager, chapterParagraphManager, header, paragraphs)
end
function AddFullWidthHeader(caption) return Do_AddHeader(chapterManager, caption) end
function AddFullWidthParagraph(paragraph) return Do_AddParagraph(chapterParagraphManager, paragraph) end
function AddFullWidthParagraphs(paragraphs) return Do_AddParagraphs(chapterParagraphManager, paragraphs) end
function AddFullWidthHeaderBody(header, body) error("NYI") end
function AddFullWidthIconHeaderBody(icon, header, body) error("NYI") end
function AddLeftColumnChapter(header, paragraphs)
  return Do_AddChapterWithParagraphs(leftChapterManager, leftParagraphManager, header, paragraphs)
end
function AddLeftColumnHeader(caption) return Do_AddHeader(leftChapterManager, caption) end
function AddLeftColumnParagraph(paragraph) return Do_AddParagraph(leftParagraphManager, paragraph) end
function AddLeftColumnParagraphs(paragraphs) return Do_AddParagraphs(leftParagraphManager, paragraphs) end
function AddLeftColumnHeaderBody(header, body) return Do_AddHeaderBody(leftHeaderBodyManager, header, body) end
function AddLeftColumnIconHeaderBody(icon, header, body) return Do_AddIconHeaderBody(leftIconHeaderBodyManager, icon, header, body) end
function AddChapter(header, paragraphs)
  if _PageContentLayout ~= "two-column" then AddFullWidthChapter(header, paragraphs)
  else AddLeftColumnChapter(header, paragraphs) end
end
function AddHeader(caption)
  if _PageContentLayout ~= "two-column" then return AddFullWidthHeader(caption) end
  return AddLeftColumnHeader(caption)
end
function AddParagraph(paragraph)
  if _PageContentLayout ~= "two-column" then return AddFullWidthParagraph(paragraph) end
  return AddLeftColumnParagraph(paragraph)
end
function AddParagraphs(paragraphs)
  if _PageContentLayout ~= "two-column" then return AddFullWidthParagraphs(paragraphs) end
  return AddLeftColumnParagraphs(paragraphs)
end
function AddHeaderBody(header, body)
  if _PageContentLayout ~= "two-column" then return AddFullWidthHeaderBody(header, body) end
  return AddLeftColumnHeaderBody(header, body)
end
function AddIconHeaderBody(icon, header, body)
  if _PageContentLayout ~= "two-column" then return AddFullWidthIconHeaderBody(icon, header, body) end
  return AddLeftColumnIconHeaderBody(icon, header, body)
end
function AddImage(image)
  if image ~= nil then
    rightPortraitManager:GetInstance().PortraitIcon:SetTexture(image)
    _PageContentLayout = "two-column"
  end
end
function AddPortrait(icon)
  if icon ~= nil then
    rightPortraitManager:GetInstance().PortraitIcon:SetIcon(icon)
    _PageContentLayout = "two-column"
  end
end
function AddTallImage(image)
  if image ~= nil then
    rightTallPortraitManager:GetInstance().Root:SetTexture(image)
    _PageContentLayout = "two-column"
  end
end
function AddTallImageNoScale(image)
  if image ~= nil then
    rightTallPortraitManager:GetInstance().PortraitIcon:SetTexture(image)
    _PageContentLayout = "two-column"
  end
end
function AddTallPortrait(icon)
  if icon ~= nil then rightTallPortraitManager:GetInstance().Root:SetIcon(icon) end
  _PageContentLayout = "two-column"
end
function AddQuote(quote, audio)
  if quote and #quote > 0 then
    rightQuoteManager:GetInstance().Quote:LocalizeAndSetText(localizeAndSet(quote))
  end
  _PageContentLayout = "two-column"
end
function AddRightColumnStatBox(title, populate_method)
  local instance = statBoxManager:GetInstance()
  instance.Title:LocalizeAndSetText(localizeAndSet(title))
  local has_content = false
  local stat_box = { Instance = instance }
  function stat_box:AddSeparator()
    statSeparatorManager:GetInstance().Root:ChangeParent(self.Instance.Content)
  end
  function stat_box:AddHeader(caption)
    if caption == nil then error("Caption must not be nil") end
    has_content = true
    statHeaderManager:GetInstance().Caption:LocalizeAndSetText(localizeAndSet(caption))
  end
  function stat_box:AddLabel(caption)
    if caption == nil then error("Caption must not be nil") end
    has_content = true
    statLabelManager:GetInstance().Caption:LocalizeAndSetText(localizeAndSet(caption))
  end
  function stat_box:AddSmallLabel(caption)
    if caption == nil then error("Caption must not be nil") end
    has_content = true
    statLabelManager:GetInstance().Caption:LocalizeAndSetText(localizeAndSet(caption))
  end
  function stat_box:AddIconLabel(icon, caption)
    if icon == nil then error("Icon must not be nil") end
    if caption == nil then error("Caption must not be nil") end
    has_content = true
    local label = statIconLabelManager:GetInstance()
    HookupIcon(icon, label.Icon, label.Button)
    label.Caption:LocalizeAndSetText(localizeAndSet(caption))
  end
  function stat_box:AddIconNumberLabel(icon, value, caption)
    if value == nil then error("Value must not be nil") end
    if caption == nil then error("Caption must not be nil") end
    has_content = true
    local label = statIconNumberManager:GetInstance()
    HookupIcon(icon, label.Icon, label.Button)
    label.Value:SetText(value)
    label.Caption:LocalizeAndSetText(localizeAndSet(caption))
  end
  function stat_box:AddIconList(icon1, icon2, icon3, icon4)
    has_content = true
    local instance = statIconListManager:GetInstance()
    local icons = { icon1, icon2, icon3, icon4 }
    for index = 1, 4 do
      if icons[index] ~= nil then HookupIcon(icons[index], instance["Icon"..index], instance["Button"..index]) end
    end
  end
  if populate_method then populate_method(stat_box) end
  if has_content then _PageContentLayout = "two-column" end
end

-- -------------------------------------------------------------------------------------
-- Page builders. FrontPage/Simple are the shipped bodies; Leader/Civilization/Unit/
-- Technology keep the shipped call shape, abridged where the shipped code scans tables the
-- fixture does not model (belief unlocks, espionage missions, modifier-derived stats).
-- -------------------------------------------------------------------------------------
function PageLayouts_FrontPage(page)
  local sectionId, pageId = page.SectionId, page.PageId
  ShowFrontPageHeader()
  SetPageHeader(nil)
  SetPageSubHeader(nil)
  local chapters = GetPageChapters(page.PageLayoutId)
  for i, chapter in ipairs(chapters) do
    local chapter_header = GetChapterHeader(sectionId, pageId, chapter.ChapterId)
    local chapter_body = GetChapterBody(sectionId, pageId, chapter.ChapterId)
    AddChapter(chapter_header, chapter_body)
  end
end

function PageLayouts_Simple(page)
  local sectionId, pageId = page.SectionId, page.PageId
  SetPageHeader(page.Title)
  SetPageSubHeader(page.Subtitle)
  local chapters = GetPageChapters(page.PageLayoutId)
  for i, chapter in ipairs(chapters) do
    local chapter_header = GetChapterHeader(sectionId, pageId, chapter.ChapterId)
    local chapter_body = GetChapterBody(sectionId, pageId, chapter.ChapterId)
    if chapter_header == nil or i == 1 and (Locale.Lookup(chapter_header) == page.Title)
      or (Locale.Lookup(chapter_header) == page.Subtitle) then
      AddParagraphs(chapter_body)
    else
      AddChapter(chapter_header, chapter_body)
    end
  end
end

function PageLayouts_Leader(page)
  local sectionId, pageId = page.SectionId, page.PageId
  SetPageHeader(page.Title)
  SetPageSubHeader(page.Subtitle)
  local base_leader = GameInfo.Leaders[pageId]
  if base_leader == nil then return end
  local leaderType = base_leader.LeaderType

  local function AddInheritedLeaders(leaders, leader)
    local inherit = leader.InheritFrom
    if inherit ~= nil then
      local parent = GameInfo.Leaders[inherit]
      if parent then
        table.insert(leaders, parent)
        AddInheritedLeaders(leaders, parent)
      end
    end
  end

  local leaders = {}
  table.insert(leaders, base_leader)
  AddInheritedLeaders(leaders, base_leader)
  local has_leader = {}
  for _, leader in ipairs(leaders) do has_leader[leader.LeaderType] = true end

  local civilizations = {}
  for row in GameInfo.CivilizationLeaders() do
    if has_leader[row.LeaderType] == true then
      local civ = GameInfo.Civilizations[row.CivilizationType]
      if civ then table.insert(civilizations, civ) end
    end
  end

  local traits, has_trait, not_ability = {}, {}, {}
  for row in GameInfo.LeaderTraits() do
    if has_leader[row.LeaderType] == true then
      local trait = GameInfo.Traits[row.TraitType]
      if trait then table.insert(traits, trait) end
      has_trait[row.TraitType] = true
    end
  end

  local uu = {}
  for row in GameInfo.Units() do
    local trait = row.TraitType
    if trait then
      not_ability[trait] = true
      if has_trait[trait] == true then table.insert(uu, { row.UnitType, row.Name }) end
    end
  end
  local ub = {}
  for row in GameInfo.Buildings() do
    local trait = row.TraitType
    if trait then
      not_ability[trait] = true
      if has_trait[trait] == true then table.insert(ub, { row.BuildingType, row.Name }) end
    end
  end
  for row in GameInfo.Districts() do
    local trait = row.TraitType
    if trait then
      not_ability[trait] = true
      if has_trait[trait] == true then table.insert(ub, { row.DistrictType, row.Name }) end
    end
  end
  for row in GameInfo.Improvements() do
    local trait = row.TraitType
    if trait then
      not_ability[trait] = true
      if has_trait[trait] == true then table.insert(ub, { row.ImprovementType, row.Name }) end
    end
  end

  local unique_abilities = {}
  for i, trait in ipairs(traits) do
    if not_ability[trait.TraitType] ~= true and not trait.InternalOnly and trait.Name ~= nil and trait.Description ~= nil then
      table.insert(unique_abilities, trait)
    end
  end

  local preferred_religion
  for row in GameInfo.FavoredReligions() do
    if row.CivilizationType == nil and has_leader[row.LeaderType] == true then
      local religion = GameInfo.Religions[row.ReligionType]
      if religion then preferred_religion = religion end
    end
  end

  local agendas = {}
  for row in GameInfo.HistoricalAgendas() do
    if has_leader[row.LeaderType] == true then
      local agenda = GameInfo.Agendas[row.AgendaType]
      if agenda ~= nil then table.insert(agendas, agenda) end
    end
  end

  local info = {}
  for row in GameInfo.LeaderInfo() do
    if has_leader[row.LeaderType] == true then table.insert(info, row) end
  end

  AddTallPortrait("ICON_" .. leaderType)
  for row in GameInfo.LeaderQuotes() do
    if has_leader[row.LeaderType] == true then AddQuote(row.Quote, row.QuoteAudio) end
  end

  AddRightColumnStatBox("LOC_UI_PEDIA_TRAITS", function(s)
    s:AddSeparator()
    if #civilizations > 0 then
      s:AddHeader("LOC_UI_PEDIA_CIVILIZATIONS")
      for _, civ in ipairs(civilizations) do
        s:AddIconLabel({ "ICON_" .. civ.CivilizationType, civ.Name, civ.CivilizationType }, civ.Name)
      end
      s:AddSeparator()
    end
    if #uu > 0 then
      s:AddHeader("LOC_UI_PEDIA_SPECIAL_UNITS")
      for _, item in ipairs(uu) do
        s:AddIconLabel({ "ICON_" .. item[1], item[2], item[1] }, item[2])
      end
      s:AddSeparator()
    end
    if #ub > 0 then
      s:AddHeader("LOC_UI_PEDIA_SPECIAL_INFRASTRUCTURE")
      for _, item in ipairs(ub) do
        s:AddIconLabel({ "ICON_" .. item[1], item[2], item[1] }, item[2])
      end
      s:AddSeparator()
    end
  end)

  AddRightColumnStatBox("LOC_UI_PEDIA_PREFERENCES", function(s)
    s:AddSeparator()
    if #agendas > 0 then
      s:AddHeader("LOC_UI_PEDIA_AGENDAS")
      for i, v in ipairs(agendas) do
        s:AddLabel(v.Name)
        s:AddLabel(v.Description)
      end
      s:AddSeparator()
    end
    if preferred_religion ~= nil then
      s:AddHeader("LOC_UI_PEDIA_PREFERRED_RELIGION")
      s:AddIconLabel({ "ICON_" .. preferred_religion.ReligionType, preferred_religion.Name, preferred_religion.ReligionType }, preferred_religion.Name)
      s:AddSeparator()
    end
  end)

  AddRightColumnStatBox("LOC_UI_PEDIA_GEOGRAPHY_AND_SOCIAL_DATA", function(s)
    s:AddSeparator()
    for _, item in ipairs(info) do
      s:AddHeader(item.Header)
      s:AddLabel(item.Caption)
      s:AddSeparator()
    end
  end)

  if #unique_abilities > 0 then
    AddHeader("LOC_UI_PEDIA_UNIQUE_ABILITY")
    for _, item in ipairs(unique_abilities) do
      if item.Name ~= nil and item.Name ~= "NONE" then AddHeaderBody(item.Name, item.Description) end
    end
  end

  local chapters = GetPageChapters(page.PageLayoutId)
  for i, chapter in ipairs(chapters) do
    local chapter_header = GetChapterHeader(sectionId, pageId, chapter.ChapterId)
    local chapter_body = GetChapterBody(sectionId, pageId, chapter.ChapterId)
    AddChapter(chapter_header, chapter_body)
  end
end

function PageLayouts_Civilization(page)
  local sectionId, pageId = page.SectionId, page.PageId
  SetPageHeader(page.Title)
  SetPageSubHeader(page.Subtitle)
  local civ = GameInfo.Civilizations[pageId]
  if civ == nil then return end
  local civType = civ.CivilizationType

  local leaders = {}
  for row in GameInfo.CivilizationLeaders() do
    if row.CivilizationType == civType then
      local leader = GameInfo.Leaders[row.LeaderType]
      if leader then table.insert(leaders, leader) end
    end
  end

  local traits = {}
  for row in GameInfo.CivilizationTraits() do
    if row.CivilizationType == civType then traits[row.TraitType] = true end
  end

  local not_abilities = {}
  local uu = {}
  for row in GameInfo.Units() do
    local trait = row.TraitType
    if trait then
      not_abilities[trait] = true
      if traits[trait] == true then table.insert(uu, { row.UnitType, row.Name }) end
    end
  end
  local ub = {}
  for row in GameInfo.Buildings() do
    local trait = row.TraitType
    if trait then
      not_abilities[trait] = true
      if traits[trait] == true then table.insert(ub, { row.BuildingType, row.Name }) end
    end
  end
  for row in GameInfo.Districts() do
    local trait = row.TraitType
    if trait then
      not_abilities[trait] = true
      if traits[trait] == true then table.insert(ub, { row.DistrictType, row.Name }) end
    end
  end
  for row in GameInfo.Improvements() do
    local trait = row.TraitType
    if trait then
      not_abilities[trait] = true
      if traits[trait] == true then table.insert(ub, { row.ImprovementType, row.Name }) end
    end
  end

  local unique_abilities = {}
  for row in GameInfo.CivilizationTraits() do
    if row.CivilizationType == civType and not_abilities[row.TraitType] ~= true then
      local trait = GameInfo.Traits[row.TraitType]
      if trait and trait.Name ~= nil and trait.Description ~= nil then table.insert(unique_abilities, trait) end
    end
  end

  local preferred_religion
  for row in GameInfo.FavoredReligions() do
    if row.CivilizationType == civType and row.LeaderType == nil then
      local religion = GameInfo.Religions[row.ReligionType]
      if religion then preferred_religion = religion end
    end
  end

  local info = {}
  for row in GameInfo.CivilizationInfo() do
    if row.CivilizationType == civType then table.insert(info, row) end
  end

  AddPortrait("ICON_" .. civType)
  AddRightColumnStatBox("LOC_UI_PEDIA_TRAITS", function(s)
    s:AddSeparator()
    if #leaders > 0 then
      s:AddHeader("LOC_UI_PEDIA_LEADERS")
      for _, leader in ipairs(leaders) do
        s:AddIconLabel({ "ICON_" .. leader.LeaderType, leader.Name, leader.LeaderType }, leader.Name)
      end
      s:AddSeparator()
    end
    if #uu > 0 then
      s:AddHeader("LOC_UI_PEDIA_SPECIAL_UNITS")
      for _, item in ipairs(uu) do
        s:AddIconLabel({ "ICON_" .. item[1], item[2], item[1] }, item[2])
      end
      s:AddSeparator()
    end
    if #ub > 0 then
      s:AddHeader("LOC_UI_PEDIA_SPECIAL_INFRASTRUCTURE")
      for _, item in ipairs(ub) do
        s:AddIconLabel({ "ICON_" .. item[1], item[2], item[1] }, item[2])
      end
      s:AddSeparator()
    end
  end)

  AddRightColumnStatBox("LOC_UI_PEDIA_PREFERENCES", function(s)
    s:AddSeparator()
    if preferred_religion ~= nil then
      s:AddHeader("LOC_UI_PEDIA_PREFERRED_RELIGION")
      s:AddIconLabel({ "ICON_" .. preferred_religion.ReligionType, preferred_religion.Name, preferred_religion.ReligionType }, preferred_religion.Name)
      s:AddSeparator()
    end
  end)

  AddRightColumnStatBox("LOC_UI_PEDIA_GEOGRAPHY_AND_SOCIAL_DATA", function(s)
    s:AddSeparator()
    for _, item in ipairs(info) do
      s:AddHeader(item.Header)
      s:AddLabel(item.Caption)
      s:AddSeparator()
    end
  end)

  if #unique_abilities > 0 then
    AddHeader("LOC_UI_PEDIA_UNIQUE_ABILITY")
    for _, item in ipairs(unique_abilities) do
      if item.Name ~= nil and item.Name ~= "NONE" then AddHeaderBody(item.Name, item.Description) end
    end
  end

  local chapters = GetPageChapters(page.PageLayoutId)
  for i, chapter in ipairs(chapters) do
    local chapter_header = GetChapterHeader(sectionId, pageId, chapter.ChapterId)
    local chapter_body = GetChapterBody(sectionId, pageId, chapter.ChapterId)
    AddChapter(chapter_header, chapter_body)
  end
end

function PageLayouts_Unit(page)
  local sectionId, pageId = page.SectionId, page.PageId
  SetPageHeader(page.Title)
  SetPageSubHeader(page.Subtitle)
  local unit = GameInfo.Units[pageId]
  if unit == nil then return end
  local unitType = unit.UnitType

  local unique_to = {}
  if unit.TraitType then
    for row in GameInfo.LeaderTraits() do
      if row.TraitType == unit.TraitType then
        local leader = GameInfo.Leaders[row.LeaderType]
        if leader then table.insert(unique_to, { "ICON_" .. row.LeaderType, leader.Name, row.LeaderType }) end
      end
    end
    for row in GameInfo.CivilizationTraits() do
      if row.TraitType == unit.TraitType then
        local civ = GameInfo.Civilizations[row.CivilizationType]
        if civ then table.insert(unique_to, { "ICON_" .. row.CivilizationType, civ.Name, row.CivilizationType }) end
      end
    end
  end

  local replaces
  local replaced_by = {}
  for row in GameInfo.UnitReplaces() do
    if row.CivUniqueUnitType == unitType then
      local other = GameInfo.Units[row.ReplacesUnitType]
      if other then replaces = { "ICON_" .. other.UnitType, other.Name, other.UnitType } end
    end
    if row.ReplacesUnitType == unitType then
      local other = GameInfo.Units[row.CivUniqueUnitType]
      if other then table.insert(replaced_by, { "ICON_" .. other.UnitType, other.Name, other.UnitType }) end
    end
  end

  local upgrades_to, upgrades_from = {}, {}
  for row in GameInfo.UnitUpgrades() do
    if row.Unit == unitType then
      local other = GameInfo.Units[row.UpgradeUnit]
      if other then table.insert(upgrades_to, { "ICON_" .. other.UnitType, other.Name, other.UnitType }) end
    end
    if row.UpgradeUnit == unitType then
      local other = GameInfo.Units[row.Unit]
      if other then table.insert(upgrades_from, { "ICON_" .. other.UnitType, other.Name, other.UnitType }) end
    end
  end

  local requires_buildings = {}
  for row in GameInfo.Unit_BuildingPrereqs() do
    if row.Unit == unitType then
      local building = GameInfo.Buildings[row.PrereqBuilding]
      if building then table.insert(requires_buildings, { "ICON_" .. building.BuildingType, building.Name, building.BuildingType }) end
    end
  end

  local improvements = {}
  for row in GameInfo.Improvement_ValidBuildUnits() do
    if row.UnitType == unitType then
      local improvement = GameInfo.Improvements[row.ImprovementType]
      if improvement then table.insert(improvements, improvement) end
    end
  end

  local cost = tonumber(unit.Cost)
  local maintenance = tonumber(unit.Maintenance)
  local purchase_cost
  if unit.PurchaseYield then
    if unit.PurchaseYield == "YIELD_GOLD" then
      purchase_cost = cost * GlobalParameters.GOLD_PURCHASE_MULTIPLIER * GlobalParameters.GOLD_EQUIVALENT_OTHER_YIELDS
    else
      purchase_cost = cost * GlobalParameters.GOLD_EQUIVALENT_OTHER_YIELDS
    end
  end

  AddPortrait("ICON_" .. unitType)
  AddRightColumnStatBox("LOC_UI_PEDIA_TRAITS", function(s)
    if #unique_to > 0 then
      s:AddHeader("LOC_UI_PEDIA_UNIQUE_TO")
      for _, icon in ipairs(unique_to) do s:AddIconLabel(icon, icon[2]) end
    end
    if replaces then
      s:AddHeader("LOC_UI_PEDIA_REPLACES")
      s:AddIconLabel(replaces, replaces[2])
    end
    if #replaced_by > 0 then
      s:AddHeader("LOC_UI_PEDIA_REPLACED_BY")
      for _, icon in ipairs(replaced_by) do s:AddIconLabel(icon, icon[2]) end
    end
    if #upgrades_to > 0 then
      s:AddHeader("LOC_UI_PEDIA_UPGRADES_TO")
      for _, icon in ipairs(upgrades_to) do s:AddIconLabel(icon, icon[2]) end
    end
    if unit.BaseMoves ~= 0 then
      s:AddIconNumberLabel({ "ICON_MOVES", nil, "MOVEMENT_1" }, unit.BaseMoves, "LOC_UI_PEDIA_MOVEMENT_POINTS")
    end
    if unit.Combat ~= 0 then
      s:AddIconNumberLabel({ "ICON_STRENGTH", nil, "COMBAT_5" }, unit.Combat, "LOC_UI_PEDIA_MELEE_STRENGTH")
    end
    s:AddSeparator()
  end)

  AddRightColumnStatBox("LOC_UI_PEDIA_REQUIREMENTS", function(s)
    s:AddSeparator()
    if unit.PrereqTech or unit.PrereqCivic or unit.PrereqDistrict or unit.StrategicResource or #requires_buildings > 0 then
      if unit.PrereqTech ~= nil then
        local technology = GameInfo.Technologies[unit.PrereqTech]
        if technology then
          s:AddHeader("LOC_TECHNOLOGY_NAME")
          s:AddIconLabel({ "ICON_" .. technology.TechnologyType, technology.Name, technology.TechnologyType }, technology.Name)
        end
      end
      if #requires_buildings > 0 then
        s:AddHeader("LOC_BUILDING_NAME")
        for _, icon in ipairs(requires_buildings) do s:AddIconLabel(icon, icon[2]) end
      end
      s:AddSeparator()
    end
    if unit.CanTrain and not unit.MustPurchase then
      local production = GameInfo.Yields["YIELD_PRODUCTION"]
      if production then
        s:AddHeader("LOC_UI_PEDIA_PRODUCTION_COST")
        s:AddLabel(Locale.Lookup("LOC_UI_PEDIA_BASE_COST", cost, production.IconString, production.Name))
      end
    end
    if purchase_cost then
      local gold = GameInfo.Yields[unit.PurchaseYield]
      if gold then
        s:AddHeader("LOC_UI_PEDIA_PURCHASE_COST")
        s:AddLabel(Locale.Lookup("LOC_UI_PEDIA_BASE_COST", purchase_cost, gold.IconString, gold.Name))
      end
    end
    if maintenance ~= 0 then
      local gold = GameInfo.Yields["YIELD_GOLD"]
      if gold then
        s:AddHeader("LOC_UI_PEDIA_MAITENANCE_COST")
        s:AddLabel(Locale.Lookup("LOC_UI_PEDIA_BASE_COST", maintenance, gold.IconString, gold.Name))
      end
    end
    s:AddSeparator()
  end)

  AddRightColumnStatBox("LOC_UI_PEDIA_USAGE", function(s)
    s:AddSeparator()
    if #improvements > 0 then
      s:AddHeader("LOC_UI_PEDIA_USAGE_CAN_CONSTRUCT")
      for _, improvement in ipairs(improvements) do
        s:AddIconLabel({ "ICON_" .. improvement.ImprovementType, improvement.Name, improvement.ImprovementType }, improvement.Name)
      end
    end
    s:AddSeparator()
  end)

  AddChapter("LOC_UI_PEDIA_DESCRIPTION", unit.Description)

  local chapters = GetPageChapters(page.PageLayoutId)
  for i, chapter in ipairs(chapters) do
    local chapter_header = GetChapterHeader(sectionId, pageId, chapter.ChapterId)
    local chapter_body = GetChapterBody(sectionId, pageId, chapter.ChapterId)
    AddChapter(chapter_header, chapter_body)
  end
end

function PageLayouts_Technology(page)
  local sectionId, pageId = page.SectionId, page.PageId
  SetPageHeader(page.Title)
  SetPageSubHeader(page.Subtitle)

  local tech, liveTech
  local techNodes = Game.GetTechs():GetActiveTechNodes()
  for _, node in ipairs(techNodes) do
    local row = GameInfo.Technologies[node.TechType]
    if row and row.TechnologyType == pageId then
      tech = row
      liveTech = node
    end
  end
  if tech == nil then return end
  local techType = tech.TechnologyType

  local required_techs, leadsto = {}, {}
  local playerTechs = Players[Game.GetLocalPlayer()]:GetTechs()
  if playerTechs:IsTechRevealed(tech.Index) then
    for _, prereqTechIndex in ipairs(liveTech.PrereqTechTypes) do
      local prereqNode = techNodes[prereqTechIndex]
      local prereqData = GameInfo.Technologies[prereqTechIndex]
      if prereqNode and prereqData and playerTechs:IsTechRevealed(prereqNode) then
        table.insert(required_techs, { "ICON_" .. prereqData.TechnologyType, prereqData.Name, prereqData.TechnologyType })
      end
    end
    for _, node in ipairs(techNodes) do
      for _, prereqTechIndex in ipairs(node.PrereqTechTypes) do
        if prereqTechIndex == liveTech.TechType then
          if playerTechs:IsTechRevealed(node.TechType) then
            local future = GameInfo.Technologies[node.TechType]
            if future then table.insert(leadsto, { "ICON_" .. future.TechnologyType, future.Name, future.TechnologyType }) end
          end
          break
        end
      end
    end
  end

  local boosts = {}
  for row in GameInfo.Boosts() do
    if row.TechnologyType == techType then table.insert(boosts, row) end
  end

  local unlocks = {}
  for _, item in ipairs(GetUnlockablesForTech(techType)) do
    table.insert(unlocks, { "ICON_" .. item[1], Locale.Lookup(item[2]), item[3], item[1] })
  end

  AddPortrait("ICON_" .. techType)
  for row in GameInfo.TechnologyQuotes() do
    if row.TechnologyType == techType then AddQuote(row.Quote, row.QuoteAudio) end
  end

  AddRightColumnStatBox("LOC_UI_PEDIA_UNLOCKS", function(s)
    s:AddSeparator()
    local icons = {}
    for _, icon in ipairs(unlocks) do
      table.insert(icons, icon)
      if #icons == 4 then
        s:AddIconList(icons[1], icons[2], icons[3], icons[4])
        icons = {}
      end
    end
    if #icons > 0 then s:AddIconList(icons[1], icons[2], icons[3], icons[4]) end
    s:AddSeparator()
  end)

  AddRightColumnStatBox("LOC_UI_PEDIA_REQUIREMENTS", function(s)
    s:AddSeparator()
    if tech.EraType then
      local era = GameInfo.Eras[tech.EraType]
      if era then
        s:AddLabel(era.Name)
        s:AddSeparator()
      end
    end
    if #required_techs > 0 then
      s:AddHeader("LOC_UI_PEDIA_REQUIRED_TECHNOLOGIES")
      for _, icon in ipairs(required_techs) do s:AddIconLabel(icon, icon[2]) end
      s:AddSeparator()
    end
    local science = GameInfo.Yields["YIELD_SCIENCE"]
    if science then
      s:AddHeader("LOC_UI_PEDIA_RESEARCH_COST")
      s:AddLabel(Locale.Lookup("LOC_UI_PEDIA_BASE_COST", tonumber(tech.Cost), science.IconString, science.Name))
      s:AddSeparator()
    end
    if #boosts > 0 then
      s:AddHeader("LOC_UI_PEDIA_BOOSTS")
      for _, boost in ipairs(boosts) do s:AddLabel(boost.TriggerDescription) end
      s:AddSeparator()
    end
  end)

  AddRightColumnStatBox("LOC_UI_PEDIA_PROGRESSION", function(s)
    s:AddSeparator()
    if #leadsto > 0 then
      s:AddHeader("LOC_UI_PEDIA_LEADS_TO_TECHS")
      for _, icon in ipairs(leadsto) do s:AddIconLabel(icon, icon[2]) end
    end
    s:AddSeparator()
  end)

  AddChapter("LOC_UI_PEDIA_DESCRIPTION", tech.Description)

  local chapters = GetPageChapters(page.PageLayoutId)
  for i, chapter in ipairs(chapters) do
    local chapter_header = GetChapterHeader(sectionId, pageId, chapter.ChapterId)
    local chapter_body = GetChapterBody(sectionId, pageId, chapter.ChapterId)
    AddChapter(chapter_header, chapter_body)
  end
end

function PageLayouts_Building(page)
  local sectionId, pageId = page.SectionId, page.PageId
  SetPageHeader(page.Title)
  SetPageSubHeader(page.Subtitle)
  local building = GameInfo.Buildings[pageId]
  if building == nil then return end
  AddPortrait("ICON_" .. building.BuildingType)
  AddRightColumnStatBox("LOC_UI_PEDIA_REQUIREMENTS", function(s)
    s:AddSeparator()
    if building.PrereqTech ~= nil then
      local technology = GameInfo.Technologies[building.PrereqTech]
      if technology then
        s:AddHeader("LOC_TECHNOLOGY_NAME")
        s:AddIconLabel({ "ICON_" .. technology.TechnologyType, technology.Name, technology.TechnologyType }, technology.Name)
      end
    end
    local production = GameInfo.Yields["YIELD_PRODUCTION"]
    if building.Cost and production then
      s:AddHeader("LOC_UI_PEDIA_PRODUCTION_COST")
      s:AddLabel(Locale.Lookup("LOC_UI_PEDIA_BASE_COST", tonumber(building.Cost), production.IconString, production.Name))
    end
    s:AddSeparator()
  end)
  AddChapter("LOC_UI_PEDIA_DESCRIPTION", building.Description)
  local chapters = GetPageChapters(page.PageLayoutId)
  for i, chapter in ipairs(chapters) do
    local chapter_header = GetChapterHeader(sectionId, pageId, chapter.ChapterId)
    local chapter_body = GetChapterBody(sectionId, pageId, chapter.ChapterId)
    AddChapter(chapter_header, chapter_body)
  end
end

function PageLayouts_EnvironmentalEffects(page)
  local sectionId, pageId = page.SectionId, page.PageId
  SetPageHeader(page.Title)
  SetPageSubHeader(page.Subtitle)
  local chapters = GetPageChapters(page.PageLayoutId)
  for i, chapter in ipairs(chapters) do
    local chapter_header = GetChapterHeader(sectionId, pageId, chapter.ChapterId)
    local chapter_body = GetChapterBody(sectionId, pageId, chapter.ChapterId)
    AddChapter(chapter_header, chapter_body)
  end
end

function PageLayouts_ModSilent(page)
  -- A layout that touches no page helper at all: nothing can have rendered through the reader.
  local untouched = page.PageId
  if untouched == nil then error("unreachable") end
end

function PageLayouts_ModControls(page)
  -- A mod layout that goes straight for the live screen.
  Controls.PageContentFrame:SetHide(true)
  AddChapter("LOC_UI_PEDIA_DESCRIPTION", "should never be captured")
end

function PageLayouts_ModBroken(page)
  AddChapter("LOC_UI_PEDIA_DESCRIPTION", "captured before the failure")
  error("mod layout exploded halfway")
end

function PageLayouts_ModHelper(page)
  STUB_MISSING_HELPER("argument")
end

PageLayouts = {
  FrontPage = PageLayouts_FrontPage,
  Simple = PageLayouts_Simple,
  Leader = PageLayouts_Leader,
  Civilization = PageLayouts_Civilization,
  Unit = PageLayouts_Unit,
  Building = PageLayouts_Building,
  Technology = PageLayouts_Technology,
  EnvironmentalEffects = PageLayouts_EnvironmentalEffects,
  ModSilent = PageLayouts_ModSilent,
  ModControls = PageLayouts_ModControls,
  ModBroken = PageLayouts_ModBroken,
  ModHelper = PageLayouts_ModHelper,
}

STUB_ORIGINALS = {
  AddChapter = AddChapter,
  GetPageChapters = GetPageChapters,
  SetPageHeader = SetPageHeader,
  LeaderBuilder = PageLayouts.Leader,
  Controls = Controls,
}

CacheData()
`;

/** The reader's JSON envelope, after the bridge-style chunk reassembly. */
interface LuaFrame {
  ok: boolean;
  result: unknown;
  error?: string;
  unavailable: unknown;
  /** Number of printed A.emit chunks the payload arrived in. */
  parts: number;
}

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number => (typeof value === "number" ? value : Number.NaN);
/** A localized value: the reader emits it as a plain string, or as an object carrying `text`. */
const text = (value: unknown): string => (typeof value === "string" ? value : str(object(value).text));
const flag = (value: unknown): boolean => value === true;

/** Reassemble one A.emit() envelope exactly the way src/bridge.ts collect() does. */
function reassemble(marker: string, printed: string): LuaFrame {
  const parts: { index: number; text: string }[] = [];
  let count = 0;
  for (const line of printed.split("\n")) {
    const match = new RegExp(`^${marker}:(\\d+):(\\d+):([0-9a-f]*)$`).exec(line);
    if (!match) continue;
    count = Number(match[2]);
    parts.push({ index: Number(match[1]), text: Buffer.from(match[3]!, "hex").toString("utf8") });
  }
  expect(parts).toHaveLength(count);
  expect(new Set(parts.map(part => part.index)).size).toBe(count);
  parts.sort((left, right) => left.index - right.index);
  const frame = JSON.parse(parts.map(part => part.text).join("")) as unknown;
  return { ...object(frame), parts: parts.length } as unknown as LuaFrame;
}

/**
 * Run one Lua expression returning a value inside a fresh VM, framed through AstraCiv.emit
 * exactly like the bridge does.  `native: false` loads no Civilopedia screen at all and
 * `prelude` runs before the module loads, so state-level facts (a missing _G, file-local
 * globals) are in place when the module resolves them.
 */
function run(body: string, options: { native?: boolean; prelude?: string } = {}): LuaFrame {
  const marker = "ASTRA_TEST";
  const sources = [
    shimSource!,
    commonSource!,
    options.native === false ? "" : FIXTURE,
    // Runs before the module loads, so state-level facts (a missing _G) are in place when the
    // module resolves its environment.
    options.prelude ?? "",
    moduleSource!,
    `AstraCiv.session = "test"\nAstraCiv.emit("${marker}", function() ${body} end)`,
  ];
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  try {
    for (const source of sources) {
      if (lauxlib.luaL_dostring(state, to_luastring(source)) !== lua.LUA_OK) {
        throw new Error(to_jsstring(lua.lua_tostring(state, -1)));
      }
    }
    if (lauxlib.luaL_dostring(state, to_luastring("return STUB_DRAIN()")) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tostring(state, -1)));
    }
    return reassemble(marker, to_jsstring(lua.lua_tostring(state, -1)));
  } finally {
    lua.lua_close(state);
  }
}

/** One civ.civilopedia call, as the bridge builds it. */
function pedia(args: string, options: { setup?: string; prelude?: string } = {}): LuaFrame {
  return run(`${options.setup ?? ""} return AstraCiv.civilopedia(${args})`, { prelude: options.prelude });
}

/** The page payload of a complete read, failing the test with the reason otherwise. */
function completedPage(frame: LuaFrame): Record<string, unknown> {
  expect(frame.ok, frame.error).toBe(true);
  const result = object(frame.result);
  expect(result.status, str(result.reason)).toBe("complete");
  return object(result.page);
}

const chaptersOf = (page: Record<string, unknown>): Record<string, unknown>[] =>
  list(page.chapters).map(object);
const statsOf = (page: Record<string, unknown>): Record<string, unknown>[] =>
  list(page.stats).map(object);
const rowsOf = (box: Record<string, unknown>): unknown[] => list(box.rows);

const boxByTitle = (page: Record<string, unknown>, title: string): Record<string, unknown> => {
  const box = statsOf(page).find(candidate => text(candidate.title) === title);
  expect(box, `stat box ${title} was not captured`).toBeTruthy();
  return box!;
};

const labelsOf = (box: Record<string, unknown>): string[] =>
  rowsOf(box).map(row => text(row));

/** The page's notes, so a test can assert why a layout path was not used. */
const notesOf = (page: Record<string, unknown>): string[] =>
  list(page.notes).map(note => str(note));

const noteMatching = (page: Record<string, unknown>, fragment: string): string[] =>
  notesOf(page).filter(note => note.includes(fragment));

test("the module remains valid Civ Lua 5.1", () => {
  expect(parse(moduleSource!, { luaVersion: "5.1" }).type).toBe("Chunk");
});

test("a context without the native screen reports unavailable instead of guessing", () => {
  const frame = run('return { sections = AstraCiv.civilopedia({}), page = AstraCiv.civilopedia({ id = "UNIT_ROMAN_LEGION" }) }', {
    native: false,
  });
  expect(frame.ok, frame.error).toBe(true);
  const sections = object(frame.result).sections;
  expect(object(sections).status).toBe("unavailable");
  expect(object(sections).complete).toBe(false);
  expect(str(object(sections).mode)).toBe("sections");
  expect(str(object(sections).reason)).toContain("native Civilopedia cache unavailable in this Lua state");
  expect(str(object(sections).reason)).toContain("GetSections");
  const page = object(frame.result).page;
  expect(str(object(page).mode)).toBe("page");
  expect(str(object(page).reason)).toContain("context must be the loaded CivilopediaScreen");
  expect(object(frame.unavailable).civilopedia).toBeTruthy();
});

// The live CivilopediaScreen state defines no `_G` and no setfenv/getfenv, and its globals are
// shared with the page files. This is the end-to-end proof for that shape: the cross-file probe
// passes, the layout renders through the name-addressed swap, every intercepted name reads back
// afterwards, and the live screen is never touched.
test("the live-shaped state renders the page through the name-addressed swap and restores every name", () => {
  const probe = `STUB_RESET()
    local page = AstraCiv.civilopedia({ id = "UNIT_ROMAN_LEGION" })
    local after = STUB_ORIGINALS
    return {
      page = page,
      noGlobal = _G == nil,
      noSetfenv = setfenv == nil,
      touches = #STUB_UI_TOUCHES,
      layoutClean = _PageContentLayout == nil,
      addChapter = AddChapter == after.AddChapter,
      chapters = GetPageChapters == after.GetPageChapters,
      setPageHeader = SetPageHeader == after.SetPageHeader,
      builder = PageLayouts.Leader == after.LeaderBuilder,
      controls = Controls == after.Controls,
    }`;
  const bare = object(run(probe, { prelude: "_G = nil" }).result);
  expect(flag(bare.noGlobal), "the prelude must have removed _G").toBe(true);
  expect(flag(bare.noSetfenv), "fengari has no setfenv either").toBe(true);
  expect(object(bare.page).status).toBe("complete");
  const page = object(object(bare.page).page);
  expect(page.layoutStatus).toBe("rendered");
  // Screen content, not a data row: the native stat boxes with their own labels.
  const boxes = statsOf(page);
  expect(boxes.map(box => text(box.title))).toEqual(["Traits", "Requirements"]);
  expect(labelsOf(boxes[1]!)).toContain("Base Cost: 110 [ICON_Production] Production");
  // Every intercepted name is back, the screen table included, and nothing was touched.
  expect(flag(bare.addChapter)).toBe(true);
  expect(flag(bare.chapters)).toBe(true);
  expect(flag(bare.setPageHeader)).toBe(true);
  expect(flag(bare.builder)).toBe(true);
  expect(flag(bare.controls)).toBe(true);
  expect(flag(bare.layoutClean)).toBe(true);
  expect(num(bare.touches)).toBe(0);
});

test("a state without _G and without the native screen reports unavailable, never throws", () => {
  const frame = run(
    'return { sections = AstraCiv.civilopedia({}), page = AstraCiv.civilopedia({ id = "UNIT_ROMAN_LEGION" }) }',
    { native: false, prelude: "_G = nil" },
  );
  expect(frame.ok, frame.error).toBe(true);
  const sections = object(object(frame.result).sections);
  expect(sections.status).toBe("unavailable");
  expect(str(sections.reason)).toContain("GetSections");
  expect(object(object(frame.result).page).status).toBe("unavailable");
});

test("when the state's globals are not shared the layout is refused and data answers instead", () => {
  const probe = `STUB_RESET()
    local sections = AstraCiv.civilopedia({})
    local query = AstraCiv.civilopedia({ query = "rome" })
    local page = AstraCiv.civilopedia({ id = "UNIT_ROMAN_LEGION" })
    return {
      sections = sections.status,
      query = query.status,
      page = page.status,
      layoutStatus = page.page.layoutStatus,
      source = page.provenance.source,
      provenance = page.provenance,
      cost = page.page.fields.columns.Cost,
      stats = page.page.stats,
      touches = #STUB_UI_TOUCHES,
    }`;
  const bare = object(run(probe, { prelude: "STUB_ISOLATE_GLOBALS()" }).result);
  expect(bare.sections).toBe("complete");
  expect(bare.query).toBe("complete");
  expect(bare.page).toBe("complete");
  expect(bare.layoutStatus).toBe("unavailable");
  expect(bare.source).toBe("data");
  expect(flag(object(bare.provenance).sharedGlobals)).toBe(false);
  expect(num(bare.cost)).toBe(110);
  expect(Object.hasOwn(bare.provenance as object, "environment")).toBe(false);
  expect(num(bare.touches)).toBe(0);
  // The refusal is stated, not silent.
  expect(rowsOf(object(bare.stats as object)).length).toBe(0);
});

test("a page whose layout builder is missing answers with chapter text and backing-row fields", () => {
  const frame = pedia('{ id = "UNIT_ROMAN_VETERAN" }', { setup: "STUB_RESET()" });
  const page = completedPage(frame);
  expect(page.layoutStatus).toBe("unusable");
  expect(page.layoutTemplate).toBe("UnitNoBuilder");
  const provenance = object(object(frame.result).provenance);
  expect(provenance.source).toBe("data");
  expect(provenance.text).toBe("row columns + chapter text");

  // Native chapter text, with the narrative chapter still dropped by chapter id.
  const chapters = chaptersOf(page);
  expect(chapters.map(chapter => chapter.chapterId)).toEqual(["CONTENT"]);
  expect(text(list(chapters[0]!.paragraphs)[0])).toBe("Veteran legionaries hold the line. (mechanics)");
  expect(list(object(page.omitted).chapters).map(object).map(chapter => chapter.chapterId)).toEqual(["HISTORY"]);
  expect(JSON.stringify(page)).not.toContain("The veteran cohort was the backbone");

  // The ruleset's own columns for the row this layout would have read, as data - no screen
  // formatting, no re-derived presentation strings, no stats block.
  const fields = object(page.fields);
  expect(fields.table).toBe("Units");
  const columns = object(fields.columns);
  expect(num(columns.Cost)).toBe(150);
  expect(num(columns.Maintenance)).toBe(3);
  expect(num(columns.Combat)).toBe(45);
  expect(columns.PrereqTech).toBe("TECH_WRITING");
  expect(text(columns.Name)).toBe("Roman Veteran");
  expect(text(columns.Description)).toBe("Veteran legionaries.");
  expect(Object.hasOwn(page, "stats")).toBe(false);
  expect(JSON.stringify(page)).not.toContain("Base Cost:");

  // The reason the layout was not used is stated rather than hidden.
  expect(noteMatching(page, "no builder for UnitNoBuilder")).not.toHaveLength(0);
  // Still no live screen touched.
  const quiet = object(run('STUB_RESET() return { touches = #STUB_UI_TOUCHES, page = AstraCiv.civilopedia({ id = "UNIT_ROMAN_VETERAN" }) }').result);
  expect(num(quiet.touches)).toBe(0);
});

test("the data path carries leader and civilization trait rows with their descriptions", () => {
  const frame = run(
    `STUB_MOD_BBG()
     return {
       trajan = AstraCiv.civilopedia({ id = "LEADER_TRAJAN" }),
       rome = AstraCiv.civilopedia({ id = "CIVILIZATION_ROME" }),
     }`,
    { prelude: "STUB_ISOLATE_GLOBALS()" },
  );
  expect(frame.ok, frame.error).toBe(true);
  const trajan = object(object(frame.result).trajan);
  const rome = object(object(frame.result).rome);
  for (const result of [trajan, rome]) {
    expect(result.status).toBe("complete");
    expect(object(result.provenance).source).toBe("data");
    expect(object(result.page).layoutStatus).toBe("unavailable");
    expect(list(object(result.page).stats)).toEqual([]);
  }

  const leaderFields = object(object(trajan.page).fields);
  expect(leaderFields.table).toBe("Leaders");
  expect(object(leaderFields.columns).LeaderType).toBeUndefined();
  expect(object(leaderFields.columns).InheritFrom).toBe("LEADER_DEFAULT");
  const traits = list(leaderFields.related).map(object);
  // Only traits that carry text survive: the InternalOnly row has no name and no description.
  expect(traits.map(trait => trait.key)).toEqual(["TRAJANS_COLUMN_TRAIT"]);
  expect(traits[0]!.relation).toBe("trait");
  expect(traits[0]!.table).toBe("Traits");
  // The mod's replacement is resolved here too: the data path localizes the same way.
  expect(text(traits[0]!.name)).toBe("Trajan's Column");
  expect(text(traits[0]!.text)).toBe(
    "All founded cities receive a free building in the City Center after unlocking Early Empire.",
  );

  // Chapter text flows beside the fields, with the narrative chapters still dropped by id.
  const chapters = chaptersOf(object(trajan.page));
  expect(chapters.map(chapter => chapter.chapterId)).toEqual(["DETAILED"]);
  expect(list(object(object(trajan.page).omitted).chapters).map(object).map(chapter => chapter.chapterId))
    .toEqual(["CAPSULE", "HISTORY"]);

  const civFields = object(object(rome.page).fields);
  expect(civFields.table).toBe("Civilizations");
  const civTraits = list(civFields.related).map(object);
  // Traits with no name/description (the unit/district ability holders) are bookkeeping here.
  expect(civTraits.map(trait => trait.key)).toEqual(["TRAIT_CIVILIZATION_ALL_ROADS_TO_ROME"]);
  expect(text(civTraits[0]!.text)).toBe("All cities start with a Trading Post. (base ruleset text)");
});

test("the data path prunes flavor columns, names defaults and keeps informative values exactly", () => {
  const frame = run('return AstraCiv.civilopedia({ id = "BUILDING_RUHR_VALLEY" })', {
    prelude: "STUB_ISOLATE_GLOBALS()",
  });
  expect(frame.ok, frame.error).toBe(true);
  const page = completedPage(frame);
  const provenance = object(object(frame.result).provenance);
  expect(provenance.source).toBe("data");
  // Terse labels only; the explanations live in A.civilopediaSpec.
  expect(provenance.text).toBe("row columns + chapter text");
  expect(str(provenance.costs)).toContain("civ.options");

  const fields = object(page.fields);
  expect(fields.table).toBe("Buildings");
  expect(fields.value).toBe("BUILDING_RUHR_VALLEY");
  const columns = object(fields.columns);
  // Informative values, exactly as the row states them.
  expect(num(columns.Cost)).toBe(1240);
  expect(num(columns.MaxPlayerInstances)).toBe(-1);
  expect(num(columns.MaxWorldInstances)).toBe(1);
  expect(columns.PrereqTech).toBe("TECH_INDUSTRIALIZATION");
  expect(columns.ObsoleteEra).toBe("ERA_ATOMIC");
  expect(columns.AdjacentDistrict).toBe("DISTRICT_INDUSTRIAL_ZONE");
  expect(columns.IsWonder).toBe(true);
  expect(columns.RequiresRiver).toBe(true);
  expect(columns.RequiresPlacement).toBe(true);
  expect(text(columns.Name)).toBe("Ruhr Valley");
  expect(text(columns.Description)).toBe("+20% [ICON_Production] Production in this city. (wonder effect)");

  // Flavor columns are dropped from the values and named like omitted chapters are; the narrative
  // text itself never reaches the payload.
  expect(Object.hasOwn(columns, "Quote")).toBe(false);
  expect(Object.hasOwn(columns, "QuoteAudio")).toBe(false);
  expect(JSON.stringify(page)).not.toContain("industrial heart");
  expect(fields.flavorColumns).toBe("Quote QuoteAudio");

  // false/0 columns are named, not valued: the name survives, no value is emitted for them.
  const defaults = str(fields.defaults).split(" ");
  for (const name of ["Capital", "Housing", "Maintenance", "InternalOnly", "MustPurchase", "RegionalRange", "AdjacentCapital"]) {
    expect(defaults).toContain(name);
    expect(Object.hasOwn(columns, name)).toBe(false);
  }
  // The key echo, PrimaryKey and the rowid bookkeeping are dropped, not listed as defaults.
  for (const name of ["BuildingType", "PrimaryKey", "RowId", "rowid"]) {
    expect(Object.hasOwn(columns, name)).toBe(false);
    expect(defaults).not.toContain(name);
  }

  // No empty shells on the data path.
  for (const name of ["stats", "icons", "links", "header", "subHeader", "subtitle", "frontPage", "chapters", "omitted"]) {
    expect(Object.hasOwn(page, name), `${name} shell must be absent`).toBe(false);
  }
  expect(page.layoutStatus).toBe("unavailable");
  expect(num(fields.omittedColumns)).toBeGreaterThan(0);
});

test("the pruning rule holds across unit, district, technology and leader pages", () => {
  const frame = run(
    `STUB_RESET()
     return {
       unit = AstraCiv.civilopedia({ id = "UNIT_ROMAN_LEGION" }),
       district = AstraCiv.civilopedia({ id = "DISTRICT_BATHS" }),
       tech = AstraCiv.civilopedia({ id = "TECH_WRITING" }),
       leader = AstraCiv.civilopedia({ id = "LEADER_TRAJAN" }),
     }`,
    { prelude: "STUB_ISOLATE_GLOBALS()" },
  );
  expect(frame.ok, frame.error).toBe(true);
  const pages = {
    unit: object(object(frame.result).unit),
    district: object(object(frame.result).district),
    tech: object(object(frame.result).tech),
    leader: object(object(frame.result).leader),
  };

  // Shared invariants: data path, complete, sparse shells, no narrative column values anywhere.
  for (const [name, result] of Object.entries(pages)) {
    expect(result.status, name).toBe("complete");
    expect(str(object(result.provenance).source), name).toBe("data");
    const page = object(result.page);
    expect(page.layoutStatus, name).toBe("unavailable");
    for (const shell of ["stats", "icons", "links", "header", "subHeader"]) {
      expect(Object.hasOwn(page, shell), `${name}.${shell} shell`).toBe(false);
    }
    const columns = object(object(page.fields).columns);
    for (const key of Object.keys(columns)) {
      expect(key.toLowerCase().includes("quote"), `${name}.${key} is a narrative column`).toBe(false);
    }
  }

  // A military unit keeps what the user listed, plus its sentinel enums; only the defaults are
  // names and only the bookkeeping/echoes are dropped.
  const unitColumns = object(object(object(pages.unit.page).fields).columns);
  expect(num(unitColumns.Combat)).toBe(40);
  expect(num(unitColumns.Cost)).toBe(110);
  expect(num(unitColumns.BaseMoves)).toBe(2);
  expect(num(unitColumns.Maintenance)).toBe(2);
  expect(unitColumns.MandatoryObsoleteTech).toBe("TECH_GUNPOWDER");
  expect(unitColumns.PromotionClass).toBe("PROMOTION_CLASS_MELEE");
  expect(unitColumns.Domain).toBe("DOMAIN_LAND");
  expect(unitColumns.FormationClass).toBe("FORMATION_CLASS_LAND_COMBAT");
  expect(unitColumns.PrereqTech).toBe("TECH_WRITING");
  expect(unitColumns.StrategicResource).toBe("RESOURCE_IRON");
  expect(unitColumns.PurchaseYield).toBe("YIELD_GOLD");
  expect(unitColumns.CostProgressionModel).toBe("NO_COST_PROGRESSION");
  expect(text(unitColumns.Description)).toBe("Roman unique melee unit.");
  const unitFields = object(object(pages.unit.page).fields);
  const unitDefaults = str(unitFields.defaults).split(" ");
  for (const name of ["AirSlots", "FoundCity", "Spy", "MustPurchase", "Range"]) expect(unitDefaults).toContain(name);
  for (const name of ["UnitType", "PrimaryKey", "RowId", "rowid", "Hash", "Index"]) {
    expect(Object.hasOwn(unitColumns, name), `${name} must be dropped`).toBe(false);
  }
  expect(Object.hasOwn(unitFields, "flavorColumns")).toBe(false);
  // The upgrade relation is carried from the same schema join the native page follows.
  const upgradedTo = list(unitFields.related).map(object);
  expect(upgradedTo.map(entry => entry.relation)).toEqual(["upgradedTo"]);
  expect(upgradedTo[0]!.key).toBe("UNIT_INFANTRY");
  expect(text(upgradedTo[0]!.name)).toBe("Infantry");
  expect(Object.hasOwn(upgradedTo[0]!, "columns")).toBe(false);

  // A district keeps cost/requirements and both sentinels, naming its false/0 columns.
  const districtFields = object(object(pages.district.page).fields);
  const districtColumns = object(districtFields.columns);
  expect(num(districtColumns.Cost)).toBe(290);
  expect(districtColumns.PrereqTech).toBe("TECH_ENGINEERING");
  expect(num(districtColumns.Housing)).toBe(2);
  expect(districtColumns.CostProgressionModel).toBe("NO_COST_PROGRESSION");
  expect(num(districtColumns.TravelTime)).toBe(-1);
  expect(str(districtFields.defaults).split(" ")).toEqual(expect.arrayContaining(["Appeal", "Coast", "ZOC"]));

  // A technology keeps cost/era/description, naming its false defaults.
  const techFields = object(object(pages.tech.page).fields);
  expect(num(object(techFields.columns).Cost)).toBe(25);
  expect(object(techFields.columns).EraType).toBe("ERA_ANCIENT");
  expect(str(techFields.defaults).split(" ")).toEqual(expect.arrayContaining(["Repeatable", "Critical", "EmbarkAll"]));

  // A leader keeps its trait rows with descriptions and drops the identity echo on both levels.
  const leaderFields = object(object(pages.leader.page).fields);
  expect(leaderFields.table).toBe("Leaders");
  expect(Object.hasOwn(object(leaderFields.columns), "LeaderType")).toBe(false);
  const traits = list(leaderFields.related).map(object);
  expect(traits.map(trait => trait.key)).toEqual(["TRAJANS_COLUMN_TRAIT"]);
  expect(text(traits[0]!.text)).toBe("All cities start with an additional City Center building. (base ruleset text)");
  expect(Object.hasOwn(traits[0]!, "columns")).toBe(false);
});

test("a layout that touches no page helper is reported, never a fake-complete empty page", () => {
  const frame = pedia('{ id = "MOD_SILENT" }', { setup: "STUB_RESET()" });
  expect(frame.ok, frame.error).toBe(true);
  const result = object(frame.result);
  expect(result.status).toBe("unsupported");
  expect(result.complete).toBe(false);
  expect(str(result.reason)).toContain("made no page-helper calls");
  expect(object(result.page).layoutStatus).toBe("unsupported");
  expect(Object.hasOwn(object(result.page), "chapters")).toBe(false);
  expect(flag(object(result.provenance).sharedGlobals)).toBe(true);
});

test("the layout path repeats no localized value, no separators and no empty shells", () => {
  const frame = pedia('{ id = "UNIT_ROMAN_LEGION" }', { setup: "STUB_RESET()" });
  const page = completedPage(frame);
  expect(page.layoutStatus).toBe("rendered");
  expect(str(object(object(frame.result).provenance).source)).toBe("layout");

  const boxes = statsOf(page);
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    const rows = rowsOf(box);
    expect(rows.length, `box ${text(box.title)} must have rows`).toBeGreaterThan(0);
    expect(Object.hasOwn(box, "hasContent")).toBe(false);
    for (const row of rows) {
      const value = object(row);
      // A row carries no type label, no nested icon object and no LOC_* key.
      expect(Object.hasOwn(value, "kind")).toBe(false);
      expect(Object.hasOwn(value, "icon")).toBe(false);
      expect(Object.hasOwn(value, "key")).toBe(false);
      if (typeof row === "string") {
        expect(row.startsWith("LOC_")).toBe(false);
      }
      for (const icon of list(value.icons).map(object)) {
        expect(Object.hasOwn(icon, "icon")).toBe(false);
        expect(Object.hasOwn(icon, "name")).toBe(false);
        expect(Object.hasOwn(icon, "key")).toBe(false);
      }
    }
  }
  const iconRow = rowsOf(boxByTitle(page, "Traits")).find(row => str(object(row).term) === "CIVILIZATION_ROME");
  expect(iconRow, "an icon label row is captured").toBeTruthy();
  expect(text(iconRow)).toBe("Rome");
  // An icon list keeps its names once, plus the term, on a page whose layout fills one.
  const tech = completedPage(pedia('{ id = "TECH_WRITING" }'));
  const unlockIcons = rowsOf(boxByTitle(tech, "Unlocks")).flatMap(row => list(object(row).icons).map(object));
  expect(unlockIcons.map(icon => text(icon.text))).toEqual(["Campus", "Library"]);
  expect(unlockIcons.map(icon => icon.term)).toEqual(["DISTRICT_CAMPUS", "BUILDING_LIBRARY"]);
  expect(Object.hasOwn(unlockIcons[0]!, "name")).toBe(false);
  expect(Object.hasOwn(unlockIcons[0]!, "icon")).toBe(false);

  // Links collapse to the resolved identity; no nested match summaries.
  const links = list(page.links).map(object);
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(Object.hasOwn(link, "matches")).toBe(false);
    expect(typeof link.term).toBe("string");
  }
  // A term the cache cannot resolve stays a bare term; a resolvable one carries its page id.
  const upgradeLink = links.find(link => link.term === "UNIT_INFANTRY")!;
  expect(upgradeLink.pageId).toBeUndefined();
  expect(links.find(link => link.term === "TECH_WRITING")!.pageId).toBe("TECH_WRITING");
  expect(links.find(link => link.term === "CIVILIZATION_ROME")!.pageId).toBe("CIVILIZATION_ROME");

  // Empty shells are absent on this path too.
  for (const shell of ["fields", "icons", "header", "subHeader", "subtitle", "frontPage"]) {
    expect(Object.hasOwn(page, shell), `${shell} shell must be absent`).toBe(false);
  }
});

test("the module publishes the contract its catalog entry describes", () => {
  const frame = run("return { spec = AstraCiv.civilopediaSpec, kind = type(AstraCiv.civilopedia) }");
  const spec = object(object(frame.result).spec);
  expect(object(frame.result).kind).toBe("function");
  // The published contract: the same argument names the entry point accepts, the four modes, and
  // the page-field and provenance sections a caller reads.  A.json sorts keys, so order is stable.
  expect(Object.keys(object(spec.args))).toEqual(["id", "limit", "offset", "query", "section"]);
  expect(Object.keys(object(spec.modes))).toEqual(["page", "pages", "query", "sections"]);
  expect(Object.keys(object(spec.page))).toEqual([
    "chapters", "fields", "layoutStatus", "links", "notes", "omitted", "related", "sparse", "stats",
  ]);
  expect(Object.keys(object(spec.provenance))).toEqual([
    "environment", "identity", "isolation", "sharedGlobals", "source", "text",
  ]);
});

test("no arguments lists the native sections, paged, with localized names", () => {
  const listing = pedia("{}");
  expect(listing.ok, listing.error).toBe(true);
  const result = object(listing.result);
  expect(result.mode).toBe("sections");
  expect(result.status).toBe("complete");
  expect(result.complete).toBe(true);
  expect(result.locale).toBe("en_US");
  const sections = list(result.sections).map(object);
  expect(sections.map(section => section.sectionId)).toEqual([
    "CONCEPTS", "CIVILIZATIONS", "LEADERS", "DISTRICTS", "UNITS", "WONDERS", "TECHNOLOGIES", "RESOURCES",
  ]);
  expect(text(sections[2]!.name)).toBe("Leaders");
  expect(num(sections[2]!.pages)).toBe(3);
  expect(num(result.total)).toBe(8);
  expect(flag(result.more)).toBe(false);

  const paged = object(pedia("{ offset = 1, limit = 2 }").result);
  expect(list(paged.sections).map(object).map(section => section.sectionId)).toEqual(["CIVILIZATIONS", "LEADERS"]);
  expect(num(paged.total)).toBe(8);
  expect(flag(paged.more)).toBe(true);
  expect(num(paged.offset)).toBe(1);
  expect(num(paged.limit)).toBe(2);
});

test("a section id lists that section's pages in native order", () => {
  const listing = object(pedia('{ section = "LEADERS", limit = 100 }').result);
  expect(listing.mode).toBe("pages");
  expect(object(listing.section).sectionId).toBe("LEADERS");
  expect(text(object(listing.section).name)).toBe("Leaders");
  const pages = list(listing.pages).map(object);
  expect(pages.map(page => page.pageId)).toEqual(["INTRO", "LEADER_TRAJAN", "LEADER_MINOR_CIV_ATHENS"]);
  expect(text(pages[1]!.title)).toBe("Trajan");
  expect(pages[1]!.layoutId).toBe("Leader");
  expect(pages[0]!.layoutId).toBe("Simple");

  const unknown = object(pedia('{ section = "NOPE" }').result);
  expect(unknown.status).toBe("not_found");
  expect(unknown.complete).toBe(false);
  expect(str(unknown.reason)).toContain("no Civilopedia section has id NOPE");
});

test("hidden pedia entries are invisible because the search reads the native cache", () => {
  const listing = object(pedia('{ section = "RESOURCES" }').result);
  expect(list(listing.pages)).toEqual([]);
  expect(num(listing.total)).toBe(0);

  const query = object(pedia('{ query = "BBG_DUMMY" }').result);
  expect(list(query.pages)).toEqual([]);
  expect(num(query.total)).toBe(0);

  const direct = object(pedia('{ id = "BBG_DUMMY_RESOURCE_MACEDON" }').result);
  expect(direct.status).toBe("not_found");
  expect(str(direct.reason)).toContain("no Civilopedia page in the active cache has id BBG_DUMMY_RESOURCE_MACEDON");
});

test("a query matches ids, localized titles and the ruleset's own search terms", () => {
  const byTitle = object(pedia('{ query = "roman legion" }').result);
  expect(byTitle.mode).toBe("query");
  const titlePages = list(byTitle.pages).map(object);
  expect(titlePages).toHaveLength(1);
  expect(titlePages[0]!.pageId).toBe("UNIT_ROMAN_LEGION");
  expect(titlePages[0]!.sectionId).toBe("UNITS");
  expect(titlePages[0]!.matchedBy).toEqual(["title"]);

  const byId = list(object(pedia('{ query = "LEADER_TRAJAN" }').result).pages).map(object);
  expect(byId[0]!.pageId).toBe("LEADER_TRAJAN");
  expect(byId[0]!.matchedBy).toEqual(["id"]);

  const byTerm = list(object(pedia('{ query = "fusion bombs" }').result).pages).map(object);
  expect(byTerm).toHaveLength(1);
  expect(byTerm[0]!.pageId).toBe("NUKES_1");
  expect(byTerm[0]!.matchedBy).toEqual(["term"]);

  const sections = list(object(pedia('{ query = "unit" }').result).sections).map(object);
  expect(sections.map(section => section.sectionId)).toContain("UNITS");
});

test("a page id that repeats across sections is reported, never silently resolved", () => {
  const ambiguous = object(pedia('{ id = "INTRO" }').result);
  expect(ambiguous.mode).toBe("page");
  expect(ambiguous.status).toBe("ambiguous");
  expect(ambiguous.complete).toBe(false);
  expect(str(ambiguous.reason)).toContain("pass section to choose one");
  expect(list(ambiguous.matches).map(object).map(match => match.sectionId))
    .toEqual(["CONCEPTS", "LEADERS", "UNITS"]);

  const resolved = object(pedia('{ id = "INTRO", section = "LEADERS" }').result);
  expect(resolved.status).toBe("complete");
  expect(object(resolved.page).sectionId).toBe("LEADERS");

  const wrongSection = object(pedia('{ id = "INTRO", section = "RESOURCES" }').result);
  expect(wrongSection.status).toBe("not_found");
  expect(str(wrongSection.reason)).toContain("section RESOURCES has no page id INTRO");
  expect(list(wrongSection.matches).map(object).map(match => match.sectionId))
    .toEqual(["CONCEPTS", "LEADERS", "UNITS"]);

  const unknown = object(pedia('{ id = "TRAJAN" }').result);
  expect(unknown.status).toBe("not_found");
  expect(list(unknown.hint).map(object)[0]!.pageId).toBe("LEADER_TRAJAN");
});

test("a leader page resolves the active locale's ability text, its traits and its links", () => {
  const leader = completedPage(pedia('{ id = "LEADER_TRAJAN" }', { setup: "STUB_MOD_BBG()" }));
  expect(text(leader.title)).toBe("Trajan");
  expect(leader.layoutTemplate).toBe("Leader");

  // The ability text is the mod's replacement, resolved at call time - not the base ruleset
  // string and not a hardcoded value.
  const ability = chaptersOf(leader).find(layer => layer.source === "headerBody");
  expect(ability, "the unique ability chapter was not captured").toBeTruthy();
  expect(text(ability!.header)).toBe("Trajan's Column");
  expect(text(ability!.body)).toBe(
    "All founded cities receive a free building in the City Center after unlocking Early Empire.",
  );

  // The agenda is mechanics; the geography/social box and the quote are flavor.
  const preferences = boxByTitle(leader, "Preferences");
  expect(labelsOf(preferences)).toEqual(expect.arrayContaining([
    "Optimus Princeps",
    "Likes civilizations with large empires.",
  ]));
  expect(statsOf(leader).some(box => text(box.title) === "Geography and Social Data")).toBe(false);
  const omitted = object(leader.omitted);
  expect(list(omitted.statBoxes).map(text)).toEqual(["Geography and Social Data"]);
  expect(num(omitted.quotes)).toBe(1);
  expect(num(omitted.images)).toBe(1);

  // Narrative chapters never reach the page, but they are reported as omitted.
  const chapterIds = chaptersOf(leader).map(layer => layer.chapterId);
  expect(chapterIds).toContain("DETAILED");
  expect(chapterIds).not.toContain("HISTORY");
  expect(chapterIds).not.toContain("CAPSULE");
  expect(list(omitted.chapters).map(object).map(chapter => chapter.chapterId)).toEqual(["CAPSULE", "HISTORY"]);
  const serialized = JSON.stringify(leader);
  expect(serialized).not.toContain("narrative history");
  expect(serialized).not.toContain("Rome is the one civilization you can trust");
  expect(serialized).toContain("Rome wants to get cities down quickly. (playstyle overview)");
});

test("the base ruleset text is what an unmodded game shows for the same page", () => {
  const ability = chaptersOf(completedPage(pedia('{ id = "LEADER_TRAJAN" }')))
    .find(layer => layer.source === "headerBody");
  expect(text(ability!.body)).toBe("All cities start with an additional City Center building. (base ruleset text)");
});

test("a leader that inherits from another leader reports the inherited ability", () => {
  const leader = completedPage(pedia('{ id = "LEADER_MINOR_CIV_ATHENS" }'));
  expect(text(leader.title)).toBe("Athens");
  const inherited = chaptersOf(leader).find(layer => layer.source === "headerBody");
  expect(text(inherited!.header)).toBe("Militaristic");
  expect(text(inherited!.body)).toBe("This city-state maintains a standing army. (inherited trait text)");
});

test("a civilization page carries its ability, unique units and unique infrastructure as links", () => {
  const frame = pedia('{ id = "CIVILIZATION_ROME" }');
  const rome = completedPage(frame);
  expect(text(rome.title)).toBe("Rome");
  // This page came from the registered native layout, not from the data path.
  expect(rome.layoutStatus).toBe("rendered");
  expect(Object.hasOwn(rome, "fields")).toBe(false);
  const provenance = object(object(frame.result).provenance);
  expect(provenance.source).toBe("layout");
  expect(str(provenance.text)).toContain("native layout output");
  const ability = chaptersOf(rome).find(layer => layer.source === "headerBody");
  expect(text(ability!.header)).toBe("All Roads Lead to Rome");

  const rows = rowsOf(boxByTitle(rome, "Traits"));
  expect(rows.some(row => typeof row === "string")).toBe(true);
  expect(rows.filter(row => typeof row === "string").join(" ")).not.toContain("LOC_");
  const unitRow = rows.find(row => str(object(row).term) === "UNIT_ROMAN_LEGION");
  expect(unitRow, JSON.stringify(rows)).toBeTruthy();
  expect(text(unitRow)).toBe("Roman Legion");
  const infrastructureRow = rows.find(row => str(object(row).term) === "DISTRICT_BATHS");
  expect(infrastructureRow).toBeTruthy();
  expect(text(infrastructureRow)).toBe("Bath");

  // Icon terms are the native navigation keys; each link is collapsed to its resolved page id.
  const links = list(rome.links).map(object);
  expect(links.find(link => link.term === "UNIT_ROMAN_LEGION")!.pageId).toBe("UNIT_ROMAN_LEGION");
  expect(links.find(link => link.term === "DISTRICT_BATHS")!.pageId).toBe("DISTRICT_BATHS");
  // A term that resolves to nothing here stays a bare term rather than a fabricated match.
  expect(links.find(link => link.term === "TRAIT_CIVILIZATION_UNIT_ROMAN_LEGION")).toBeUndefined();
});

test("a unit page captures cost, stats, requirements and unique-to, with history omitted", () => {
  const unit = completedPage(pedia('{ id = "UNIT_ROMAN_LEGION" }'));
  expect(text(unit.title)).toBe("Roman Legion");
  const requirements = boxByTitle(unit, "Requirements");
  const requirementRows = rowsOf(requirements);
  expect(labelsOf(requirements)).toEqual(expect.arrayContaining([
    "Base Cost: 110 [ICON_Production] Production",
    "Base Cost: 440 [ICON_Gold] Gold",
    "Base Cost: 2 [ICON_Gold] Gold",
  ]));
  const techRow = requirementRows.find(row => str(object(row).term) === "TECH_WRITING");
  expect(techRow, JSON.stringify(requirementRows)).toBeTruthy();
  // The native localized string is kept as-is, [ICON_x] tokens included.
  const costRow = requirementRows.find(row => text(row).includes("110"));
  expect(text(costRow)).toBe("Base Cost: 110 [ICON_Production] Production");

  const traitRows = rowsOf(boxByTitle(unit, "Traits"));
  const numberRows = traitRows.filter(row => object(row).value !== undefined);
  expect(numberRows.map(row => [object(row).value, text(row)])).toEqual([
    [2, "Movement Points"],
    [40, "Melee Strength"],
  ]);
  const uniqueTo = traitRows.find(row => text(row) === "Rome");
  expect(str(object(uniqueTo).term)).toBe("CIVILIZATION_ROME");

  expect(chaptersOf(unit).some(layer => text(layer.header) === "Description")).toBe(true);
  expect(chaptersOf(unit).every(layer => layer.chapterId !== "HISTORY")).toBe(true);
  expect(list(object(unit.omitted).chapters).map(object).map(chapter => chapter.chapterId)).toEqual(["HISTORY"]);
});

test("a technology page captures prerequisites, unlocks and the research cost", () => {
  const tech = completedPage(pedia('{ id = "TECH_WRITING" }'));
  expect(text(tech.title)).toBe("Writing");
  const unlockIcons = rowsOf(boxByTitle(tech, "Unlocks")).flatMap(row => list(object(row).icons).map(object));
  expect(unlockIcons.map(icon => icon.term)).toEqual(["DISTRICT_CAMPUS", "BUILDING_LIBRARY"]);
  expect(unlockIcons.map(icon => text(icon.text))).toEqual(["Campus", "Library"]);

  const requirementLabels = labelsOf(boxByTitle(tech, "Requirements"));
  expect(requirementLabels).toContain("Ancient Era");
  expect(requirementLabels).toContain("Base Cost: 25 [ICON_Science] Science");
  expect(requirementLabels).toContain("Meet another civilization.");
  const progression = rowsOf(boxByTitle(tech, "Progression"));
  expect(progression.some(row => str(object(row).term) !== "")).toBe(true);
});

test("reading pages never touches the live screen, and the probe can see a real touch", () => {
  const quiet = object(run(`
    STUB_RESET()
    local sections = AstraCiv.civilopedia({})
    local query = AstraCiv.civilopedia({ query = "rome" })
    local leader = AstraCiv.civilopedia({ id = "LEADER_TRAJAN" })
    local unit = AstraCiv.civilopedia({ id = "UNIT_ROMAN_LEGION" })
    local blocked = AstraCiv.civilopedia({ id = "MOD_PANEL" })
    return {
      modes = { sections.mode, query.mode, leader.mode, unit.mode, blocked.status },
      touches = #STUB_UI_TOUCHES,
    }
  `).result);
  expect(quiet.modes).toEqual(["sections", "query", "page", "page", "unsupported"]);
  expect(num(quiet.touches)).toBe(0);

  // The same probe reports a direct native helper call, so the zero above is evidence.
  const noisy = object(run(`
    STUB_RESET()
    AddChapter("LOC_UI_PEDIA_DESCRIPTION", "touched")
    return { touches = #STUB_UI_TOUCHES }
  `).result);
  expect(num(noisy.touches)).toBeGreaterThan(0);
});

test("a layout that reaches for the live screen is refused and answered from data instead", () => {
  const frame = pedia('{ id = "MOD_PANEL" }', { setup: "STUB_RESET()" });
  expect(frame.ok, frame.error).toBe(true);
  const result = object(frame.result);
  const page = object(result.page);
  expect(result.status).toBe("unsupported");
  expect(result.complete).toBe(false);
  expect(page.layoutStatus).toBe("unsupported");
  expect(str(result.reason)).toContain("touches the live screen");
  expect(str(result.reason)).toContain("Controls");
  expect(str(object(result.provenance).source)).toBe("data");
  expect(list(noteMatching(page, "Controls"))).not.toHaveLength(0);
  expect(Object.hasOwn(page, "chapters")).toBe(false);
  expect(Object.hasOwn(page, "stats")).toBe(false);
});

test("a layout that needs a native helper this context lacks fails visibly", () => {
  const result = object(pedia('{ id = "MOD_HELPER" }', { setup: "STUB_RESET()" }).result);
  expect(result.status).toBe("unsupported");
  expect(str(result.reason)).toContain("STUB_MISSING_HELPER");
  expect(object(result.page).layoutStatus).toBe("unsupported");
});

test("a failing layout returns a labelled partial capture and restores every helper", () => {
  const frame = pedia('{ id = "MOD_BROKEN" }', { setup: "STUB_RESET()" });
  expect(frame.ok, frame.error).toBe(true);
  const result = object(frame.result);
  expect(result.status).toBe("error");
  expect(result.complete).toBe(false);
  expect(result.partial).toBe(true);
  expect(str(result.reason)).toContain("mod layout exploded halfway");
  const layers = chaptersOf(object(result.page));
  expect(text(list(layers[0]!.paragraphs)[0])).toBe("captured before the failure");
});

test("after a failing layout the helpers, the screen table and the layout flag are untouched", () => {
  const probe = object(run(`
    STUB_RESET()
    local ok = pcall(AstraCiv.civilopedia, { id = "MOD_BROKEN" })
    local after = STUB_ORIGINALS
    return {
      ok = ok,
      addChapter = AddChapter == after.AddChapter,
      chapters = GetPageChapters == after.GetPageChapters,
      setPageHeader = SetPageHeader == after.SetPageHeader,
      builder = PageLayouts.Leader == after.LeaderBuilder,
      controls = Controls == after.Controls,
      layoutClean = _PageContentLayout == nil,
      touches = #STUB_UI_TOUCHES,
    }
  `).result);
  expect(probe.ok).toBe(true);
  expect(flag(probe.addChapter)).toBe(true);
  expect(flag(probe.chapters)).toBe(true);
  expect(flag(probe.setPageHeader)).toBe(true);
  expect(flag(probe.builder)).toBe(true);
  expect(flag(probe.controls)).toBe(true);
  expect(flag(probe.layoutClean)).toBe(true);
  expect(num(probe.touches)).toBe(0);
});

test("layouts with no builder or no registered template are unsupported, never invented", () => {
  const ghost = object(pedia('{ id = "GHOST" }').result);
  expect(ghost.status).toBe("unsupported");
  expect(str(ghost.reason)).toContain("GhostPage");
  expect(str(ghost.reason)).toContain("no builder for GhostPage");
  expect(object(ghost.page).layoutStatus).toBe("unusable");
  expect(Object.hasOwn(object(ghost.page), "chapters")).toBe(false);
  expect(str(object(ghost.provenance).source)).toBe("data");

  const nowhere = object(pedia('{ id = "NOWHERE" }').result);
  expect(nowhere.status).toBe("unsupported");
  expect(str(nowhere.reason)).toContain("no ScriptTemplate for Unregistered");
  expect(object(nowhere.page).layoutStatus).toBe("unusable");
});

test("a large page survives the bridge's chunk framing", () => {
  const frame = pedia('{ id = "CITIES_1" }', { setup: "STUB_RESET()" });
  const cities = completedPage(frame);
  expect(frame.parts).toBeGreaterThan(1);
  const chapter = chaptersOf(cities)[0]!;
  const paragraphs = list(chapter.paragraphs);
  expect(paragraphs).toHaveLength(2);
  expect(text(paragraphs[0])).toBe("Cities are founded by Settlers. (mechanics)");
  expect(text(paragraphs[1]).length).toBeGreaterThan(3000);
  expect(chapter.chapterId).toBe("CONTENT");
  expect(chapter.header).toBeNull();
});

test("an expansion-only layout keeps its mechanical chapters and still drops history", () => {
  const page = completedPage(pedia('{ id = "DISASTERS_1" }'));
  expect(page.layoutTemplate).toBe("EnvironmentalEffects");
  const chapters = chaptersOf(page);
  const volcanoes = chapters.find(chapter => chapter.chapterId === "VOLCANOES");
  expect(volcanoes, JSON.stringify(chapters)).toBeTruthy();
  expect(text(list(volcanoes!.paragraphs)[0])).toBe("Volcanic eruptions damage tiles and units. (mechanics)");
  expect(text(volcanoes!.header)).toBe("Volcanoes");
  expect(chapters.every(chapter => chapter.chapterId !== "HISTORY")).toBe(true);
  expect(list(object(page.omitted).chapters).map(object).map(chapter => chapter.chapterId)).toEqual(["HISTORY"]);
  expect(JSON.stringify(page)).not.toContain("Vesuvius");
});

test("a replaced page builder is what runs, because the reader resolves it per call", () => {
  const probe = object(run(`
    STUB_RESET()
    local before = AstraCiv.civilopedia({ id = "CITIES_1" })
    local original = PageLayouts.Simple
    PageLayouts.Simple = function(page)
      SetPageHeader(page.Title)
      AddHeader("LOC_UI_PEDIA_DESCRIPTION")
      AddParagraph("Replaced by the expansion copy of the page file.")
    end
    local replaced = AstraCiv.civilopedia({ id = "CITIES_1" })
    PageLayouts.Simple = original
    return {
      before = before.page.chapters[1].paragraphs[1],
      replaced = replaced.page.chapters[2].paragraphs[1],
      builder = replaced.page.layoutTemplate,
      restored = PageLayouts.Simple == original,
      touches = #STUB_UI_TOUCHES,
    }
  `).result);
  expect(probe.before).toBe("Cities are founded by Settlers. (mechanics)");
  expect(probe.replaced).toBe("Replaced by the expansion copy of the page file.");
  expect(probe.builder).toBe("Simple");
  expect(flag(probe.restored)).toBe(true);
  expect(num(probe.touches)).toBe(0);
});

test("the front page reports its layout flag and bad arguments are refused", () => {
  const front = completedPage(pedia('{ id = "INTRO", section = "CONCEPTS" }'));
  expect(flag(front.frontPage)).toBe(true);
  expect(front.layoutTemplate).toBe("FrontPage");
  expect(Object.hasOwn(front, "header")).toBe(false);

  const conflict = pedia('{ query = "rome", id = "CIVILIZATION_ROME" }');
  expect(conflict.ok).toBe(false);
  expect(str(conflict.error)).toContain("query or id, not both");

  const badLimit = pedia("{ limit = 0 }");
  expect(badLimit.ok).toBe(false);
  expect(str(badLimit.error)).toContain("limit must be an integer 1..100");
});
