import { ValidationError } from "./errors.js";

export interface ResearchConclusion {
  kind: "fact" | "inference" | "recommendation";
  statement: string;
  url: string;
  accessed_at: string;
  applicable_version: string;
  source_level: "official" | "primary" | "secondary";
}

export const validateResearchConclusions = (conclusions: ResearchConclusion[]): void => {
  if (!conclusions.length) throw new ValidationError("research report requires at least one conclusion");
  for (const [index, item] of conclusions.entries()) {
    if (!(["fact", "inference", "recommendation"] as string[]).includes(item.kind)) throw new ValidationError(`research conclusion ${index} has invalid kind`);
    if (!item.statement || !item.applicable_version) throw new ValidationError(`research conclusion ${index} lacks statement or applicable version`);
    try { const url = new URL(item.url); if (!(["http:", "https:"] as string[]).includes(url.protocol)) throw new Error(); } catch { throw new ValidationError(`research conclusion ${index} has invalid URL`); }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.accessed_at)) throw new ValidationError(`research conclusion ${index} has invalid access date`);
    if (!(["official", "primary", "secondary"] as string[]).includes(item.source_level)) throw new ValidationError(`research conclusion ${index} has invalid source level`);
  }
};
