import type { AssetIndex } from '../index/assetIndex.js';
import { modelInfo } from './model.js';

/**
 * Dota 2 ParticleAttachment_t values (verified from the ModDota engine dump).
 * The attachment NAME only matters for PATTACH_POINT / PATTACH_POINT_FOLLOW.
 */
export const PATTACH = {
  PATTACH_ABSORIGIN: 0,
  PATTACH_ABSORIGIN_FOLLOW: 1,
  PATTACH_CUSTOMORIGIN: 2,
  PATTACH_CUSTOMORIGIN_FOLLOW: 3,
  PATTACH_POINT: 4,
  PATTACH_POINT_FOLLOW: 5,
  PATTACH_EYES_FOLLOW: 6,
  PATTACH_OVERHEAD_FOLLOW: 7,
  PATTACH_WORLDORIGIN: 8,
  PATTACH_ROOTBONE_FOLLOW: 9,
  PATTACH_RENDERORIGIN_FOLLOW: 10,
  PATTACH_CENTER_FOLLOW: 13,
  PATTACH_HEALTHBAR: 15,
} as const;

export type PattachName = keyof typeof PATTACH;
const POINT_ATTACH = new Set<PattachName>(['PATTACH_POINT', 'PATTACH_POINT_FOLLOW']);

function stripC(p: string): string {
  return p.replace(/_c$/i, '');
}

function ensureC(p: string): string {
  return /_c$/i.test(p) ? p : p + '_c';
}

export interface ValidateAttachmentResult {
  ok: boolean;
  model: { path: string; exists: boolean; suggestions?: { path: string; score: number }[] };
  particle?: { path: string; exists: boolean; suggestions?: { path: string; score: number }[] };
  attachment: { name: string; exists: boolean; available: string[]; suggestions: string[] };
  problems: string[];
  note: string;
}

/** Closest attachment names by simple substring/prefix overlap. */
function suggestAttachments(name: string, available: string[]): string[] {
  const q = name.toLowerCase().replace(/^attach_/, '');
  const scored = available
    .map((a) => {
      const base = a.replace(/^attach_/, '');
      let score = 0;
      if (base === q) score = 3;
      else if (base.startsWith(q) || q.startsWith(base)) score = 2;
      else if (base.includes(q) || q.includes(base)) score = 1;
      return { a, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map((x) => x.a);
}

/**
 * Validates that a model exists, the particle exists (if given), and the
 * attachment name actually exists on the model — surfacing the model's real
 * attachment list and fuzzy suggestions on any miss. This is the preflight that
 * stops particles from being bound to non-existent attachment names.
 */
export async function validateAttachment(
  index: AssetIndex,
  modelPath: string,
  attachment: string,
  particlePath?: string,
): Promise<ValidateAttachmentResult> {
  const problems: string[] = [];

  const modelKey = ensureC(modelPath);
  const modelExists = index.has(modelKey);
  const modelSug = modelExists
    ? undefined
    : index.resolve(modelPath, { kind: 'model', limit: 5 }).results.map((r) => ({ path: r.path, score: r.score }));
  if (!modelExists) problems.push(`Model not found: "${modelPath}".`);

  let particle: ValidateAttachmentResult['particle'];
  if (particlePath) {
    const pKey = ensureC(particlePath);
    const pExists = index.has(pKey);
    particle = {
      path: particlePath,
      exists: pExists,
      suggestions: pExists
        ? undefined
        : index.resolve(particlePath, { kind: 'particle', limit: 5 }).results.map((r) => ({ path: r.path, score: r.score })),
    };
    if (!pExists) problems.push(`Particle not found: "${particlePath}".`);
  }

  let available: string[] = [];
  let attExists = false;
  let attSug: string[] = [];
  if (modelExists) {
    const info = await modelInfo(index, modelKey);
    available = info.attachments;
    const att = attachment.toLowerCase();
    attExists = available.includes(att);
    if (!attExists) {
      attSug = suggestAttachments(att, available);
      problems.push(
        `Attachment "${attachment}" not found on model.` +
          (attSug.length ? ` Did you mean: ${attSug.join(', ')}?` : ''),
      );
    }
  }

  return {
    ok: problems.length === 0,
    model: { path: modelKey, exists: modelExists, suggestions: modelSug },
    particle,
    attachment: { name: attachment.toLowerCase(), exists: attExists, available, suggestions: attSug },
    problems,
    note:
      'Attachment names are matched against the model\'s real attachment list ' +
      '(from the decompiled DATA block). The name only matters for PATTACH_POINT[_FOLLOW].',
  };
}

export interface GenSnippetResult {
  ok: boolean;
  lua: string;
  validation: ValidateAttachmentResult;
  warnings: string[];
}

/**
 * Generates a correct Lua snippet that creates a particle and binds a control
 * point to a model attachment, using validated asset paths and attachment names.
 * Always runs validation first; emits the snippet with a warning banner if any
 * check fails (so the user sees both the code and what to fix).
 */
export async function genAttachSnippet(
  index: AssetIndex,
  args: {
    model: string;
    attachment: string;
    particle: string;
    controlPoint?: number;
    attachType?: PattachName;
    entityVar?: string;
  },
): Promise<GenSnippetResult> {
  const cp = args.controlPoint ?? 0;
  const attachType = args.attachType ?? 'PATTACH_POINT_FOLLOW';
  const ent = args.entityVar ?? 'hEntity';
  const warnings: string[] = [];

  const validation = await validateAttachment(index, args.model, args.attachment, args.particle);
  if (!validation.ok) warnings.push(...validation.problems);
  if (!POINT_ATTACH.has(attachType)) {
    warnings.push(
      `attachType ${attachType} ignores the attachment name; use PATTACH_POINT_FOLLOW to follow "${args.attachment}".`,
    );
  }
  if (!(attachType in PATTACH)) {
    warnings.push(`Unknown attachType "${attachType}"; defaulting reference to PATTACH_POINT_FOLLOW.`);
  }

  const particleLua = stripC(args.particle); // Lua uses the source .vpcf path
  const att = args.attachment.toLowerCase();

  const lua = [
    `-- Attach particle "${particleLua}"`,
    `-- to attachment "${att}" on "${stripC(validation.model.path)}" via control point ${cp}.`,
    `local fx = ParticleManager:CreateParticle("${particleLua}", ${attachType}, ${ent})`,
    `ParticleManager:SetParticleControlEnt(fx, ${cp}, ${ent}, ${attachType}, "${att}", ${ent}:GetAbsOrigin(), true)`,
    `-- Release when done (lets it finish), or DestroyParticle(fx, true) to stop immediately:`,
    `ParticleManager:ReleaseParticleIndex(fx)`,
  ].join('\n');

  return { ok: validation.ok, lua, validation, warnings };
}
