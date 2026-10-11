/**
 * Protocol adaptation boundary for gateway runtime targets.
 *
 * The product currently registers only KCoder app-server. The factory and base class
 * keep transport independent of a concrete protocol. Any future runtime should add
 * and explicitly register an adapter in its own module rather than scatter branches through the gateway.
 */
export class RuntimeTargetAdapter {
  constructor(runtime, { rawPassthrough = false } = {}) {
    if (typeof runtime !== "string" || runtime.length === 0) {
      throw new Error("runtime target adapter requires a runtime id");
    }
    this.runtime = runtime;
    this.rawPassthrough = rawPassthrough;
  }

  toUpstream(_message) {
    throw new Error(
      `runtime target adapter ${this.runtime} does not implement toUpstream`,
    );
  }

  fromUpstream(_message) {
    throw new Error(
      `runtime target adapter ${this.runtime} does not implement fromUpstream`,
    );
  }
}

export class PassthroughRuntimeTargetAdapter extends RuntimeTargetAdapter {
  constructor(runtime) {
    super(runtime, { rawPassthrough: true });
  }

  toUpstream(message) {
    return { upstream: [message], client: [] };
  }

  fromUpstream(message) {
    return { upstream: [], client: [message] };
  }
}

const adapterFactories = new Map([
  ["kcoder", () => new PassthroughRuntimeTargetAdapter("kcoder")],
]);

export function createRuntimeTargetAdapter(runtime) {
  const factory = adapterFactories.get(runtime);
  if (!factory)
    throw new Error(`unsupported runtime target adapter: ${runtime}`);
  return factory();
}
