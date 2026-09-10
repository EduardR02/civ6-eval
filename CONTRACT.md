# Ergonomic player interface completion contract

This document governs completion of the interrupted rewrite. DESIGN.md remains authoritative. Fold this contract into the design and remove it after integration; it is not a permanent parallel specification.

## Goal and invariants

Remove unnecessary interface reconstruction, round trips and accidental output volume. Do not target one round trip per turn or prescribe a turn workflow. Persistent Python already permits multi-action code, observation and branching. The model chooses strategy, scope, pacing and delegation.

- Native legal requests only; no simulation setters, cost bypass, raw Lua/SQL/context RPC or host access.
- Player-observable data only. Native engine APIs are not automatically fog-safe; follow native UI visibility/target filters. Unknown, remembered, omitted and empty are distinct.
- Every mutation distinguishes submission from observation/completion. No transaction/rollback claim. Never replay interrupted mutations. Unknown acknowledgement/outcome always stops dependent batch admission.
- Preserve native Responses items, tool identities, opaque compaction and provider-specific context semantics. Compaction compresses context; it does not erase all knowledge or reset Python.
- Workspace files, artifacts, history and model-authored notes are durable. Python bindings survive compaction, not process restart. No mandatory note/plan/checkpoint workflow.
- All writers skip builds/tests/formatters until integration. No live desktop or game access during implementation. A dedicated operator owns later native verification and launch.

## Ownership and module boundaries

Lua loading order: common.lua, state.lua, actions.lua, options.lua, decisions.lua. Shared helpers live in common.lua. Functions may reference later-loaded modules at call time, never require their existence at load time.

- Common/action owner: common.lua, actions.lua, options.lua. Exports A.action(args), A.options(args), A.path(args), A.capabilities(args), A.ownedEntity(kind,id,pid), A.actionTypes, and the existing common helpers. The action dispatcher delegates decision-related action types to A.decisionAction(args); the decision module must publish only actual supported types through A.decisionActionTypes. A.capabilities combines both at call time.
- Observation owner: state.lua. Keeps A.snapshot(args), A.inspect(args), A.turnState(), A.keybinds(args), A.dismiss_notifications(args). Publish A.unitRecord(unit,own) and A.cityRecord(city,own) wrappers for targeted post-submission observations if needed; never perform a full snapshot for one entity.
- Gameplay-decision owner: decisions.lua. Exports A.decisions(args), A.decide(args), A.decisionAction(args), A.decisionActionTypes. Uses shared helpers, not copies of codecs. Popup closing is not this module's responsibility.
- Popup owner: src/bridge/popups.ts. Exports named types PopupObservation, PopupInvoker, and observePopups(invoke), dismissPopup(id,invoke). PopupInvoker is a trusted internal (contextName:string, body:string)=>Promise<unknown> function; model code cannot supply either string. Bodies/context names are fixed reviewed adapters. Popup IDs use popup:<registry-key>. This module owns native popup context lookup and close behavior only, never generic raw context execution.
- Bridge/host owner: src/bridge.ts, src/host.ts and their direct integration tests. Integrates the above modules and popup invoker, persistence, coverage, read-only analyst snapshots, note RPC and output artifacts.
- Provider owner: src/player/native.ts, provider.ts, associated provider tests, src/config.ts, src/contracts.ts, test/config.test.ts and relevant image-budget tests in test/usage.test.ts. RequestLimits contract below; bridge/host owner forwards config.requestLimits into PlayerOptions unchanged.
- Lua-test owner: test/lua.test.ts and test/lua/** only. Deterministic real Lua-module execution against explicit native API fixtures, plus Lua 5.1 syntax validation.
- Parent: CONTRACT.md, DESIGN.md, prompts.ts, python/worker.py, CLI integration, final validation and launch decisions. Shared boundaries are coordinated before edits.

## Surface

civ.probe(verbose=false) reports compact supported schemas and runtime identities. Distinguish ruleset presence, bridge support and current legality. A missing bridge handler must not be described as a missing engine operation. Verbose context diagnostics are optional, never default output.

civ.snapshot(include=[...], region=..., mapOffset=..., mapLimit=..., edges=false, detail='summary')
civ.inspect(id=... | x=..., y=...)
civ.options(unitId=... | cityId=... | neither, operation=..., targets=false, detail='summary', offset=0, limit=50)
civ.path(unitId=..., x=..., y=...)
civ.decisions(kind=..., id=..., detail='summary', offset=0, limit=50)
civ.decide(id=..., choice=... | choices=[...])
civ.action(type=..., ...) or civ.action(actions=[...], expectedTurn=..., stopOnError=true)
civ.rules(...), civ.keybinds(...), civ.dismiss_notifications(...)
history.note(text=...)

Arguments omitted above are optional selectors, not multiple required calls. Default option/decision responses must be useful without expanding every target or description. Specific decision id or operation permits detailed expansion. Return total/more/offset metadata when paging; never silently truncate candidates.

## Observations, coverage and durable knowledge

Snapshot sections: core, economy, units, cities, map, research, culture, resources, diplomacy, governors, religion, trade, victory, notifications, configuration. Default core, units, cities, notifications; core always included. include=['all'] deliberately requests all. Unknown sections/selectors fail before work.

Omitted sections are absent, not empty arrays. Every snapshot has sections plus coverage={units:'complete'|'partial'|'omitted', cities:..., map:...}. Coverage refers to the queried player-observable collection, not omniscient world state. Regional/paged map requests are partial even when units/cities were queried completely. Empty arrays mean the included, covered query returned none. A failed collection query is partial/unknown, never complete-empty.

Region supports 'owned'|'visible'|'all', {x,y,radius}, or {x0,y0,x1,y1}; map offset/limit metadata is explicit. Native enemy-unit/city observation may still require a visible-plot scan; do not falsely claim region filtering eliminates that engine cost. Cheap inspect must not scan the whole map and must recover remembered foreign-unit/city/tile records honestly when live observation is unavailable.

The bridge maintains accumulated player knowledge independently of an individual partial snapshot. Host persistence must save/recover that accumulated baseline across sectioned/region/page/inspect observations; never replace it with a regional map. Every archived snapshot remains immutable and addressable. Default analyst access may use the latest captured snapshot, including a partial one, with its coverage explicit; explicit snapshotId always selects exactly that capture. Recovery memory and latest snapshot are separate concepts. No forced full-map bootstrap just to allow analysts or recovery.

Own-entity removals require complete relevant coverage. A foreign entity leaving visibility becomes remembered/currentPresence unknown, not dead. Map-region filtering must not suppress stale processing for a separately complete unit/city query. World/player changes invalidate old live knowledge. Every returned remembered fact retains lastSeenTurn/staleness; action observations are narrow and do not imply absence elsewhere.

Compact edges preserve the game's six directions and river/cliff validity separately. riverMask/cliffMask are 6-bit masks, accompanied by riverKnownMask/cliffKnownMask; failed or unobserved reads leave known bits unset. edges=true adds full edge details including flow; no null-to-false conversion. Document geometry once in probe; don't repeat long neighbor IDs everywhere. Decode activity/formation/queue/research/policy indices to stable ruleset type names and localize display names without inventing values.

## Native action and discovery semantics

Resolve operation/command row identities via GameInfo hashes; keep explicit verified parameter codecs and supported handler descriptions. VisibleInUI is a discovery filter, not permission to blindly dispatch every row. Filter irrelevant never-applicable unit actions as native UnitPanel does; temporary unavailability has reasons. Retain presence/support/legality distinctions and native-UI-only status for genuinely unsupported operations. Do not expose arbitrary params to bypass codecs.

Complete existing move, melee/ranged/air attack, found, unit operation/command, production/purchase (including district placement), research/civic/government/policies/unlock, city attack and end-turn actions. Add the requested movement/trade/worker/air mechanics: route-to, alert, automate-explore, trade route destination, plant forest, excavate, rebase/deploy where native rules support them. Unit promotion/upgrade/formations use verified native encodings, no guessed hash-versus-index conversion. Shared specs must drive both supported discovery and dispatch.

Melee uses native ATTACK movement modifier semantics and explicit visible target checks. Confirm observed combat later; static source is not outcome proof. Decode native FAILURE_REASONS. Preserve target PLOTS paired with MODIFIERS; filter actual targets as native UI does. Distinguish range-overlay plots from attack targets. Engine suggestions such as BEST_IMPROVEMENT are omitted by default, not rankings masquerading as mechanics.

Unit options return basic unit state, relevant supported operations/commands and reasons. targets=true or a selected operation requests bounded target/reachability detail. City options return production and purchase choices/costs and, on targeted expansion, legal placement plots and exact adjacency information where observable; unknown adjacency components are explicit. Player options expose current research/civic/government/policy choices. No strategic ordering.

Path exposes native per-plot path and turn data, with uncertainty across fog and engine-busy status. Never infer hidden enemies/resources or promise movement succeeds. Use UI-equivalent reachable movement/ZOC/visibility filters. Bound result sizes with honest truncation/cursor metadata.

## Batches and outcomes

Maximum 64 actions; end_turn only last. Preserve input order and initial game/player/turn identity. Each item validates before submission. Ordinary known rejection stops when stopOnError=true; unknown outcome, thrown mutation, game/turn/player transition or interrupted acknowledgement always stops. Return attempted/submitted/not_attempted per item and accurate stoppedAt/lastSubmittedIndex; no rollback or atomicity claims. Multiple native requests within one item must expose partial progress or be rejected before any submission if that semantics cannot be represented safely.

Single and batch results use accepted, completed:false, status, reasons and turnState. Narrow observed records include capture turn and explicit post-submission/pending semantics; they are not complete deltas or causal completion certificates. Never take/return a full snapshot automatically. Observe/branch again when required; do not advise unconditional replacement of verification with immediate reads.

## Gameplay decisions

Complete discovery and verified requests for dedication/commemoration, pantheon, great-person recruit/reject/patronage, governor appointment/assignment/promotion, unit promotion, government/policy changes, religion founding/belief choices, city keep/raze, world congress resolutions/voting, espionage missions, and diplomacy session responses. Research/civic/production/unit-order blockers refer to actual observable entities and supported action schemas. City citizen focus/management and tile purchase are explicit supported actions. Do not silently pay unlock/patronage costs or choose replacements.

Use native UI source for exact schemas and gates; no fabricated fallback. A decision is not the same as every currently available management action: distinguish required/end-turn-blocking choices from optional opportunities and UI-input blocking. Stable IDs include relevant current entity/era/session identity, and decide revalidates the choice against fresh native availability. Default discovery is bounded and compact; details expand one decision without forcing repeated screenshots. Governor target IDs encode actual destination owner (including Amani city-states).

Native getters require the UI's lifecycle preconditions; pcall catches Lua errors, not native access violations. Turn-state blocker fields stay unknown while local turn activation is incomplete or UI messages are processing, and decisions reuse that blocker observation. Do not apply ordinary-turn readiness to between-turn congress voting. Dedications exclude the initial era/configured start turn; congress detail access requires an actual voting segment, normal capability/era access, or a live emergency notification (including nonblocking notifications). A manager wrapper alone does not prove its internal decision storage is ready. Unknown legality is not permission, and missing belief/proposal collections are not empty known collections. Simulated call-order regressions do not establish that a native crash is fixed.

In particular, `GetNextEscapingSpyID()` is not an availability probe: the native binding can dereference a null search result when no spy is escaping. Query it only after observing `ENDTURN_BLOCKING_SPY_CHOOSE_ESCAPE_ROUTE`; unknown blocker readiness defers the lookup with an explicit diagnostic. This preserves real escape choices without probing the getter on ordinary turns.

Partial policy edits merge against current slots, preserve untouched assignments, validate duplicates/slot compatibility, then submit one native clear/add operation. Do not auto-unlock policy changes or charge gold without an explicit action.

## Popup adapters

Never treat generic DequeuePopup or IsInPopupQueue as universal close/detection. Use exact native screen handlers, including temporary-visibility/lens/camera/audio/queue/lock cleanup. Inspect fixed known popup contexts through the private bridge callback if their native global functions are callable. If a handler is local/inaccessible, implement only a verified equivalent native event/input path; do not skip side effects. The model still explicitly chooses dismissal. Mandatory choice/diplomacy windows are not cosmetic. EndGameMenu is reported and never dismissed.

Cover common informational interruptions (disaster, natural wonder, wonder/project completion, boost/tech/civic completion, era review, great-work showcase) and correctly identify gameplay choosers/diplomacy. Unknown contexts stay native-UI-only, not claimed supported or blindly closed. Return structured remaining blocker/status information; opening/closing a native popup is shared live UI mutation and requires control.

## Provider limits, durability and output efficiency

Add exported RequestLimits={maxImages?:number, retainedImages?:number, maxBytes?:number} to contracts; Config.requestLimits and PlayerOptions.requestLimits are optional, forwarded by host. Overrides explicitly apply to the configured run/provider/model. Known default image-count limit is Muse Spark on opencode-go (observed maximum 50); retain a sensible recent window rather than globally imposing 45->5 on Astra. No unmeasured byte cap claimed as a provider fact. Validate values and combinations. Apply explicit maxBytes to serialized UTF-8 request bytes, including compaction, in both provider adapters where configured.

Evict only older already-presented input images when a known/configured limit requires it. Preserve original captures and useful recovery references. Do not discard fresh unseen tool images or opaque reasoning/text/tool identities to fit a request; if fresh evidence alone exceeds a limit, report a recoverable pretransport limit error, no automatic mutation retry. History representation rewrites are explicit/journalled, not claimed cache-neutral. Preserve array shape and tool call pairing.

Keep the incremental request journal improvement. Record actual UTF-8 bytes, item counts and rewrite events; append deltas rather than duplicate full input on every request. Preserve durable no-replay identities and recovery. Do not call remaining full native-state checkpoint rewrites 'eliminated O(n²) I/O'; optimize avoidable duplicate work without weakening crash safety.

history.note is optional bounded append to searchable public history. Return compact acknowledgement/reference, not a full echo of text the model just supplied. Attribute last-observed-turn honestly (not a false exact current turn). No automatic reinjection of all notes and no claim notes alone survive compaction. Important exact data remains available through files/artifacts/history. Omit unconditional stdout/stderr file-list noise, but preserve explicit paths when an output is truncated or an original image is needed.

## Verification and cutover

No backward-compatibility shims for old model-authored turn scripts; launch a fresh v2 run only after integration. Do not mutate old run workspaces, histories, saves, or running kernels. A missing module or advertised-unimplemented action is not a finished deliverable.

Permanent tests defend uncertain behavior: dispatch/legality/parameter errors, partial batches and lost acknowledgements, fog/target filters, omitted/partial coverage + restart, edge unknownness, popup cleanup, policy edits, image limit preservation and native replay. Lua VM fixtures are simulated proof, not native gameplay proof. Parent runs bun run check and bun test once writers settle. Dedicated operator performs focused live scenarios when the user's game/permission permits; unavailable specific scenarios are explicitly identified, never fabricated. No parent screenshots/live UI inspection.

After source/runtime verification: consolidate docs, remove throwaway executable scaffolding, then prepare fresh unlimited muse-spark-1.3-contributor xhigh + live dashboard. Do not kill existing player processes or create/load a game without user authorization. Record mods/settings and use a neutral outcome-based initial prompt, not a strategic checklist.
