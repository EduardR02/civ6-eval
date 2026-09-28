# Civ VI player

This is the code we're using to let a language model play Civilization VI: Gathering Storm. It can look at Civ's screen, read player-visible game state through a FireTuner bridge, and take actions in the game. It also has a persistent, isolated Python workspace for calculations and can delegate focused work to subagents using the same model in separate contexts.

We want the interface to make Civ's mechanics easy to inspect and use, without deciding the strategy for the player. The model chooses what to investigate, where to expand, what to build and how to respond when the game changes. [DESIGN.md](DESIGN.md) goes into the tradeoffs behind that setup.

## Status

We haven't finished a full game yet. So far we've stopped runs when they fell too far behind or turned up a problem with the interface, then fixed what we found and tried again. That has taught us quite a bit about the harness, but the runs don't give us a win rate or a clean model comparison.

Of the models we've tried, Astra has made the best use of the interface and has been the quickest to play. The others tend to take longer per turn and have more trouble using the available controls. Nearby Deity AI civs start with large bonuses and have attacked us early in a lot of games. The models haven't done much to head that off: they rarely send delegations or open the trade screen to improve relations before a war is declared. We don't yet know whether that comes from the model's decisions, how the interface presents other players, the multiplayer focus of the guide, or something else.

New runs don't automatically remember earlier ones. If a run ends after an early attack, the next model won't know what happened unless we give it that history. One thing worth trying is a short account of a previous run's failure, to see whether the model changes how it deals with its neighbours.

The game occupies the Windows desktop while a run is in progress. Even Astra plays slowly compared with a human, so a long run would need to happen overnight or on another computer. On our Astra subscription, we got through about 25 early turns in one five-hour usage window. Later turns take longer.

## Running locally

You'll need Windows, Civ VI: Gathering Storm, a WSL 2 distro (the checked-in config uses `Ubuntu-24.04`), [Bun](https://bun.sh/), and [uv](https://docs.astral.sh/uv/) with Python 3.12. Install the WSL distro first. You'll also need access to a supported model provider.

```sh
bun install
bun start setup --enable-tuner
bun start doctor
bun start play --prompt 'Play the current game to a victory. Continue turn by turn until the game ends.'
```

The starting [system prompt](src/prompts.ts) describes the tools and game interface. In the default completion mode, the CLI also appends [task-completion instructions](src/player.ts#L59).

`setup` installs the Python and WSL dependencies. With `--enable-tuner`, it backs up Civ's local `AppOptions.txt` and enables FireTuner; restart Civ afterward. Start or load a Gathering Storm game and leave it open before running `doctor` or `play`. For the other commands, including resume and the local dashboard, see `bun start help`.

The checked-in `civ6.config.json` selects `deepseek-flash` through opencode-go and allows unlimited model calls. You can change the model, provider, effort and call limit with command-line flags or a private JSON file passed to `--config PATH`. `unlimited` removes the harness's call limit, not the provider's quota or charges. Usage costs shown by the program are API-equivalent estimates, not subscription bills.

Run artifacts, captures, transcripts and player workspaces go under the ignored `.civ6/` directory. The credential source and Civ saves are outside this repository. Review any run directory separately before sharing it.

### Authentication

The default credential path points at OMP's `~/.omp/agent/agent.db`, which the player reads without modifying it. You can use the player without OMP:

- With the checked-in opencode-go config, set `OPENCODE_API_KEY` in your environment.
- For a ChatGPT/Codex subscription, run `codex login`, set `"authPath": "~/.codex/auth.json"` in a private config, then select `--provider codex --model gpt-6-astra` (or another supported model). The player uses the existing access token; renew it through Codex when needed.
- For the OpenAI API, set `OPENAI_API_KEY` and select `--provider openai --model gpt-6-astra` (or another supported API model). This uses API billing rather than the subscription.

Keep credentials and private config files out of Git. Player Python cannot read the host credential source.

## Knowledge and rulesets

Runs use the *uncoached* track unless you pass `--knowledge expert-informed`. That option reads the guide named by `expertGuidePath` in the config. We have a usable first version of the guide locally, but are still experimenting with its content and structure, so it isn't checked in yet. We also haven't settled how to publish material derived from someone else's videos. For now, you can supply your own guide and set its path in the config.

Ours came from Herson's 30-video [Civ VI BBG Guides playlist](https://www.youtube.com/playlist?list=PLUmau0-sP9xFMKZz6eMH15mrf3h-fhFCQ). We collected the auto-generated English captions, used LLMs to make a first pass of useful notes for each video, and compiled those notes into a structured `SKILL.md`. During that last pass we compared sources, reconciled conflicting claims where possible, flagged what remained uncertain, and marked advice that depends on multiplayer conditions. The current draft is about 119,000 characters long. You can follow the same process with that playlist, or make a guide from other sources you prefer.

The guide draws on competitive multiplayer games with Better Balanced Game (BBG) and Better Balanced Map(s) (BBM). Much of the advice about growing cities, districts and the economy is useful against AI too. Advice that depends on bargaining with, deterring or predicting human opponents needs more care, and mod-specific numbers should be checked against the rules of the game being played.

The idea is to give the model the kind of background someone might have after playing and studying Civ for a while, then see what it does in a fresh game. Supplying that background changes the experiment, so we keep guided and unguided runs separate. Record the mods, ruleset, map settings, speed, seed, model and knowledge track when comparing them.

The code here is [MIT licensed](LICENSE).
