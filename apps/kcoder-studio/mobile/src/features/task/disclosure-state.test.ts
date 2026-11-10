import { describe, expect, it } from "vitest";
import { resolveDisclosureExpanded, toggleDisclosureChoice } from "./disclosure-state";

describe("conversation disclosure defaults", () => {
  it("uses the current device default until the user changes this node", () => {
    expect(resolveDisclosureExpanded(null, false)).toBe(false);
    expect(resolveDisclosureExpanded(null, true)).toBe(true);
  });

  it("keeps an explicit node choice ahead of changed defaults and streamed updates", () => {
    const explicitlyExpanded = toggleDisclosureChoice(null, false);
    expect(explicitlyExpanded).toBe(true);
    expect(resolveDisclosureExpanded(explicitlyExpanded, false)).toBe(true);
    expect(resolveDisclosureExpanded(explicitlyExpanded, true)).toBe(true);

    const explicitlyCollapsed = toggleDisclosureChoice(null, true);
    expect(explicitlyCollapsed).toBe(false);
    expect(resolveDisclosureExpanded(explicitlyCollapsed, true)).toBe(false);
    expect(resolveDisclosureExpanded(explicitlyCollapsed, false)).toBe(false);
  });
});
