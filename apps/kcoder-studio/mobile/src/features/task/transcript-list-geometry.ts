import { Component, type ReactNode } from "react";
import { shouldAnchorLatest, type MessageFollowState } from "@/components/message-follow-state";

export const TRANSCRIPT_ANCHOR_SETTLE_MAX_FRAMES = 16;

export function transcriptLogicalTop(scrollHeight: number, clientHeight: number, rawTop: number): number {
  return Math.max(0, scrollHeight - clientHeight) - rawTop;
}

export function transcriptRawTop(scrollHeight: number, clientHeight: number, logicalTop: number): number {
  const maximum = Math.max(0, scrollHeight - clientHeight);
  return Math.max(0, Math.min(maximum, maximum - logicalTop));
}

type List = {
  getNativeScrollRef(): unknown;
  scrollToOffset(options: { offset: number; animated?: boolean }): unknown;
};
type Lifetime = { intent: MessageFollowState; mounted: boolean; generation: number; owner: object };
type DirectionalInput = {
  intent: MessageFollowState;
  generation: number;
  owner?: object;
  direction?: "toward-old" | "toward-latest";
  host?: HTMLElement;
  outerInput?: boolean;
};
type OwnedJump = {
  host: HTMLElement;
  list: List;
  binding: number;
  owner: object;
  generation: number;
  intent: MessageFollowState;
};
type Anchor = {
  id: string;
  offset: number;
  host: HTMLElement;
  intent: MessageFollowState;
  generation: number;
  binding: number;
  owner: object;
};

// Only the Web rendering representation is inverted. Existing history/follow
// callers continue to see chronological coordinates and scrollToEnd semantics.
export class InvertedTranscriptGeometry {
  private list: List | null = null;
  private binding = 0;
  private host: HTMLElement | null = null;
  private logicalHost: HTMLElement | null = null;
  private rows = new Map<string, HTMLElement>();
  private anchor: Anchor | null = null;
  private frame: number | null = null;
  private input: DirectionalInput | null = null;
  private ownedJump: OwnedJump | null = null;
  private deferredLatest = false;

  constructor(private readonly lifetime: () => Lifetime) {}

  bind<T extends List>(list: T | null): T | null {
    if (this.list === list) return this.adapter as T | null;
    this.cancelAnchor();
    this.input = null;
    this.ownedJump = null;
    this.deferredLatest = false;
    this.binding += 1;
    this.list = list;
    this.host = null;
    this.logicalHost = null;
    if (!list) {
      this.rows.clear();
      this.adapter = null;
      return null;
    }
    this.adapter = new Proxy(list, {
      get: (target, property) => {
        if (property === "getNativeScrollRef") return () => this.chronologicalHost();
        if (property === "scrollToEnd") return (options?: { animated?: boolean }) => {
          if (this.inputIsCurrent()) {
            this.deferredLatest = true;
            return;
          }
          this.cancelAnchor();
          this.input = null;
          this.deferredLatest = false;
          const current = this.lifetime();
          const host = this.rawHost();
          // Only this adapter's explicit animated latest intent owns a browser animation.
          this.ownedJump = options?.animated === true && current.mounted &&
            current.intent.programmaticFollow && host?.isConnected ? {
              host, list: target, binding: this.binding, owner: current.owner,
              generation: current.generation, intent: current.intent,
            } : null;
          try { return target.scrollToOffset({ offset: 0, animated: options?.animated }); }
          catch (error) { this.ownedJump = null; throw error; }
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return this.adapter as T;
  }
  private adapter: List | null = null;

  rawHost(): HTMLElement | null {
    const host = this.list?.getNativeScrollRef();
    if (!host || typeof (host as HTMLElement).getBoundingClientRect !== "function") return null;
    return host as HTMLElement;
  }

  movement(): { top: number; distance: number } | null {
    const host = this.rawHost();
    // The extent may grow without any user movement. The negative raw offset
    // preserves chronological gesture direction without incorporating it.
    return host ? { top: -host.scrollTop, distance: Math.max(0, host.scrollTop) } : null;
  }

  private chronologicalHost(): HTMLElement | undefined {
    const host = this.rawHost();
    if (!host) return undefined;
    if (this.host !== host) {
      this.host = host;
      this.logicalHost = new Proxy(host, {
        get: (target, property) => {
          if (property === "scrollTop")
            return transcriptLogicalTop(target.scrollHeight, target.clientHeight, target.scrollTop);
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
        set: (target, property, value) => {
          if (property === "scrollTop") {
            if (this.inputIsCurrent()) return true;
            // Older-page height compensation must not displace an exact
            // mounted-message anchor captured during detached reading.
            if (!this.restoreAnchor())
              target.scrollTop = transcriptRawTop(target.scrollHeight, target.clientHeight, Number(value));
            return true;
          }
          return Reflect.set(target, property, value, target);
        },
      });
    }
    if (!this.currentAnchor()) this.captureAnchor();
    return this.logicalHost ?? undefined;
  }

  setRow(id: string, node: unknown): void {
    if (node && typeof (node as HTMLElement).getBoundingClientRect === "function")
      this.rows.set(id, node as HTMLElement);
    else this.rows.delete(id);
  }

  private currentAnchor(): Anchor | null {
    const anchor = this.anchor;
    const current = this.lifetime();
    if (!anchor || !current.mounted || current.generation !== anchor.generation ||
        current.intent !== anchor.intent || shouldAnchorLatest(current.intent) ||
        current.intent.pendingInput || this.binding !== anchor.binding ||
        current.owner !== anchor.owner ||
        this.rawHost() !== anchor.host || !anchor.host.isConnected) return null;
    return anchor;
  }

  captureAnchor(): void {
    const current = this.lifetime();
    if (!current.mounted || shouldAnchorLatest(current.intent) || current.intent.pendingInput) {
      this.cancelAnchor();
      return;
    }
    // Preserve the original ID/offset through successive measurement commits.
    // Only confirmed user movement explicitly selects a new reading anchor.
    if (this.currentAnchor()) return;
    const host = this.rawHost();
    if (!host?.isConnected) return;
    const viewport = host.getBoundingClientRect();
    let chosen: { id: string; top: number; visibleTop: number } | undefined;
    for (const [id, row] of this.rows) {
      if (!row.isConnected) continue;
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom ||
          rect.right <= viewport.left || rect.left >= viewport.right) continue;
      const visibleTop = Math.max(rect.top, viewport.top);
      if (!chosen || visibleTop < chosen.visibleTop)
        chosen = { id, top: rect.top, visibleTop };
    }
    if (chosen) this.anchor = {
      id: chosen.id, offset: chosen.top - viewport.top, host,
      intent: current.intent, generation: current.generation, binding: this.binding,
      owner: current.owner,
    };
  }

  userMoved(): void {
    this.cancelAnchor();
    this.captureAnchor();
  }

  inputStarted(input: DirectionalInput): void {
    const current = this.lifetime();
    const jump = this.currentOwnedJump();
    // Old gesture callbacks cannot acquire or interrupt a later independent jump.
    if (!current.mounted || input.generation !== current.generation ||
        input.owner !== current.owner || input.intent !== current.intent ||
        input.host !== this.rawHost()) return;
    if (this.input !== input) this.deferredLatest = false;
    this.input = input;
    if (input.direction !== "toward-old" || input.outerInput !== true ||
        !jump || input.host !== jump.host) return;
    // currentOwnedJump proved exact host/binding/owner/generation and that the
    // input's pending.follow (or unchanged intent) is this adapter's jump intent.
    this.ownedJump = null; // Consume this marker once, before the synchronous stop.
    this.deferredLatest = true; // No real outer movement must retain the original latest intent.
    jump.list.scrollToOffset({ offset: jump.host.scrollTop, animated: false });
  }

  private currentOwnedJump(): OwnedJump | null {
    const jump = this.ownedJump;
    const current = this.lifetime();
    const follow = current.intent.pendingInput?.follow ?? current.intent;
    if (!jump || !current.mounted || current.generation !== jump.generation ||
        current.owner !== jump.owner || this.binding !== jump.binding ||
        this.list !== jump.list || this.rawHost() !== jump.host || !jump.host.isConnected ||
        follow !== jump.intent || !follow.programmaticFollow) {
      this.ownedJump = null;
      return null;
    }
    return jump;
  }

  inputFinished(input: { intent: MessageFollowState; generation: number; owner?: object }): void {
    if (this.input !== input) return;
    const current = this.inputIsCurrent();
    this.input = null;
    const follow = this.deferredLatest && current && shouldAnchorLatest(this.lifetime().intent);
    this.deferredLatest = false;
    if (follow) {
      this.cancelAnchor();
      this.list?.scrollToOffset({ offset: 0, animated: false });
      return;
    }
    this.contentChanged();
  }

  private inputIsCurrent(): boolean {
    const current = this.lifetime();
    return Boolean(this.input && current.mounted &&
      current.generation === this.input.generation && current.intent === this.input.intent &&
      current.owner === this.input.owner && this.rawHost() === this.input.host);
  }

  restoreAnchor(): boolean {
    if (this.inputIsCurrent()) return false;
    const anchor = this.currentAnchor();
    const row = anchor && this.rows.get(anchor.id);
    if (!anchor || !row?.isConnected) return false;
    const delta = row.getBoundingClientRect().top -
      anchor.host.getBoundingClientRect().top - anchor.offset;
    if (Math.abs(delta) >= 0.5) {
      // Inverted visual rows move down when the physical offset increases.
      anchor.host.scrollTop -= delta;
    }
    return true;
  }

  contentChanged(): void {
    if (this.inputIsCurrent()) return;
    this.restoreAnchor();
    if (this.frame !== null) return;
    const captured = this.currentAnchor();
    if (!captured) return;
    let stable = 0;
    let frames = 0;
    const settle = () => {
      this.frame = null;
      if (this.anchor !== captured || !this.currentAnchor()) return;
      frames += 1;
      const before = captured.host.scrollTop;
      this.restoreAnchor();
      stable = Math.abs(before - captured.host.scrollTop) < 0.5 ? stable + 1 : 0;
      if (stable < 4 && frames < TRANSCRIPT_ANCHOR_SETTLE_MAX_FRAMES)
        this.frame = requestAnimationFrame(settle);
    };
    this.frame = requestAnimationFrame(settle);
  }

  cancelAnchor(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.anchor = null;
  }
}

// React's pre-mutation snapshot preserves the old mounted row geometry. An
// effect after the DOM update would already have lost the original offset.
export class TranscriptAnchorBoundary extends Component<{
  geometry: InvertedTranscriptGeometry;
  children: ReactNode;
}> {
  getSnapshotBeforeUpdate(): null {
    this.props.geometry.captureAnchor();
    return null;
  }
  componentDidUpdate(): void { this.props.geometry.contentChanged(); }
  componentWillUnmount(): void { this.props.geometry.cancelAnchor(); }
  render(): ReactNode { return this.props.children; }
}
