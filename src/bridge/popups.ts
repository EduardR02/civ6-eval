/**
 * Fixed, reviewed adapters for the game's known popup screens.
 *
 * Native popup screens are separate LuaContexts declared in InGame.xml (each is its own Lua
 * state). Closing them generically (blanket DequeuePopup / IsInPopupQueue) is forbidden: it
 * skips the screens' native cleanup. Every dismissable screen here therefore executes its own
 * exact native global handler (Close / OnClose / OnClosePopup / HideScreen) *inside that
 * screen's context* through the trusted PopupInvoker, so all native side effects run: temporary
 * plot visibility, lens save/restore, interface mode, camera animations, sound loops, internal
 * popup sequences and the exclusive popup manager's engine-event hold.
 *
 * Explicit dismissal is exposed only where the screen's own close handler is a pure teardown,
 * verified per screen and cited below: the information-only screens, the congress popup and
 * intro, the governor panel/chooser, the great-people popup and the great-work gallery. The model
 * asks for one with civ.decide {id:"popup:<key>"} and the bridge re-probes the screen first.
 * Screens whose buttons decide something (event choices, war declaration, raze/keep, espionage,
 * map pins) expose no close at all, and the terminal EndGameMenu is only reported. Automatic
 * dismissal is the narrower `auto` set below. The model can only supply a `popup:<key>` id;
 * context names and Lua bodies are fixed constants in this file.
 *
 * Content capture. Every information-only screen has fixed probes that read its *rendered* text.
 * Verified named controls are read first (their Lua SetText call sites are cited per screen), so a
 * field keeps its semantic identity - Controls.DisasterName, Controls.UnitsLostLabel,
 * Controls.ResearchName - instead of a tree position. The visible control tree is then walked
 * (ContextPtr:GetChildren/IsVisible, the natives TunerUtilities walks) for text that only exists
 * in instance-manager controls (historic-moment entries, unlock stacks, deal rows), with a
 * Control:GetToolTipString fallback for content that renders an icon instead of text. The walk is
 * bounded (items, characters, per-text length, depth) and reports `truncated` when text was
 * dropped; `unreadable` names rendered content that carries no readable text at all (icon-only
 * slots, frame decoration) so partial capture is never blessed as complete.
 *
 * Closing. Every close runs the screen's exact native global inside that screen's own LuaContext,
 * and the presence check, the content comparison and the handler call happen in ONE screen
 * invocation: a successor raised from the same context can therefore never be acknowledged before
 * its own content was captured. `auto` marks the screens whose entire rendered content is
 * information and whose exact native close is lossless once that text is captured; only those may
 * be closed automatically, and only after the presentation callback has accepted the observation.
 * No gameplay chooser is ever closed automatically, and the model's explicit civ.decide close is
 * available for the dismiss-only screens (information-only, congress, governor, great-people).
 *
 * Deliberately native-UI-only (known contexts we neither detect nor close):
 * - RockBandMoviePopup / RockBandPopup: rock-band cinematics/chooser, outside the requested
 *   common interruption set (same ExclusivePopupManager pattern as WonderBuilt if ever needed).
 * - PBCNotificationPopup / InvitePopup / PlayerChange: Play-By-Cloud, multiplayer invites and
 *   hotseat turn change; not part of the single-player experiment.
 * - SwitchLayoutPopup: transient layout-change confirmation.
 * - Automation_NarrationPopup: tutorial/automation narration.
 * - UnitCaptured: builds a transient OK-only PopupDialog inside its own context; the dialog
 *   instance is class-local (PopupDialog:new) with no context-level visibility to probe, and
 *   the player's OK click lowers it. Undetectable from this context's globals, so it is never
 *   claimed supported.
 */

export type PopupInvoker = (contextName: string, body: string) => Promise<unknown>;

/** The host aborted the call while a screen was being read or closed; it must not be reported as a
 *  degraded screen, because an aborted call stops instead of continuing with fewer popups. Marked
 *  by setting `name`, so this module needs no import from the bridge. */
function isAborted(error: unknown): boolean {
  return error instanceof Error && error.name === "AuthorizationAborted";
}

export type PopupKind = "informational" | "choice" | "diplomacy" | "gameover";

/** The kinds in canonical order; also the accepted values for a selector's kinds filter. */
const POPUP_KINDS: readonly PopupKind[] = ["informational", "choice", "diplomacy", "gameover"];

export interface PopupSelector {
  /** Exactly one registry entry; takes precedence over kinds. */
  id?: string;
  /** Only entries of these kinds are probed; an empty array selects nothing. */
  kinds?: PopupKind[];
}

export interface PopupContentField {
  /** Named control, control-tree path, or explicit native game-state field. */
  control: string;
  text: string;
  /** Text/tooltip from the screen, or native state supplying its graphical meaning. */
  source: "text" | "tooltip" | "game-state";
}

export interface PopupContent {
  /** Rendered text plus explicitly attributed native state supplying graphical meaning. */
  fields: ReadonlyArray<PopupContentField>;
  /** Rendered text was dropped before it could be read (capture bounds). */
  truncated: boolean;
  /** Content not preserved by this capture; nonempty prevents automatic dismissal. */
  unreadable: readonly string[];
}

export type PopupContentStatus = "captured" | "unsupported" | "error";

export interface PopupObservation {
  /** Stable id in the form `popup:<registry-key>`. */
  id: string;
  /** Native LuaContext id the screen lives in. */
  context: string;
  kind: PopupKind;
  /** The screen holds an active native popup-queue slot (may render imminently). */
  active: boolean;
  /** The screen is actually rendered right now. */
  visible: boolean;
  /** true = the native screen requires resolution before normal gameplay input proceeds (engine event hold, modal, or input-consuming handler); null = not verified from source. */
  blocking: boolean | null;
  /** Cosmetic dismissal via the screen's exact native handler is supported. */
  dismissable: boolean;
  /** The screen's rendered content is information only, so its native close may run automatically
   *  once `content` has been preserved. Never true for a chooser, diplomacy/congress UI or the
   *  game-over screen, and false while the capture is missing, truncated or unread. */
  autoDismissible: boolean;
  /** Why `autoDismissible` is false; null when it is true. */
  autoDismissReason: string | null;
  /** Rendered text read from the screen while it was visible, named controls first; null when nothing was captured. */
  content: PopupContent | null;
  contentStatus: PopupContentStatus;
  contentError?: string;
  /** Best-effort localized header text; null when the screen exposes none cheaply. */
  title: string | null;
  status: "ok" | "context-missing" | "error";
  error?: string;
  note?: string;
}

/** Outcome of the mechanical congress teardown that follows the model's own explicit submit. */
export interface CongressCloseResult {
  id: "popup:world-congress";
  /** closed = the in-session surface was showing and the native ClosePopup ran; already-closed = it was gone; not-the-submitted-surface = the context moved on to review data and was left untouched. */
  status: "closed" | "already-closed" | "not-the-submitted-surface" | "error";
  error?: string;
  note?: string;
}

export interface DismissPopupResult {
  id: string;
  /** The screen reports no longer active/visible after the native handler ran. */
  dismissed: boolean;
  status: "ok" | "not-dismissable" | "error";
  /** The native handler ran and the same screen immediately shows its next queued item (native sequencing), so this is progress, not a completed close. */
  advanced?: boolean;
  /** The screen was already gone when the pre-close probe ran (it closed itself); the handler was not invoked and nothing is unresolved. */
  gone?: boolean;
  /** A supplied content expectation did not match what the screen shows now; the handler was not invoked. */
  changed?: boolean;
  /** What the screen shows instead, when `changed` is true. */
  content?: PopupContent | null;
  error?: string;
  note?: string;
}

interface PopupAdapter {
  key: string;
  context: string;
  kind: PopupKind;
  dismissable: boolean;
  /** Information-only screen: the whole rendered content is preserved by `content`, so the exact native close may run automatically after the presentation callback accepts it. */
  auto?: boolean;
  /** Why an informational screen is never closed automatically (choosers and generic modals). */
  manualReason?: string;
  blocking: boolean | null;
  /** The single description the probe and the close body are generated from. */
  spec: ProbeSpec;
  /** Native global the close body invokes inside the screen's own context. */
  closeGlobal?: string;
  /** Generated from `spec` by the registry below. */
  probe: string;
  note?: string;
}

/** Escapes arbitrary bytes into a Lua string literal; the model never supplies Lua. */
function luaString(value: string): string {
  return '"' + [...Buffer.from(value)].map(byte => "\\" + byte.toString().padStart(3, "0")).join("") + '"';
}

// EraCompletePopup.StartEraShow derives its frame from these age predicates (heroic first).
// Preserve their meaning, not a screenshot of the frame. Include the score and thresholds
// available in EraProgressPanel; a missing getter must never silently become a Normal Age.
const LUA_ERA_STATE = `
  do
    local ok, state = pcall(function()
      local player = Game.GetLocalPlayer()
      assert(type(player) == "number" and player >= 0, "No local player")
      local eras = Game.GetEras()
      local era = eras:GetCurrentEra()
      local info = GameInfo.Eras[era]
      assert(info ~= nil, "Current era unavailable")
      assert(Controls.EraCompletedHeader:GetText() == Locale.ToUpper(info.Name), "Displayed era differs from current era")
      local heroic = eras:HasHeroicGoldenAge(player)
      local golden = eras:HasGoldenAge(player)
      local dark = eras:HasDarkAge(player)
      assert(type(heroic) == "boolean" and type(golden) == "boolean" and type(dark) == "boolean", "Age state unavailable")
      local values = {
        { "localPlayer", player },
        { "currentEra", era },
        { "age", heroic and "heroic" or golden and "golden" or dark and "dark" or "normal" },
        { "currentScore", eras:GetPlayerCurrentScore(player) },
        { "previousScore", eras:GetPlayerPreviousScore(player) },
        { "darkAgeThreshold", eras:GetPlayerDarkAgeThreshold(player) },
        { "goldenAgeThreshold", eras:GetPlayerGoldenAgeThreshold(player) },
        { "previousDarkAgeThreshold", eras:GetPlayerPreviousDarkAgeThreshold(player) },
        { "previousGoldenAgeThreshold", eras:GetPlayerPreviousGoldenAgeThreshold(player) },
      }
      for _, value in ipairs(values) do
        if value[1] ~= "age" then
          assert(type(value[2]) == "number" and value[2] == value[2] and math.abs(value[2]) < math.huge, value[1] .. " unavailable")
        end
      end
      return values
    end)
    if ok then
      for _, value in ipairs(state) do add("Game.GetEras." .. value[1], tostring(value[2]), "game-state") end
    else
      note("Era result could not be preserved: " .. tostring(state))
    end
  end`;

/**
 * Bounded capture of what the screen currently renders, as one Lua expression that leaves the
 * capture in `local capture`.
 *
 * Verified named controls are read first, so the fields carry their semantic identity
 * (Controls.DisasterName, Controls.UnitsLostLabel, ...) instead of a tree position; the visible
 * control tree is walked afterwards for everything else (instance-manager text such as historic
 * moment entries, unlock stacks and deal rows). A control whose GetText is empty but whose
 * GetToolTipString has text is reported with source "tooltip": that is how icon-only content
 * (unlock slots, buttons, wonder icon descriptions) states its name natively. Every call is
 * pcall'd because control types differ in which methods they answer, and text already reported
 * under a named control is not repeated from its tree position.
 *
 * Limits are reported, never hidden: `truncated` means rendered text was dropped, and `unreadable`
 * names rendered content that carries no readable text at all (icon-only slots, frame decoration).
 */
function luaCapture(spec: ProbeSpec): string {
  const anchors = (spec.anchors ?? []).map((anchor, index) => `
    do
      local anchorOK${index}, anchorControl${index} = pcall(function() return ${anchor} end)
      if anchorOK${index} and anchorControl${index} ~= nil and shown(anchorControl${index}) then
        local anchorText${index}, anchorSource${index} = controlText(anchorControl${index})
        if anchorText${index} ~= nil then
          named[anchorText${index}] = (named[anchorText${index}] or 0) + 1
          add(${luaString(anchor)}, anchorText${index}, anchorSource${index})
        end
      end
    end`).join("");
  // Containers whose visible children are render slots (icons, buttons) that must each expose
  // readable content: text or a tooltip anywhere inside the slot. A slot that reads as nothing is
  // reported as unreadable, so a screen is only ever closed over content it actually preserved.
  const slots = (spec.slotRoots ?? []).map((slot, index) => `
    do
      local slotsOK${index}, slotRoot${index} = pcall(function() return ${slot.root} end)
      if slotsOK${index} and slotRoot${index} ~= nil then checkSlots(slotRoot${index}, ${luaString(slot.root)}, ${luaString(slot.button)}) end
    end`).join("");
  return `local capture = (function()
  local MAX_ITEMS, MAX_CHARS, MAX_TEXT, MAX_DEPTH = 600, 48000, 4000, 12
  local MAX_NOTES = 6
  local fields, chars, truncated = {}, 0, false
  local unreadable = { ${spec.unreadable === undefined ? "" : luaString(spec.unreadable)} }
  local named = {}
  local function note(text)
    if #unreadable >= MAX_NOTES then return end
    unreadable[#unreadable + 1] = text
  end
  local function add(control, text, source)
    if type(text) ~= "string" then return end
    text = text:gsub("^%s+", ""):gsub("%s+$", "")
    if text == "" then return end
    if #text > MAX_TEXT then text = text:sub(1, MAX_TEXT); truncated = true end
    if #fields >= MAX_ITEMS or chars + #text > MAX_CHARS then truncated = true; return end
    chars = chars + #text
    fields[#fields + 1] = { control = control, text = text, source = source or "text" }
  end
  local function shown(control)
    local visibleOK, visible = pcall(function() return control:IsVisible() end)
    if visibleOK and visible == false then return false end
    local hiddenOK, hidden = pcall(function() return control:IsHidden() end)
    if hiddenOK and hidden == true then return false end
    return true
  end
  -- A control that answers GetText with nothing is normal (containers, images, grids) and is not a
  -- defect. A getter that raises is also treated as no text for that control: only the tree
  -- enumeration and the slot checks below can tell us that something readable was never read.
  local function controlText(control)
    local textOK, text = pcall(function() return control:GetText() end)
    if textOK and type(text) == "string" and text:match("%S") then return text, "text" end
    local tipOK, tip = pcall(function() return control:GetToolTipString() end)
    if tipOK and type(tip) == "string" and tip:match("%S") then return tip, "tooltip" end
    return nil, nil
  end
  local function walk(control, path, depth)
    if #fields >= MAX_ITEMS or chars >= MAX_CHARS then truncated = true; return end
    local ok, children = pcall(function() return control:GetChildren() end)
    if not ok or type(children) ~= "table" then
      -- The subtree below this control was never enumerated: its text cannot be claimed as
      -- captured, so the capture is incomplete and no automatic close may rely on it.
      truncated = true
      note("GetChildren failed at " .. path .. ", so that subtree's text was not read")
      return
    end
    for index, child in ipairs(children) do
      local childPath = path .. "/" .. tostring(index)
      if shown(child) then
        local text, source = controlText(child)
        if text ~= nil then
          if named[text] ~= nil and named[text] > 0 then named[text] = named[text] - 1 else add(childPath, text, source) end
        end
        if depth < MAX_DEPTH then walk(child, childPath, depth + 1) else
          truncated = true
          note("text below " .. childPath .. " was not read (depth " .. MAX_DEPTH .. " reached)")
        end
      end
    end
  end
  -- The slot's own named control is what states the content natively (TechCivicCompletedPopup.xml:
  -- UnlockInstance Top -> Image -> UnlockIcon button, and TechAndCivicSupport puts the item's
  -- localized tooltip on that button), so the check targets that control, never a decorative image.
  local function findById(control, id, depth)
    if depth > 4 then return nil end
    local idOK, own = pcall(function() return control:GetID() end)
    if idOK and own == id then return control end
    local childrenOK, children = pcall(function() return control:GetChildren() end)
    if not childrenOK or type(children) ~= "table" then return nil end
    for _, child in ipairs(children) do
      local found = findById(child, id, depth + 1)
      if found ~= nil then return found end
    end
    return nil
  end
  local function checkSlots(root, rootName, buttonId)
    local ok, renderedSlots = pcall(function() return root:GetChildren() end)
    if not ok or type(renderedSlots) ~= "table" then
      note(rootName .. " could not be enumerated, so its rendered slots were not read")
      return
    end
    local rendered, readable = 0, 0
    for _, slot in ipairs(renderedSlots) do
      if shown(slot) then
        rendered = rendered + 1
        local button = findById(slot, buttonId, 0)
        if button ~= nil and controlText(button) ~= nil then readable = readable + 1 end
      end
    end
    if rendered > readable then
      note(rootName .. ": " .. tostring(readable) .. " of " .. tostring(rendered) .. " rendered slots exposed no readable " .. buttonId .. " text or tooltip")
    end
  end${anchors}${slots}${spec.eraState ? LUA_ERA_STATE : ""}
  walk(ContextPtr, "root", 0)
  return { fields = fields, truncated = truncated, unreadable = unreadable }
end)()`;
}

/** Structural comparison used inside the screen's own invocation, so it cannot race the close. */
const LUA_SAME_CAPTURE = `local function sameCapture(left, right)
  if left == nil or right == nil then return left == right end
  if left.truncated ~= right.truncated then return false end
  if #left.unreadable ~= #right.unreadable then return false end
  for i = 1, #left.unreadable do if left.unreadable[i] ~= right.unreadable[i] then return false end end
  if #left.fields ~= #right.fields then return false end
  for i = 1, #left.fields do
    local a, b = left.fields[i], right.fields[i]
    if a.control ~= b.control or a.text ~= b.text or (a.source or "text") ~= (b.source or "text") then return false end
  end
  return true
end`;

/** The expected capture as a Lua literal, read by the in-screen comparison. */
function luaContent(value: PopupContent): string {
  const fields = value.fields
    .map(field => `{control=${luaString(field.control)},text=${luaString(field.text)},source=${luaString(field.source)}}`)
    .join(",");
  return `{fields={${fields}},truncated=${value.truncated ? "true" : "false"},unreadable={${value.unreadable.map(luaString).join(",")}}}`;
}

interface ProbeSpec {
  /** Queue-member screens ask UIManager directly; every other screen reports active = visible. */
  queue?: boolean;
  /** Global close handler whose callability is reported as `closeable`. */
  close?: string;
  /** Verified control read as `title` while the screen is rendered. */
  title?: string;
  /** Verified named controls whose rendered text is reported first, under its own name. */
  anchors?: readonly string[];
  /** Rendered content on this screen that carries no readable text at all. */
  unreadable?: string;
  /** Containers whose visible children are render slots; the named control inside each rendered slot must expose readable content. */
  slotRoots?: ReadonlyArray<{ root: string; button: string }>;
  /** Preserve the age frame's native meaning and score at an era rollover. */
  eraState?: boolean;
  /** Capture the rendered text tree while the screen is visible. */
  capture?: boolean;
}

/** One presence probe; content is only walked while the screen is actually rendered. */
function luaProbe(spec: ProbeSpec): string {
  const body: string[] = ["local result = { visible = (not ContextPtr:IsHidden()) }"];
  body.push(spec.queue
    ? "result.active = UIManager:IsInPopupQueue(ContextPtr)"
    : "result.active = result.visible");
  if (spec.close) {
    body.push(`local closeOK, closeValue = pcall(function() return ${spec.close} end)`,
      `result.closeable = (closeOK and type(closeValue) == "function")`);
  }
  if (spec.title) {
    body.push(`if result.visible then
  local titleOK, titleValue = pcall(function() return ${spec.title}:GetText() end)
  if titleOK and type(titleValue) == "string" and titleValue ~= "" then result.title = titleValue end
end`);
  }
  if (spec.capture) body.push(`if result.visible then ${luaCapture(spec)} result.content = capture end`);
  return `(function() ${body.join("\n")} return result end)()`;
}

/**
 * Presence check and the exact native close in ONE screen invocation. When an expectation is
 * supplied, the screen is re-captured and compared inside the same Lua execution, so a successor
 * raised from the same context can never be acknowledged before its own content is preserved.
 * Returns {present=false} when the screen is not showing, {matched=false,content=...} when the
 * content changed, {closed=false,missing="X"} when the handler is not callable, {closed=true} after
 * the native handler ran.
 */
function luaClose(global: string, spec: ProbeSpec, expected?: PopupContent): string {
  if (expected !== undefined && spec.capture !== true) {
    throw new Error("A guarded close needs a capture probe for that screen.");
  }
  const presence = spec.queue
    ? "local visible = (not ContextPtr:IsHidden())\n    local active = UIManager:IsInPopupQueue(ContextPtr)\n    if not (visible or active) then return { present = false } end"
    : "if ContextPtr:IsHidden() then return { present = false } end";
  const guard = expected === undefined
    ? ""
    : `${luaCapture(spec)}
    if not sameCapture(capture, ${luaContent(expected)}) then return { present = true, matched = false, content = capture } end
    `;
  return `(function()
    ${presence}
    ${expected === undefined ? "" : `${LUA_SAME_CAPTURE}\n    `}${guard}if type(${global}) ~= "function" then return { present = true, closed = false, missing = "${global}" } end
    ${global}()
    return { present = true, closed = true }
  end)()`;
}

/** The registry. Handler evidence and cleanup side effects are cited per screen from the native
 * UI source. `blocking` reflects source-verified semantics only; unverified screens are null. The
 * probe is not written here: every adapter is described once by its spec and the registry below
 * generates the probe from it. */
const ADAPTERS: ReadonlyArray<Omit<PopupAdapter, "probe">> = [
  {
    key: "natural-disaster",
    context: "NaturalDisasterPopup",
    kind: "informational",
    dismissable: true,
    auto: true,
    blocking: true,
    spec: { close: "Close", title: "Controls.HeaderTitle", capture: true, anchors: ["Controls.HeaderTitle", "Controls.DisasterName", "Controls.DisasterDescription", "Controls.PlotLostFertileLabel", "Controls.PlotFertileLabel", "Controls.PlotDamagedLabel", "Controls.UnitsLostLabel", "Controls.PopLostLabel", "Controls.MitigatedLabel"] },
    closeGlobal: "Close",
    note: "NaturalDisasterPopup.lua (GS Addition). Close() clears temporary plot visibility 'NaturalDisaster', stops all disaster movie sound loops, stops camera animations, advances its internal queued sequence, then restores SELECTION interface mode + active lens and ExclusivePopupManager:Unlock (DequeuePopup + Input.PopContext + engine event release). ESC/right-click = Close; auto-closes on local turn end. Animation-sequenced disasters may have released the engine hold mid-movie while still visible. HeaderTitle/DisasterName/DisasterDescription and the casualty counters are SetText-backed, so the rendered report is captured before any automatic close.",
  },
  {
    key: "natural-wonder",
    context: "NaturalWonderPopup",
    kind: "informational",
    dismissable: true,
    auto: true,
    blocking: true,
    spec: { close: "Close", title: "Controls.WonderName", capture: true, anchors: ["Controls.WonderName", "Controls.WonderQuote"] },
    closeGlobal: "Close",
    note: "NaturalWonderPopup.lua. Close() clears temporary plot visibility 'NaturalWonder', stops the wonder speech, stops camera animations, advances its internal queued sequence, then restores SELECTION interface mode + active lens and Unlock (engine hold released). ESC/right-click = Close. WonderName/WonderQuote are SetText-backed, and the wonder description that ShowPopup sets on Controls.WonderIcon as a tooltip is captured from that control.",
  },
  {
    key: "wonder-built",
    context: "WonderBuiltPopup",
    kind: "informational",
    dismissable: true,
    auto: true,
    blocking: true,
    spec: { close: "Close", title: "Controls.WonderName", capture: true, anchors: ["Controls.WonderName", "Controls.WonderQuote"] },
    closeGlobal: "Close",
    note: "WonderBuiltPopup.lua. Close() stops the wonder music tracks, advances its internal queued sequence, then restores SELECTION interface mode + active lens and Unlock. ESC/right-click = Close; native auto-close on local turn end. WonderName/WonderQuote are SetText-backed, and the description ShowPopup sets as the wonder icon's tooltip is captured from that control.",
  },
  {
    key: "project-built",
    context: "ProjectBuiltPopup",
    kind: "informational",
    dismissable: true,
    auto: true,
    blocking: true,
    spec: { close: "Close", title: "Controls.ProjectName", capture: true, anchors: ["Controls.ProjectName", "Controls.ProjectQuote"] },
    closeGlobal: "Close",
    note: "ProjectBuiltPopup.lua. Close() stops the narrator sound, advances its internal queued sequence, then restores SELECTION interface mode + active lens and Unlock. ESC/right-click = Close. ProjectName/ProjectQuote are SetText-backed.",
  },
  {
    key: "era-complete",
    context: "EraCompletePopup",
    kind: "informational",
    dismissable: true,
    auto: true,
    blocking: true,
    spec: { close: "Close", title: "Controls.EraCompletedHeader", capture: true, anchors: ["Controls.EraCompletedHeader"], eraState: true },
    closeGlobal: "Close",
    note: "EraCompletePopup.lua (GS): preserves the displayed era plus local-player age, score and thresholds from Game.GetEras, with heroic/golden/dark/normal precedence matching StartEraShow. Close() releases the popup's engine lock or dequeues it and stops both animations; it selects no dedication. Native state is recaptured in the atomic compare-and-close invocation.",
  },
  {
    key: "boost-unlocked",
    context: "BoostUnlockedPopup",
    kind: "informational",
    dismissable: true,
    auto: true,
    blocking: false,
    spec: { queue: true, close: "OnClose", title: "Controls.HeaderLabel", capture: true, anchors: ["Controls.HeaderLabel", "Controls.BoostDescString", "Controls.BoostCauseString"] },
    closeGlobal: "OnClose",
    note: "BoostUnlockedPopup.lua. OnClose() is the native Continue-button/ESC/Return path: UIManager:DequeuePopup(ContextPtr) then ShowNextQueuedPopup(). No engine event hold (Low priority, DelayShow queue slot); other input passes through while shown. HeaderLabel/BoostDescString/BoostCauseString are SetText-backed.",
  },
  {
    key: "tech-civic-completed",
    context: "TechCivicCompletedPopup",
    kind: "informational",
    dismissable: true,
    auto: true,
    blocking: true,
    spec: { queue: true, close: "OnClose", title: "Controls.HeaderLabel", capture: true, anchors: ["Controls.HeaderLabel", "Controls.ResearchName", "Controls.CivicMsgLabel", "Controls.UnlockCountLabel", "Controls.QuoteLabel"], slotRoots: [{ root: "Controls.UnlockStack", button: "UnlockIcon" }] },
    closeGlobal: "OnClose",
    note: "TechCivicCompletedPopup.lua. OnClose() is the native Close-button/ESC path (TryClose): it acknowledges the shown tech/civic, then shows the NEXT queued completion and only fully closes when none remain; dismiss again until none left. The direct Close() global dumps the whole internal queue and is never what a native click does, so it is not used. Consumes all input while shown. HeaderLabel/ResearchName/CivicMsgLabel/UnlockCountLabel/QuoteLabel are captured before the acknowledgement, each rendered unlock slot must expose readable content (TechAndCivicSupport.lua:366-367/:400 put ToolTipHelper.GetToolTip(typeName, playerID) on the slot's UnlockIcon button, so the unlocked item's own localized tooltip is captured; a slot that reads as nothing makes the capture incomplete and blocks the automatic close), and an immediate successor is observed again before it is acknowledged in turn.",
  },
  {
    key: "in-game",
    context: "InGamePopup",
    kind: "informational",
    dismissable: true,
    manualReason: "Generic modal raised by many systems; its instances can carry confirm/cancel buttons, and PopupDialog text is only reachable by walking the rendered tree. The text is preserved, but closing it stays an explicit decision.",
    blocking: true,
    spec: { close: "OnClosePopup", capture: true, anchors: ["Controls.PopupTitle"], unreadable: "The dialog rows are built by PopupDialog instances under Controls.PopupStack (PopupDialog.lua AddText/AddButton); their text is read from the tree, but a countdown/checkbox row may carry its state without text and stays readable only as native state." },
    closeGlobal: "OnClosePopup",
    note: "InGamePopup.lua. OnClosePopup() is the native last-resort ESC branch: UIManager:PopModal + close the dialog WITHOUT activating any button. Raised generically by many systems (modal, 'popups are blocking'); some instances carry confirm/cancel buttons - inspect the captured content before dismissing.",
  },
  {
    key: "advisor",
    context: "AdvisorPopup",
    kind: "informational",
    dismissable: true,
    manualReason: "Advisor items can register button callbacks, so the message is preserved but closing stays an explicit decision.",
    blocking: true,
    spec: { queue: true, close: "Close", capture: true, anchors: ["Controls.CalloutHeader", "Controls.CalloutBody", "Controls.InfoString", "Controls.MetaInfoString"] },
    closeGlobal: "Close",
    note: "AdvisorPopup.lua (TutorialUIRoot context). Close() dequeues the tutorial-priority popup. Native ESC here opens the options menu instead, so Close() is the verified cosmetic close; input consumption is gated by the screen's own IsBlockingInput(). The message lives in InfoString or MetaInfoString depending on the portrait mode, and CalloutHeader/CalloutBody carry any callout; both are captured.",
  },
  {
    key: "great-work-showcase",
    context: "GreatWorkShowcase",
    kind: "informational",
    dismissable: true,
    auto: true,
    blocking: false,
    spec: { close: "HideScreen", title: "Controls.WritingName", capture: true, anchors: ["Controls.WritingName"] },
    closeGlobal: "HideScreen",
    note: "GreatWorkShowcase.lua. HideScreen() is the native close-button/ESC path: hides the context and stops the gallery music, great-writing speech and ambience. A full-screen reveal, not a popup-queue member; no engine hold. Next/Previous/ViewGreatWorks are navigation callbacks, not choices. The screen is also opened deliberately from the great-works overview (m_isGallery), which the context alone cannot distinguish, so a deliberately opened gallery is closed by the same path - its rendered content is captured first.",
  },
  {
    key: "historic-moments",
    context: "HistoricMoments",
    kind: "informational",
    dismissable: true,
    auto: true,
    blocking: null,
    spec: { queue: true, close: "Close", title: "Controls.ModalScreenTitle", capture: true, anchors: ["Controls.ModalScreenTitle"] },
    closeGlobal: "Close",
    note: "DLC/Expansion2/UI/Additions/HistoricMoments.lua: the era-moment timeline raise. Queued at PopupPriority.Medium with DelayShow + InputAtCurrentParent and one moment shown per UI idle from its own internal queue (m_kQueuedPopups, Show(), OnUIIdle). Close() is the native Close-button/right-click/ESC path: UIManager:DequeuePopup(ContextPtr) then HistoricMoments_Closed; the next queued moment raises on the following UI idle, so dismiss again. Input consumption while it is the active popup is not verified from source, so blocking is unknown. The same screen is also opened deliberately from the LaunchBar/EndGame menu, which the context alone cannot distinguish; the whole rendered timeline is captured before any automatic close.",
  },
  {
    key: "event",
    context: "EventPopup",
    kind: "choice",
    dismissable: false,
    blocking: true,
    spec: { queue: true },
    note: "EventPopup.lua: generic event popup, queued at Medium priority. Native ESC deliberately refuses to close while choices are pending (TTP 43191) - mandatory when it carries ChoiceA/ChoiceB; answer through civ.decide/native UI.",
  },
  {
    key: "great-people",
    context: "GreatPeoplePopup",
    kind: "choice",
    dismissable: true,
    blocking: null,
    spec: { queue: true, close: "OnClose" },
    closeGlobal: "OnClose",
    note: "GreatPeoplePopup: great-person patronage chooser (recruit / gold / faith / reject). Close()/OnClose() (Base/Assets/UI/Popups/GreatPeoplePopup.lua:852) is the native screen close: UI_Screen_Close + UIManager:DequeuePopup + GreatPeople_CloseGreatPeople, and it patronizes nobody, so the screen may be closed explicitly. Claiming or patronizing a person stays a decision answered through civ.decide.",
  },
  {
    key: "unit-promotion",
    context: "UnitPromotionPopup",
    kind: "choice",
    dismissable: false,
    blocking: null,
    spec: {},
    note: "UnitPromotionPopup: promotion chooser for a leveled unit (queued, Low priority). Answer through civ.decide.",
  },
  {
    key: "governor-panel",
    context: "GovernorPanel",
    kind: "choice",
    dismissable: true,
    blocking: null,
    spec: { queue: true, close: "Close" },
    closeGlobal: "Close",
    note: "DLC/Expansion2/UI/Additions/GovernorPanel.lua: governor management panel (PopupPriority.Low queue member, opened from the governor title prompt, the LaunchBar or a city banner). Close() (:476) hides the details panel, Dequeues and fires GovernorPanel_Closed; the source states explicitly that closing does not mark the player as having considered their governor options, so it is a lossless screen close and never spends a title. Appointing or promoting a governor stays a decision answered through civ.decide.",
  },
  {
    key: "governor-assignment-chooser",
    context: "GovernorAssignmentChooser",
    kind: "choice",
    dismissable: true,
    blocking: null,
    spec: { queue: true, close: "Close" },
    closeGlobal: "Close",
    note: "DLC/Expansion2/UI/Additions/GovernorAssignmentChooser.lua: the assign-this-governor chooser raised with the Loyalty lens. Close() (:387) restores the lens and Dequeues; the assignment itself is a separate native request (ConfirmedAssignment, :400), so closing cancels nothing that was submitted and assigns nobody. Reported, never closed automatically.",
  },
  {
    key: "raze-city",
    context: "RazeCity",
    kind: "choice",
    dismissable: false,
    blocking: null,
    spec: {},
    note: "RazeCity: raze-or-keep city confirmation. Answer through civ.decide.",
  },
  {
    key: "choose-artifact",
    context: "ChooseArtifact",
    kind: "choice",
    dismissable: false,
    blocking: null,
    spec: {},
    note: "ChooseArtifact: artifact/relic selection chooser.",
  },
  {
    key: "espionage-escape",
    context: "EspionageEscape",
    kind: "choice",
    dismissable: false,
    blocking: null,
    spec: {},
    note: "EspionageEscape: escape-route district choice; confirming issues the native SET_ESCAPE_ROUTE player operation.",
  },
  {
    key: "espionage",
    context: "EspionagePopup",
    kind: "choice",
    dismissable: false,
    blocking: null,
    spec: {},
    note: "EspionagePopup: spy mission briefing with accept/abort/renew outcomes; those are real espionage choices.",
  },
  {
    key: "map-pin",
    context: "MapPinPopup",
    kind: "choice",
    dismissable: false,
    blocking: null,
    spec: {},
    note: "MapPinPopup: map-pin creation form; OK/Delete/Cancel each act on the pin, so no bare cosmetic close is exposed.",
  },
  {
    key: "declare-war",
    context: "DeclareWarPopup",
    kind: "choice",
    dismissable: false,
    blocking: null,
    spec: {},
    note: "DeclareWarPopup: war confirmation with consequence summary; its OnClose merely hides the chooser without deciding.",
  },
  {
    key: "world-congress",
    context: "WorldCongressPopup",
    kind: "diplomacy",
    dismissable: true,
    blocking: null,
    spec: { queue: true, close: "ClosePopup" },
    closeGlobal: "ClosePopup",
    note: "WorldCongressPopup: congress session voting UI; ballots are answered through civ.decide diplomacy session responses. ClosePopup() (DLC/Expansion2/UI/Additions/WorldCongressPopup.lua) is the native close button: it only runs while the context is visible, then UIManager:DequeuePopup + Input.PopContext + WC_Exit; out of session it also sends the native WORLD_CONGRESS_LOOKED_AT_AVAILABLE acknowledgement for the turn blocker. After a ballot submit that reports sessionSubmitted=true the bridge runs exactly that teardown itself and reports it as popupClose, but only while ResolutionContainer (stages 1-2) or the tabless in-session ReviewContainer is showing: a stage-4 review surface is left untouched so its rendered review data is preserved. civ.decide({id:\"popup:world-congress\"}) remains the explicit path if the screen is still up for any other reason. Never closed automatically by the presentation boundary.",
  },
  {
    key: "world-congress-between-turns",
    context: "WorldCongressBetweenTurns",
    kind: "diplomacy",
    dismissable: false,
    blocking: null,
    spec: { queue: true },
    note: "WorldCongressBetweenTurns: between-session congress flow. Its teardown lives in the context's own OnHide (ReleaseEventLock + DequeuePopup, WorldCongressBetweenTurns.lua:113-118); there is no callable close global, so no dismissal is exposed and the screen is only reported. The between-sessions look blocker is cleared by the native WORLD_CONGRESS_LOOKED_AT_AVAILABLE request, not by closing this screen.",
  },
  {
    key: "world-congress-intro",
    context: "WorldCongressIntro",
    kind: "diplomacy",
    dismissable: true,
    blocking: null,
    spec: { queue: true, close: "OnClose" },
    closeGlobal: "OnClose",
    note: "WorldCongressIntro: congress session introduction flow. OnClose() (WorldCongressIntro.lua:26) is the native close and does UIManager:DequeuePopup(ContextPtr) only. Never closed automatically: the session's choices stay with the model.",
  },
  {
    key: "diplomacy-action-view",
    context: "DiplomacyActionView",
    kind: "diplomacy",
    dismissable: false,
    blocking: null,
    spec: { capture: true },
    note: "DiplomacyActionView: leader diplomacy session view; sessions end only through native diplomacy choices. Read-only text capture of the rendered screen (requested by the diplomacy module as a degraded-diagnostics fallback when its InGame managers are unreachable); the screen is never dismissed by the bridge.",
  },
  {
    key: "diplomacy-deal-view",
    context: "DiplomacyDealView",
    kind: "diplomacy",
    dismissable: false,
    blocking: null,
    spec: { capture: true },
    note: "DiplomacyDealView: deal negotiation view. Read-only text capture of the rendered terms (same degraded-diagnostics fallback as the action view: deal rows and values live in instance controls the control-tree walk reaches); the offered, requested and draft state itself stays with the diplomacy module and native UI, and the bridge never dismisses this screen.",
  },
  {
    key: "leader-scene",
    context: "LeaderScene",
    kind: "diplomacy",
    dismissable: false,
    blocking: null,
    spec: {},
    note: "LeaderScene: leader dialogue scene behind diplomacy sessions.",
  },
  {
    key: "end-game-menu",
    context: "EndGameMenu",
    kind: "gameover",
    dismissable: false,
    blocking: true,
    spec: {},
    note: "EndGameMenu: victory/defeat screen; ShouldPauseGame holds the game while shown. Reported, never dismissed by the bridge.",
  },
];

const REGISTRY: PopupAdapter[] = ADAPTERS.map(entry => ({ ...entry, probe: luaProbe(entry.spec) }));

const KNOWN_IDS = REGISTRY.map(entry => `popup:${entry.key}`).join(", ");

const NOT_DISMISSABLE_REASON: Record<PopupKind, string> = {
  informational: "",
  choice: "Gameplay chooser: answer through civ.decide or native UI; cosmetically closing it would skip a real decision.",
  diplomacy: "Diplomacy/congress UI: it ends only through the native diplomacy session, never a cosmetic close.",
  gameover: "Terminal game-over screen: never dismissed by the bridge.",
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function titleFrom(record: Record<string, unknown>): string | null {
  const raw = record.title;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Observe known popup contexts through the trusted invoker. No selector probes every registry context; selector.id selects exactly one (precedence over kinds); selector.kinds filters by kind. Unknown selector values throw; missing/failed contexts are reported explicitly, never fabricated. */
export async function observePopups(invoke: PopupInvoker, selector?: PopupSelector): Promise<PopupObservation[]> {
  return Promise.all(selectEntries(selector).map(entry => observeEntry(entry, invoke)));
}

function selectEntries(selector?: PopupSelector): PopupAdapter[] {
  if (selector === undefined) return REGISTRY;
  if (selector.id !== undefined) {
    const entry = REGISTRY.find(candidate => `popup:${candidate.key}` === selector.id);
    if (entry === undefined) throw new Error(`Unknown popup selector id ${selector.id}. Known ids: ${KNOWN_IDS}.`);
    return [entry];
  }
  if (selector.kinds !== undefined) {
    const kinds = selector.kinds;
    const unknownKinds = kinds.filter(kind => !POPUP_KINDS.includes(kind));
    if (unknownKinds.length > 0) throw new Error(`Unknown popup selector kind ${unknownKinds.join(", ")}. Valid kinds: ${POPUP_KINDS.join(", ")}.`);
    return REGISTRY.filter(entry => kinds.includes(entry.kind));
  }
  return REGISTRY;
}
const FIELD_SOURCES: readonly PopupContentField["source"][] = ["text", "tooltip", "game-state"];

/** Rendered texts the screen reported; a malformed capture is an error, never a partial claim. */
function contentFrom(raw: unknown): { content: PopupContent | null; error?: string } {
  if (raw === undefined || raw === null) return { content: null };
  const source = asRecord(raw);
  if (!Array.isArray(source.fields)) return { content: null, error: "The screen's content probe returned no field list." };
  const fields: PopupContentField[] = [];
  const seen = new Set<string>();
  for (const item of source.fields) {
    const field = asRecord(item);
    if (typeof field.control !== "string" || typeof field.text !== "string") {
      return { content: null, error: "The screen's content probe returned a malformed text entry." };
    }
    const kind = FIELD_SOURCES.includes(field.source as PopupContentField["source"])
      ? field.source as PopupContentField["source"]
      : "text";
    const key = `${field.control}\0${field.text}\0${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fields.push({ control: field.control, text: field.text, source: kind });
  }
  const unreadable: string[] = [];
  if (Array.isArray(source.unreadable)) {
    for (const item of source.unreadable) if (typeof item === "string" && item) unreadable.push(item);
  }
  return { content: { fields, truncated: source.truncated === true, unreadable } };
}

/** Why this observation will never be closed automatically; null when it may be. */
function autoReason(entry: PopupAdapter, observation: PopupObservation): string | null {
  if (observation.kind !== "informational") return NOT_DISMISSABLE_REASON[observation.kind];
  if (!entry.auto) return entry.manualReason ?? "This screen is never closed automatically.";
  if (observation.status !== "ok") return `The screen could not be probed: ${observation.error ?? observation.status}.`;
  if (!observation.visible && observation.active) return "The screen holds a queue slot but is not rendered yet; nothing is closed before its content is captured.";
  if (!observation.dismissable) return `No native close handler is callable in ${entry.context}, so the screen cannot be dismissed.`;
  if (observation.contentStatus === "error") return `The screen's rendered text could not be captured: ${observation.contentError ?? "unknown extraction error"}.`;
  if (observation.contentStatus === "unsupported") return `Nothing was captured from ${entry.context}, so no rendered text would be preserved before closing it.`;
  if (observation.content === null || observation.content.fields.length === 0) return "The capture contains no rendered text, so there is nothing to preserve before closing it.";
  if (observation.content.truncated) return "The capture is incomplete: rendered text was dropped or part of the control tree could not be read, so the screen is left on screen.";
  if (observation.content.unreadable.length > 0) return `The screen renders content the capture cannot read (${observation.content.unreadable[0]}), so nothing is closed over content that is not preserved.`;
  if (!observation.active && !observation.visible) return "Not currently active or visible.";
  return null;
}

/** True when two captures describe the same rendered content. Exported for the presentation tests. */
export function sameContent(left: PopupContent | null, right: PopupContent | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.truncated !== right.truncated) return false;
  if (left.unreadable.length !== right.unreadable.length) return false;
  if (left.unreadable.some((item, index) => item !== right.unreadable[index])) return false;
  if (left.fields.length !== right.fields.length) return false;
  return left.fields.every((field, index) => {
    const other = right.fields[index]!;
    return field.control === other.control && field.text === other.text && field.source === other.source;
  });
}

function observationFrom(entry: PopupAdapter, record: Record<string, unknown>): PopupObservation {
  const visible = record.visible === true;
  const active = record.active === undefined ? visible : record.active === true;
  const capture = contentFrom(record.content);
  const observation: PopupObservation = {
    id: `popup:${entry.key}`,
    context: entry.context,
    kind: entry.kind,
    active,
    visible,
    blocking: entry.blocking,
    dismissable: entry.dismissable && record.closeable === true,
    autoDismissible: false,
    autoDismissReason: null,
    content: capture.content,
    contentStatus: capture.error !== undefined ? "error" : capture.content !== null ? "captured" : "unsupported",
    contentError: capture.error,
    title: titleFrom(record),
    status: "ok",
    note: entry.note,
  };
  const reason = autoReason(entry, observation);
  observation.autoDismissReason = reason;
  observation.autoDismissible = reason === null;
  return observation;
}

async function observeEntry(entry: PopupAdapter, invoke: PopupInvoker): Promise<PopupObservation> {
  let decoded: unknown;
  try {
    decoded = await invoke(entry.context, entry.probe);
  } catch (error) {
    if (isAborted(error)) throw error;
    return missingOrError(entry, message(error));
  }
  return observationFrom(entry, asRecord(decoded));
}

function missingOrError(entry: PopupAdapter, text: string): PopupObservation {
  const contextMissing = text.includes(entry.context) && text.includes("is not available");
  const observation: PopupObservation = {
    id: `popup:${entry.key}`,
    context: entry.context,
    kind: entry.kind,
    active: false,
    visible: false,
    blocking: entry.blocking,
    dismissable: entry.dismissable,
    autoDismissible: false,
    autoDismissReason: null,
    content: null,
    contentStatus: "unsupported",
    title: null,
    status: contextMissing ? "context-missing" : "error",
    error: text,
    note: entry.note,
  };
  observation.autoDismissReason = autoReason(entry, observation);
  return observation;
}

/**
 * Dismiss a known popup by executing its exact native close handler inside the screen's own
 * context. Pure screen teardown; never a gameplay choice. Presence, the optional content
 * expectation and the close all run in ONE Lua invocation, so a same-context successor can never
 * be acknowledged before its own content was read: a screen that is gone is reported as `gone`, a
 * screen whose content changed is reported as `changed` (with the new capture) and the handler is
 * not invoked at all.
 */
export async function dismissPopup(id: string, invoke: PopupInvoker, expect?: PopupContent): Promise<DismissPopupResult> {
  const entry = id.startsWith("popup:") ? REGISTRY.find(candidate => `popup:${candidate.key}` === id) : undefined;
  if (!entry) {
    return { id, dismissed: false, status: "error", error: `Unknown popup id ${id}. Known ids: ${KNOWN_IDS}.` };
  }
  if (!entry.dismissable || !entry.closeGlobal) {
    const reason = NOT_DISMISSABLE_REASON[entry.kind];
    return { id, dismissed: false, status: "not-dismissable", note: `${reason}${entry.note ? ` ${entry.note}` : ""}`.trim() };
  }

  // The guard needs the screen's capture probe; a programming mistake must fail loudly here
  // rather than silently close without comparing.
  const body = luaClose(entry.closeGlobal, entry.spec, expect);
  let closed: unknown;
  try {
    closed = await invoke(entry.context, body);
  } catch (error) {
    if (isAborted(error)) throw error;
    return { id, dismissed: false, status: "error", error: `Native close handler failed in ${entry.context}: ${message(error)}` };
  }
  const record = asRecord(closed);
  if (record.present === false) {
    return { id, dismissed: false, status: "ok", gone: true, note: `Not currently active or visible; native ${entry.context} close handler was not invoked.` };
  }
  if (record.matched === false) {
    const changed = contentFrom(record.content);
    return {
      id, dismissed: false, status: "ok", changed: true, content: changed.content,
      note: `${entry.context} no longer shows the captured content; it was not acknowledged, so the text on screen now is preserved before it is closed.`,
    };
  }
  if (record.missing !== undefined) {
    return { id, dismissed: false, status: "error", error: `Native ${String(record.missing)} handler is not callable in context ${entry.context}; no equivalent fallback is attempted.` };
  }
  if (record.closed !== true) {
    return { id, dismissed: false, status: "error", error: `Native close handler in ${entry.context} did not report success.` };
  }

  const after = await readPresence(entry, invoke);
  if (after.error !== undefined) {
    return { id, dismissed: false, status: "ok", note: `Native close invoked, but post-close verification failed: ${after.error}` };
  }
  if (after.present) {
    return {
      id, dismissed: false, status: "ok", advanced: true,
      note: "Native close ran; the screen immediately shows its next queued item (native sequence behavior), so the next item must be observed before it is dismissed in turn.",
    };
  }
  return { id, dismissed: true, status: "ok", note: entry.note };
}

interface Presence { present: boolean; error?: string }

/**
 * The teardown the native Accept performs after a submitted ballot (WorldCongressPopup.lua
 * OnAccept -> ClosePopup). This is mechanical follow-through of the model's own explicit submit,
 * never a choice, and it runs only while the context still shows the in-session congress surface.
 * Source-verified guard: SetStage sets `m_IsInSession = stageNum ~= 4` and shows
 * ResolutionContainer for stages 1-2 only (`SetHide(stageNum >= 3)`), while the out-of-session
 * review surface of stage 4 shows ReviewContainer together with ReviewTabsContainer
 * (`SetHide(stageNum ~= 4)`). In-session phase 2 shows ReviewContainer without those tabs, so the
 * predicate needs both signals - a context that has moved on to the review tabs is reported
 * untouched instead of being closed over freshly rendered review data.
 */
export async function closeSubmittedCongress(invoke: PopupInvoker): Promise<CongressCloseResult> {
  let decoded: unknown;
  try {
    decoded = await invoke("WorldCongressPopup", LUA_CONGRESS_ACCEPT_TEARDOWN);
  } catch (error) {
    if (isAborted(error)) throw error;
    return { id: "popup:world-congress", status: "error", error: message(error), note: "The submit result stands; the congress screen could not be re-probed, so close it explicitly with civ.decide if it is still up." };
  }
  const record = asRecord(decoded);
  if (record.present === false) {
    return { id: "popup:world-congress", status: "already-closed", note: "The congress screen was no longer showing; nothing was closed." };
  }
  if (record.inSessionSurface !== true) {
    return { id: "popup:world-congress", status: "not-the-submitted-surface", note: "The congress context no longer shows the in-session voting surface (it is on the review tabs), so it was left untouched; its rendered review data is preserved by civ.decisions." };
  }
  if (record.missing !== undefined) {
    return { id: "popup:world-congress", status: "error", error: `Native ${String(record.missing)} handler is not callable in context WorldCongressPopup.` };
  }
  if (record.closed !== true) {
    return { id: "popup:world-congress", status: "error", error: "Native ClosePopup did not report success." };
  }
  return { id: "popup:world-congress", status: "closed", note: "Closed with the native ClosePopup teardown the Accept button itself runs." };
}

/** Presence check, the in-session surface guard and the exact native ClosePopup in one invocation. */
const LUA_CONGRESS_ACCEPT_TEARDOWN = `(function()
  if ContextPtr:IsHidden() then return { present = false } end
  local function shown(control)
    if control == nil then return false end
    local hiddenOK, hidden = pcall(function() return control:IsHidden() end)
    return hiddenOK and hidden == false
  end
  local resolutionOK, resolutionControl = pcall(function() return Controls.ResolutionContainer end)
  local reviewOK, reviewControl = pcall(function() return Controls.ReviewContainer end)
  local tabsOK, tabsControl = pcall(function() return Controls.ReviewTabsContainer end)
  -- SetStage: ResolutionContainer is shown for stages 1-2 and hidden from stage 3 on, while the
  -- review surface of stage 4 shows ReviewContainer together with ReviewTabsContainer. In-session
  -- phase 2 shows ReviewContainer without the review tabs, so both signals are needed.
  local inSessionSurface = shown(resolutionOK and resolutionControl or nil)
    or (shown(reviewOK and reviewControl or nil) and not shown(tabsOK and tabsControl or nil))
  if not inSessionSurface then return { present = true, inSessionSurface = false } end
  if type(ClosePopup) ~= "function" then return { present = true, inSessionSurface = true, closed = false, missing = "ClosePopup" } end
  ClosePopup()
  return { present = true, inSessionSurface = true, closed = true }
end)()`;

async function readPresence(entry: PopupAdapter, invoke: PopupInvoker): Promise<Presence> {
  let decoded: unknown;
  try {
    decoded = await invoke(entry.context, entry.probe);
  } catch (error) {
    if (isAborted(error)) throw error;
    return { present: false, error: message(error) };
  }
  const record = asRecord(decoded);
  return { present: record.visible === true || record.active === true };
}

/** Compact catalog for civ.probe; ids and kinds the bridge may advertise. */
export const popupCatalog: ReadonlyArray<{ id: string; context: string; kind: PopupKind; dismissable: boolean }> =
  REGISTRY.map(({ key, context, kind, dismissable }) => ({ id: `popup:${key}`, context, kind, dismissable }));

/**
 * What an auto-dismissed informational screen is worth in the player's context: the turn, the
 * screen, and the text it actually showed. Everything else the observation carries - the adapter's
 * implementation note, control-tree positions, the capture's provenance flags and the constant
 * status booleans - is engineering detail that was being reprinted on every occurrence. The full
 * observation stays in public history, which is where an audit belongs.
 */
const CHROME = new Set(["continue", "close", "ok", "okay", "cancel", "back", "next", "previous", "done", "accept", "dismiss", "boosted", "unlocked"]);

/** Rendered markup the screen uses for layout and icons; it carries no fact the text does not. */
function plain(text: string): string {
  return text
    .replace(/\\\|/g, "|")
    .replace(/\[NEWLINE\]/g, " ")
    .replace(/\[(?:SIZE|COLOR)_[^\]]*\]|\[\/?(?:COLOR|S|BOLD|ITALIC)\]/gi, "")
    .replace(/\[ICON_[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function popupDigest(popup: PopupObservation, turn: number | null): { turn: number | null; id: string; title: string | null; text: string; truncated?: true } | null {
  const lines: string[] = [];
  const seen = new Set<string>();
  const title = popup.title ? plain(popup.title) : null;
  if (title) seen.add(title.toLowerCase());
  for (const field of popup.content?.fields ?? []) {
    const text = plain(field.text);
    // Button captions and repeats are the screen's furniture, not its message.
    if (!text || CHROME.has(text.toLowerCase())) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(text);
  }
  if (!title && !lines.length) return null;
  return {
    turn,
    id: popup.id.replace(/^popup:/, ""),
    title,
    text: lines.join(" "),
    ...(popup.content?.truncated ? { truncated: true as const } : {}),
  };
}
