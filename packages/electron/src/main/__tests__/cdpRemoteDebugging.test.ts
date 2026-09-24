// @vitest-environment node

// The CDP port gives any local process full control of the app without
// authentication. A released app launched from Finder or the Dock carries no
// NODE_ENV, so the decision has to rest on something that is true at runtime.

import { describe, expect, it } from 'vitest';
import { getCdpRemoteDebuggingPort } from '../cdpRemoteDebugging';

describe('getCdpRemoteDebuggingPort', () => {
  it('keeps the port closed in a packaged app launched without any environment', () => {
    expect(getCdpRemoteDebuggingPort({ isPackaged: true, env: {} })).toBeUndefined();
  });

  it('opens the requested port in a packaged app only when NIMBALYST_CDP_PORT is set', () => {
    expect(getCdpRemoteDebuggingPort({ isPackaged: true, env: { NIMBALYST_CDP_PORT: '9232' } })).toBe('9232');
  });

  it('opens the port for a dev run, on the requested port if one is set', () => {
    expect(getCdpRemoteDebuggingPort({ isPackaged: false, env: {} })).toBe('9222');
    expect(getCdpRemoteDebuggingPort({ isPackaged: false, env: { NIMBALYST_CDP_PORT: '0' } })).toBe('0');
  });
});
