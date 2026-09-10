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
 * Only cosmetic closes are exposed. Gameplay choosers, diplomacy/congress UI and the terminal
 * EndGameMenu are observed and reported honestly (kind, blocking semantics, notes); the model
 * answers them through civ.decide / native UI. The model can only supply a `popup:<key>` id;
 * context names and Lua bodies are fixed constants in this file.
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

export type PopupKind = "informational" | "choice" | "diplomacy" | "gameover";

/** The kinds in canonical order; also the accepted values for a selector's kinds filter. */
const POPUP_KINDS: readonly PopupKind[] = ["informational", "choice", "diplomacy", "gameover"];

export interface PopupSelector {
  /** Exactly one registry entry; takes precedence over kinds. */
  id?: string;
  /** Only entries of these kinds are probed; an empty array selects nothing. */
  kinds?: PopupKind[];
}

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
  /** Best-effort localized header text; null when the screen exposes none cheaply. */
  title: string | null;
  status: "ok" | "context-missing" | "error";
  error?: string;
  note?: string;
}

export interface DismissPopupResult {
  id: string;
  /** The screen reports no longer active/visible after the native handler ran. */
  dismissed: boolean;
  status: "ok" | "not-dismissable" | "error";
  error?: string;
  note?: string;
}

interface PopupAdapter {
  key: string;
  context: string;
  kind: PopupKind;
  dismissable: boolean;
  blocking: boolean | null;
  /** Lua expression evaluated inside the screen's context; returns {active?, visible?, closeable?, title?}. */
  probe: string;
  /** Lua expression invoking the exact native close handler; returns {closed=true} or {closed=false,missing="X"}. */
  close?: string;
  note?: string;
}

/** Lua body builders. All results are fixed reviewed strings; the model never supplies Lua. */
const LUA_VISIBLE = `(function() return { visible = (not ContextPtr:IsHidden()) } end)()`;

function luaVisibilityProbe(closeGlobal: string | null, titleControl: string | null): string {
  const fields: string[] = ["visible = (not ContextPtr:IsHidden())"];
  if (closeGlobal) fields.push(`closeable = (type(${closeGlobal}) == "function")`);
  if (titleControl) fields.push(`title = (${titleControl} and ${titleControl}:GetText() or nil)`);
  return `(function() return { ${fields.join(", ")} } end)()`;
}

function luaQueueProbe(closeGlobal: string | null, titleControl: string | null): string {
  const fields: string[] = ["active = UIManager:IsInPopupQueue(ContextPtr)", "visible = (not ContextPtr:IsHidden())"];
  if (closeGlobal) fields.push(`closeable = (type(${closeGlobal}) == "function")`);
  if (titleControl) fields.push(`title = (${titleControl} and ${titleControl}:GetText() or nil)`);
  return `(function() return { ${fields.join(", ")} } end)()`;
}

function luaClose(global: string): string {
  return `(function() if type(${global}) ~= "function" then return { closed = false, missing = "${global}" } end ${global}() return { closed = true } end)()`;
}

/**
 * The registry. Handler evidence and cleanup side effects are cited per screen from the native
 * UI source. `blocking` reflects source-verified semantics only; unverified screens are null.
 */
const REGISTRY: PopupAdapter[] = [
  {
    key: "natural-disaster",
    context: "NaturalDisasterPopup",
    kind: "informational",
    dismissable: true,
    blocking: true,
    probe: luaVisibilityProbe("Close", "Controls.HeaderTitle"),
    close: luaClose("Close"),
    note: "NaturalDisasterPopup.lua (GS Addition). Close() clears temporary plot visibility 'NaturalDisaster', stops all disaster movie sound loops, stops camera animations, advances its internal queued sequence, then restores SELECTION interface mode + active lens and ExclusivePopupManager:Unlock (DequeuePopup + Input.PopContext + engine event release). ESC/right-click = Close; auto-closes on local turn end. Animation-sequenced disasters may have released the engine hold mid-movie while still visible.",
  },
  {
    key: "natural-wonder",
    context: "NaturalWonderPopup",
    kind: "informational",
    dismissable: true,
    blocking: true,
    probe: luaVisibilityProbe("Close", "Controls.WonderName"),
    close: luaClose("Close"),
    note: "NaturalWonderPopup.lua. Close() clears temporary plot visibility 'NaturalWonder', stops the wonder speech, stops camera animations, advances its internal queued sequence, then restores SELECTION interface mode + active lens and Unlock (engine hold released). ESC/right-click = Close.",
  },
  {
    key: "wonder-built",
    context: "WonderBuiltPopup",
    kind: "informational",
    dismissable: true,
    blocking: true,
    probe: luaVisibilityProbe("Close", "Controls.WonderName"),
    close: luaClose("Close"),
    note: "WonderBuiltPopup.lua. Close() stops the wonder music tracks, advances its internal queued sequence, then restores SELECTION interface mode + active lens and Unlock. ESC/right-click = Close; native auto-close on local turn end.",
  },
  {
    key: "project-built",
    context: "ProjectBuiltPopup",
    kind: "informational",
    dismissable: true,
    blocking: true,
    probe: luaVisibilityProbe("Close", "Controls.ProjectName"),
    close: luaClose("Close"),
    note: "ProjectBuiltPopup.lua. Close() stops the narrator sound, advances its internal queued sequence, then restores SELECTION interface mode + active lens and Unlock. ESC/right-click = Close.",
  },
  {
    key: "era-complete",
    context: "EraCompletePopup",
    kind: "informational",
    dismissable: true,
    blocking: true,
    probe: luaVisibilityProbe("Close", "Controls.EraCompletedHeader"),
    close: luaClose("Close"),
    note: "EraCompletePopup.lua. Close() is re-entry guarded (m_isClosing): stops the era animation and Unlock (dequeue + engine hold release). ESC = Close.",
  },
  {
    key: "boost-unlocked",
    context: "BoostUnlockedPopup",
    kind: "informational",
    dismissable: true,
    blocking: false,
    probe: luaQueueProbe("OnClose", "Controls.HeaderLabel"),
    close: luaClose("OnClose"),
    note: "BoostUnlockedPopup.lua. OnClose() is the native Continue-button/ESC/Return path: UIManager:DequeuePopup(ContextPtr) then ShowNextQueuedPopup(). No engine event hold (Low priority, DelayShow queue slot); other input passes through while shown.",
  },
  {
    key: "tech-civic-completed",
    context: "TechCivicCompletedPopup",
    kind: "informational",
    dismissable: true,
    blocking: true,
    probe: luaQueueProbe("OnClose", "Controls.HeaderLabel"),
    close: luaClose("OnClose"),
    note: "TechCivicCompletedPopup.lua. OnClose() is the native Close-button/ESC path (TryClose): it acknowledges the shown tech/civic, then shows the NEXT queued completion and only fully closes when none remain; dismiss again until none left. The direct Close() global dumps the whole internal queue and is never what a native click does, so it is not used. Consumes all input while shown.",
  },
  {
    key: "in-game",
    context: "InGamePopup",
    kind: "informational",
    dismissable: true,
    blocking: true,
    probe: luaVisibilityProbe("OnClosePopup", null),
    close: luaClose("OnClosePopup"),
    note: "InGamePopup.lua. OnClosePopup() is the native last-resort ESC branch: UIManager:PopModal + close the dialog WITHOUT activating any button. Raised generically by many systems (modal, 'popups are blocking'); some instances carry confirm/cancel buttons - inspect the screenshot before dismissing.",
  },
  {
    key: "advisor",
    context: "AdvisorPopup",
    kind: "informational",
    dismissable: true,
    blocking: true,
    probe: luaQueueProbe("Close", "Controls.InfoString"),
    close: luaClose("Close"),
    note: "AdvisorPopup.lua (TutorialUIRoot context). Close() dequeues the tutorial-priority popup. Native ESC here opens the options menu instead, so Close() is the verified cosmetic close; input consumption is gated by the screen's own IsBlockingInput().",
  },
  {
    key: "great-work-showcase",
    context: "GreatWorkShowcase",
    kind: "informational",
    dismissable: true,
    blocking: false,
    probe: luaVisibilityProbe("HideScreen", "Controls.WritingName"),
    close: luaClose("HideScreen"),
    note: "GreatWorkShowcase.lua. HideScreen() is the native close-button/ESC path: hides the context and stops the gallery music, great-writing speech and ambience. A full-screen reveal, not a popup-queue member; no engine hold.",
  },
  {
    key: "event",
    context: "EventPopup",
    kind: "choice",
    dismissable: false,
    blocking: true,
    probe: luaQueueProbe(null, "Controls.Title"),
    note: "EventPopup.lua: generic event popup, queued at Medium priority. Native ESC deliberately refuses to close while choices are pending (TTP 43191) - mandatory when it carries ChoiceA/ChoiceB; answer through civ.decide/native UI.",
  },
  {
    key: "great-people",
    context: "GreatPeoplePopup",
    kind: "choice",
    dismissable: false,
    blocking: null,
    probe: LUA_VISIBLE,
    note: "GreatPeoplePopup: great-person patronage chooser (recruit / gold / faith / reject). Answer through civ.decide.",
  },
  {
    key: "unit-promotion",
    context: "UnitPromotionPopup",
    kind: "choice",
    dismissable: false,
    blocking: null,
    probe: LUA_VISIBLE,
    note: "UnitPromotionPopup: promotion chooser for a leveled unit (queued, Low priority). Answer through civ.decide.",
  },
  {
    key: "raze-city",
    context: "RazeCity",
    kind: "choice",
    dismissable: false,
    blocking: null,
    probe: LUA_VISIBLE,
    note: "RazeCity: raze-or-keep city confirmation. Answer through civ.decide.",
  },
  {
    key: "choose-artifact",
    context: "ChooseArtifact",
    kind: "choice",
    dismissable: false,
    blocking: null,
    probe: LUA_VISIBLE,
    note: "ChooseArtifact: artifact/relic selection chooser.",
  },
  {
    key: "espionage-escape",
    context: "EspionageEscape",
    kind: "choice",
    dismissable: false,
    blocking: null,
    probe: LUA_VISIBLE,
    note: "EspionageEscape: escape-route district choice; confirming issues the native SET_ESCAPE_ROUTE player operation.",
  },
  {
    key: "espionage",
    context: "EspionagePopup",
    kind: "choice",
    dismissable: false,
    blocking: null,
    probe: LUA_VISIBLE,
    note: "EspionagePopup: spy mission briefing with accept/abort/renew outcomes; those are real espionage choices.",
  },
  {
    key: "map-pin",
    context: "MapPinPopup",
    kind: "choice",
    dismissable: false,
    blocking: null,
    probe: LUA_VISIBLE,
    note: "MapPinPopup: map-pin creation form; OK/Delete/Cancel each act on the pin, so no bare cosmetic close is exposed.",
  },
  {
    key: "declare-war",
    context: "DeclareWarPopup",
    kind: "choice",
    dismissable: false,
    blocking: null,
    probe: LUA_VISIBLE,
    note: "DeclareWarPopup: war confirmation with consequence summary; its OnClose merely hides the chooser without deciding.",
  },
  {
    key: "world-congress",
    context: "WorldCongressPopup",
    kind: "diplomacy",
    dismissable: false,
    blocking: null,
    probe: LUA_VISIBLE,
    note: "WorldCongressPopup: congress session voting UI; answered through civ.decide diplomacy session responses.",
  },
  {
    key: "world-congress-between-turns",
    context: "WorldCongressBetweenTurns",
    kind: "diplomacy",
    dismissable: false,
    blocking: null,
    probe: LUA_VISIBLE,
    note: "WorldCongressBetweenTurns: between-session congress flow.",
  },
  {
    key: "world-congress-intro",
    context: "WorldCongressIntro",
    kind: "diplomacy",
    dismissable: false,
    blocking: null,
    probe: LUA_VISIBLE,
    note: "WorldCongressIntro: congress session introduction flow.",
  },
  {
    key: "diplomacy-action-view",
    context: "DiplomacyActionView",
    kind: "diplomacy",
    dismissable: false,
    blocking: null,
    probe: LUA_VISIBLE,
    note: "DiplomacyActionView: leader diplomacy session view; sessions end only through native diplomacy choices.",
  },
  {
    key: "diplomacy-deal-view",
    context: "DiplomacyDealView",
    kind: "diplomacy",
    dismissable: false,
    blocking: null,
    probe: LUA_VISIBLE,
    note: "DiplomacyDealView: deal negotiation view.",
  },
  {
    key: "leader-scene",
    context: "LeaderScene",
    kind: "diplomacy",
    dismissable: false,
    blocking: null,
    probe: LUA_VISIBLE,
    note: "LeaderScene: leader dialogue scene behind diplomacy sessions.",
  },
  {
    key: "end-game-menu",
    context: "EndGameMenu",
    kind: "gameover",
    dismissable: false,
    blocking: true,
    probe: LUA_VISIBLE,
    note: "EndGameMenu: victory/defeat screen; ShouldPauseGame holds the game while shown. Reported, never dismissed by the bridge.",
  },
];

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
async function observeEntry(entry: PopupAdapter, invoke: PopupInvoker): Promise<PopupObservation> {
  let decoded: unknown;
  try {
    decoded = await invoke(entry.context, entry.probe);
  } catch (error) {
    return missingOrError(entry, message(error));
  }
  const record = asRecord(decoded);
  const visible = record.visible === true;
  const active = record.active === undefined ? visible : record.active === true;
  const observation: PopupObservation = {
    id: `popup:${entry.key}`,
    context: entry.context,
    kind: entry.kind,
    active,
    visible,
    blocking: entry.blocking,
    dismissable: entry.dismissable && record.closeable === true,
    title: titleFrom(record),
    status: "ok",
    note: entry.note,
  };
  return observation;
}

function missingOrError(entry: PopupAdapter, text: string): PopupObservation {
  const contextMissing = text.includes(entry.context) && text.includes("is not available");
  return {
    id: `popup:${entry.key}`,
    context: entry.context,
    kind: entry.kind,
    active: false,
    visible: false,
    blocking: entry.blocking,
    dismissable: entry.dismissable,
    title: null,
    status: contextMissing ? "context-missing" : "error",
    error: text,
    note: entry.note,
  };
}

/** Dismiss a known informational popup by executing its exact native close handler inside the screen's own context. Pure dismissal; never a gameplay choice. */
export async function dismissPopup(id: string, invoke: PopupInvoker): Promise<DismissPopupResult> {
  const entry = id.startsWith("popup:") ? REGISTRY.find(candidate => `popup:${candidate.key}` === id) : undefined;
  if (!entry) {
    return { id, dismissed: false, status: "error", error: `Unknown popup id ${id}. Known ids: ${KNOWN_IDS}.` };
  }
  if (!entry.dismissable || !entry.close) {
    const reason = NOT_DISMISSABLE_REASON[entry.kind];
    return { id, dismissed: false, status: "not-dismissable", note: `${reason}${entry.note ? ` ${entry.note}` : ""}`.trim() };
  }

  const before = await readPresence(entry, invoke);
  if (before.error !== undefined) return { id, dismissed: false, status: "error", error: before.error };
  if (!before.present) {
    return { id, dismissed: false, status: "ok", note: `Not currently active or visible; native ${entry.context} close handler was not invoked.` };
  }

  let closed: unknown;
  try {
    closed = await invoke(entry.context, entry.close);
  } catch (error) {
    return { id, dismissed: false, status: "error", error: `Native close handler failed in ${entry.context}: ${message(error)}` };
  }
  const record = asRecord(closed);
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
    return { id, dismissed: false, status: "ok", note: "Native close ran; the screen immediately shows its next queued item (native sequence behavior). Dismiss again to continue." };
  }
  return { id, dismissed: true, status: "ok", note: entry.note };
}

interface Presence { present: boolean; error?: string }

async function readPresence(entry: PopupAdapter, invoke: PopupInvoker): Promise<Presence> {
  let decoded: unknown;
  try {
    decoded = await invoke(entry.context, entry.probe);
  } catch (error) {
    return { present: false, error: message(error) };
  }
  const record = asRecord(decoded);
  return { present: record.visible === true || record.active === true };
}

/** Compact catalog for civ.probe; ids and kinds the bridge may advertise. */
export const popupCatalog: ReadonlyArray<{ id: string; context: string; kind: PopupKind; dismissable: boolean }> =
  REGISTRY.map(({ key, context, kind, dismissable }) => ({ id: `popup:${key}`, context, kind, dismissable }));
