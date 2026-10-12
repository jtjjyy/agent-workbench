export interface ToolAuthorizationInput {
  workspaceRoot: string | null | undefined;
  workspaceDataEgressConsent: boolean | undefined;
  networkDataEgressConsent: boolean;
}

export interface ToolAuthorization {
  workspaceAuthorized: boolean;
  networkAuthorized: boolean;
}

export function resolveToolAuthorization(input: ToolAuthorizationInput): ToolAuthorization {
  return {
    workspaceAuthorized: !!input.workspaceRoot && input.workspaceDataEgressConsent === true,
    networkAuthorized: input.networkDataEgressConsent === true,
  };
}
