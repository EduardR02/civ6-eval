# Why this project exists

We want to discover how well current, highly capable language models can play **Civilization VI: Gathering Storm** when given an excellent interface and a powerful general-purpose harness.

Beating Deity AI is a meaningful target: a player that cannot reach that level is less interesting for the original question. But the project is not merely a race to produce one Deity win. We care about how the model understands the game, reasons about competing investments, adapts, makes calculations, builds tools, delegates, and carries decisions through a long game.

A representative intended game is Online speed, Standard map size, eight major civilizations, normal fog of war, and all intended victory conditions enabled. The conversation used roughly 125 turns to victory and a 250-turn cap as a scale example, not a promise or mandatory score cutoff. Thousands of tiles, many units, and interdependent city decisions make representation and interaction a real engineering problem.

The player and the harness are both experimental variables. We must not quietly replace the model's decisions with a hand-authored Civ strategy engine.

## How to read prior research

Prior projects are sources of useful discoveries, not architectural defaults or ceilings on today's models. A year-old model can require workarounds that are unnecessary or harmful now. Inspect the exact model, interface, available information, action granularity, context treatment, and evaluation conditions before importing a conclusion.

ARC-AGI-3 was researched to understand the intelligence landscape and harness sensitivity—not as a blueprint for Civ. MazeBench is similarly informative about active observation, long-horizon behavior, and model-authored tools. Neither requires us to make a Civ player rediscover a stable game API every run. Civ is one well-defined domain; useful domain-specific engineering is appropriate.

Useful reference directions from the research:

- [Civ6 tool-mediated play](https://github.com/lmwilki/civ6-mcp): engine/API discoveries and real failure cases. We did **not** choose to inherit its server, narration, or strategic workflow.
- [Recursive Language Models](https://arxiv.org/abs/2512.24601): large context as inspectable external data and model calls over selected portions.
- [PRO-LONG](https://arxiv.org/abs/2607.20064): durable, searchable interaction history and programmatic memory.
- [ARC Prize's Astra analysis](https://arcprize.org/blog/astra): provider-state preservation and examples of model-authored parsers, planners, and synchronization code.
- [MazeBench](https://mazebench.com/blog?post=maze-bench-results): agent-controlled viewpoints and distinct visual/text/coding configurations. Do not conflate this with the unrelated static maze-image paper of the same name.
- [Factorio Learning Environment](https://github.com/JackHopkins/factorio-learning-environment): programmatic observation/action composition and feedback. Its older-model results and mechanically powerful routing helpers are not evidence of Astra's limits or unaided planning ability.

Results from these systems establish hypotheses worth testing here, not universal rules such as “screenshots are bad” or “subagents do not help.”

# Design position

**Build stable, trustworthy access; leave cognition and useful derived tools flexible.**

This is neither screenshot-only asceticism nor a prewritten strategy bot. A small model-facing surface may need careful implementation underneath. Minimal means little accidental friction and little imposed workflow—not the fewest lines of code at any cost.

## Mechanics versus judgment

Provide durable access to identities, coordinates, rules, exact observable quantities, legal actions, and outcomes. The model should not repeatedly discover our serialization format or the correct command for city production.

Leave valuation, strategy, prioritization, planning, and adaptation to the model. Computing an exact adjacency bonus or an engine-authorized movement path is different from choosing an optimal city layout using our own strategic weights. When a helper contains substantial planning, make that contribution explicit rather than crediting it entirely to the model.

The model can create its own strategic helpers. A planner it chooses to write, checks, and uses during play is part of the capability we want to observe. Keep the source and evidence available. Useful code can persist across games; record whether an evaluation uses a pre-existing skill library or starts fresh.

## Neutrality and attention

The interface must not decide that a local military situation is the whole game. “Five enemy units near this city” is a factual observation. “A desperate medieval war on the eastern front” adds narrative and can bias attention.

A competent decision may simultaneously involve those units, a technology beeline, a builder elsewhere, production in another city, and a district investment. Camera focus is not strategic focus. Local inspection must not hide the rest of the empire or create a mandatory military/economic workflow.

No representation is perfectly neutral. We can nevertheless avoid strategic rankings, retain access to alternatives, label uncertainty, and let the model change what it displays. If the model neglects something despite good access, that can be an intelligence/behavior finding. Do not automatically fix every loss by adding another reminder or scripted policy.

# The interaction experience

## Native visuals are first-class

Use Civ's own rendering: normal view, Strategic View, camera movement, zoom, selection, lenses, tooltips, and panels. A screenshot can communicate rich spatial structure efficiently. Do not replace it with a custom map renderer until a demonstrated problem justifies that work.

Observation is an action. The model can think, change a view, inspect what changed, calculate, and act in an interleaved loop. A single screenshot need not contain every fact for this to work well.

Keep images available in the executable workspace. The model or a subagent can crop, annotate, combine, or analyze them. Cropping an existing capture does not reveal pixels that were never captured; zooming the actual game or taking a higher-resolution capture may be necessary. Image cost depends on dimensions/provider settings and repeated inclusion; do not assume a universal token count.

Initial ergonomic recommendation: 1920x1080 windowed, ordinary UI scale, Quick Movement/Combat on, Auto End Turn and Auto Unit Cycling off, no real-time turn timer. Resource icons are useful; yield icons and grid can be toggled for the current question. These are starting choices, not a proven optimum. Reacquire coordinates after resolution, scaling, window, or game changes.

The installed Codex desktop reference reinforced the general pattern: a persistent JavaScript REPL, window-scoped native controls, screenshots, and interleaved calls—not just a legacy one-click tool. Its shipped implementation uses SendInput/UI Automation/Windows.Graphics.Capture. Our Python-backed implementation need not copy its private helper or claim to be identical.

## Exact data complements the picture

Expose documented player-observable state to code: tiles and edges, units, cities, production, research/civics, economy, diplomacy, notifications, rules, and other supported systems. Keep the full available data outside the prompt; acquiring it and printing it are different operations.

Prefer ordinary inspectable data over a deep domain-object hierarchy or many conversational query steps. When useful, one code execution can join city, tile, and unit data into the view the model wants. What is seen, queried, and acted on should have unambiguous matching references.

Preserve geometry correctly. Rivers and cliffs can belong to tile boundaries; a lossy `river=true` field is not enough to reason about a crossing. Stable IDs, coordinate conventions, visibility, and capture revisions matter more than cryptic compressed notation.

The source of truth is **what this player can know**, not everything exposed by the engine:

- Current visible facts.
- Last-known observations with timestamps.
- Unknown information.
- Model inferences and assumptions, stored separately from facts.

An enemy leaving sight is not a confirmed death. A previously explored tile is not permission to read its current hidden contents. Unavailable APIs must be reported honestly; do not fabricate zeros or quietly leak hidden state to fill gaps.

## Derived views should be easy to request, not all prebuilt

A request such as “compare Campus placements across these cities” can go to a subagent. It can inspect rules, fetch data, write calculations, check them, and return a compact table or annotated image with code/evidence references. Its exploratory transcript stays out of the main player's context.

This is why persistent execution and subagents are central. Do not turn every plausible query into another permanent tool. Conversely, do not force the model to recreate stable mechanical access just to satisfy a minimalism ideal. Add a durable convenience function when repeated evidence shows that it removes real friction.

Keep queries composable. Ten tiny calls can cost more than one rich scene that settles a decision. Optimize total computation, context, interaction, and error cost to make and execute good decisions—not individual response length alone.

## Routine controls without routine click work

Discovery must describe the actual supported argument codecs, native costs, current legality and unavailable information. A catalog entry is not a guarantee of success. Displayable production choices may be disabled; expose their reasons rather than hiding alternatives or describing every failure as an unmet prerequisite. Resolve entity references by exact current owner and ID; never silently substitute whatever a stale native lookup returns.

Multi-turn movement and research/civic queues are optional native execution mechanisms. The model chooses the destination or research target; the engine computes its ordinary route or prerequisite path. Expose queued state separately from completion and readiness, allow replacement/cancellation through native controls, and do not reissue or strategically replan interrupted orders. A queued unit may still need attention; annotations must not erase genuine blockers.

Congress and diplomacy should expose the choices, terms and legal controls available in their native screens. Explicit Congress submission includes the native Accept lifecycle; voting preferences remain entirely model-owned. A deal-balancing request asks the AI for a counteroffer, not a mathematically minimum price, and does not accept it. Draft edits, proposals and acceptance must remain distinguishable; the model reviews and chooses commitments.

Known informational popups may be dismissed automatically **after their information is preserved durably**. Capture relevant labels, values and icon tooltips; incomplete capture leaves the popup pending. Deliver newly captured content with execution results and keep it searchable in public history. Revalidate the exact displayed content in the same native invocation that closes it, so a successor notification is never acknowledged unseen. Use the screen's native cleanup, not generic Escape or popup-queue removal.

Graphical presentation alone is not a reason to require another screenshot/model turn. Preserve equivalent player-observable native state when available: an era-rollover frame carries the local player's age result, which can be captured with the era score and thresholds. Include those values in the same revalidation as the rendered text before automatic closure; unavailable state must not be mistaken for a Normal Age or zero score.

Automatic presentation cleanup runs at fresh observation and turn-advance boundaries, never immediately before a coordinate click derived from an earlier screenshot. It does not choose responses, vote, accept deals, or dismiss game-over screens. Closing a screen as part of an explicitly requested native action is different from choosing that action automatically. Screenshots remain usable when the structured bridge fails.

# Harness and provider contracts

## Pi host and executable memory

Use a Pi-based runner with a deliberately restricted set of host capabilities, not a fork of a large general coding harness or an inherited Civ MCP catalog. MCP is a protocol, not inherently bloat; it was not necessary for this custom local boundary.

The executable workspace supports persistent Python, files, images, access to permitted observations/history, and programmatic subagent/model calls. In the RLM sense, large material stays external and can be inspected/transformed before selected results enter a context. This does not grant access to a model's hidden activations or arbitrary private chain of thought.

Subagents have separate contexts and Python namespaces. They can use the same powerful model for substantive work; cheaper models are an optimization to evaluate, not an assumption. Do not force a permanent cabinet of named ministers. Bounded analyses, independent alternatives, execution handoffs, and persistent specialists are all available when the model finds them useful.

## Provider-specific state must remain correct

Astra defaults to the user's ChatGPT/Codex subscription via OMP's read-only credential source. Preserve complete native Responses items, including opaque reasoning and tool identities. Codex can emit full items in `response.output_item.done` while terminal `output` is empty; do not lose them. Native streaming compaction must preserve its opaque replacement state rather than flattening it into ordinary text.

GLM 5.3 Flash and Muse Spark through opencode-go are cheaper/faster iteration targets and alternate players. Keep the same game/runtime contract, but use each model's supported provider transport, vision conversion, reasoning levels, and compaction. Muse's Responses support does not imply support for `/responses/compact`: context reduction uses a model-generated continuation summary through the ordinary Responses endpoint, with no tools exposed. Complete original native items remain in the private journal; new operator instructions enter after successful summarization. Failed or incomplete summaries must not replace context or authorize actions. This is not Astra's native opaque compaction. A saved run must not silently switch model/provider/account and replay incompatible state.

DeepSeek V4.1 Flash is available through `opencode-go/deepseek-flash`, with vision and literal `max` reasoning effort. Capabilities follow the current catalog and verified route requirements. For tool-bearing Chat Completions requests, preserve prior assistant `reasoning_content`, including turns without tool calls; a new user message does not erase it. No-tool summaries have different context semantics. Keep private reasoning out of player-visible artifacts and verify vision, effort, replay, restart and summary continuation on the actual gateway route.

Read credentials privately at the trusted boundary. Never mount them into player workspaces, include them in artifacts, or expose token-bearing refresh errors. Do not rotate shared subscription refresh tokens behind another harness. Do not switch accounts automatically after rate limits or retry quota failures indefinitely.

## Execution and recovery

One controller owns live game/UI access. Mouse, keyboard, camera, and selection are shared state; independent snapshot analyses are not. Subagents may execute bounded tasks after explicit handoff—“one controller” does not mean the main model must type every action.

Player code runs in a real OS sandbox. The current Windows implementation uses network-isolated Bubblewrap inside WSL for computation, with a trusted Windows desktop service and FireTuner bridge outside it. Raw host filesystem/network/debug access must not become available through arbitrary Python or protocol messages.

Actions use normal legal game requests or native UI input. Do not bypass costs or substitute simulation mutations. Report submission, rejection, pending processing, and observed completion accurately. Batches may interleave queries and conditionals; never silently replay a partly executed batch.

A batch is not a transaction. Ordinary known rejection can follow `stopOnError`; unknown outcomes always stop further admission. Turn-ending requests, including Congress submission, belong last. Native getters also have lifecycle prerequisites: catching Lua exceptions cannot prevent native access violations. Do not probe Congress or escaping-spy collections outside the native UI's readiness gates.

All FireTuner exchanges, including popup context loading and probing, share one single-flight gate. A positively identified pre-submission refusal is distinct from a lost acknowledgement with unknown outcome. Congress requests use their native turn-segment prerequisites rather than the ordinary strategic/tactical command gate. Native submission state, not a persistent client latch, governs whether an end-turn request is outstanding. These mechanisms do not authorize automatic replay or prove that an accepted request completed.

Files, observations, artifacts, and provider history are durable. In-memory Python bindings are not restored by restarting a process. An interrupted request or action has unknown outcome until reobserved. Failed or cancelled transports must stop admitting new work and release held inputs.

The operator may set a finite saved-run model-call ceiling or explicitly choose `--calls unlimited` (`maxModelCalls: "unlimited"` in configuration). Unlimited disables only the harness's call-admission ceiling, including children and compaction; it does not bypass provider quota, authentication expiry, transport limits, or the need to stop after an uncertain failure. A full-game task need not have a harness turn limit.

CLI play defaults to explicit task outcomes: the operator's agent declares `completed` or `blocked` with a reason through `finish_task`. The model owns the goal and evidence; this declaration is not host-verified victory. A progress-only final receives at most one protocol reminder, then stops as a protocol failure if still undeclared. Unresolved execution failure suppresses automatic protocol repair, and calls after a declaration are not executed. Outcomes are recorded per dispatch, never inherited as completion of a later task. Generic Player callers and delegated analyses retain response-mode completion; `--completion response` selects that behavior explicitly for CLI play.

## Usage accounting

Track all agents and compaction calls, not only the main model. Persist request identities so resume and repeated reporting cannot double count. Record input, cache reads/writes, output, and reported reasoning tokens without counting reasoning twice; image tokens may be included in input without a separate reported breakdown.

Per-turn attribution is currently based on the last confirmed game/player/turn when a request starts. Preserve that attribution if the game advances before the response arrives. Record an analyst's older snapshot separately. Before a confirmed observation, use an unknown/pre-game bucket; do not pretend screenshot-only activity has exact turn attribution.

Show API-equivalent estimates separately from actual subscription charges. Unknown rates and unreported request usage remain unknown. Preserve rates/provenance used for estimates; changing a rate later must not rewrite historical accounting silently.

## Live operator monitoring

`bun start dashboard --run DIR --interval 1` starts a separate read-only process and prints a loopback URL. Open that URL rather than an old generated `viewer.html`. The viewer reads durable run observations, transcripts, and usage; it does not own game control, make model calls, or promise token-by-token visibility into an unfinished response.

The browser receives an initial state followed by incremental server-sent updates, not repeated downloads of the full transcript or page reloads. Source reads consume appended bytes; idle cycles do not rebuild cards. Changed cycles still reconcile accumulated chronological metadata, while unchanged card HTML is cached. Reconnection or rewritten history rebuilds the view explicitly; ordinary updates preserve reading position and expanded details, with a separate follow control.

The server binds only to `127.0.0.1` and serves the viewer, its event stream, and recorded display images through a constrained route. It is not a static server for the run directory: provider state, credentials, saves, and arbitrary workspace paths must not be published. Treat visible run text and captures as private local material, not a public-safe export. Monitoring does not guarantee that the player is progressing; quota errors and other stops remain part of the experiment.

## Transport size is separate from model context

Budget serialized request bytes separately from token context. Image encoding can reduce upload size without reducing image tokens; image-token accounting depends on the actual provider/model and dimensions. A successful small JPEG example is not a universal compression ratio or an image-quality guarantee.

Our current Astra path replays native items with `store: false`; it does **not** use `previous_response_id` to keep conversation history server-side. Both this path and the GLM completions path can therefore accumulate large request bodies. Prompt caching reduces some computation/billing, not the bytes our client uploads. A provider exposing a Responses route does not establish that it supports the model, server-side history, or compaction we need.

Prefer stable already-sent representations during ordinary continuation. Compaction is a convenient default boundary for deliberate history reduction, **not** the only API-permitted time to change history. Evaluate cache-prefix effects, valid tool/result pairing, preserved reasoning, and access to original observations independently. Retain original captures and make any lossy model-facing representation explicit. Do not blindly shrink the newest evidence or drop arbitrary tool messages to get under a limit.

`requestLimits` configures optional `maxImages`, `retainedImages` and serialized UTF-8 `maxBytes` bounds for the selected run. Only the measured Muse Spark route has a default image watermark (45, retaining five); do not impose that default on Astra or DeepSeek. Preserve fresh unseen images, original captures, reasoning, text and tool identities. If permitted removal of older already-sent images cannot satisfy a bound, refuse before transport without consuming a model call or authorizing a replay. An unknown sent-history boundary is not proof that images were seen.

Record explicit omission markers and recoverable original-image references. Model-generated compaction retains the supplied system prompt and uses a transient no-tool summary request; this does not promise a cache hit or native opaque compaction. Native request-size accounting measures actual UTF-8 serialized bytes, including compaction, rather than internal ledger metadata.

Transport limits need their own measured/configurable guard and recoverable failure handling. Token-threshold compaction alone is insufficient, and a compaction request can itself be too large. Raising a provider's token threshold is an experiment, not a remedy for HTTP 413. Native API-equivalent pricing tiers also do not establish how a ChatGPT subscription meters its quota.

When reviewing an experiment, distinguish no recursive delegation from no useful computational memory: a model may build and reuse in-namespace helpers, query external state, and crop images without spawning a subagent or saving a Python module. Likewise, fewer explicit planning notes do not by themselves prove that no planning occurred. Fix misleading mechanics and broken affordances; test behavioral hypotheses before turning them into process rules.


# Evaluation and iteration

Start by getting the core access/execution contract right, then use cheaper capable models and agents to iterate without making rate limits the project's dominant bottleneck. Stronger models remain important for load-bearing work and maximum-strength play. Use the same game/tool contract so model comparisons are interpretable.

Maintain two knowledge tracks when evaluating:

- **Uncoached:** game rules, interface documentation, and within-game work; no curated strategy guide.
- **Expert-informed:** the same harness with selected community/multiplayer strategy material available.

“Uncoached” does not mean the model has never seen Civ strategy in training. Guides can be useful and interesting without being executable strategy scripts. Preserve their ruleset, mod, speed, and multiplayer assumptions. Do not silently mix supplied guide knowledge, supplied procedures, and model-authored skills.

The Herson BBG guide corpus is an explicit expert-informed experiment: `guides/herson-bbg/SKILL.md` synthesizes the complete source playlist into original strategy teaching intended for the player's initial context in full. Per-video notes, publication dates and a conflict record preserve provenance. Prefer newer advice when it revises the same assumptions, not merely because it was published later; distinguish BBG patches, game speed, multiplayer placement incentives and Deity-AI objectives. Source-era advice remains useful when clearly labeled. The model may adapt or reject it; it is not a runtime build-order controller, mandatory checklist or change to the uncoached baseline. Record which guide revision a run received.

Declare mods, map settings, speed, difficulty, seeds, model/effort, knowledge track, and human interventions. BBG/BBM interface smoke is not an unmodified Gathering Storm benchmark. Development saves and scenario probes are useful for diagnosis; full games are necessary evidence for winning ability. Do not discard early defeats or automation failures from evaluation results.

Archive the exact supplied guide and sanitized configuration, not merely a path/hash that depends on future workspace contents. Archive each effective system-prompt revision and its tool definitions privately; retain operator tasks in durable history. New launches/resumptions must not overwrite earlier experimental inputs. These archives are not permissions to expose provider reasoning or credentials to player code.

Useful observations include actual outcome, decision/action errors, missed facts, repeated work, query rounds, context growth, token usage, subagent cost, and elapsed time. Avoid constructing a large benchmark apparatus before the player works.

# What the core checkpoint means

A useful core baseline has a runnable documented CLI; sound provider/session handling; persistent computation and delegation; native visuals and exact observable state; legal actions with confirmed consequences; privacy/cancellation/recovery boundaries; and honest usage reporting. It has focused regressions plus recorded runtime proof.

It does **not** mean every victory path has been tested, every optional game API has a direct wrapper, the representation is optimal, or a Deity win has been achieved. The native UI remains available for specialized interactions. State those limits rather than calling a partial scaffold a finished player.

Create a local Git checkpoint only after the relevant checks pass and secrets/run artifacts are excluded. A commit makes the baseline recoverable and changes inspectable; it does not stop future agents breaking it. Protect the invariants with tests, small reviewable changes, and updated design notes. Keep temporary progress, screenshots, and run-specific failures in ignored artifacts instead of turning this document into a changelog.

## Working agreement with the user

The orchestrator retains project interpretation and acceptance decisions. Delegate implementation and especially live computer-use testing so its large context is not polluted by screenshots, click traces, debugging logs, or small coding excursions. The user explicitly requested that this project context be written by the orchestrator because the nuances developed across the entire conversation matter.

When the user is at the computer, ask them to start/load the intended game rather than spend model calls navigating menus. Respect their open game and settings. Tell them if display changes would improve ergonomics; do not change them unexpectedly during a verifier's coordinate-sensitive work.

Further changes should preserve this intent while remaining open to evidence. Neither “the newest model can do everything unaided” nor “every model failure needs a harness trick” is our premise.
