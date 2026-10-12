import { describe, expect, it } from 'vitest';
import { resolveToolAuthorization } from '../../src/main/agent/tool-authorization';
import { createWebTools } from '../../src/main/tools/web-tools';

describe('tool authorization policy', () => {
  it('allows network tools without workspace tools when only network egress is approved', () => {
    expect(resolveToolAuthorization({ workspaceRoot: null, workspaceDataEgressConsent: false, networkDataEgressConsent: true }))
      .toEqual({ workspaceAuthorized: false, networkAuthorized: true });
  });

  it('allows both tool groups only after workspace and network authorization', () => {
    expect(resolveToolAuthorization({ workspaceRoot: 'D:\\project', workspaceDataEgressConsent: true, networkDataEgressConsent: true }))
      .toEqual({ workspaceAuthorized: true, networkAuthorized: true });
  });

  it('disables network tools when network egress is not approved', () => {
    expect(resolveToolAuthorization({ workspaceRoot: null, workspaceDataEgressConsent: false, networkDataEgressConsent: false }))
      .toEqual({ workspaceAuthorized: false, networkAuthorized: false });
  });
});

describe('web tools authorization', () => {
  it('registers public web tools without a selected workspace when network egress is approved', () => {
    expect(createWebTools({ dataEgressConsent: true }).map((tool) => tool.name))
      .toEqual(['web_fetch', 'web_search']);
  });

  it('does not register public web tools when network egress is not approved', () => {
    expect(createWebTools({ dataEgressConsent: false })).toEqual([]);
  });
});
