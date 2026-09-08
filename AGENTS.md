# Civ VI player: working rules

Read `DESIGN.md` before making architectural or gameplay-interface changes. It records the intent behind the code, not just its current layout.

## What we are building

A capable language model playing Civilization VI: Gathering Storm through a deliberately ergonomic interface and a general coding harness. Deity is a meaningful capability target, not the whole research question. We want to understand the model's strategy, adaptation, computation, delegation, and execution—not build a scripted Civ bot and put a model in front of it.

Default player: Astra through the user's ChatGPT/Codex subscription. GLM 5.3 Flash through opencode-go is an additional player and a faster iteration option. Keep the game interface and general runtime reusable across models; preserve each provider's actual protocol and context semantics.

## Non-negotiable boundaries

- The model chooses strategy, priorities, plans, observation scope, and delegation. Do not add fixed build orders, threat rankings, automatic strategic focus, or mandatory domain-agent workflows without explicit approval.
- Use Civ's native rendering. Screenshots, camera movement, selection, lenses, and tooltips are first-class ways to obtain information. Do not build a replacement map renderer by default.
- Provide exact player-observable state alongside visuals. Keep it available to code without dumping it into every prompt. Distinguish current, remembered, unknown, and inferred information; unseen enemy state is not observable.
- Stable mechanics/access helpers are welcome. An adjacency calculation is not the same as a hand-authored ranking of the best Campus sites. Do not make the model repeatedly reverse-engineer our bridge, but do not prebuild every imaginable dashboard.
- Persistent arbitrary code, external memory, and model-directed subagents are core capabilities. A subagent can build a requested analysis and return a compact table/image plus evidence/code references; its exploration and debugging need not enter the main player's context.
- One process/agent owns live game and desktop control at a time. Camera and selection changes count as shared UI mutations. Snapshot analysis can run concurrently.
- Arbitrary player code must not expose host credentials, raw FireTuner, saves, or privileged logs. The sandbox boundary is enforced by the runtime, not by a prompt or Python blacklist.
- Preserve native Responses output, opaque reasoning, tool identity, and compaction for Astra. Do not replace it with a text-only replay. Other providers use their supported context mechanism; do not claim their summaries are native opaque compaction.
- A submitted action is not a confirmed outcome. Never automatically replay an interrupted move, purchase, or other mutation. Reobserve after uncertainty. A restart restores files/history, not Python variables or undone game actions.
- Track all agents and compaction calls. Prices derived from tokens are **API-equivalent estimates**, not subscription charges. Missing usage or prices are unknown, not zero. Label last-observed-turn attribution honestly.

## How to work in this repository

- Preserve the orchestrator's context. Delegate bounded implementation and runtime investigation when independent work permits it; keep integration decisions with the parent.
- **The main orchestrator must not personally drive or inspect live computer-use tests.** Put screenshots, click debugging, and game interaction traces in a dedicated verifier's context. Return concise results and evidence paths.
- **Do not spend model calls navigating game setup menus when the user is available.** Ask the user to start/load a game and leave it ready. Do not close, reload, reconfigure, or overwrite their game/save without authorization.
- Use `codex-coder`/Astra for load-bearing implementation when available. Cheaper capable agents are appropriate for bounded expansion once core invariants are protected. Do not convert old-model benchmark workarounds into permanent requirements.
- Respect user/other-agent edits. Reconcile a handoff with current files rather than restoring an earlier version. Give concurrent writers disjoint ownership and explicit interfaces.
- Prefer direct code and existing patterns. Avoid enterprise layers, compatibility shims, sprawling tool catalogs, and speculative abstractions.
- Run `bun run check` and `bun test` after concurrent changes settle. Add regression tests for real uncertain boundaries and bugs, not to pad coverage. Use throwaway smoke scenarios to prove new behavior; remove their executable scaffolding afterward.
- Significant runtime claims require observed proof. Mark what was actually exercised, what was simulated, and what remains unverified. A passing compiler is not gameplay proof.
- Keep `.civ6/`, credentials, captures, model transcripts, local secrets, and dependency environments out of Git. Commit source, lockfile, default nonsecret config, tests, and these design notes. Use local checkpoints before further agent-driven changes; never push without a request.

## Orientation

- `src/player.ts`, `src/player/`: Pi orchestration, provider protocols, auth, durable sessions/subagents.
- `src/execution.ts`, `python/worker.py`, `python/launch.sh`: persistent sandboxed computation and host RPC.
- `src/desktop.ts`, `python/desktop_worker.py`: trusted Windows Civ-only desktop access.
- `src/bridge.ts`, `src/bridge/`, `lua/`: trusted FireTuner transport, observation, rules, and legal requests.
- `src/host.ts`: permissions, control ownership, snapshots, artifacts, public history, accounting integration.
- `src/usage.ts`: persisted usage and estimated price reports.
- `src/cli.ts`, `src/config.ts`, `civ6.config.json`: operator entry points. Start with `bun start help`.

Update `DESIGN.md` when an accepted decision changes. Keep temporary task progress in the task tracker or run artifacts—not as permanent instructions here.
