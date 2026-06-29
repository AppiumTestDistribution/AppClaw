/**
 * Shared step helpers — reusable across spec files.
 *
 * Not a spec file (no `.spec.ts` / `.test.ts` suffix), so the runner won't
 * collect it as tests; it's just a plain module of functions that take `app`.
 */
import type { AppClaw } from 'appclaw';

/** Tap the login button — the common entry step for the VodQA flows. */
export async function tapLogin(app: AppClaw): Promise<void> {
  await app.run('Click on login button');
}
