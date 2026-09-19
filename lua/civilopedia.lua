-- ===========================================================================
--  Civilopedia: read the active ruleset's encyclopedia from code.
--
--  This module runs inside the already-loaded CivilopediaScreen Lua state and
--  reads that context's own cache and page builders.  It never opens, closes,
--  scrolls, selects or re-renders the live screen: for the length of one page build the
--  layout helpers, the cache accessors a layout reads and the blocked screen/hook names
--  are swapped for capture sinks by name, the layout then runs as the screen would run
--  it, and every name is restored and read back before the call returns - also on error.
--  That state's base library is trimmed (no _G, no getfenv, no setfenv), so the swap is
--  addressed through per-name accessors and may run only when a cross-file probe proves a
--  global written here is read by functions defined in other files.
--
--  Native interface used, from the installed game (D:/SteamLibrary/.../Sid Meier's
--  Civilization VI).  Line numbers are the shipped files; the expansion copies
--  re-register the same globals, so a GS game reads GS layouts automatically:
--
--    Base/Assets/UI/Civilopedia/CivilopediaScreen.lua:6-13
--      include("CivilopediaSupport"); include("CivilopediaPage_", true); Initialize()
--    Base/Assets/UI/Civilopedia/CivilopediaSupport.lua:52-70
--      globals _Sections/_PagesBySection/_PagesById/_ChaptersByPageLayout/
--      _PageLayoutScriptTemplates and PageLayouts
--    CivilopediaSupport.lua:78-423   CacheData (Fetch/Process/Sort) - the cache this module reads
--    CivilopediaSupport.lua:480-580  GetSections/GetPages/GetPage/GetPageChapters/
--                                    GetChapterHeader/GetChapterBody
--    CivilopediaSupport.lua:1441-1794 the layout helpers page builders call
--                                    (SetPageHeader/AddChapter/AddRightColumnStatBox/...)
--    Base/Assets/UI/Civilopedia/CivilopediaPage_*.lua
--    DLC/Expansion2/UI/Civilopedia/CivilopediaPage_*.lua
--      one builder per layout, stored as PageLayouts[ScriptTemplate]; the GS files
--      replace the base entries for Unit/Building/Policy/Resource/Route/...
--    Base/Assets/Gameplay/Data/Civilopedia.xml:1-385 and
--    DLC/Expansion2/Data/{Expansion1,Expansion2}_Civilopedia.xml
--      sections, pages, page groups, chapter maps and layout -> template rows
--
--  Everything is read through the native accessors and builders, so it honors the
--  active ruleset and locale: mod gameplay data (rows, traits, page excludes) and
--  mod localization (e.g. Better Balanced Game's ability rewrites) are whatever the
--  screen itself would render.  A page is produced by the layout builder registered for
--  its PageLayoutId; when that builder cannot run here (no builder or template in this
--  context, refused because it reaches the live screen, globals not shared across files,
--  or a build that failed), the page is answered from the same native data instead - its
--  own chapter text plus the GameInfo row behind its LayoutId - and provenance.source
--  names which path ran.
--  This module never runs SQL of its own, never evaluates model-supplied code, and never
--  fabricates a value the page did not produce - an unsupported layout, a missing
--  dependency or a failed build is reported as such instead of being filled in.
-- ===========================================================================

local A = AstraCiv

local DEFAULT_LIMIT = 50
local MAX_LIMIT = 100
local MAX_TEXT = 32000   -- characters of page text captured per page before truncation is reported
local MAX_HINT = 5       -- "did you mean" pages attached to a not_found id
local MAX_NOTES = 12     -- per-page structural notes kept in the result

-- Chapters the shipped chapter map uses for narrative/flavor rather than mechanics.
-- Source: Base/Assets/Gameplay/Data/Civilopedia.xml:357-385 plus the expansion
-- Civilopedia files (CivilopediaPageLayoutChapters).  HISTORY is the historical
-- biography (LOC_PEDIA_<SECTION>_PAGE_<PAGE>_CHAPTER_HISTORY_PARA_*); CAPSULE is the
-- leader blurb.  DETAILED (leader gameplay overview) and the expansion chapter ids
-- (CONGRESS, FAVOR, RESOLUTIONS, VOLCANOES, ...) are mechanics-bearing and are kept.
-- The test is the native ChapterId, never the localized English text.
local FLAVOR_CHAPTERS = { HISTORY = true, CAPSULE = true }

-- Stat boxes that carry geography/social flavor rather than mechanics.  Keyed on the
-- native title key the layout passes to AddRightColumnStatBox (CivilopediaPage_Leader.lua:204),
-- not on the localized caption.
local FLAVOR_STAT_BOXES = { LOC_UI_PEDIA_GEOGRAPHY_AND_SOCIAL_DATA = true }

-- Globals a page layout must not reach.  Two groups: the live screen/input/event namespaces
-- (mutating or hook-installing), and the cache/navigation entry points that would rebuild or
-- move the screen.  A layout that reads one of these fails visibly instead of silently
-- touching the live Civilopedia.
local BLOCKED_GLOBALS = {
  Controls = true, UIManager = true, ContextPtr = true, InstanceManager = true,
  Input = true, UI = true, Mouse = true, Keys = true, Network = true,
  LuaEvents = true, Events = true, GameEvents = true, exposedMembers = true,
  include = true, DB = true, _G = true,
  CacheData = true, CacheData_FetchData = true, CacheData_ProcessData = true, CacheData_SortData = true,
  PopulateSearchData = true, Initialize = true, Shutdown = true,
  RefreshSections = true, RefreshPageTabs = true, RefreshPageContent = true, ResetPageContent = true,
  NavigateTo = true, NavigateToPageTrailIndex = true, UpdateCrumbHighlight = true,
  OnClose = true, OnOpenCivilopedia = true, OnToggleCivilopedia = true,
  OnNavForward = true, OnNavBackward = true,
}

-- ---------------------------------------------------------------------------
-- Text and identity helpers.
-- ---------------------------------------------------------------------------

local function trim(value)
  if type(value) ~= 'string' then return nil end
  return (value:gsub('^%s+', ''):gsub('%s+$', ''))
end

local function lower(value)
  if type(value) ~= 'string' then return '' end
  local ok, text = pcall(Locale.ToLower, value)
  if ok and type(text) == 'string' then return text end
  return value:lower()
end

--- Plain substring test (never a Lua pattern, so model-supplied text is inert).
local function contains(value, needle)
  return type(value) == 'string' and value:find(needle, 1, true) ~= nil
end

--- One localized string per value, with no internal trace of how it got that way: the ruleset's
--- LOC_* key is not repeated (localization already happened here, at call time, so the active
--- locale and any mod override like BBG apply) and the marked-up native text is what the screen
--- renders ([ICON_x] tokens are self-describing), so no stripped duplicate is carried either.
local function localized(value)
  if type(value) ~= 'string' or value == '' then return A.null end
  return A.loc(value)
end

--- A string the native cache already localized (page.Title, page.SubTitle, section.TabName).
local function cachedText(value)
  if type(value) ~= 'string' or value == '' then return A.null end
  return value
end

local function paginate(list, offset, limit)
  local out, total = A.array(), #list
  for index = offset + 1, math.min(total, offset + limit) do out[#out + 1] = list[index] end
  return out, total, offset + #out < total
end

-- ---------------------------------------------------------------------------
-- The native cache.
-- ---------------------------------------------------------------------------

--- Locate the native Civilopedia cache accessors.  A missing accessor means this Lua state
--- is not a loaded Civilopedia screen (or the screen never initialized), which is reported
--- instead of reading some other, unrelated global of the same name.
local function cache()
  -- Checked by direct global read (this state defines no _G) so the reason lists exactly which
  -- accessors are missing, in a stable order.
  local names = { 'GetSections', 'GetPages', 'GetPage', 'GetPageChapters', 'GetChapterHeader', 'GetChapterBody' }
  local accessors = { GetSections, GetPages, GetPage, GetPageChapters, GetChapterHeader, GetChapterBody }
  local missing = A.array()
  for index = 1, #names do
    if type(accessors[index]) ~= 'function' then missing[#missing + 1] = names[index] end
  end
  if type(PageLayouts) ~= 'table' or type(_PageLayoutScriptTemplates) ~= 'table' then
    missing[#missing + 1] = 'PageLayouts/_PageLayoutScriptTemplates'
  end
  if #missing > 0 then
    return nil, 'native Civilopedia cache unavailable in this Lua state (' .. table.concat(missing, ', ')
      .. '); context must be the loaded CivilopediaScreen'
  end
  local sections = GetSections()
  if type(sections) ~= 'table' or #sections == 0 then
    return nil, 'the native Civilopedia cache is empty; the screen has not run CacheData yet'
  end
  -- The accessor *function values* are captured here, before any capture swaps globals: a sink that
  -- re-read the global by name would call itself once the swap is installed.
  return {
    sections = sections,
    layouts = PageLayouts,
    templates = _PageLayoutScriptTemplates,
    chapters = GetPageChapters,
    chapterHeader = GetChapterHeader,
    chapterBody = GetChapterBody,
  }
end

--- Flat view of the cache: sections in native order, pages in native order, plus the
--- section/page indexes search and link resolution need.  Hidden pedia entries are already
--- gone from GetSections/GetPages (CacheData_FetchData applies CivilopediaSectionExcludes/
--- CivilopediaPageExcludes/CivilopediaPageGroupExcludes, CivilopediaSupport.lua:81-96), so
--- they can never leak into a listing or a search here.
local function catalog(native)
  local out = { entries = A.array(), bySection = {}, byKey = {} }
  for _, section in ipairs(native.sections) do
    local pages = GetPages(section.SectionId)
    out.bySection[section.SectionId] = pages
    if type(pages) == 'table' then
      for _, page in ipairs(pages) do
        local entry = { section = section, page = page }
        out.entries[#out.entries + 1] = entry
        out.byKey[section.SectionId .. '::' .. page.PageId] = entry
      end
    end
  end
  return out
end

local function sectionSummary(section)
  local pages = GetPages(section.SectionId)
  return {
    sectionId = section.SectionId,
    name = cachedText(section.TabName or section.Name),
    icon = section.Icon or A.null,
    pages = type(pages) == 'table' and #pages or 0,
  }
end

local function pageSummary(entry)
  local page = entry.page
  return {
    sectionId = page.SectionId,
    pageId = page.PageId,
    title = cachedText(page.Title or page.Name),
    groupId = page.PageGroupId or A.null,
    layoutId = page.PageLayoutId or A.null,
  }
end

--- Every cache page with this id (exact first, then case-insensitive), in native order.
--- Page ids repeat across sections (INTRO exists in every section), so this is always a list.
local function pagesWithId(cat, wanted)
  local out = A.array()
  for _, entry in ipairs(cat.entries) do
    if entry.page.PageId == wanted then out[#out + 1] = entry end
  end
  if #out == 0 then
    local loose = lower(wanted)
    for _, entry in ipairs(cat.entries) do
      if lower(entry.page.PageId) == loose then out[#out + 1] = entry end
    end
  end
  return out
end

local function sectionWithId(native, wanted)
  for _, candidate in ipairs(native.sections) do
    if candidate.SectionId == wanted then return candidate end
  end
  local loose = lower(wanted)
  for _, candidate in ipairs(native.sections) do
    if lower(candidate.SectionId) == loose then return candidate end
  end
  return nil
end

-- ---------------------------------------------------------------------------
-- Search.  Matches the native cache the screen renders from: page ids and the raw page
-- name key, the already-localized page title, and the ruleset's own Civilopedia search
-- terms (GameInfo.CivilopediaPageSearchTerms, the table PopulateSearchData indexes into the
-- full-text context).  Matching is case-insensitive through Locale.ToLower (the idiom native
-- search UIs use, e.g. MapSearchPanel.lua:176) - never through English word lists.
-- ---------------------------------------------------------------------------

local function searchTerms()
  local out = A.array()
  if type(GameInfo) ~= 'table' then return out end
  -- GameInfo.X() is itself the iterator in this engine (native idiom: `for row in GameInfo.X() do`,
  -- e.g. lua/decisions.lua), so it is called through pcall for a missing table/ruleset.
  local ok, iterator = pcall(GameInfo.CivilopediaPageSearchTerms)
  if not ok or iterator == nil then return out end
  for row in iterator do
    local sectionId = row.SectionId or row.SectionID
    if type(sectionId) == 'string' and type(row.PageId) == 'string' then
      local term = A.loc(row.Term)
      if type(term) == 'string' and term ~= '' then
        out[#out + 1] = { sectionId = sectionId, pageId = row.PageId, term = term }
      end
    end
  end
  return out
end

local function search(cat, query)
  local needle = lower(query)
  local matches, order = {}, A.array()
  local function mark(entry, kind)
    local key = entry.page.SectionId .. '::' .. entry.page.PageId
    local found = matches[key]
    if not found then
      found = { entry = entry, by = {} }
      matches[key] = found
      order[#order + 1] = found
    end
    found.by[kind] = true
  end
  for _, entry in ipairs(cat.entries) do
    local page = entry.page
    if contains(lower(page.PageId), needle) or contains(lower(page.Name), needle) then mark(entry, 'id') end
    if contains(lower(page.Title), needle) then mark(entry, 'title') end
  end
  for _, term in ipairs(searchTerms()) do
    if contains(lower(term.term), needle) then
      local entry = cat.byKey[term.sectionId .. '::' .. term.pageId]
      if entry then mark(entry, 'term') end
    end
  end
  local out = A.array()
  for _, found in ipairs(order) do
    local summary = pageSummary(found.entry)
    local by = A.array()
    for _, kind in ipairs({ 'id', 'title', 'term' }) do
      if found.by[kind] then by[#by + 1] = kind end
    end
    summary.matchedBy = by
    out[#out + 1] = summary
  end
  return out
end

local function sectionMatches(native, query)
  local needle = lower(query)
  local out = A.array()
  for _, section in ipairs(native.sections) do
    if contains(lower(section.SectionId), needle) or contains(lower(section.Name), needle)
      or contains(lower(section.TabName), needle) then
      out[#out + 1] = sectionSummary(section)
    end
  end
  return out
end

-- ---------------------------------------------------------------------------
-- Page capture.
--
-- The page body is produced by the real layout builder for the page's PageLayoutId
-- (PageLayouts[_PageLayoutScriptTemplates[PageLayoutId]](page)), with every layout helper it
-- can call replaced by a sink that records the same arguments the native helper would hand to
-- the screen.  Native semantics that decide *whether* something is rendered are reproduced,
-- including the two-column inference (`_PageContentLayout`) and the "header and paragraphs are
-- both required" guards, so the captured page matches what the screen would show.
-- ---------------------------------------------------------------------------

--- An icon a layout passes to a stat box or to HookupIcon: a bare icon string, or
--- {icon, tooltip/name, searchTerm, color} (HookupIcon, CivilopediaSupport.lua:1374-1388).
--- The search term is what the native button navigates to (CivilopediaSearch(term, 1)), so it is
--- also the cross-reference this module resolves against the cache.  The decorative atlas name
--- (icon[1]) is dropped - it carries no readable value - and the localized name is emitted once, as
--- this entry's `text`; a row that also carries the same caption keeps only that caption (see
--- dedupeText) so no localized string is repeated inside one payload.
local function iconRef(capture, value)
  if value == nil or type(value) ~= 'table' then return A.null end
  local out = {}
  local name = localized(value[2])
  if name ~= A.null then out.text = name end
  if type(value[3]) == 'string' and value[3] ~= '' then
    out.term = value[3]
    if not capture.linkSeen[value[3]] then
      capture.linkSeen[value[3]] = true
      capture.linkTerms[#capture.linkTerms + 1] = value[3]
    end
  end
  if out.text == nil and out.term == nil then return A.null end
  return out
end

--- The sinks installed for one page build, plus the capture they fill.
local function buildCapture(page, chapterPlan, native)
  local capture = {
    page = page,
    layers = A.array(),
    stats = A.array(),
    icons = A.array(),
    notes = A.array(),
    omittedChapters = A.array(),
    omittedStatBoxes = A.array(),
    linkTerms = A.array(),
    linkSeen = {},
    bodyChapter = {},
    headerChapter = chapterPlan.byHeader,
    layout = nil,
    header = A.null,
    subHeader = A.null,
    frontPage = false,
    images = 0,
    quotes = 0,
    textChars = 0,
    dropped = 0,
    failed = nil,
    calls = 0,
  }
  for _, chapterId in ipairs(chapterPlan.omitted) do
    capture.omittedChapters[#capture.omittedChapters + 1] = { chapterId = chapterId }
  end

  local function note(message)
    if #capture.notes < MAX_NOTES then capture.notes[#capture.notes + 1] = message end
    capture.failed = capture.failed or message
  end

  local function budgeted(value)
    local entry = localized(value)
    if entry == A.null then return A.null end
    if capture.textChars + #entry > MAX_TEXT then
      capture.dropped = capture.dropped + 1
      return A.null
    end
    capture.textChars = capture.textChars + #entry
    return entry
  end

  local function paragraphs(value)
    local out = A.array()
    if type(value) == 'string' then value = { value } end
    if type(value) ~= 'table' then return out end
    for index = 1, #value do
      local entry = budgeted(value[index])
      if entry ~= A.null then out[#out + 1] = entry end
    end
    return out
  end

  --- Which native chapter a captured piece of text belongs to: by the body table the native
  --- GetChapterBody handed out (identity, so the Simple layout's "hide the header" branch is
  --- still attributed), or by the chapter header text key the layout passed.
  local function chapterIdFor(headerValue, body)
    if type(body) == 'table' and capture.bodyChapter[body] then return capture.bodyChapter[body] end
    if type(headerValue) == 'string' and capture.headerChapter[headerValue] then
      return capture.headerChapter[headerValue]
    end
    return A.null
  end

  local function layer(entry)
    entry.chapterId = entry.chapterId or A.null
    entry.paragraphs = entry.paragraphs or A.array()
    capture.layers[#capture.layers + 1] = entry
  end

  local function textLayer(source, headerValue, bodyValue)
    local header = budgeted(headerValue)
    layer({
      source = source,
      header = headerValue == nil and A.null or header,
      paragraphs = paragraphs(bodyValue),
      chapterId = chapterIdFor(headerValue, bodyValue),
    })
  end

  local function headerBodyLayer(source, headerValue, bodyValue, iconValue)
    if capture.layout ~= 'two-column' then
      note('the native full-width header+body renderer is NYI (CivilopediaSupport.lua:1472);'
        .. ' content captured, the live page would not render it')
    end
    local icons = A.array()
    if iconValue ~= nil then icons[#icons + 1] = iconRef(capture, iconValue) end
    layer({
      source = source,
      header = budgeted(headerValue),
      body = budgeted(bodyValue),
      icons = icons,
      chapterId = chapterIdFor(headerValue, nil),
    })
  end

  local function statBox(titleKey, populate)
    if type(titleKey) == 'string' and FLAVOR_STAT_BOXES[titleKey] then
      capture.omittedStatBoxes[#capture.omittedStatBoxes + 1] = localized(titleKey)
      return
    end
    local box = { title = localized(titleKey), rows = A.array() }
    local hasContent = false
    local function push(entry) box.rows[#box.rows + 1] = entry end
    local function content(entry) hasContent = true; push(entry) end
    local sink = {}
    -- Native layouts call these with ':' (CivilopediaPage_*.lua `s:AddHeader(...)`); the first
    -- parameter is the receiver.  A separator is a visual divider with nothing readable, so it is
    -- not recorded; the two-column inference it feeds is kept through hasContent.  Rows carry no
    -- type label: a plain string is a header, an object is a value row (text, value, term, icons).
    function sink.AddSeparator(_) end
    function sink.AddHeader(_, caption)
      if caption == nil then error('Caption must not be nil') end
      local header = budgeted(caption)
      if header ~= A.null then content(header) end
    end
    function sink.AddLabel(_, caption)
      if caption == nil then error('Caption must not be nil') end
      local label = budgeted(caption)
      if label ~= A.null then content({ text = label }) end
    end
    function sink.AddSmallLabel(_, caption)
      if caption == nil then error('Caption must not be nil') end
      local label = budgeted(caption)
      if label ~= A.null then content({ text = label }) end
    end
    function sink.AddIconLabel(_, icon, caption)
      if icon == nil then error('Icon must not be nil') end
      if caption == nil then error('Caption must not be nil') end
      local label = budgeted(caption)
      local ref = iconRef(capture, icon)
      if label == A.null and (ref == A.null or ref.term == nil) then return end
      local row = {}
      if label ~= A.null then row.text = label end
      if ref ~= A.null and ref.term ~= nil then row.term = ref.term end
      content(row)
    end
    function sink.AddIconNumberLabel(_, icon, value, caption)
      if value == nil then error('Value must not be nil') end
      if caption == nil then error('Caption must not be nil') end
      local label = budgeted(caption)
      local ref = iconRef(capture, icon)
      local row = {
        value = type(value) == 'number' and value or budgeted(value),
      }
      if label ~= A.null then row.text = label end
      if ref ~= A.null and ref.term ~= nil then row.term = ref.term end
      content(row)
    end
    function sink.AddIconList(_, icon1, icon2, icon3, icon4)
      local icons = A.array()
      local candidates = { icon1, icon2, icon3, icon4 }
      for index = 1, 4 do
        if candidates[index] ~= nil then
          local ref = iconRef(capture, candidates[index])
          if ref ~= A.null then icons[#icons + 1] = ref end
        end
      end
      -- An icon list whose entries carry no name and no link has nothing readable to report.
      if #icons > 0 then content({ icons = icons }) end
    end
    if populate ~= nil then
      local ok, err = pcall(populate, sink)
      if not ok then note('stat box ' .. tostring(titleKey) .. ' failed: ' .. tostring(err)) end
    end
    -- The native stat box hides itself when no content was added (CivilopediaSupport.lua:1786-1793),
    -- so a box left without rows is not part of the rendered page and is not reported.
    if #box.rows > 0 then capture.stats[#capture.stats + 1] = box end
    if hasContent then capture.layout = 'two-column' end
  end

  local sinks = {}
  sinks.SetPageHeader = function(caption) capture.header = localized(caption) end
  sinks.SetPageSubHeader = function(caption) capture.subHeader = localized(caption) end
  sinks.ShowFrontPageHeader = function() capture.frontPage = true end

  local function chapter(header, value)
    if header == nil or value == nil then return end   -- native renders nothing without both
    textLayer('chapter', header, value)
  end
  sinks.AddChapter = chapter
  sinks.AddFullWidthChapter = chapter
  sinks.AddLeftColumnChapter = chapter

  local function headerOnly(caption)
    if caption == nil then return end
    layer({ source = 'header', header = budgeted(caption), paragraphs = A.array() })
  end
  sinks.AddHeader = headerOnly
  sinks.AddFullWidthHeader = headerOnly
  sinks.AddLeftColumnHeader = headerOnly

  local function paragraph(value)
    if value == nil then return end
    textLayer('paragraph', nil, value)
  end
  sinks.AddParagraph = paragraph
  sinks.AddFullWidthParagraph = paragraph
  sinks.AddLeftColumnParagraph = paragraph
  sinks.AddParagraphs = paragraph
  sinks.AddFullWidthParagraphs = paragraph
  sinks.AddLeftColumnParagraphs = paragraph

  local function headerBody(header, body) headerBodyLayer('headerBody', header, body, nil) end
  local function iconHeaderBody(icon, header, body) headerBodyLayer('iconHeaderBody', header, body, icon) end
  sinks.AddHeaderBody = headerBody
  sinks.AddLeftColumnHeaderBody = headerBody
  sinks.AddIconHeaderBody = iconHeaderBody
  sinks.AddLeftColumnIconHeaderBody = iconHeaderBody

  local function image(value)
    if value == nil then return end
    capture.images = capture.images + 1
    capture.layout = 'two-column'
  end
  sinks.AddImage = image
  sinks.AddTallImage = image
  sinks.AddTallImageNoScale = image
  sinks.AddPortrait = image
  sinks.AddTallPortrait = function(icon)
    if icon ~= nil then capture.images = capture.images + 1 end
    capture.layout = 'two-column'   -- native sets the layout outside the icon guard (:1608-1615)
  end
  sinks.AddQuote = function(quote)
    if type(quote) == 'string' and #quote > 0 then capture.quotes = capture.quotes + 1 end
    capture.layout = 'two-column'   -- native sets the layout outside the quote guard (:1618-1639)
  end
  sinks.AddRightColumnStatBox = statBox
  sinks.HookupIcon = function(icon)
    local ref = iconRef(capture, icon)
    if ref ~= A.null then capture.icons[#capture.icons + 1] = ref end
  end

  -- The Do_* helpers are what the Add* wrappers call with the support file's private instance
  -- managers.  A layout cannot reach those managers, but a mod layout may still call the
  -- global Do_* helpers directly with its own managers; capturing them keeps that path from
  -- creating real UI instances.
  sinks.Do_AddChapterWithParagraphs = function(_, _, header, value) chapter(header, value) end
  sinks.Do_AddHeader = function(_, caption) headerOnly(caption) end
  sinks.Do_AddParagraph = function(_, value) paragraph(value) end
  sinks.Do_AddParagraphs = function(_, value) paragraph(value) end
  sinks.Do_AddHeaderBody = function(_, header, body) headerBody(header, body) end
  sinks.Do_AddIconHeaderBody = function(_, icon, header, body) iconHeaderBody(icon, header, body) end

  -- GetPageChapters is filtered for this page so narrative chapters are never fetched or
  -- rendered; GetChapterHeader/GetChapterBody are wrapped to remember which chapter a body
  -- belongs to (identity, not header text).
  -- These call the accessors captured when the call started (native.*), never the globals by name:
  -- with the swap installed the global name is this sink.
  sinks.GetPageChapters = function(layoutId)
    if layoutId == capture.page.PageLayoutId then return chapterPlan.kept end
    return native.chapters(layoutId)
  end
  sinks.GetChapterHeader = function(sectionId, pageId, chapterId)
    return native.chapterHeader(sectionId, pageId, chapterId)
  end
  sinks.GetChapterBody = function(sectionId, pageId, chapterId)
    local body = native.chapterBody(sectionId, pageId, chapterId)
    if type(body) == 'table' then capture.bodyChapter[body] = chapterId end
    return body
  end

  -- Count intercepted calls: a layout that touches none of these helpers cannot have rendered
  -- anything through this reader, which the caller reports instead of an empty page.
  for name, sink in pairs(sinks) do
    sinks[name] = function(...)
      capture.calls = capture.calls + 1
      return sink(...)
    end
  end

  return capture, sinks
end

--- Refuse a blocked global from layout code with the name.
local blockedReplacements = setmetatable({}, {
  __index = function(cache, name)
    local replacement = setmetatable({}, {
      __index = function() error('civilopedia: blocked global ' .. name .. ' touched by page layout', 0) end,
    })
    -- Plain assignment, not rawset: this state's base library is trimmed (no rawset/rawget), and an
    -- assignment already writes the table itself rather than going through __index.
    cache[name] = replacement
    return replacement
  end,
})

--- Static, name-addressed accessors for every global a page build may intercept or must block.
---
--- Civ's CivilopediaScreen state is reached with a trimmed base library: no `_G`, no `getfenv`,
--- no `setfenv`.  Its globals table is nevertheless shared and writable - the shipped page files
--- read exactly the globals CivilopediaSupport.lua wrote (AddChapter, SetPageHeader,
--- GetSections...), which is the only consistent explanation for our own successful reads of
--- GetSections/PageLayouts.  So capture, swap, restore and read-back verification all address the
--- globals by name through these accessor pairs, with no table reference anywhere.
local INTERCEPTED = {
  { 'SetPageHeader', function(value) SetPageHeader = value end, function() return SetPageHeader end },
  { 'SetPageSubHeader', function(value) SetPageSubHeader = value end, function() return SetPageSubHeader end },
  { 'ShowFrontPageHeader', function(value) ShowFrontPageHeader = value end, function() return ShowFrontPageHeader end },
  { 'AddChapter', function(value) AddChapter = value end, function() return AddChapter end },
  { 'AddFullWidthChapter', function(value) AddFullWidthChapter = value end, function() return AddFullWidthChapter end },
  { 'AddLeftColumnChapter', function(value) AddLeftColumnChapter = value end, function() return AddLeftColumnChapter end },
  { 'AddHeader', function(value) AddHeader = value end, function() return AddHeader end },
  { 'AddFullWidthHeader', function(value) AddFullWidthHeader = value end, function() return AddFullWidthHeader end },
  { 'AddLeftColumnHeader', function(value) AddLeftColumnHeader = value end, function() return AddLeftColumnHeader end },
  { 'AddParagraph', function(value) AddParagraph = value end, function() return AddParagraph end },
  { 'AddFullWidthParagraph', function(value) AddFullWidthParagraph = value end, function() return AddFullWidthParagraph end },
  { 'AddLeftColumnParagraph', function(value) AddLeftColumnParagraph = value end, function() return AddLeftColumnParagraph end },
  { 'AddParagraphs', function(value) AddParagraphs = value end, function() return AddParagraphs end },
  { 'AddFullWidthParagraphs', function(value) AddFullWidthParagraphs = value end, function() return AddFullWidthParagraphs end },
  { 'AddLeftColumnParagraphs', function(value) AddLeftColumnParagraphs = value end, function() return AddLeftColumnParagraphs end },
  { 'AddHeaderBody', function(value) AddHeaderBody = value end, function() return AddHeaderBody end },
  { 'AddLeftColumnHeaderBody', function(value) AddLeftColumnHeaderBody = value end, function() return AddLeftColumnHeaderBody end },
  { 'AddIconHeaderBody', function(value) AddIconHeaderBody = value end, function() return AddIconHeaderBody end },
  { 'AddLeftColumnIconHeaderBody', function(value) AddLeftColumnIconHeaderBody = value end, function() return AddLeftColumnIconHeaderBody end },
  { 'AddImage', function(value) AddImage = value end, function() return AddImage end },
  { 'AddTallImage', function(value) AddTallImage = value end, function() return AddTallImage end },
  { 'AddTallImageNoScale', function(value) AddTallImageNoScale = value end, function() return AddTallImageNoScale end },
  { 'AddPortrait', function(value) AddPortrait = value end, function() return AddPortrait end },
  { 'AddTallPortrait', function(value) AddTallPortrait = value end, function() return AddTallPortrait end },
  { 'AddQuote', function(value) AddQuote = value end, function() return AddQuote end },
  { 'AddRightColumnStatBox', function(value) AddRightColumnStatBox = value end, function() return AddRightColumnStatBox end },
  { 'HookupIcon', function(value) HookupIcon = value end, function() return HookupIcon end },
  { 'Do_AddChapterWithParagraphs', function(value) Do_AddChapterWithParagraphs = value end, function() return Do_AddChapterWithParagraphs end },
  { 'Do_AddHeader', function(value) Do_AddHeader = value end, function() return Do_AddHeader end },
  { 'Do_AddParagraph', function(value) Do_AddParagraph = value end, function() return Do_AddParagraph end },
  { 'Do_AddParagraphs', function(value) Do_AddParagraphs = value end, function() return Do_AddParagraphs end },
  { 'Do_AddHeaderBody', function(value) Do_AddHeaderBody = value end, function() return Do_AddHeaderBody end },
  { 'Do_AddIconHeaderBody', function(value) Do_AddIconHeaderBody = value end, function() return Do_AddIconHeaderBody end },
  { 'GetPageChapters', function(value) GetPageChapters = value end, function() return GetPageChapters end },
  { 'GetChapterHeader', function(value) GetChapterHeader = value end, function() return GetChapterHeader end },
  { 'GetChapterBody', function(value) GetChapterBody = value end, function() return GetChapterBody end },
  { 'Controls', function(value) Controls = value end, function() return Controls end },
  { 'UIManager', function(value) UIManager = value end, function() return UIManager end },
  { 'ContextPtr', function(value) ContextPtr = value end, function() return ContextPtr end },
  { 'InstanceManager', function(value) InstanceManager = value end, function() return InstanceManager end },
  { 'Input', function(value) Input = value end, function() return Input end },
  { 'UI', function(value) UI = value end, function() return UI end },
  { 'Mouse', function(value) Mouse = value end, function() return Mouse end },
  { 'Keys', function(value) Keys = value end, function() return Keys end },
  { 'Network', function(value) Network = value end, function() return Network end },
  { 'LuaEvents', function(value) LuaEvents = value end, function() return LuaEvents end },
  { 'Events', function(value) Events = value end, function() return Events end },
  { 'GameEvents', function(value) GameEvents = value end, function() return GameEvents end },
  { 'exposedMembers', function(value) exposedMembers = value end, function() return exposedMembers end },
  { 'include', function(value) include = value end, function() return include end },
  { 'DB', function(value) DB = value end, function() return DB end },
  { 'CacheData', function(value) CacheData = value end, function() return CacheData end },
  { 'CacheData_FetchData', function(value) CacheData_FetchData = value end, function() return CacheData_FetchData end },
  { 'CacheData_ProcessData', function(value) CacheData_ProcessData = value end, function() return CacheData_ProcessData end },
  { 'CacheData_SortData', function(value) CacheData_SortData = value end, function() return CacheData_SortData end },
  { 'PopulateSearchData', function(value) PopulateSearchData = value end, function() return PopulateSearchData end },
  { 'Initialize', function(value) Initialize = value end, function() return Initialize end },
  { 'Shutdown', function(value) Shutdown = value end, function() return Shutdown end },
  { 'RefreshSections', function(value) RefreshSections = value end, function() return RefreshSections end },
  { 'RefreshPageTabs', function(value) RefreshPageTabs = value end, function() return RefreshPageTabs end },
  { 'RefreshPageContent', function(value) RefreshPageContent = value end, function() return RefreshPageContent end },
  { 'ResetPageContent', function(value) ResetPageContent = value end, function() return ResetPageContent end },
  { 'NavigateTo', function(value) NavigateTo = value end, function() return NavigateTo end },
  { 'NavigateToPageTrailIndex', function(value) NavigateToPageTrailIndex = value end, function() return NavigateToPageTrailIndex end },
  { 'UpdateCrumbHighlight', function(value) UpdateCrumbHighlight = value end, function() return UpdateCrumbHighlight end },
  { 'OnClose', function(value) OnClose = value end, function() return OnClose end },
  { 'OnOpenCivilopedia', function(value) OnOpenCivilopedia = value end, function() return OnOpenCivilopedia end },
  { 'OnToggleCivilopedia', function(value) OnToggleCivilopedia = value end, function() return OnToggleCivilopedia end },
  { 'OnNavForward', function(value) OnNavForward = value end, function() return OnNavForward end },
  { 'OnNavBackward', function(value) OnNavBackward = value end, function() return OnNavBackward end },
}

--- Prove that a global written here is read by native functions defined in *other* files before any
--- layout runs.  Reading back our own scratch global would only prove this chunk can see its own
--- environment: if each UI file had a per-file environment delegating to a shared parent, the write
--- would land in this chunk's table, the page builder would never see it, the build would call the
--- REAL helpers and the live screen would be painted.  So the probe spoofs a cache global that a
--- shipped support function reads and asks that function for it back: set _ChaptersByPageLayout to a
--- marker table, call GetPageChapters (CivilopediaSupport.lua:524-526 reads the global) and require
--- the marker back by identity, then restore the original and verify the read-back.  A layout runs
--- only when this passes.
local PROBE_LAYOUT_ID = 'ASTRA_CIVILOPEDIA_PROBE'
local function sharedGlobalsVisible()
  if type(GetPageChapters) ~= 'function' then return false end
  local original = _ChaptersByPageLayout
  local marker = {}
  local ok, seen = pcall(function()
    _ChaptersByPageLayout = { [PROBE_LAYOUT_ID] = marker }
    return GetPageChapters(PROBE_LAYOUT_ID)
  end)
  _ChaptersByPageLayout = original
  return ok == true and seen == marker and _ChaptersByPageLayout == original
end

--- Install the sinks for one build: replace the intercepted globals by name (INTERCEPTED) and
--- restore every one of them in reverse, verifying afterwards that each reads back as it did
--- before.  This is the mechanism the shipped state supports - its base library is trimmed (no
--- _G, no getfenv, no setfenv) but its globals table is shared with the page files, which the
--- cross-file probe proves before a layout is allowed to run.
local function install(fn, sinks)
  local saved = A.array()
  for _, entry in ipairs(INTERCEPTED) do
    saved[#saved + 1] = { name = entry[1], set = entry[2], get = entry[3], value = entry[3]() }
  end
  for _, entry in ipairs(saved) do
    local sink = sinks[entry.name]
    entry.set(sink ~= nil and sink or blockedReplacements[entry.name])
  end
  return function()
    for index = #saved, 1, -1 do saved[index].set(saved[index].value) end
    local failed = A.array()
    for _, entry in ipairs(saved) do
      if entry.get() ~= entry.value then failed[#failed + 1] = entry.name end
    end
    return failed
  end
end

--- Run one layout builder with the capture sinks installed, restoring them whatever happens.
--- Isolation is installed before the builder can fail and torn down after it, on both the success
--- and the error path; an install that cannot run (a PageLayouts entry that is not a Lua function)
--- is reported without running anything.  With the swap strategy the restore also reports any
--- global that did not read back as it was, which the caller turns into a hard error.
local function build(plan)
  local capture, sinks = buildCapture(plan.page, plan.chapters, plan.native)
  local installed, restore, reason = pcall(install, plan.builder, sinks)
  if not installed or restore == nil then
    return capture, false, tostring(reason or restore), A.array()
  end
  local ok, err = pcall(plan.builder, plan.pageCopy)
  local failed = restore() or A.array()
  return capture, ok, err, failed
end

--- The chapters of one layout, split into the mechanics-bearing list the layout will see and the
--- narrative/flavor ids recorded as omitted.  Header keys are also collected so a captured
--- chapter can be attributed to its ChapterId even when the layout hides the header.
local function chapterPlan(native, page, sectionId, pageId)
  local kept, omitted = A.array(), A.array()
  local byHeader = {}
  local chapters = native.chapters(page.PageLayoutId)
  for _, chapter in ipairs(type(chapters) == 'table' and chapters or {}) do
    local chapterId = chapter.ChapterId
    if FLAVOR_CHAPTERS[chapterId] then
      omitted[#omitted + 1] = chapterId
    else
      kept[#kept + 1] = chapter
      local header = native.chapterHeader(sectionId, pageId, chapterId)
      if type(header) == 'string' and byHeader[header] == nil then byHeader[header] = chapterId end
    end
  end
  return { kept = kept, omitted = omitted, byHeader = byHeader }
end

--- Copy of a page cache record handed to the layout: the layout only reads it, and a mod layout
--- writing to its own copy can never touch the live cache the screen renders from.
local function pageCopy(page)
  local out = {}
  for key, value in pairs(page) do out[key] = value end
  return out
end

--- A native link term is the page id the button navigates by (CivilopediaSearch(term, 1)).  It is
--- collapsed to that identity: the resolved page id when the cache carries exactly one, the bare
--- term when it resolves to nothing here.  Per-match summaries (group, layout, title copies) are
--- not repeated - the caller reads the page when the row matters.
local function linkSummary(cat, term)
  local out = { term = term }
  local matches = pagesWithId(cat, term)
  if #matches == 1 then out.pageId = matches[1].page.PageId end
  return out
end

-- ---------------------------------------------------------------------------
-- Data-derived page content: the layout-free path.
--
-- When a page's layout builder cannot run here (not registered in this context, refused because it
-- reaches the live screen, failed, or globals are not shared across files), page mode still
-- answers from the same native data the layout would read: the page's own chapter text through
-- GetPageChapters/GetChapterHeader/GetChapterBody with the same narrative/flavor split, and the
-- columns of the GameInfo row that layout reads for this LayoutId.  The columns are reported as
-- the ruleset states them - raw values, no screen formatting, no ranking and no recommendation -
-- and provenance.source says which path produced the text.
-- ---------------------------------------------------------------------------

--- Which GameInfo row backs a page, per native PageLayoutId, with the table's own key column and
--- the extra rows that layout reads beside it (relation = trait|upgradedTo).
--- Sources: the PageQueries in Base/Assets/Gameplay/Data/Civilopedia.xml:241-300 ("SELECT <X>Type
--- as PageId ... FROM <Table>") and the layouts that look a row up by page id in their page files
--- (CivilopediaPage_*.lua, DLC/Expansion2/UI/Civilopedia/CivilopediaPage_*.lua).  Joins are schema
--- grounded: LeaderTraits/CivilizationTraits -> Traits (ability names and descriptions) and
--- UnitUpgrades.Unit -> Units.UpgradeUnit (the unit a unit upgrades into).
local TRAIT_JOIN = { relation = 'trait', join = 'LeaderTraits', column = 'LeaderType', of = 'TraitType',
  table = 'Traits', key = 'TraitType', text = 'Description' }
local CIV_TRAIT_JOIN = { relation = 'trait', join = 'CivilizationTraits', column = 'CivilizationType', of = 'TraitType',
  table = 'Traits', key = 'TraitType', text = 'Description' }

local PAGE_ROW_TABLES = {
  Unit = {
    table = 'Units', key = 'UnitType',
    related = { { relation = 'upgradedTo', join = 'UnitUpgrades', column = 'Unit', of = 'UpgradeUnit', table = 'Units', key = 'UnitType' } },
  },
  UnitPromotion = { table = 'UnitPromotions', key = 'UnitPromotionType' },
  Building = { table = 'Buildings', key = 'BuildingType' },
  Wonder = { table = 'Buildings', key = 'BuildingType' },
  District = { table = 'Districts', key = 'DistrictType' },
  Technology = { table = 'Technologies', key = 'TechnologyType' },
  Civic = { table = 'Civics', key = 'CivicType' },
  Improvement = { table = 'Improvements', key = 'ImprovementType' },
  Route = { table = 'Routes', key = 'RouteType' },
  Resource = { table = 'Resources', key = 'ResourceType' },
  Feature = { table = 'Features', key = 'FeatureType' },
  Terrain = { table = 'Terrains', key = 'TerrainType' },
  Policy = { table = 'Policies', key = 'PolicyType' },
  Government = { table = 'Governments', key = 'GovernmentType' },
  Project = { table = 'Projects', key = 'ProjectType' },
  Belief = { table = 'Beliefs', key = 'BeliefType' },
  Religion = { table = 'Religions', key = 'ReligionType' },
  GreatPerson = { table = 'GreatPersonIndividuals', key = 'GreatPersonIndividualType' },
  Governor = { table = 'Governors', key = 'GovernorType' },
  GovernorPromotion = { table = 'GovernorPromotions', key = 'GovernorPromotionType' },
  CityState = { table = 'Civilizations', key = 'CivilizationType' },
  Leader = { table = 'Leaders', key = 'LeaderType', related = { TRAIT_JOIN } },
  Civilization = { table = 'Civilizations', key = 'CivilizationType', related = { CIV_TRAIT_JOIN } },
}

--- Fallback for layouts this module does not know (a mod layout id): the candidate tables of the
--- page's own native section, the same grouping CivilopediaSections defines
--- (Base/Assets/Gameplay/Data/Civilopedia.xml:4-20).  A section that holds two layouts is
--- ambiguous only until the row is looked up: the page id decides which candidate owns it.
local SECTION_ROW_TABLES = {
  CIVILIZATIONS = { PAGE_ROW_TABLES.Civilization, PAGE_ROW_TABLES.Leader },
  CITYSTATES = { PAGE_ROW_TABLES.CityState },
  DISTRICTS = { PAGE_ROW_TABLES.District },
  BUILDINGS = { PAGE_ROW_TABLES.Building },
  WONDERS = { PAGE_ROW_TABLES.Wonder, PAGE_ROW_TABLES.Project },
  UNITS = { PAGE_ROW_TABLES.Unit },
  UNITPROMOTIONS = { PAGE_ROW_TABLES.UnitPromotion },
  GREATPEOPLE = { PAGE_ROW_TABLES.GreatPerson },
  TECHNOLOGIES = { PAGE_ROW_TABLES.Technology },
  CIVICS = { PAGE_ROW_TABLES.Civic },
  GOVERNMENTS = { PAGE_ROW_TABLES.Government, PAGE_ROW_TABLES.Policy },
  RELIGIONS = { PAGE_ROW_TABLES.Religion, PAGE_ROW_TABLES.Belief },
  FEATURES = { PAGE_ROW_TABLES.Terrain, PAGE_ROW_TABLES.Feature },
  RESOURCES = { PAGE_ROW_TABLES.Resource },
  IMPROVEMENTS = { PAGE_ROW_TABLES.Improvement, PAGE_ROW_TABLES.Route },
  GOVERNORS = { PAGE_ROW_TABLES.Governor, PAGE_ROW_TABLES.GovernorPromotion },
}

local function rowSpecs(page)
  local spec = PAGE_ROW_TABLES[page.PageLayoutId]
  if spec ~= nil then return { spec } end
  return SECTION_ROW_TABLES[page.SectionId] or {}
end

-- Engine bookkeeping, display ordering and row-identity echoes, not mechanics; the row's own
-- mechanical columns are all emitted as the ruleset states them.  A column whose value merely
-- repeats the page id (the table's key column, PrimaryKey) is dropped for the same reason.
local COLUMN_SKIP = { Index = true, Hash = true, SortIndex = true, RowId = true, rowid = true, PrimaryKey = true }

-- Narrative columns, dropped exactly as the HISTORY/CAPSULE chapters are - matched by the
-- ruleset's own column *names* (a "quote" name pattern, case-insensitive), never by the localized
-- text and never by value, so an explicit "none" enum such as NO_TECH or NO_FEATURE stays
-- informative.  Grounded in the schema (Base/Assets/Gameplay/Data/Schema/01_GameplaySchema.sql):
-- every column whose name carries "quote" in the tables pages are built from is narrative
-- (Buildings:461-462 and Features:648-649 Quote/QuoteAudio; the other quote columns live in
-- separate *_Quotes tables this reader does not page from).  Table-agnostic by construction.
local flavorColumnCache = {}
local function isFlavorColumn(key)
  local cached = flavorColumnCache[key]
  if cached == nil then
    cached = type(key) == 'string' and key:lower():find('quote', 1, true) ~= nil
    flavorColumnCache[key] = cached
  end
  return cached
end

local MAX_COLUMNS = 64

local function gameInfoRows(name)
  local namespace = GameInfo
  if type(namespace) ~= 'table' then return nil end
  local rows = namespace[name]
  if type(rows) ~= 'table' and type(rows) ~= 'userdata' then return nil end
  return rows
end

--- The row whose key column equals `value`: the table's own lookup first, then a scan for tables
--- the engine does not index by that column.
local function rowByKey(tableName, keyColumn, value)
  local rows = gameInfoRows(tableName)
  if rows == nil then return nil end
  local ok, row = pcall(function() return rows[value] end)
  if ok and type(row) == 'table' and row[keyColumn] == value then return row end
  local _, found = pcall(function()
    for candidate in rows() do
      if candidate[keyColumn] == value then return candidate end
    end
    return nil
  end)
  if type(found) == 'table' then return found end
  return nil
end

--- The values a join table maps this page's row to (LeaderTraits -> TraitType, UnitUpgrades ->
--- UpgradeUnit), in table order, deduplicated.
local function joinKeys(spec, value)
  local out = A.array()
  local rows = gameInfoRows(spec.join)
  if rows == nil then return out end
  local seen = {}
  pcall(function()
    for row in rows() do
      if row[spec.column] == value then
        local target = row[spec.of]
        if type(target) == 'string' and not seen[target] then
          seen[target] = true
          out[#out + 1] = target
        end
      end
    end
  end)
  return out
end

--- A joined row is reduced to what identifies it and what the page would say about it: relation,
--- table, key, its own name text and (when the join declares one) its descriptive text.  Reading
--- the target page is the caller's job when the full row matters.  A joined row that carries
--- neither text is bookkeeping (e.g. an InternalOnly trait with no name or description) and is
--- dropped rather than reported as an empty entry.
local function relatedEntry(join, target, row, take)
  if row == nil then return nil end
  local entry = { relation = join.relation, table = join.table, key = target }
  local name = take(row.Name)
  if name ~= A.null then entry.name = name end
  if join.text ~= nil then
    local text = take(row[join.text])
    if text ~= A.null then entry.text = text end
  end
  if entry.name == nil and entry.text == nil then return nil end
  return entry
end

--- Engine column names never contain spaces, so a name list travels as one space-separated string
--- instead of a JSON array; nothing is dropped, only the quoting goes away.
local function nameList(names)
  if #names == 0 then return nil end
  return table.concat(names, ' ')
end

--- Does the ruleset carry a string for this value?  Falls back to the engine's own text-key naming
--- convention when the lookup API is unavailable in this state (it is what the shipped
--- Find*TextKey helpers use), so a data-path page cannot fail on a missing API.
local function hasTextKey(value)
  if type(value) ~= 'string' or value == '' then return false end
  if type(Locale) == 'table' and type(Locale.HasTextKey) == 'function' then
    local ok, found = pcall(Locale.HasTextKey, value)
    if ok then return found == true end
  end
  return value:find('LOC_', 1, true) == 1
end

--- The row's own columns, as the data states them, in three groups:
---   columns  - a value that states something: true, any number except 0 (so -1 sentinels stay),
---              a non-empty string, or a localized {key,text[,plain]} object;
---   defaults - the names of false/0/empty-string columns, so nothing is unnamed and no value is
---              silently dropped without carrying a column of pure default noise;
---   flavor   - narrative columns (see FLAVOR_COLUMNS), reported by name and never emitted.
--- Columns whose value repeats the row identity (page id / entry key) and engine bookkeeping are
--- dropped entirely.  Keys are sorted so the selection is deterministic.
local function rowColumns(row, take, identity)
  local keys = A.array()
  for key in pairs(row) do
    if type(key) == 'string' then keys[#keys + 1] = key end
  end
  table.sort(keys)
  local columns, defaults, flavor = {}, A.array(), A.array()
  local omitted = 0
  for index = 1, #keys do
    local key = keys[index]
    local value = row[key]
    local kind = type(value)
    if isFlavorColumn(key) then
      flavor[#flavor + 1] = key
    elseif COLUMN_SKIP[key] then
      -- bookkeeping / identity echo of the row itself
    elseif index > MAX_COLUMNS or (kind ~= 'number' and kind ~= 'boolean' and kind ~= 'string') then
      omitted = omitted + 1
    elseif kind == 'string' then
      if value == '' then
        defaults[#defaults + 1] = key
      elseif value ~= identity then
        columns[key] = hasTextKey(value) and take(value) or value
      end
    elseif value == false or value == 0 then
      defaults[#defaults + 1] = key
    else
      columns[key] = value
    end
  end
  return columns, defaults, flavor, omitted
end

--- A bounded text meter shared by the chapter text and the row columns of one page.
local function meter()
  local state = { chars = 0, dropped = 0 }
  local function take(value)
    local entry = localized(value)
    if entry == A.null then return A.null end
    if state.chars + #entry > MAX_TEXT then
      state.dropped = state.dropped + 1
      return A.null
    end
    state.chars = state.chars + #entry
    return entry
  end
  return take, state
end

--- Layout-free page content: chapters + omitted flavor ids + the backing row's fields.
local function dataContent(native, page)
  local take, state = meter()
  local chapters, omitted = A.array(), A.array()
  local chapterRows = native.chapters(page.PageLayoutId)
  for _, chapter in ipairs(type(chapterRows) == 'table' and chapterRows or {}) do
    local chapterId = chapter.ChapterId
    if FLAVOR_CHAPTERS[chapterId] then
      omitted[#omitted + 1] = { chapterId = chapterId }
    else
      local body = native.chapterBody(page.SectionId, page.PageId, chapterId)
      if type(body) == 'string' then body = { body } end
      local paragraphs = A.array()
      if type(body) == 'table' then
        for index = 1, #body do
          local entry = take(body[index])
          if entry ~= A.null then paragraphs[#paragraphs + 1] = entry end
        end
      end
      chapters[#chapters + 1] = {
        source = 'chapter',
        chapterId = chapterId,
        header = take(native.chapterHeader(page.SectionId, page.PageId, chapterId)),
        paragraphs = paragraphs,
      }
    end
  end
  local fields = A.null
  for _, spec in ipairs(rowSpecs(page)) do
    local row = rowByKey(spec.table, spec.key, page.PageId)
    if row ~= nil then
      local columns, defaults, flavor, omittedColumns = rowColumns(row, take, page.PageId)
      fields = { table = spec.table, key = spec.key, value = page.PageId, columns = columns }
      local defaultNames = nameList(defaults)
      if defaultNames ~= nil then fields.defaults = defaultNames end
      local flavorNames = nameList(flavor)
      if flavorNames ~= nil then fields.flavorColumns = flavorNames end
      if omittedColumns > 0 then fields.omittedColumns = omittedColumns end
      if spec.related ~= nil then
        local related = A.array()
        for _, join in ipairs(spec.related) do
          for _, target in ipairs(joinKeys(join, page.PageId)) do
            local entry = relatedEntry(join, target, rowByKey(join.table, join.key, target), take)
            if entry ~= nil then related[#related + 1] = entry end
          end
        end
        if #related > 0 then fields.related = related end
      end
      break
    end
  end
  return chapters, omitted, fields, state
end

--- A blocked-global read or a call into a missing native helper means the layout cannot run here
--- at all, so no part of its output is used; anything else is a genuine build failure whose
--- captured prefix is still worth returning (labelled partial).  Missing-global messages are
--- matched in both the shipped 5.1 wording ("attempt to call global 'X' (a nil value)") and the
--- newer wording ("attempt to call a nil value (global 'X')").
local function classify(err)
  err = tostring(err)
  if contains(err, 'civilopedia: blocked global') then
    return 'unsupported', 'the layout touches the live screen; this reader refuses to run it (' .. err .. ')'
  end
  if (contains(err, "attempt to call global '") or contains(err, "attempt to index global '")
      or contains(err, "attempt to call global \"") or contains(err, "attempt to index global \"")
      or contains(err, "attempt to call a nil value (global '") or contains(err, "attempt to index a nil value (global '")
      or contains(err, 'attempt to call a nil value (global "') or contains(err, 'attempt to index a nil value (global "')) then
    return 'unsupported', 'the layout needs a native helper that is not defined in this context: ' .. err
  end
  return 'error', 'the native layout failed: ' .. err
end

local function pageResult(cat, native, entry)
  local page = entry.page
  local sectionId, pageId = page.SectionId, page.PageId
  local layoutId = page.PageLayoutId
  local template = type(layoutId) == 'string' and native.templates[layoutId] or nil
  local builder = type(template) == 'string' and native.layouts[template] or nil

  -- Which native path can produce this page here: the registered layout builder through the
  -- name-addressed swap, or the data-derived path when that layout cannot run.  The notes are
  -- terse labels; the full explanations live in A.civilopediaSpec and in the layout status values.
  local layoutStatus, layoutNote, capture, ok, err, restoreFailures
  local sharedGlobals
  if type(layoutId) ~= 'string' or template == nil then
    layoutStatus = 'unusable'
    layoutNote = 'layout not run: no ScriptTemplate for ' .. tostring(layoutId)
  elseif type(builder) ~= 'function' then
    layoutStatus = 'unusable'
    layoutNote = 'layout not run: no builder for ' .. tostring(template)
  else
    -- A layout runs only when a global written here is read back by a function from another file;
    -- otherwise the swap would leave the real helpers in place and the layout would paint the live
    -- screen, so it is refused and the page answers from data.
    sharedGlobals = sharedGlobalsVisible()
    if not sharedGlobals then
      layoutStatus = 'unavailable'
      layoutNote = 'layout not run: globals are not shared with the page files'
    else
      capture, ok, err, restoreFailures = build({
        page = page,
        pageCopy = pageCopy(page),
        builder = builder,
        native = native,
        chapters = chapterPlan(native, page, sectionId, pageId),
      })
      if ok and capture.calls == 0 and #capture.layers == 0 and #capture.stats == 0 then
        -- The builder never used a single page helper, so it cannot have rendered page content
        -- here; an empty page is reported as unsupported rather than as a complete one.
        layoutStatus = 'unsupported'
        layoutNote = 'layout made no page-helper calls and captured nothing'
      elseif ok then
        layoutStatus = 'rendered'
        layoutNote = nil
      else
        layoutStatus, layoutNote = classify(err)
      end
    end
  end

  local rendered = layoutStatus == 'rendered'
  local capturedPrefix = capture ~= nil and (#capture.layers > 0 or #capture.stats > 0)
  -- The layout's own output is used when it ran, and when it failed after producing something:
  -- that prefix is native page content.  Otherwise the page answers from native data.
  local useCapture = rendered or (capturedPrefix and layoutStatus == 'error')
  local notes = A.array()
  if layoutNote ~= nil then notes[#notes + 1] = layoutNote end

  local chapters, omittedChapters, fields, dropped, failed
  if useCapture then
    chapters, omittedChapters, fields = capture.layers, capture.omittedChapters, A.null
    dropped, failed = capture.dropped, capture.failed
    if capture.dropped > 0 then
      notes[#notes + 1] = 'text truncated; ' .. capture.dropped
        .. ' paragraph(s) omitted'
    end
    if not rendered then
      -- A half-built layout still leaves the model the ruleset's own values for this page.
      local _, _, dataFields = dataContent(native, page)
      fields = dataFields
    end
  else
    local omitted, state
    chapters, omitted, fields, state = dataContent(native, page)
    omittedChapters, dropped = omitted, state.dropped
    if state.dropped > 0 then
      notes[#notes + 1] = 'text truncated; ' .. state.dropped
        .. ' paragraph(s) omitted'
    end
  end

  -- One shape for both paths: a key that carries no value is left out rather than emitted as an
  -- empty placeholder (null fields/header/subtitle, empty icon, link, chapter, stat, omitted or
  -- note lists, false frontPage).  Content that the layout did produce - chapters, stat rows,
  -- notes, the non-zero omitted counts - is kept exactly as produced.
  local captured = {
    sectionId = sectionId,
    pageId = pageId,
    layoutId = layoutId,
    layoutTemplate = template,
    layoutStatus = layoutStatus,
    title = cachedText(page.Title or page.Name),
    chapters = chapters,
  }
  if page.PageGroupId ~= nil then captured.groupId = page.PageGroupId end
  local subtitle = cachedText(page.SubTitle)
  if subtitle ~= A.null then captured.subtitle = subtitle end
  if notes ~= nil and #notes > 0 then captured.notes = notes end
  if useCapture then
    if capture.frontPage == true then captured.frontPage = true end
    if capture.header ~= A.null and (captured.title == A.null or capture.header.text ~= captured.title.text) then
      captured.header = capture.header
    end
    if capture.subHeader ~= A.null and (subtitle == A.null or capture.subHeader.text ~= subtitle.text) then
      captured.subHeader = capture.subHeader
    end
    if #capture.stats > 0 then captured.stats = capture.stats end
    if #capture.icons > 0 then captured.icons = capture.icons end
    local links = A.array()
    for _, term in ipairs(capture.linkTerms) do links[#links + 1] = linkSummary(cat, term) end
    if #links > 0 then captured.links = links end
    if #omittedChapters > 0 or #capture.omittedStatBoxes > 0 or capture.images > 0 or capture.quotes > 0 then
      local omitted = {}
      if #omittedChapters > 0 then omitted.chapters = omittedChapters end
      if #capture.omittedStatBoxes > 0 then omitted.statBoxes = capture.omittedStatBoxes end
      if capture.images > 0 then omitted.images = capture.images end
      if capture.quotes > 0 then omitted.quotes = capture.quotes end
      captured.omitted = omitted
    end
  else
    if #chapters == 0 then captured.chapters = nil end
    if fields == A.null then captured.fields = nil else captured.fields = fields end
    if #omittedChapters > 0 then captured.omitted = { chapters = omittedChapters } end
  end

  local source = useCapture and 'layout' or 'data'
  local out = {
    mode = 'page',
    page = captured,
    provenance = {
      source = source,
      layout = type(template) == 'string' and (tostring(layoutId) .. ' -> PageLayouts["' .. template .. '"]') or A.null,
      text = source == 'layout' and 'native layout output' or 'row columns + chapter text',
      isolation = 'helpers_only',
      -- The one fact that decides whether a screen-faithful capture is possible in this state:
      -- whether a global written here is read by the native functions defined in other files.
      sharedGlobals = sharedGlobals == true,
      costs = 'base values; civ.options for live prices',
    },
  }

  -- Judged on what was produced, before the sparse pruning removes empty shells.
  local hasContent = #chapters > 0 or fields ~= A.null
  local unrestored = restoreFailures ~= nil and #restoreFailures > 0
  out.complete = false
  if unrestored then
    -- The screen's own helpers did not all read back as they were: that is a hard error, reported
    -- with the names rather than passed off as a clean read.
    out.status = 'error'
    out.partial = true
    out.reason = 'globals not restored after the layout: ' .. table.concat(restoreFailures, ' ')
  elseif useCapture and rendered and failed == nil and dropped == 0 then
    out.status = 'complete'
    out.complete = true
  elseif useCapture and rendered then
    out.status = 'partial'
    out.reason = failed or ('page text exceeded ' .. MAX_TEXT .. ' characters and was truncated')
  elseif useCapture then
    -- A layout that failed mid-build: the prefix is real content, the rest of the page is missing.
    out.status = 'error'
    out.partial = true
    out.reason = layoutNote
  elseif hasContent then
    out.status = dropped > 0 and 'partial' or 'complete'
    out.complete = dropped == 0
    if dropped > 0 then
      out.reason = 'page text exceeded ' .. MAX_TEXT .. ' characters and was truncated'
    end
  else
    -- Nothing usable here: no layout ran and the data path found neither chapter text nor a
    -- backing row, so no page content is claimed.
    out.status = 'unsupported'
    out.reason = layoutNote
  end
  return out
end

-- ---------------------------------------------------------------------------
-- Entry point.
-- ---------------------------------------------------------------------------

function A.civilopedia(args)
  args = args or {}
  assert(type(args) == 'table', 'civilopedia takes a table of arguments')
  local query, section, identifier = args.query, args.section, args.id
  assert(query == nil or type(query) == 'string', 'query must be a string')
  assert(section == nil or type(section) == 'string', 'section must be a string')
  assert(identifier == nil or type(identifier) == 'string', 'id must be a string')
  local offset = args.offset or 0
  local limit = args.limit or DEFAULT_LIMIT
  assert(type(offset) == 'number' and offset >= 0 and offset % 1 == 0, 'offset must be a non-negative integer')
  assert(type(limit) == 'number' and limit >= 1 and limit <= MAX_LIMIT and limit % 1 == 0,
    'limit must be an integer 1..' .. MAX_LIMIT)
  query, section, identifier = trim(query), trim(section), trim(identifier)
  assert(query == nil or query ~= '', 'query must not be empty')
  assert(section == nil or section ~= '', 'section must not be empty')
  assert(identifier == nil or identifier ~= '', 'id must not be empty')

  local native, reason = cache()
  if native == nil then
    A.unavailable('civilopedia', 'cache', reason)
    return {
      mode = identifier ~= nil and 'page' or (query ~= nil and 'query' or (section ~= nil and 'pages' or 'sections')),
      status = 'unavailable',
      complete = false,
      reason = reason,
    }
  end
  local cat = catalog(native)
  local locale = A.null
  local localeOK, language = pcall(Locale.GetCurrentLanguage)
  if localeOK and type(language) == 'string' then locale = language end

  -- Only what the caller needs to judge a list answer: the localized-at-call-time note.  The
  -- module publishes no game identity - A.session is a per-context FireTuner session id that can
  -- differ from the InGame snapshot gameId, so it is deliberately not reported here.
  local function result(mode)
    local out = { mode = mode, status = 'complete', complete = true }
    if locale ~= A.null then out.locale = locale end
    out.provenance = { text = 'Locale.Lookup at call time' }
    return out
  end

  local function hints(cat, text)
    local out = A.array()
    for _, found in ipairs(search(cat, text)) do
      if #out < MAX_HINT then out[#out + 1] = found end
    end
    return out
  end

  if query ~= nil and identifier ~= nil then
    error('civilopedia takes query or id, not both')
  end

  if query ~= nil then
    local out = result('query')
    out.query = query
    local pages = search(cat, query)
    out.sections = sectionMatches(native, query)
    out.pages, out.total, out.more = paginate(pages, offset, limit)
    out.offset, out.limit = offset, limit
    return out
  end

  if identifier ~= nil then
    local requested
    if section ~= nil then
      requested = sectionWithId(native, section)
      if requested == nil then
        local out = result('page')
        out.status = 'not_found'
        out.complete = false
        out.id, out.section = identifier, section
        out.reason = 'no Civilopedia section has id ' .. section
        out.hint = sectionMatches(native, section)
        return out
      end
      local page = GetPage(requested.SectionId, identifier)
      local matches = A.array()
      if page ~= nil and page.SectionId == requested.SectionId and page.PageId == identifier then
        matches[#matches + 1] = { section = requested, page = page }
      else
        for _, entry in ipairs(pagesWithId(cat, identifier)) do
          if entry.page.SectionId == requested.SectionId then matches[#matches + 1] = entry end
        end
      end
      if #matches == 0 then
        local elsewhere = pagesWithId(cat, identifier)
        local out = result('page')
        out.status = 'not_found'
        out.complete = false
        out.id, out.section = identifier, requested.SectionId
        out.reason = 'section ' .. requested.SectionId .. ' has no page id ' .. identifier
          .. (#elsewhere > 0 and '; that page id exists in other sections' or '')
        local list = A.array()
        for _, entry in ipairs(elsewhere) do list[#list + 1] = pageSummary(entry) end
        out.matches = list
        if #list == 0 then out.hint = hints(cat, identifier) end
        return out
      end
      return pageResult(cat, native, matches[1])
    end
    local candidates = pagesWithId(cat, identifier)
    if #candidates == 0 then
      local out = result('page')
      out.status = 'not_found'
      out.complete = false
      out.id = identifier
      out.reason = 'no Civilopedia page in the active cache has id ' .. identifier
      out.hint = hints(cat, identifier)
      return out
    end
    if #candidates > 1 then
      local out = result('page')
      out.status = 'ambiguous'
      out.complete = false
      out.id = identifier
      out.reason = #candidates .. ' sections have a page with id ' .. identifier
        .. '; pass section to choose one (page ids repeat across sections, e.g. INTRO)'
      local matches = A.array()
      for _, entry in ipairs(candidates) do matches[#matches + 1] = pageSummary(entry) end
      out.matches = matches
      return out
    end
    return pageResult(cat, native, candidates[1])
  end

  if section ~= nil then
    local requested = sectionWithId(native, section)
    if requested == nil then
      local out = result('pages')
      out.status = 'not_found'
      out.complete = false
      out.section = section
      out.reason = 'no Civilopedia section has id ' .. section
      out.hint = sectionMatches(native, section)
      return out
    end
    local out = result('pages')
    out.section = sectionSummary(requested)
    local summaries = A.array()
    for _, page in ipairs(cat.bySection[requested.SectionId] or {}) do
      summaries[#summaries + 1] = pageSummary({ section = requested, page = page })
    end
    out.pages, out.total, out.more = paginate(summaries, offset, limit)
    out.offset, out.limit = offset, limit
    return out
  end

  local out = result('sections')
  local summaries = A.array()
  for _, candidate in ipairs(native.sections) do summaries[#summaries + 1] = sectionSummary(candidate) end
  out.sections, out.total, out.more = paginate(summaries, offset, limit)
  out.offset, out.limit = offset, limit
  return out
end

A.civilopediaSpec = {
  args = {
    query = 'free text matched case-insensitively against page ids, page name keys, localized titles '
      .. 'and the ruleset\'s Civilopedia search terms; returns matching sections and a paged page list',
    section = 'SectionId such as CIVILIZATIONS|UNITS|TECHNOLOGIES|CONCEPTS|RESOURCES|DISTRICTS; with id it '
      .. 'disambiguates a repeated page id, without id it lists that section\'s pages',
    id = 'page id such as LEADER_TRAJAN|UNIT_ROMAN_LEGION|TECH_WRITING; returns the complete mechanics page',
    offset = 'integer >= 0 into the returned list, for the list modes (default 0)',
    limit = 'list page size 1..' .. MAX_LIMIT .. ' (default ' .. DEFAULT_LIMIT
      .. '); a page read returns the whole page (bounded by the text limit below)',
  },
  modes = {
    sections = 'no arguments: the native sections with localized names, icons and page counts',
    pages = 'section only: that section\'s pages (pageId, localized title, page group, layout)',
    query = 'query: matching sections plus a paged list of pages, each with '
      .. 'matchedBy = id (page id or its raw name key) | title (localized) | term (the ruleset\'s own search terms)',
    page = 'id (optionally with section): the page below; status complete|partial|error|unsupported|not_found|ambiguous',
  },
  page = {
    layoutStatus = 'rendered (native layout ran; stats/links are screen content) | unusable (no builder or no '
      .. 'layout template here) | unsupported (the layout touched the live screen or needs a missing helper) | '
      .. 'failed | unavailable (globals are not shared with the page files, so no layout was run)',
    chapters = 'mechanics text in native order: {source=chapter|paragraph|header|headerBody|iconHeaderBody, '
      .. 'chapterId from the native chapter map, header, paragraphs or body, icons} with header, paragraphs, body '
      .. 'and icon texts as localized strings; narrative HISTORY/CAPSULE chapters are listed under '
      .. 'omitted.chapters instead of being returned',
    stats = 'native-layout only, in native order, one localized string per value and no LOC_* keys: a box is '
      .. '{title, rows} where title is the localized box name, and a row is a plain string when the screen showed '
      .. 'a header and an object otherwise - {text?, value?, term?, icons?} - so its shape says what it is without '
      .. 'a type label.  text is the native localized string ([ICON_x] tokens included, which is why no stripped '
      .. 'duplicate is carried), value is the number a value row showed, term is the page id the native button '
      .. 'navigates by, and icons lists {text?, term?} entries.  The decorative atlas name is dropped, a row whose '
      .. 'link text repeats the row text keeps the text alone, a separator is not reported (nothing readable) and a '
      .. 'box the layout left without rows is not reported either - the native stat box hides itself in that case '
      .. '(CivilopediaSupport.lua:1786-1793)',
    fields = 'data-derived only: {table, key, value, columns, defaults, flavorColumns, omittedColumns, related} - '
      .. 'the columns of the GameInfo row the native layout for this LayoutId reads. The rule is value-driven and '
      .. 'table-agnostic: columns carries every value that states something - true, any number except 0 (so -1 '
      .. 'sentinels and explicit "none" enums such as NO_TECH or NO_FEATURE stay), a non-empty string, and a '
      .. 'localized column as its plain localized string; false/0/empty-string columns are named in defaults and narrative '
      .. 'columns in flavorColumns, both as one space-separated string (engine column names never contain spaces) '
      .. 'and never emitted as values - flavor is matched by the ruleset\'s own column names (a "quote" name '
      .. 'pattern), never by localized text or by value. Nominal row identity (the key column, PrimaryKey) and '
      .. 'engine rowid bookkeeping (RowId/rowid/Hash/Index/SortIndex) are dropped, and columns whose value is not '
      .. 'a scalar the reader can serialize are counted in omittedColumns. Values are the ruleset\'s own, never '
      .. 'screen-formatted, ranked or re-derived; null on the layout path',
    related = 'rows this layout reads beside its own (relation=trait for Leader/Civilization trait rows, '
      .. 'relation=upgradedTo for the unit a unit upgrades into), reduced to {relation, table, key, name, text} - '
      .. 'the joined row\'s own name text plus, where the join declares one, its descriptive text (a trait\'s '
      .. 'ability description). A joined row that carries neither text is bookkeeping and is dropped.  Reading the '
      .. 'target page is the caller\'s job when the full row matters',
    sparse = 'both paths: a shell that carries no content is omitted rather than emitted empty - no null fields/'
      .. 'header/subHeader/subtitle, no empty chapters/stats/icons/links/omitted/notes, no false frontPage and no '
      .. 'zero-count omitted entry.  A missing key means no value was produced; the content a path did produce is '
      .. 'kept exactly as produced',
    links = 'icon search terms the native page navigates by (e.g. UNIT_ROMAN_LEGION), collapsed to {term, pageId} '
      .. 'with the resolved page id when the cache carries exactly one, or the bare term when it resolves to '
      .. 'nothing; read that page for its own group, layout and title.  No key and no title copy is repeated here',
    omitted = 'narrative chapters (by chapter id), geography/social stat boxes (by their localized title), images '
      .. 'and quotes the screen would show but this reader drops',
    notes = 'why the layout path was not used (no builder, refusal, unshared globals) and any structural problem '
      .. '(failed stat box, NYI native renderer, text truncation)',
  },
  provenance = {
    source = 'layout (page text is native layout output) | data (native chapter text plus GameInfo row columns)',
    sharedGlobals = 'the one fact that decides whether a screen-faithful capture is possible in this state: '
      .. 'true when a global written here is read back by a native function defined in another file.  Probed '
      .. 'before any layout runs by spoofing _ChaptersByPageLayout and asking GetPageChapters for the marker '
      .. '(resolved per call; false on the data path means the layout was refused, not that the page is empty)',
    isolation = 'helpers_only: the one mechanism this state supports.  The intercepted globals (page helpers, the '
      .. 'cache accessors a layout reads, the blocked screen/hook names) are swapped by name, and every one is '
      .. 'verified to read back as it was afterwards',
    text = 'terse label for the text path: "native layout output" or "row columns + chapter text"; both are '
      .. 'localized with Locale.Lookup at call time, so the active locale and any mod override (e.g. BBG) apply. '
      .. 'costs means base/reference values with civ.options as the live source',
    environment = 'the shipped CivilopediaScreen state has a trimmed base library (no _G, no getfenv, no setfenv, '
      .. 'no rawget) but a globals table shared with the page files, so nothing here needs an environment handle: '
      .. 'the swap is addressed through per-name accessors.  Because a state that did NOT share globals would '
      .. 'silently leave the real helpers in place, a cross-file probe runs first - it spoofs _ChaptersByPageLayout '
      .. 'and asks GetPageChapters for the marker, requiring it back by identity - and provenance.sharedGlobals '
      .. 'reports the answer.  A page reports the outcome, not the internals: page.layoutStatus (rendered|'
      .. 'unusable|unsupported|failed|unavailable) plus one terse note, e.g. "layout not run: globals are not '
      .. 'shared with the page files".  A layout that makes no page-helper calls and captures nothing is '
      .. 'unsupported, never a complete empty page',
    identity = 'the result carries no game id: A.session is a per-context FireTuner session id that can differ '
      .. 'from the InGame snapshot gameId, so lua/civilopedia.lua deliberately publishes none; use civ.snapshot '
      .. 'for the game identity.  Result level keeps only mode/status/complete plus locale when this state '
      .. 'reports one, and the list modes only a one-label provenance',
  },
  native = 'CivilopediaScreen context: the native cache GetSections/GetPages/GetPage/GetPageChapters/GetChapterHeader/'
    .. 'GetChapterBody plus PageLayouts[_PageLayoutScriptTemplates[PageLayoutId]](page) with exactly one interception '
    .. 'layer for the page helpers (AddChapter/AddRightColumnStatBox/SetPageHeader/...), the cache accessors the '
    .. 'layout reads and the blocked screen/hook names - no per-entity parsing, so any shipped or mod layout renders '
    .. 'through the same path and the layout itself decides the content and its formatting.  When the state has '
    .. 'setfenv) it is addressed by name: the intercepted globals are swapped, and only after the cross-file probe '
    .. 'proves a written global is read by functions from other files.  Every name is verified to read back '
    .. 'afterwards, and a name that does not is a hard error.  When that '
    .. 'layout cannot run here, the page is answered from the same native data instead - its own chapter text and the '
    .. 'GameInfo row behind its LayoutId - and provenance.source says so. '
    .. 'No navigation, no screen mutation, no SQL, no model-supplied code; every swapped name is restored. '
    .. 'When the globals are not shared with the page files, or the builder cannot be intercepted, the layout is '
    .. 'refused rather than run against the real helpers, and the page is answered from its data instead.',
  limits = 'text is bounded at ' .. MAX_TEXT .. ' characters per page (reported as partial), lists at limit<=' .. MAX_LIMIT
    .. ', row columns at ' .. MAX_COLUMNS .. ' per row (excess reported in fields.omittedColumns), and unsupported '
    .. 'layouts or failed builds are reported without invented content.',
}
