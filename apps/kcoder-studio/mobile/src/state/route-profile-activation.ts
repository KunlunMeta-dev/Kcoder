interface RouteProfileActivationInput {
  focused: boolean;
  hydrated: boolean;
  routeProfileId?: string;
  activeProfileId?: string;
  profileIds: readonly string[];
}

export function shouldActivateRouteProfile(input: RouteProfileActivationInput): boolean {
  return input.focused
    && input.hydrated
    && Boolean(input.routeProfileId)
    && input.activeProfileId !== input.routeProfileId
    && input.profileIds.includes(input.routeProfileId!);
}
