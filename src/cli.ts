import { resolve, join } from "node:path";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { loadConfig } from "./config.ts";
import { PlayerHost } from "./host.ts";
import { readOmpApiKey, readOmpCredential } from "./player/auth.ts";
import type { PlayerEvent, TaskRecord } from "./contracts.ts";
import { readUsageReport, formatUsageReport } from "./usage.ts";
import { runDashboard } from "./dashboard.ts";

const HELP = `Civ VI player — native visuals, isolated Python, Astra and subagents

  bun start doctor                 Check game, model credentials, and sandbox
  bun start setup                  Install local Python and WSL dependencies
  bun start setup --enable-tuner   Also enable Civ's FireTuner (restart game)
  bun start observe                Capture a game screenshot and state snapshot
  bun start exec --code '...'      Run Python without a model (or --file script.py)
  bun start play                   Interactive player console
  bun start play --prompt '...'    Run one autonomous task, then exit
  bun start play --resume RUN      Resume a saved run (never replays game actions)
  bun start usage --run RUN        Read saved token/cost accounting offline
  bun start dashboard --run DIR    Serve a private live viewer on a loopback URL

Options:
  --config PATH   JSON configuration (default civ6.config.json if present)
  --run PATH      Use an explicit run directory
  --resume PATH   Resume an existing run directory
  --calls N       Saved-run call ceiling, or unlimited (children + compaction included)
  --knowledge T   Declared evaluation track: uncoached (default) or expert-informed.
                  expert-informed loads expertGuidePath into the main player's system prompt
                  as labelled reference; the run archives its exact text, hash and configuration.
  --provider MODE openai, codex or opencode-go
  --model NAME    Provider model id, for example deepseek-flash or gpt-6-astra
  --effort LEVEL  Codex/OpenAI: low, medium, high, xhigh; opencode-go: low, high, max
  --completion M  explicit (default) or response; see below
  --prompt TEXT   One task for play; omit for the interactive console
  --code TEXT     Python source for exec (mutually exclusive with --file)
  --file PATH     Python file for exec
  --json          Machine-readable output for usage only
  --interval N    Dashboard ledger poll interval in seconds (default 10)

Configured values win. Without a configuration file the fallbacks are provider
codex, model gpt-6-astra (glm-5.3-flash for opencode-go), effort high, 200 saved
model calls, and completion mode explicit. The repository civ6.config.json pins
whatever the next run should use; --provider/--model/--effort/--calls/--completion
override it for one invocation.

Completion modes (play):
  explicit  The task ends only when the model declares its outcome through the
            finish_task tool: "completed" (goal achieved/work done) or "blocked"
            (needs the operator or an external blocker). A turn that only stops —
            for example a progress report with no tool calls — gets exactly one
            protocol reminder; a second undeclared turn stops the run as an
            explicit protocol failure instead of silently ending it. Declared
            outcomes are durable in player/agents.json and player/tasks.jsonl,
            and \`--prompt\` exits 1 on blocked. The model owns the goal and the
            evidence; the harness records the declaration without verifying it.
  response  The task ends when the model stops calling tools. Use it for
            one-shot questions and analyses; a full-game task can stop early.
  Config key: "completionMode": "explicit" | "response". Children always use
  response mode: a delegated analysis ends when its model stops.

Authentication: ChatGPT/Codex subscription from ~/.omp/agent/agent.db by default.
Set authPath to ~/.codex/auth.json to use the desktop/CLI login instead.
OPENAI_API_KEY is used only with explicit provider openai. Credentials never
enter player Python sandboxes; the OMP store is read-only and never refreshed here.
The current CLI does not start scored games automatically; open your intended
Gathering Storm game, or ask the player to create one through the UI.

Interactive commands: /status, /agents, /usage, /control ID, /abort, /quit.
Other lines prompt the player; lines entered during a run are queued.
/abort drops queued prompts and resets main Python (workspace files persist).
Ctrl+C aborts activity; press again before the next task to close. /quit also
discards queued prompts. Neither closes Civ. Usage reports need no credentials,
game, Python or tuner. Subscription costs are API-equivalent estimates, not
actual subscription charges; unavailable prices are reported as unavailable.

Python: persistent namespace, display(PIL_image), pyautogui, civ, rpc.
Arbitrary code runs in WSL bubblewrap with no host files or network. Player
files persist in the run workspace. All live game/UI operations use a single
controller, initially 'main'. Subagents may analyze immutable snapshots;
main can grant control with rpc('control.grant', {'agentId': child_id}).
Artifacts/history are available through artifact.* and history.* RPC.
Runs, observations and model-created files live in .civ6/runs/.
`;

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  help: [],
  setup: ["config", "enable-tuner"],
  doctor: ["config", "run", "provider", "model", "effort"],
  observe: ["config", "run"],
  exec: ["config", "run", "code", "file"],
  play: ["config", "run", "resume", "provider", "model", "effort", "calls", "completion", "knowledge", "prompt"],
  usage: ["run", "json"],
  dashboard: ["run", "interval"],
};
const FLAGS: Record<string, true> = { help: true, "enable-tuner": true, json: true };

function parseArguments(argv: string[]): { command: string; options: Record<string, string | boolean> } {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "help";
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) throw new Error(`Unknown command: ${command}. Use bun start --help.`);
  const allowed = COMMAND_OPTIONS[command]!;
  const options: Record<string, string | boolean> = {};
  for (let i = command === argv[0] ? 1 : 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (name !== "help" && !allowed.includes(name)) throw new Error(`Unknown option for ${command}: ${arg}`);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: ${arg}`);
    if (Object.hasOwn(FLAGS, name)) { options[name] = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith("--") || !value.trim()) throw new Error(`${arg} requires a value`);
    options[name] = value;
  }
  if (options.run && options.resume) throw new Error("--run and --resume are mutually exclusive");
  if (options.code && options.file) throw new Error("--code and --file are mutually exclusive");
  if (!options.help && command === "usage" && !options.run) throw new Error("usage requires --run DIR");
  if (!options.help && command === "dashboard" && !options.run) throw new Error("dashboard requires --run DIR");
  return { command, options };
}
const projectRoot = resolve(import.meta.dir, "..");

async function runCommand(args: string[], cwd = projectRoot): Promise<void> {
  const child = Bun.spawn(args, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exit = await child.exited;
  if (exit !== 0) throw new Error(`${args[0]} exited with ${exit}`);
}

async function main(): Promise<void> {
  const { command, options } = parseArguments(process.argv.slice(2));
  const option = (name: string): string | undefined => typeof options[name] === "string" ? options[name] as string : undefined;
  if (command === "help" || options.help) { console.log(HELP); return; }
  if (command === "usage") {
    const report = await readUsageReport(resolve(option("run")!));
    console.log(options.json ? JSON.stringify(report, null, 2) : formatUsageReport(report));
    return;
  }
  if (command === "dashboard") {
    const interval = Number(option("interval") ?? 10);
    if (!Number.isSafeInteger(interval) || interval < 1) throw new Error("--interval must be a positive integer (seconds)");
    await runDashboard(resolve(option("run")!), interval);
    return;
  }
  const config = await loadConfig(projectRoot, option("config"));
  if (option("provider")) {
    const value = option("provider");
    if (value !== "openai" && value !== "codex" && value !== "opencode-go") throw new Error("--provider must be codex, openai or opencode-go");
    if (value !== config.provider && !option("model")) config.model = value === "opencode-go" ? "glm-5.3-flash" : "gpt-6-astra";
    config.provider = value as typeof config.provider;
  }
  if (option("model")) config.model = option("model")!;
  if (option("effort")) {
    const value = option("effort")!;
    if (!["low", "medium", "high", "xhigh", "max"].includes(value)) throw new Error("Invalid --effort");
    config.effort = value as typeof config.effort;
  }
  if (config.provider === "opencode-go" && !["low", "high", "max", "xhigh"].includes(config.effort)) throw new Error("opencode-go --effort must be low, high, max or xhigh");
  if (config.provider !== "opencode-go" && config.effort === "max") throw new Error("Codex/OpenAI --effort max is unsupported; choose xhigh");
  if (option("calls")) {
    const value = option("calls")!;
    const count = value === "unlimited" ? value : Number(value);
    if (count !== "unlimited" && (!Number.isSafeInteger(count) || count < 1)) throw new Error("--calls must be a positive integer or unlimited");
    config.maxModelCalls = count;
  }
  if (option("knowledge")) {
    const value = option("knowledge")!;
    if (value !== "uncoached" && value !== "expert-informed") throw new Error("--knowledge must be uncoached or expert-informed");
    config.knowledge = value;
  }
  if (option("completion")) {
    const value = option("completion")!;
    if (value !== "explicit" && value !== "response") throw new Error("--completion must be explicit or response");
    config.completionMode = value;
  }
  if (command === "setup") {
    await runCommand(["uv", "venv", "--python", "3.12", ".venv"]);
    await runCommand(["uv", "pip", "install", "--python", config.pythonPath, "-r", "requirements.txt"]);
    await runCommand(["wsl.exe", "-d", config.distro, "-u", "root", "--", "apt-get", "update"]);
    await runCommand(["wsl.exe", "-d", config.distro, "-u", "root", "--", "apt-get", "install", "-y", "bubblewrap", "python3-pil", "python3-numpy"]);
    if (options["enable-tuner"]) {
      const path = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Firaxis Games", "Sid Meier's Civilization VI", "AppOptions.txt");
      const source = await readFile(path, "utf8");
      if (!/^EnableTuner\s+[01]\s*$/m.test(source)) throw new Error("EnableTuner setting not found");
      const backup = `${path}.civ6-player-backup`;
      await writeFile(backup, source, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
      await writeFile(path, source.replace(/^EnableTuner[ \t]+[01]/m, "EnableTuner 1"));
      console.log(`Enabled FireTuner. Restart Civ VI. Original settings preserved at ${backup}`);
    }
    console.log("Setup complete. Run bun start doctor with Civ VI open.");
    return;
  }
  const runDir = resolve(option("resume") ?? option("run") ?? join(config.runsDir, new Date().toISOString().replace(/[:.]/g, "-")));
  if (option("resume")) await access(runDir);
  await mkdir(runDir, { recursive: true });
  console.log(`Run: ${runDir}`);
  const onEvent = (event: PlayerEvent) => {
    if (event.type === "text" && event.agentId === "main") process.stdout.write(event.text ?? "");
    else if (event.type === "agent_complete") {
      if (event.agentId !== "main") console.log(`\n[${event.agentId}] Completed`);
    } else if (event.type === "task_outcome") {
      const data = event.data as Partial<TaskRecord> | undefined;
      console.log(`\n[${event.agentId}] Task ${data?.outcome ?? "declared"}: ${data?.reason ?? ""}`);
    } else if (event.type === "protocol_repair") {
      console.log(`\n[${event.agentId}] No task declaration in that turn; sending the single protocol reminder.`);
    } else if (event.type === "usage") {
      const data = event.data as { usage?: { input: number; output: number; cacheRead: number }; kind?: string } | undefined;
      if (data?.usage) console.log(`\n[${event.agentId}] ${data.kind ?? "model"}: ${data.usage.input} new input, ${data.usage.cacheRead} cached, ${data.usage.output} output tokens`);
    } else if (["tool_start", "agent_start", "agent_error", "compaction"].includes(event.type)) {
      console.log(`\n[${event.agentId}] ${event.type}${event.text ? `: ${event.text}` : ""}`);
    }
  };
  const host = new PlayerHost(projectRoot, runDir, config, onEvent);
  let closing = false;
  let abortRequested = false;
  let aborting: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  let generation = 0;
  let controlGeneration = 0;
  let closeInput: (() => void) | undefined;
  const reportError = (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  };
  const interrupt = (): Promise<void> => {
    generation++;
    controlGeneration++;
    abortRequested = true;
    if (aborting) return aborting;
    console.log("\nAborting activity and discarding queued prompts; main Python resets (files persist)...");
    aborting = Promise.allSettled([
      host.setController("main"),
      host.player.abort(),
      host.execution.reset("main"),
    ]).then(results => {
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, `Abort failed: ${errors.map(String).join("; ")}`);
    }).finally(() => { aborting = undefined; });
    return aborting;
  };
  const signalInterrupt = () => {
    if (abortRequested) {
      closing = true;
      generation++;
      process.exitCode = 130;
      closeInput?.();
      void (shutdown ??= host.close()).catch(reportError);
    } else {
      void interrupt().catch(reportError);
    }
  };
  process.on("SIGINT", signalInterrupt);
  try {
    await host.initialize();
    if (command === "doctor") {
      const checks: Record<string, unknown> = {};
      for (const [name, check] of Object.entries({
        nativePython: () => access(config.pythonPath).then(() => "available"),
        credentials: async () => {
          if (config.provider === "openai") return process.env.OPENAI_API_KEY ? "OpenAI API key present (environment; API billing)" : "MISSING OPENAI_API_KEY";
          if (config.provider === "opencode-go") {
            if (process.env.OPENCODE_API_KEY) return "opencode-go API key present (environment)";
            readOmpApiKey(config.authPath);
            return "opencode-go API key available (OMP store, read-only)";
          }
          if (config.authPath.endsWith(".db")) { readOmpCredential(config.authPath); return "OMP subscription OAuth available (source read-only)"; }
          const auth = JSON.parse(await readFile(config.authPath, "utf8"));
          return auth.tokens?.access_token ? "Codex login present (not yet verified with provider)" : "MISSING Codex access token";
        },
        game: () => host.desktop.request("desktop.window", {}),
        tuner: () => host.bridge.request("civ.probe", {}),
        sandbox: () => host.execute("import os, socket\nprint('python', os.sys.version)\nprint('workspace', os.getcwd())\nprint('host_mount_visible', os.path.exists('/mnt/c/Users'))\nprint('network_interfaces', socket.if_nameindex())\nfrom PIL import Image\nimport numpy\nprint('PIL and numpy available')"),
      })) {
        try { checks[name] = await check(); }
        catch (error) { checks[name] = { error: String(error) }; }
      }
      console.log(JSON.stringify(checks, null, 2));
      if (Object.values(checks).some(value => typeof value === "string" ? value.startsWith("MISSING") : typeof value === "object" && value !== null && ("error" in value || "isError" in value && value.isError))) process.exitCode = 1;
      return;
    }
    if (command === "observe") {
      await host.rpc("main", "desktop.focus", {});
      const screenshot = await host.rpc("main", "desktop.screenshot", {}) as Record<string, unknown>;
      const imagePath = join(runDir, "observation.png");
      await writeFile(imagePath, Buffer.from(String(screenshot.data), "base64"));
      console.log(`Screenshot: ${imagePath} (${screenshot.width}x${screenshot.height})`);
      try {
        const state = await host.rpc("main", "civ.snapshot", {});
        const statePath = join(runDir, "observation.json");
        await writeFile(statePath, JSON.stringify(state, null, 2));
        console.log(`Snapshot: ${statePath}`);
      } catch (error) { console.error(`State unavailable: ${String(error)}. Screenshot remains available.`); process.exitCode = 1; }
      return;
    }
    if (command === "exec") {
      const code = option("file") ? await readFile(resolve(option("file")!), "utf8") : option("code");
      if (!code) throw new Error("exec needs --code or --file");
      const result = await host.execute(code);
      for (let i = 0; i < result.content.length; i++) {
        const block = result.content[i];
        if (block.type === "text") console.log(block.text);
        else {
          const imagePath = join(runDir, `execution-${i}.${block.mimeType === "image/jpeg" ? "jpg" : "png"}`);
          await writeFile(imagePath, Buffer.from(block.data, "base64"));
          console.log(`Image: ${imagePath}`);
        }
      }
      if (result.isError) process.exitCode = 1;
      return;
    }
    if (option("prompt")) {
      const task = await host.player.prompt(option("prompt")!);
      process.stdout.write("\n");
      // The task_outcome event already printed the declaration; a declared blocker is a
      // controlled stop, not a harness failure, and scripted runs must be able to tell it
      // apart from a completed task.
      if (task?.outcome === "blocked") process.exitCode = 1;
      return;
    }
    console.log("Enter a task. /status /agents /usage /control ID /abort /quit.");
    const input = createInterface({ input: process.stdin, output: process.stdout, prompt: "civ> " });
    closeInput = () => input.close();
    let queue: Promise<unknown> = Promise.resolve();
    let commands: Promise<void> = Promise.resolve();
    const prompt = () => { if (!closing) input.prompt(); };
    type AgentStatus = {
      totalCalls: number; active: number;
      agents: { id: string; status: string; calls: number; compactionCalls: number; task?: TaskRecord }[];
    };
    const operatorCommand = async (text: string) => {
      if (text === "/status") {
        const [control, state] = await Promise.all([
          host.rpc("main", "control.status", {}) as Promise<{ controller: string }>,
          host.player.rpc("main", "agent.list", {}) as Promise<AgentStatus>,
        ]);
        console.log(`Run: ${runDir}\nControl: ${control.controller} | ${config.provider}/${config.model}\nCalls: ${state.totalCalls}/${config.maxModelCalls} saved-run ceiling (children + compaction included) | Agents: ${state.active} active, ${state.agents.length} total`);
        const last = state.agents.find(agent => agent.id === "main")?.task;
        if (last) console.log(`Last task: ${last.outcome} at ${last.at}${last.repair ? " (after one protocol reminder)" : ""}: ${last.reason.split("\n")[0]}`);
      } else if (text === "/agents") {
        const state = await host.player.rpc("main", "agent.list", {}) as AgentStatus;
        for (const agent of state.agents) console.log(`${agent.id}: ${agent.status}${agent.task ? ` | task ${agent.task.outcome} at ${agent.task.at}` : ""} | calls ${agent.calls} (${agent.compactionCalls} compaction)`);
      } else if (text === "/usage") {
        console.log(formatUsageReport(await readUsageReport(runDir)));
      } else if (text.startsWith("/control ")) {
        const id = text.slice(9).trim();
        await host.setController(id);
        console.log(`Control: ${id}`);
      } else {
        throw new Error(`Unknown console command: ${text}. Use /status /agents /usage /control ID /abort /quit.`);
      }
    };
    prompt();
    await new Promise<void>(resolveDone => {
      input.on("SIGINT", signalInterrupt);
      input.on("line", line => {
        if (closing) return;
        const text = line.trim();
        if (!text) { prompt(); return; }
        if (text === "/quit") { closing = true; generation++; input.close(); return; }
        if (text === "/abort") { void interrupt().catch(reportError).finally(prompt); return; }
        if (text.startsWith("/")) {
          const ticket = controlGeneration;
          commands = commands.then(() => text.startsWith("/control ") && ticket !== controlGeneration ? undefined : operatorCommand(text)).catch(reportError).finally(prompt);
          return;
        }
        const ticket = generation;
        const beforePrompt = commands;
        queue = queue.then(async () => {
          await aborting;
          await beforePrompt;
          if (closing || ticket !== generation) return;
          abortRequested = false;
          await host.player.prompt(text);
          process.stdout.write("\n");
        }).catch(reportError).finally(prompt);
      });
      input.on("close", () => { closing = true; generation++; resolveDone(); });
    });
    await commands;
  } finally {
    process.off("SIGINT", signalInterrupt);
    await aborting?.catch(reportError);
    await (shutdown ??= host.close());
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
