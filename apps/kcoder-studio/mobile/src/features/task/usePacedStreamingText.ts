import { useEffect, useRef, useState } from "react";
import { mustShowFullText, pacedTextStep, TEXT_PACING } from "./streaming-text-pacing";

type Display = { owner: object | undefined; messageId: string; fragmentId: string; shown: string;
  target: string; since: number | null; nextAt: number; timer: ReturnType<typeof setTimeout> | null };
const now = () => typeof performance !== "undefined" ? performance.now() : Date.now();

/** Received text remains authoritative. Only this mounted view's live tail is paced. */
export function usePacedStreamingText(text: string, live: boolean, owner: object | undefined, messageId: string, fragmentId: string): string {
  const current = useRef<Display | null>(null);
  const [, redraw] = useState(0);
  if (!current.current || current.current.owner !== owner || current.current.messageId !== messageId || current.current.fragmentId !== fragmentId) {
    const sameMessage = current.current?.owner === owner && current.current?.messageId === messageId;
    current.current = { owner, messageId, fragmentId, shown: sameMessage && live ? "" : text,
      target: text, since: null, nextAt: 0, timer: null };
  }
  const display = current.current;
  const age = display.since === null ? 0 : Math.max(0, now() - display.since);
  const immediate = mustShowFullText(text, display.shown, live, age);

  useEffect(() => {
    display.target = text;
    let cancelled = false;
    const owns = () => !cancelled && current.current === display;
    const sync = (value: string) => {
      display.shown = value;
      if (value === display.target) display.since = null;
    };
    if (immediate) { sync(text); return; }
    const started = now();
    if (display.since === null) { display.since = started; display.nextAt = started + TEXT_PACING.tickMs; }
    const schedule = () => {
      const deadline = Math.min(display.nextAt, display.since! + TEXT_PACING.maxLagMs);
      display.timer = setTimeout(advance, Math.max(0, deadline - now()));
    };
    const advance = () => {
      display.timer = null;
      if (!owns()) return;
      const time = now();
      sync(mustShowFullText(display.target, display.shown, live, Math.max(0, time - display.since!))
        ? display.target : pacedTextStep(display.target, display.shown));
      redraw(value => value + 1);
      if (display.since !== null) { display.nextAt = time + TEXT_PACING.tickMs; schedule(); }
    };
    schedule();
    return () => { cancelled = true; if (display.timer !== null) clearTimeout(display.timer); display.timer = null; };
  }, [display, text, live, immediate]);

  return immediate ? text : display.shown;
}
