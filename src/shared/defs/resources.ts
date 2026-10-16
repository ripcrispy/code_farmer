/** Resource economy definitions. Add new resource types here; nothing else hardcodes the list. */

export const RESOURCE_TYPES = ["wood", "stone", "gold", "food"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export type ResourceBag = Record<ResourceType, number>;

export function emptyBag(): ResourceBag {
  return { wood: 0, stone: 0, gold: 0, food: 0 };
}

export function bagTotal(b: ResourceBag): number {
  let t = 0;
  for (const r of RESOURCE_TYPES) t += b[r];
  return t;
}

export function isResourceType(s: unknown): s is ResourceType {
  return typeof s === "string" && (RESOURCE_TYPES as readonly string[]).includes(s);
}

/** Kinds of harvestable world nodes and what they yield. */
export const NODE_KINDS = ["tree", "stone", "gold", "berries"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export interface NodeDef {
  kind: NodeKind;
  yields: ResourceType;
  /** Inclusive range for the generated starting amount. */
  minAmount: number;
  maxAmount: number;
  /** Display colour used by the renderer and UI (0xRRGGBB). */
  color: number;
  label: string;
  /**
   * Regrowing nodes stay in place (and keep blocking their tile) when emptied, and
   * regain this many units per minute up to their original amount. 0 = finite.
   */
  regrowPerMinute: number;
}

export const NODE_DEFS: Record<NodeKind, NodeDef> = {
  tree: { kind: "tree", yields: "wood", minAmount: 40, maxAmount: 80, color: 0x2f6b2a, label: "Tree", regrowPerMinute: 0 },
  stone: { kind: "stone", yields: "stone", minAmount: 150, maxAmount: 300, color: 0x9a9a9a, label: "Stone deposit", regrowPerMinute: 0 },
  gold: { kind: "gold", yields: "gold", minAmount: 100, maxAmount: 250, color: 0xe5c040, label: "Gold vein", regrowPerMinute: 0 },
  berries: { kind: "berries", yields: "food", minAmount: 60, maxAmount: 120, color: 0xb0306a, label: "Berry bush", regrowPerMinute: 6 },
};

export function isNodeKind(s: unknown): s is NodeKind {
  return typeof s === "string" && (NODE_KINDS as readonly string[]).includes(s);
}
