import type { Href } from "expo-router";

export interface BackCapableRouter {
  back(): void;
  canGoBack(): boolean;
  replace(href: Href): void;
}

/**
 * A Web cold start on a deep link has no browser history; return explicitly to a safe in-product page.
 */
export function backOrReplace(router: BackCapableRouter, fallback: Href): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace(fallback);
}

export function profileHomeHref(profileId?: string): Href {
  return profileId
    ? { pathname: "/h/[profileId]", params: { profileId } }
    : "/welcome";
}
