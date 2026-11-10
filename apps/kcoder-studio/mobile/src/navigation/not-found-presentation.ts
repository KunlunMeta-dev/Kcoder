export interface NotFoundRouter {
  canGoBack(): boolean;
  back(): void;
  replace(href: "/"): void;
}

/** Keep the full mounted pathname while dropping query and fragment data. */
export function getSafeNotFoundPathname(pathname: string | undefined): string {
  if (!pathname) return "/";
  const sensitiveSuffix = pathname.search(/[?#]/);
  const pathOnly = sensitiveSuffix < 0 ? pathname : pathname.slice(0, sensitiveSuffix);
  if (!pathOnly) return "/";
  return pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
}

export function returnFromNotFound(router: NotFoundRouter): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace("/");
}

export function goToNotFoundHome(router: NotFoundRouter): void {
  // Use the Expo route so its configured baseUrl keeps direct and Relay mounts intact.
  router.replace("/");
}
