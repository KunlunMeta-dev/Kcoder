import { expect, it, vi } from "vitest";
const host = vi.hoisted(() => ({ refs: [] as { current: unknown }[], index: 0 }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useRef(initial: unknown) { return host.refs[host.index++] ??= { current: initial }; },
  useEffect() {},
}));
import { useFormOwner } from "./form-owner";
it("isolates failed owner cleanup, releases subsequent claims and retries only failed callbacks", () => {
  host.refs = []; host.index = 0;
  const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
  const owner = useFormOwner("A");
  const first = vi.fn().mockImplementationOnce(() => { throw new Error("private error"); });
  const next = vi.fn();
  owner.onDispose(first); owner.onDispose(next);
  expect(() => owner.dispose()).not.toThrow();
  expect(next).toHaveBeenCalledTimes(1);
  expect(diagnostic).toHaveBeenCalledWith("form_owner_cleanup_pending");
  owner.dispose();
  expect(first).toHaveBeenCalledTimes(2); expect(next).toHaveBeenCalledTimes(1);
  diagnostic.mockRestore();
});
