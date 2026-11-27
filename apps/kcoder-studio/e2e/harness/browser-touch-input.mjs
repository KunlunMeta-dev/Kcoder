/**
 * Dispatch a trusted Chromium touch drag through the page's owned CDP session.
 * Defaults are force 0.8, 12 moves, and one browser animation frame per move;
 * callers may override those options, or pass force:null to omit force. Each
 * frame wait is bounded so a hidden page cannot stall the gesture indefinitely.
 */
let animationFrameWaitSequence = 0;

async function waitForBrowserAnimationFrame(page, timeoutMs) {
  const waiterId = `${Date.now()}-${++animationFrameWaitSequence}`;
  const waiterKey = "__kcoderE2ePendingAnimationFrameWaits";
  let hostTimeout;
  let hostTimedOut = false;

  const frameWait = page.evaluate(({ waiterId: id, waiterKey: key, timeoutMs: limit }) => new Promise((resolve, reject) => {
    let registry = window[key];
    if (!(registry instanceof Map)) {
      registry = new Map();
      window[key] = registry;
    }

    let frameHandle;
    let browserTimer;
    let settled = false;
    const cleanup = () => {
      if (frameHandle !== undefined) cancelAnimationFrame(frameHandle);
      if (browserTimer !== undefined) clearTimeout(browserTimer);
      registry.delete(id);
      if (registry.size === 0) delete window[key];
    };
    const cancel = message => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    registry.set(id, cancel);
    browserTimer = window.setTimeout(() => cancel(`Timed out waiting ${limit}ms for a browser animation frame`), limit);
    frameHandle = requestAnimationFrame(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    });
  }), { waiterId, waiterKey, timeoutMs });

  try {
    await Promise.race([
      frameWait,
      new Promise((_, reject) => {
        hostTimeout = setTimeout(() => {
          hostTimedOut = true;
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for a browser animation frame`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (hostTimedOut) {
      let cleanupTimeout;
      try {
        await Promise.race([
          page.evaluate(({ waiterId: id, waiterKey: key }) => {
            const cancel = window[key]?.get(id);
            if (typeof cancel === "function") cancel("Host animation-frame wait timed out");
            return true;
          }, { waiterId, waiterKey }),
          new Promise((_, reject) => {
            cleanupTimeout = setTimeout(() => reject(new Error("Timed out cancelling the pending browser animation frame")), 250);
          }),
        ]);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Animation-frame wait and cancellation failed", { cause: error });
      } finally {
        clearTimeout(cleanupTimeout);
      }
    }
    throw error;
  } finally {
    clearTimeout(hostTimeout);
  }
}

export async function dispatchTrustedTouchDrag(page, gesture, signal) {
  const {
    start,
    end,
    moves = 12,
    force = 0.8,
    waitForAnimationFrame = true,
    animationFrameTimeoutMs = 1000,
    moveDelayMs = 16,
    id = 73,
  } = gesture ?? {};
  if (![start?.x, start?.y, end?.x, end?.y].every(Number.isFinite) ||
      !Number.isInteger(moves) || moves < 1 || moves > 32 ||
      (force !== null && (!Number.isFinite(force) || force < 0 || force > 1)) ||
      typeof waitForAnimationFrame !== "boolean" ||
      !Number.isInteger(animationFrameTimeoutMs) || animationFrameTimeoutMs < 100 || animationFrameTimeoutMs > 5000 ||
      !Number.isInteger(moveDelayMs) || moveDelayMs < 0 || moveDelayMs > 250 ||
      !Number.isInteger(id) || id < 0) {
    throw new TypeError("touch drag requires finite endpoints, 1..32 moves, force 0..1 or null, a pacing option, and a nonnegative integer id");
  }

  const cdp = await page.context().newCDPSession(page);
  let primaryError = null;
  let ended = false;
  try {
    if (signal?.aborted) throw signal.reason || new Error("Touch drag aborted before touchstart");
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: start.x, y: start.y, id, ...(force === null ? {} : { force }) }],
    });
    for (let index = 1; index <= moves; index += 1) {
      if (signal?.aborted) throw signal.reason || new Error("Touch drag aborted during touchmove");
      const progress = index / moves;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{
          x: start.x + (end.x - start.x) * progress,
          y: start.y + (end.y - start.y) * progress,
          id,
          ...(force === null ? {} : { force }),
        }],
      });
      if (waitForAnimationFrame) {
        await waitForBrowserAnimationFrame(page, animationFrameTimeoutMs);
      } else if (moveDelayMs > 0) {
        await page.waitForTimeout(moveDelayMs);
      }
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    ended = true;
  } catch (error) {
    primaryError = error;
  } finally {
    if (!ended) {
      try {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } catch (cleanupError) {
        primaryError = primaryError
          ? new AggregateError([primaryError, cleanupError], "touch drag and touchend cleanup failed", { cause: primaryError })
          : cleanupError;
      }
    }
    try {
      await cdp.detach();
    } catch (cleanupError) {
      primaryError = primaryError
        ? new AggregateError([primaryError, cleanupError], "touch drag and CDP detach failed", { cause: primaryError })
        : cleanupError;
    }
  }
  if (primaryError) throw primaryError;
  return {
    status: "dispatched",
    dispatchedMoves: moves,
    force,
    waitForAnimationFrame,
    animationFrameTimeoutMs: waitForAnimationFrame ? animationFrameTimeoutMs : null,
    moveDelayMs: waitForAnimationFrame ? null : moveDelayMs,
  };
}
