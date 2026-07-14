// Single source of truth for the CLI's own package version at runtime.
//
// Read from package.json (published alongside `out/` at the package root, so
// `../package.json` resolves from `out/version.js`). Surfaced in the startup
// banner and reported to pixel-office in the WS agent_online frame as
// `cliVersion` so stale, steer-incapable agents become visible server-side.
export const CLI_VERSION: string = (() => {
  try {
    return (require('../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
