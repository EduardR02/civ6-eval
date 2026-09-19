import { createHash } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import { validateRequestLimits, type PlayerOptions } from "../contracts.ts";

/** Model-facing text that replaces a screenshot removed from the replayed view. It names the
 * policy instead of pretending to be an observation, and the durable elision record says which
 * capture it stands for: the append-only journal still holds every byte that was ever sent. */
export const ELIDED_IMAGE_TEXT = "[screenshot elided — image budget]";

/** Screenshots a watermark purge keeps when a count limit was configured without a retained count.
 * Purging to the trigger itself would rewrite history on every later image. */
export const DEFAULT_RETAINED_IMAGES = 5;

/** Measured request caps, keyed `provider/model`. Only a route whose limit was actually observed
 * appears here: Muse Spark's Responses route caps one request at 50 images, so its ledger purges
 * above 45 and settles at 5. Astra (Codex Responses) and DeepSeek (Chat Completions) have no
 * measured image cap, so nothing is evicted there unless the operator configures a limit, and an
 * unmeasured route gets no invented one. Caps are recorded against the model they were measured
 * on: a different model on the same host stays unmeasured until someone measures it. */
const MEASURED_IMAGE_LIMITS: Readonly<Record<string, { maxImages: number; retainedImages: number }>> = {
  "opencode-go/muse-spark-1.3-contributor": { maxImages: 45, retainedImages: 5 },
};

/** Effective limits for one ledger. */
export interface ResolvedLimits {
  /** Purge trigger: the replayed view is left alone while it holds at most this many images. */
  maxImages?: number;
  /** Images a purge leaves, never above `maxImages`. */
  retainedImages?: number;
  /** Serialized request cap in UTF-8 bytes: system prompt, tools, transient asks and history. */
  maxBytes?: number;
}

/** Explicit per-run limits win; otherwise a measured route cap applies. */
export function resolveRequestLimits(options: PlayerOptions, model: Model<Api>): ResolvedLimits {
  validateRequestLimits(options.requestLimits);
  const measured = MEASURED_IMAGE_LIMITS[`${model.provider}/${model.id}`];
  const configured = options.requestLimits;
  const maxImages = configured?.maxImages ?? measured?.maxImages;
  const resolved: ResolvedLimits = {};
  if (maxImages !== undefined) {
    resolved.maxImages = maxImages;
    resolved.retainedImages = Math.min(configured?.retainedImages ?? measured?.retainedImages ?? DEFAULT_RETAINED_IMAGES, maxImages);
  }
  if (configured?.maxBytes !== undefined) resolved.maxBytes = configured.maxBytes;
  return resolved;
}

/** One capture removed from the replayed view: its position in the durable ledger, its serialized
 * size, and a digest of the exact serialized part that was replaced, so an audit can locate the
 * original capture in the append-only journal without the journal growing a second copy. */
export interface Elision {
  /** Index of the owning ledger item or message. */
  position: number;
  /** Index of the replaced part inside that ledger entry's image-bearing array. */
  part: number;
  bytes: number;
  mimeType?: string;
  sha256: string;
}

export function elision(position: number, part: number, material: string, bytes: number, mimeType?: string): Elision {
  return { position, part, bytes, mimeType, sha256: createHash("sha256").update(material).digest("hex") };
}

/** Serialized UTF-8 size of one JSON fragment, the unit both ledgers count and journal. */
export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/** An oldest-first elision plan: how many captures to replace and how many UTF-8 bytes that frees,
 * given part sizes in ledger order and the serialized size of the marker that replaces each one. */
export interface ElisionPlan {
  count: number;
  freed: number;
}

export function elisionPlan(sizes: readonly number[], overage: number, markerBytes: number): ElisionPlan {
  let freed = 0;
  let count = 0;
  while (count < sizes.length && freed < overage) {
    freed += Math.max(0, sizes[count]! - markerBytes);
    count++;
  }
  return { count, freed };
}
