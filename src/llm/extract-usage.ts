/**
 * Normalize token counts from `generateText` — AI SDK 6 exposes both `usage` (last step)
 * and `totalUsage` (sum). Gemini preview models sometimes omit fields the converter maps,
 * or only return snake_case / totalTokenCount; we recover from providerMetadata / raw body.
 */

type UsageShape = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
};

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

/** Google generateContent usageMetadata (mixed camelCase / snake_case). */
function fromGoogleUsageMetadata(meta: unknown): { input: number; output: number } | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  const prompt = num(m.promptTokenCount) ?? num(m.prompt_token_count);
  const candidates = num(m.candidatesTokenCount) ?? num(m.candidates_token_count);
  const thoughts = num(m.thoughtsTokenCount) ?? num(m.thoughts_token_count) ?? 0;
  const total = num(m.totalTokenCount) ?? num(m.total_token_count);

  if (prompt != null || candidates != null) {
    return { input: prompt ?? 0, output: (candidates ?? 0) + thoughts };
  }
  if (total != null && total > 0) {
    return { input: total, output: 0 };
  }
  return null;
}

function bodyRecord(body: unknown): Record<string, unknown> | null {
  if (body == null) return null;
  if (typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  if (typeof body === 'string') {
    try {
      const o = JSON.parse(body) as unknown;
      return typeof o === 'object' && o !== null && !Array.isArray(o)
        ? (o as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function fromProviderMetadata(meta: unknown): { input: number; output: number } | null {
  if (!meta || typeof meta !== 'object') return null;
  const root = meta as Record<string, unknown>;
  for (const key of ['google', 'vertex']) {
    const block = root[key];
    if (block && typeof block === 'object') {
      const u = (block as Record<string, unknown>).usageMetadata;
      const parsed = fromGoogleUsageMetadata(u);
      if (parsed) return parsed;
    }
  }
  return null;
}

/** Extract cached token count from Gemini/Vertex provider metadata. */
export function extractCachedTokensFromMetadata(providerMetadata: unknown): number {
  if (!providerMetadata || typeof providerMetadata !== 'object') return 0;
  const root = providerMetadata as Record<string, unknown>;
  for (const key of ['google', 'vertex']) {
    const block = root[key];
    if (block && typeof block === 'object') {
      const u = (block as Record<string, unknown>).usageMetadata;
      if (u && typeof u === 'object') {
        const cached = (u as Record<string, unknown>).cachedContentTokenCount;
        if (typeof cached === 'number' && cached > 0) return cached;
      }
    }
  }
  return 0;
}

/**
 * Pick input/output token counts from a generateText result.
 */
export function extractUsageFromGenerateTextResult(result: {
  usage: UsageShape;
  totalUsage: UsageShape;
  providerMetadata?: unknown;
  response?: { body?: unknown };
}): { inputTokens: number; outputTokens: number; totalTokens: number } {
  const candidates: UsageShape[] = [result.totalUsage, result.usage];

  for (const u of candidates) {
    if (!u) continue;
    const inp = u.inputTokens;
    const out = u.outputTokens;
    if (inp != null || out != null) {
      const i = Math.max(0, inp ?? 0);
      const o = Math.max(0, out ?? 0);
      if (i > 0 || o > 0) {
        return { inputTokens: i, outputTokens: o, totalTokens: i + o };
      }
    }
  }

  const fromMeta = fromProviderMetadata(result.providerMetadata);
  if (fromMeta && (fromMeta.input > 0 || fromMeta.output > 0)) {
    return {
      inputTokens: fromMeta.input,
      outputTokens: fromMeta.output,
      totalTokens: fromMeta.input + fromMeta.output,
    };
  }

  const raw = bodyRecord(result.response?.body);
  const fromBody = raw ? fromGoogleUsageMetadata(raw.usageMetadata) : null;
  if (fromBody && (fromBody.input > 0 || fromBody.output > 0)) {
    return {
      inputTokens: fromBody.input,
      outputTokens: fromBody.output,
      totalTokens: fromBody.input + fromBody.output,
    };
  }

  for (const u of candidates) {
    if (!u) continue;
    const t = u.totalTokens;
    if (t != null && t > 0) {
      return { inputTokens: t, outputTokens: 0, totalTokens: t };
    }
  }

  const inp = result.totalUsage?.inputTokens ?? result.usage?.inputTokens ?? 0;
  const out = result.totalUsage?.outputTokens ?? result.usage?.outputTokens ?? 0;
  const i = Math.max(0, inp ?? 0);
  const o = Math.max(0, out ?? 0);
  return { inputTokens: i, outputTokens: o, totalTokens: i + o };
}
