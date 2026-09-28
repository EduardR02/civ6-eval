# Civ VI player

A language model plays Civilization VI: Gathering Storm through the game's own UI and a FireTuner bridge. It can inspect screenshots and exact player-observable game state, issue legal game actions, write and retain Python code in an isolated workspace, and delegate bounded analyses. The model chooses what to inspect and how to play; the bridge is not a scripted strategy engine. [DESIGN.md](DESIGN.md) explains the interface and experimental choices.

## Status

This is an experiment, not a demonstrated Deity-winning agent. No full game has been completed in the runs so far: we stopped exploratory runs early when they became unpromising or exposed a harness problem. The interface has also changed during those runs, so they are not clean comparisons between models.

In the starts observed so far, Astra has used the interface more effectively and played faster than the other models tried; weaker models often spend more time per turn and struggle with the available controls. Early wars have been especially damaging against Deity's starting bonuses. The models have also made limited use of diplomacy—delegations, trades and similar interactions—which *might* be contributing to those wars. That is a hypothesis, not an identified cause: the interface or its explanation could be part of the problem. We do not yet have full-game results or a measured win rate.

Live play owns the Windows desktop, and even the faster runs take much longer per turn than a human player. Long runs currently mean leaving the machine occupied, running overnight, or using a separate game computer. On our Astra subscription, one five-hour usage window has lasted only about 25 early turns; later turns have more decisions. This is a local observation, not a promised provider limit.

## Running locally

The current implementation targets **Windows with Civ VI: Gathering Storm**, a working WSL 2 distro (the checked-in config names `Ubuntu-24.04`), [Bun](https://bun.sh/), [uv](https://docs.astral.sh/uv/) with Python 3.12, and access to the Civ VI desktop. Install the WSL distro before setup. You will also need credentials for a supported model provider; see below. This is not a headless game server or a cross-platform desktop client.

```sh
bun install
bun start setup --enable-tuner
bun start doctor
bun start play --prompt 'Inspect the current position and explain your next priorities'
```

`setup` installs the Python/WSL dependencies; `--enable-tuner` changes Civ's local `AppOptions.txt` after saving a backup. Restart Civ after enabling FireTuner. Start or load a Gathering Storm game yourself and leave it open before `doctor` or `play`; the CLI does not start a scored game automatically. `bun start help` lists the other commands, including resume, usage reporting and the local dashboard. Run artifacts, captures, transcripts and player workspaces live under ignored `.civ6/`; the credential source and Civ saves are outside this repository. Do not publish a run directory without reviewing it separately.

The checked-in `civ6.config.json` selects `deepseek-flash` through opencode-go and permits unlimited model calls. This removes only the harness's call-admission ceiling; it does not bypass provider quotas or charges. It is a starting configuration, not an endorsement or a benchmark result. Override provider, model, effort and call ceiling on the command line, or use `--config PATH` with your own JSON file outside the repository. Usage prices shown by the program are API-equivalent estimates, not subscription charges.

### Authentication

Authentication still reflects the development setup. The default credential path is OMP's read-only `~/.omp/agent/agent.db`; **OMP is not required** if you choose one of these alternatives:

- For the checked-in opencode-go profile, set `OPENCODE_API_KEY` in your environment instead of using the OMP credential store.
- For a ChatGPT/Codex subscription, run `codex login`, set `"authPath": "~/.codex/auth.json"` in a private config, and select `--provider codex --model gpt-6-astra` (or another supported Codex model). This player reads the existing access token; it does not refresh that login for you.
- For direct OpenAI API billing, set `OPENAI_API_KEY` and select `--provider openai --model gpt-6-astra` (or another supported API model). Subscription access and API billing are different routes.

Do not commit credentials or a private config. Keep the credential source on the trusted host, not in the player's Python workspace.

## Knowledge and rulesets

Runs distinguish *uncoached* play from an *expert-informed* track, selected with `--knowledge expert-informed`. The latter loads a separately supplied guide from `expertGuidePath` in the config. The local Herson/BBG synthesis used during development is **not included here** while its source rights and publication form are being settled; an expert-informed run in a fresh clone needs its own guide file and configured path. Uncoached play does not need that file.

The development guide draws on competitive multiplayer material for Better Balanced Game (BBG) and Better Balanced Map(s) (BBM). Using those mods makes the source advice more applicable, but modded multiplayer advice is not automatically correct against Deity AI, and modded runs are not unmodified Gathering Storm results. The base game has different balance and can favor different strategies. Record the ruleset, mods, map settings, speed, seed, model, and knowledge track when comparing runs.

The first-party source is [MIT licensed](LICENSE). Civ VI, mods and third-party strategy material retain their respective owners and licenses; the excluded guide is not covered by this repository's license.
