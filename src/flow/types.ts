/** Optional header (first YAML document before `---`) */
export interface FlowMeta {
  appId?: string;
  name?: string;
}

/** Set when the step was parsed from a natural-language YAML string (shown in CLI). */
type Verbatim = { verbatim?: string };

export type FlowStep =
  | ({ kind: "launchApp" } & Verbatim)
  | ({ kind: "openApp"; query: string } & Verbatim)
  | ({ kind: "wait"; seconds: number } & Verbatim)
  | ({ kind: "tap"; label: string } & Verbatim)
  | ({ kind: "type"; text: string } & Verbatim)
  | ({ kind: "enter" } & Verbatim)
  | ({ kind: "back" } & Verbatim)
  | ({ kind: "home" } & Verbatim)
  | ({ kind: "swipe"; direction: "up" | "down" | "left" | "right" } & Verbatim)
  | ({ kind: "assert"; text: string } & Verbatim)
  | ({ kind: "scrollAssert"; text: string; direction: "up" | "down" | "left" | "right"; maxScrolls: number } & Verbatim)
  | ({ kind: "done"; message?: string } & Verbatim);

export interface ParsedFlow {
  meta: FlowMeta;
  steps: FlowStep[];
}
