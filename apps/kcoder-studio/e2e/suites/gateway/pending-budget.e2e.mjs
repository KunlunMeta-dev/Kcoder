import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { WorkspaceAppServerBroker } from "../../../src/workspace-app-server-broker.js";
import { appRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

// QA: no-model real subprocess hangs/retries; metadata counts, isolation, late
// resource disk cleanup, stdin backpressure, then exact owned process teardown.
await runE2E(
  import.meta.url,
  {
    testId: "gateway-unanswered-budget-late-cleanup",
    tier: "full-integration",
    modelPolicy:
      "model-independent hanging stdio backend and resource lifecycle, zero model calls",
    retainSuccessEvidence: true,
    evidenceReason:
      "Actual admission, unknown receipts and filesystem compensation",
  },
  async (context) => {
    const fixture = resolve(appRoot, "e2e/fixtures/pending-budget/backend.mjs");
    const resource = context.pathInState("late.txt");
    const start = (label, budget, extra = []) => {
      const child = context.spawnOwned(
        label,
        process.execPath,
        [fixture, resource, ...extra],
        { stdin: "pipe" },
      );
      const broker = new WorkspaceAppServerBroker({
        child,
        adapter: {
          rawPassthrough: true,
          fromUpstream: (m) => ({ upstream: [], client: [m] }),
        },
        serverId: "owned",
        residentThreads: true,
        maxMessageBytes: 128 * 1024,
        pendingBudget: budget,
      });
      const owner = () => {
        const client = {
          channel: "runtime",
          messages: [],
          paused: 0,
          resumed: 0,
          send(message) {
            this.messages.push(message);
            return true;
          },
          pause() {
            this.paused++;
          },
          resume() {
            this.resumed++;
          },
          close() {},
        };
        broker.attach(client);
        context.addCleanup(`${label} owner`, () => {
          if (broker.clients.has(client)) broker.detach(client);
        });
        return client;
      };
      return {
        broker,
        owner,
        request(client, id, method, params) {
          broker.receive(
            client,
            JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          );
        },
      };
    };
    const f = start("hanging-backend", {
      total: 8,
      perOwner: 3,
      bytes: 256 * 1024,
      ownerBytes: 96 * 1024,
      ttlMs: 300,
    });
    const a = f.owner(),
      b = f.owner();
    f.request(a, 1, "attachment/save", {
      filename: "late.txt",
      bytes: "x".repeat(32000),
    });
    f.request(a, 2, "server/info", { data: "x".repeat(32000) });
    f.request(a, 3, "server/info", { data: "x".repeat(32000) });
    for (let id = 4; id < 104; id++) f.request(a, id, "server/info", {});
    assert.equal(f.broker.requestLoad.total.inFlight, 3);
    assert.equal(a.messages.filter((m) => m.error).length, 100);
    await waitFor(
      () => f.broker.pendingLoad.expired === 3,
      5000,
      "metadata compacted into unknown receipts",
    );
    assert.ok(f.broker.pendingLoad.retainedBytes < 512, 'only compact correlation metadata remains');
    assert.equal(f.broker.requestLoad.total.inFlight, 3);
    assert.equal(f.broker.hasPendingWork, true);
    f.request(a, 105, "server/info", {});
    assert.match(a.messages.at(-1).error.message, /capacity/);
    f.request(b, 201, "server/info", { control: "healthy" });
    await waitFor(
      () => b.messages.find((m) => m.id === 201),
      5000,
      "other owner healthy",
    );
    assert.equal(f.broker.requestLoad.total.inFlight, 3);
    f.broker.detach(a);
    assert.equal(f.broker.requestLoad.total.inFlight, 3);
    f.request(b, 202, "server/info", { control: "release" });
    await waitFor(
      () => b.messages.find((m) => m.id === 202),
      5000,
      "late answers returned",
    );
    await waitFor(
      async () =>
        !(await access(resource).then(
          () => true,
          () => false,
        )),
      5000,
      "late resource removed",
    );
    assert.equal(f.broker.requestLoad.total.inFlight, 0);
    assert.equal(f.broker.resourceOwners.size, 0);

    const pressure = start(
      "backpressured-backend",
      {
        total: 16,
        perOwner: 12,
        ownerBytes: 1024 * 1024,
        bytes: 2 * 1024 * 1024,
        ttlMs: 5000,
      },
      ["pause"],
    );
    const client = pressure.owner();
    let rejectedWrites = 0;
    for (let id = 1; id <= 12; id++) {
      try {
        pressure.request(client, id, "server/info", {
          data: "x".repeat(64000),
        });
      } catch (error) {
        assert.match(error.message, /queue is full/);
        rejectedWrites++;
      }
    }
    assert.ok(client.paused > 0, "real stdin high-water triggers owner pause");
    assert.ok(rejectedWrites > 0, "queue overflow rolls back unforwarded work");
    await waitFor(
      () => client.resumed > 0,
      5000,
      "real stdin drain resumes owners",
    );
    assert.equal(
      pressure.broker.pending.size,
      pressure.broker.requestLoad.total.inFlight,
    );
    pressure.request(client, 100, "server/info", { control: "release" });
    await waitFor(
      () => pressure.broker.requestLoad.total.inFlight === 0,
      5000,
      "all real queued work settles",
    );
    await context.writeArtifactJson("budget-result.json", {
      peakAccepted: 3,
      expiredUnanswered: 3,
      retainedPayloadBytes: f.broker.pendingLoad.retainedBytes,
      lateDiskResourceRemoved: true,
      otherOwnerHealthy: true,
      actualStdinPauses: client.paused,
      actualStdinResumes: client.resumed,
      rejectedWrites,
      modelCalls: 0,
    });
  },
);
