export const HUMAN_RENDERER_VERSION = "human-renderer-v1";

const label = (key: string): string => key.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
const scalar = (value: unknown): string => value === null || value === undefined || value === "" ? "None" : String(value);

const renderTree = (value: unknown, depth = 0): string[] => {
  const indent = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}None`];
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") return [`${indent}- ${scalar(item)}`];
      const rendered = renderTree(item, depth + 1);
      return [`${indent}-`, ...rendered];
    });
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return [`${indent}None`];
    return entries.flatMap(([key, item]) => {
      if (!item || typeof item !== "object") return [`${indent}${label(key)}: ${scalar(item)}`];
      return [`${indent}${label(key)}:`, ...renderTree(item, depth + 1)];
    });
  }
  return [`${indent}${scalar(value)}`];
};

const renderTimeline = (timeline: unknown[]): string[] => {
  const visible = timeline.slice(-20);
  return [
    `Timeline (${visible.length} of ${timeline.length}):`,
    ...(visible.length ? visible.flatMap((item) => renderTree(item, 1)) : ["  None"]),
  ];
};

const renderRun = (value: Record<string, unknown>): string => {
  const timeline = Array.isArray(value.timeline) ? value.timeline : Array.isArray(value.timeline_tail) ? value.timeline_tail : [];
  const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "timeline" && key !== "timeline_tail"));
  return [...renderTree(rest), ...renderTimeline(timeline)].join("\n");
};

const renderResolvedEnvironment = (value: Record<string, unknown>): string => [
  ...renderTree({ environment: value.environment, effective_config: value.effective_config }),
  ...renderTree({ provenance: value.provenance, digests: value.digests }),
].join("\n");

export const renderHuman = (value: unknown): string => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return renderTree(value).join("\n");
  const record = value as Record<string, unknown>;
  if (record.ok === false && typeof record.error === "string") return [
    "ok: false",
    `Error: ${record.error}`,
    `Code: ${scalar(record.code)}`,
    "Details:",
    ...renderTree(record.details, 1),
  ].join("\n");
  if (record.environment && record.effective_config && record.provenance && record.digests) return renderResolvedEnvironment(record);
  if (Array.isArray(record.timeline) || Array.isArray(record.timeline_tail)) return renderRun(record);
  return renderTree(record).join("\n");
};
