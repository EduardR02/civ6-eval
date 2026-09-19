import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model, OAuthCredential, CredentialStore } from "@earendil-works/pi-ai";
import type { PlayerOptions } from "../contracts.ts";
import { loadJson, privateDirectory, saveJson } from "./storage.ts";

/** Read subscription access without modifying OMP or rotating its shared refresh token. */
export function readOmpCredential(path: string, accountId?: string): OAuthCredential {
  const database = new Database(path, { readonly: true });
  try {
    const row = database.query(`SELECT c.data FROM auth_credentials c
      WHERE c.provider = 'openai-codex' AND c.credential_type = 'oauth' AND c.disabled_cause IS NULL
      AND NOT EXISTS (SELECT 1 FROM auth_credential_blocks b WHERE b.credential_id = c.id AND b.blocked_until_ms > ?)
      AND json_extract(c.data, '$.expires') > ?
      AND (? IS NULL OR json_extract(c.data, '$.accountId') = ?)
      ORDER BY c.updated_at DESC, c.id DESC LIMIT 1`).get(Date.now(), Date.now() + 6 * 60_000, accountId ?? null, accountId ?? null) as { data: string } | null;
    if (!row) throw new Error("No available unexpired OMP Codex subscription login for this run's account; refresh/login in OMP, then retry. Accounts are never switched automatically.");
    let credential: OAuthCredential;
    try { credential = JSON.parse(row.data); }
    catch { throw new Error("OMP Codex credential data is invalid; repair the login in OMP."); }
    if (typeof credential.access !== "string" || !credential.access || typeof credential.accountId !== "string" || !credential.accountId) throw new Error("OMP Codex credential is missing required access metadata.");
    return { ...credential, type: "oauth" };
  } finally { database.close(); }
}
/** Read the stored opencode-go API key without modifying OMP. Never logged or echoed. */
export function readOmpApiKey(path: string): string {
  const database = new Database(path, { readonly: true });
  try {
    const row = database.query(`SELECT c.data FROM auth_credentials c
      WHERE c.provider = 'opencode-go' AND c.credential_type = 'api_key' AND c.disabled_cause IS NULL
      AND NOT EXISTS (SELECT 1 FROM auth_credential_blocks b WHERE b.credential_id = c.id AND b.blocked_until_ms > ?)
      ORDER BY c.updated_at DESC, c.id DESC LIMIT 1`).get(Date.now()) as { data: string } | null;
    if (!row) throw new Error("No opencode-go API key in the OMP credential store; add the opencode-go login in OMP, or set OPENCODE_API_KEY for this invocation.");
    let credential: { key?: unknown };
    try { credential = JSON.parse(row.data); }
    catch { throw new Error("OMP opencode-go credential data is invalid; repair the login in OMP."); }
    if (typeof credential.key !== "string" || !credential.key) throw new Error("OMP opencode-go credential is missing its API key; repair the login in OMP.");
    return credential.key;
  } finally { database.close(); }
}
export async function createRuntime(options: PlayerOptions): Promise<{ runtime: ModelRuntime; model: Model<Api> }> {
  const directory = join(options.runDir, "player");
  privateDirectory(directory);
  const authPath = join(directory, "auth.json");
  const provider = options.provider === "openai" ? "openai" : options.provider === "opencode-go" ? "opencode-go" : "openai-codex";
  const effort = options.effort ?? (provider === "opencode-go" ? "high" : "xhigh");
  if (provider === "opencode-go" && !["low", "high", "max", "xhigh"].includes(effort)) throw new Error("opencode-go reasoning effort must be low, high, max or xhigh; unsupported levels are never remapped.");
  if (provider !== "opencode-go" && effort === "max") throw new Error("max reasoning effort is only supported by opencode-go; use xhigh for Codex/OpenAI.");
  const sourcePath = options.authPath ? resolve(options.authPath.replace(/^~(?=[/\\])/, homedir())) : join(homedir(), ".omp", "agent", "agent.db");
  const ompSource = provider === "openai-codex" && sourcePath.endsWith(".db");
  const bindingPath = join(directory, "auth-source.json");
  let binding = loadJson<{ accountId: string }>(bindingPath);
  const readSubscription = (): OAuthCredential => {
    let credential: OAuthCredential;
    if (ompSource) credential = readOmpCredential(sourcePath, binding?.accountId);
    else {
      if (resolve(sourcePath) === resolve(authPath)) throw new Error("Codex source authPath must differ from the private run auth store.");
      let source: { auth_mode?: string; tokens?: { access_token?: string; account_id?: string } } | undefined;
      try { source = loadJson<typeof source>(sourcePath); }
      catch { throw new Error("Codex source credentials could not be read; check authPath or renew the login in Codex."); }
      const tokens = source?.tokens;
      if (source?.auth_mode !== "chatgpt" || typeof tokens?.access_token !== "string" || !tokens.access_token) {
        throw new Error("No Codex ChatGPT OAuth credentials at the configured authPath. Run 'codex login', or select provider openai with OPENAI_API_KEY.");
      }
      let claims: { exp?: number; "https://api.openai.com/auth"?: { chatgpt_account_id?: string } };
      try { claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1]!, "base64url").toString()); }
      catch { throw new Error("Codex access token is not a valid JWT. Run 'codex login' to renew it."); }
      const accountId = tokens.account_id ?? claims["https://api.openai.com/auth"]?.chatgpt_account_id;
      if (!accountId) throw new Error("Codex OAuth credentials lack an account id. Run 'codex login' again.");
      const expires = typeof claims.exp === "number" ? claims.exp * 1000 : 0;
      if (expires <= Date.now() + 6 * 60_000) throw new Error("Codex access token expires soon; renew it in Codex before retrying.");
      credential = { type: "oauth", access: tokens.access_token, refresh: "", expires, accountId };
    }
    if (binding && binding.accountId !== credential.accountId) throw new Error("Subscription account differs from this run's pinned account. Restore its login or start a new run; native state cannot switch accounts.");
    if (!binding) {
      if (typeof credential.accountId !== "string" || !credential.accountId) throw new Error("Codex OAuth credentials lack an account id. Run 'codex login' again.");
      binding = { accountId: credential.accountId };
      saveJson(bindingPath, binding);
    }
    // The original source owns refresh. Never copy or rotate its refresh token.
    return { ...credential, refresh: "" };
  };
  if (provider === "openai-codex") readSubscription();
  const sourceStore: CredentialStore | undefined = provider === "openai-codex" ? {
    read: async id => id === provider ? readSubscription() : undefined,
    list: async () => [{ providerId: provider, type: "oauth" as const }],
    modify: async () => { throw new Error("Refresh the subscription login in its source application; this player cannot rotate shared credentials."); },
    delete: async () => { throw new Error("Subscription credential storage is read-only."); },
  } : undefined;
  const runtime = await ModelRuntime.create({ credentials: sourceStore, authPath, modelsPath: join(import.meta.dir, "models.json"), modelsStorePath: join(directory, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
  if (provider === "openai") {
    const key = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OpenAI API authentication is missing. Set OPENAI_API_KEY or supply apiKey; alternatively choose provider codex and run 'codex login'.");
    await runtime.setRuntimeApiKey(provider, key);
  } else if (provider === "opencode-go") {
    const key = options.apiKey ?? process.env.OPENCODE_API_KEY ?? (sourcePath.endsWith(".db") ? readOmpApiKey(sourcePath) : undefined);
    if (!key) throw new Error("opencode-go authentication is missing; add the opencode-go login in OMP, set OPENCODE_API_KEY for this invocation, or supply apiKey.");
    await runtime.setRuntimeApiKey(provider, key);
  }
  const id = options.model ?? (provider === "opencode-go" ? "glm-5.3-flash" : "gpt-6-astra");
  const registered = runtime.getModel(provider, id);
  if (provider === "opencode-go" && (!registered || (registered.api !== "openai-completions" && registered.api !== "openai-responses"))) throw new Error("Select a registered opencode-go completions or responses model, such as deepseek-flash or muse-spark-1.3-contributor.");
  // The transport clamps any level the catalog does not map to an equal-or-higher one, so a missing or null
  // entry would run a cheaper effort than the run was configured for. Compare with the SDK's own clamp and
  // fail instead of letting max quietly become high.
  const clamped = provider === "opencode-go" && registered ? clampThinkingLevel(registered, effort) : effort;
  if (provider === "opencode-go" && registered && clamped !== effort) {
    const levels = getSupportedThinkingLevels(registered);
    const supported = (["minimal", "low", "medium", "high", "xhigh", "max"] as const).filter(level => levels.includes(level));
    throw new Error(`${id} does not support reasoning effort ${effort}; the transport would silently run ${clamped}. Supported opencode-go efforts: ${supported.join(", ") || "none"}.`);
  }
  // Explicit profile avoids registry staleness; catalog profiles are authoritative for opencode-go.
  const model: Model<Api> = {
    ...registered,
    id, name: id, provider,
    api: provider === "opencode-go" && registered ? registered.api : provider === "openai" ? "openai-responses" : "openai-codex-responses",
    baseUrl: options.baseUrl ?? (provider === "opencode-go" ? "https://opencode.ai/zen/go/v1" : provider === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api"),
    reasoning: registered?.reasoning ?? true, input: registered?.input ?? ["text", "image"],
    contextWindow: registered?.contextWindow ?? 1_000_000,
    maxTokens: registered?.maxTokens ?? 32768,
    cost: provider === "openai-codex" ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : registered?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: registered?.thinkingLevelMap ?? { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
  };
  const profilePath = join(directory, "profile.json");
  const profile = { provider, model: id, baseUrl: model.baseUrl, effort, pricingKnown: !!registered };
  const previous = loadJson<typeof profile>(profilePath);
  if (previous && (previous.provider !== profile.provider || previous.model !== profile.model || previous.baseUrl !== profile.baseUrl || previous.effort !== profile.effort)) {
    throw new Error("This run contains state for a different model/provider/endpoint/effort profile. Start a new run rather than replay state across profiles.");
  }
  saveJson(profilePath, profile);
  return { runtime, model };
}
