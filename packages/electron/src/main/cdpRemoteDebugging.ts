/**
 * The Chrome DevTools (CDP) remote-debugging port that bootstrap opens, if any.
 * It lets Playwright drive a running dev instance via `connectOverCDP`.
 *
 * The port gives any local process full control of the app without
 * authentication, so a packaged app opens it only when `NIMBALYST_CDP_PORT`
 * asks for it. `NODE_ENV` cannot make this call: it is a build-time setting,
 * and a packaged app launched from Finder or the Dock has none at runtime.
 */
export function getCdpRemoteDebuggingPort(params: {
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
}): string | undefined {
  if (params.env.NIMBALYST_CDP_PORT) {
    return params.env.NIMBALYST_CDP_PORT;
  }
  return params.isPackaged ? undefined : '9222';
}
