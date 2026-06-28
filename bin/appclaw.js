#!/usr/bin/env node

// `appclaw test ...` routes to the runner CLI; everything else falls through to
// the main interactive/flow/report entry point.
if (process.argv[2] === 'test') {
  // Spec/config files (appclaw.config.ts, *.spec.ts) are TypeScript, loaded via
  // dynamic import() inside the runner. Node can't import .ts directly, so we
  // register a TS loader here (tsx) before the runner runs. This lets a plain
  // `appclaw test` work from a package.json script — no `tsx` wrapper needed.
  // Pre-compiled `.js` specs work without it.
  await registerTsLoader();
  const { runCli } = await import('../dist/runner/cli.js');
  const code = await runCli(process.argv.slice(3));
  process.exit(code);
} else {
  await import('../dist/index.js');
}

/** Register tsx's ESM loader so later `import()` of `.ts` files resolves. */
async function registerTsLoader() {
  try {
    const { register } = await import('tsx/esm/api');
    register();
  } catch {
    // tsx isn't installed in this project. TypeScript specs will fail to load;
    // hint how to fix it. JavaScript specs still run fine, so don't hard-exit.
    process.stderr.write(
      'appclaw: TypeScript specs need a TS loader. Run `npm i -D tsx`\n' +
        '         (or compile specs to .js, or invoke via `tsx`).\n'
    );
  }
}
