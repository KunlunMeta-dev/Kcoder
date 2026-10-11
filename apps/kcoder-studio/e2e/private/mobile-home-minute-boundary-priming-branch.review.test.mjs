import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const directory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(directory, "../../../..");
const livePath = resolve(directory, "mobile-home-minute-boundary-auth-cleanup.once.e2e.mjs");
const candidatePath = resolve(directory, "mobile-home-minute-boundary-priming-r1.candidate.e2e.mjs");
const baselinePath = resolve(repositoryRoot, "target/private-phone-ux-validation/home-minute-boundary-auth-cleanup-20261009/priming-static-r1/baseline-source.mjs");
const baselineSha256 = "9c81d89b97664d62c08cfa3a7e4455445066ea84f456ab855fa7017af23c4977";

const oldBranchPrime = [
  '                if (refreshHomeMinuteBoundaryDiagnosticMode && group.view === "home") {',
  "                  sampleResult.minuteBoundaryFixturePriming = {",
  "                    stage,",
  "                    reloadAfterPair: true,",
  '                    purpose: "make the exact Home sample stage own the timestamped thread/list baseline",',
  "                  };",
  '                  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });',
  '                  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 60_000 });',
  '                  await page.getByTestId(`toggle-server-${SERVER_ID}`).waitFor({ state: "visible", timeout: 10_000 });',
  '                  await page.getByTestId(`thread-${THREAD_ID}`).waitFor({ state: "visible", timeout: 10_000 });',
  "                  await waitForGatewayRpcQuiescence(network, 15_000, 100);",
  "                }",
].join("\n") + "\n";
const joinedSetupAnchor = [
  "            }",
  "",
  '            if (group.kind === "background") {',
  "              let initialMessageText = null;",
].join("\n");
const commonPrime = [
  "            }",
  "",
  "            // Prime after either pairing/setup branch has joined so the fixture response uses the sample stage.",
  '            if (refreshHomeMinuteBoundaryDiagnosticMode && group.kind === "background" && group.view === "home") {',
  "              sampleResult.minuteBoundaryFixturePriming = {",
  "                stage,",
  "                reloadAfterPair: true,",
  '                purpose: "make the exact Home sample stage own the timestamped thread/list baseline",',
  "              };",
  '              await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });',
  '              await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 60_000 });',
  '              await page.getByTestId(`toggle-server-${SERVER_ID}`).waitFor({ state: "visible", timeout: 10_000 });',
  '              await page.getByTestId(`thread-${THREAD_ID}`).waitFor({ state: "visible", timeout: 10_000 });',
  "              await waitForGatewayRpcQuiescence(network, 15_000, 100);",
  "            }",
  "",
  '            if (group.kind === "background") {',
  "              let initialMessageText = null;",
].join("\n");

test("Home minute-boundary fixture priming runs after setup branch join and before exact-stage capture", async () => {
  const [baseline, live, candidate] = await Promise.all([
    readFile(baselinePath, "utf8"),
    readFile(livePath, "utf8"),
    readFile(candidatePath, "utf8"),
  ]);
  assert.equal(createHash("sha256").update(baseline).digest("hex"), baselineSha256, "the review must use the preserved exact pre-apply source bytes");
  assert.equal(baseline.split(oldBranchPrime).length - 1, 1, "baseline must contain one old Home priming block to move");
  assert.equal(baseline.split(joinedSetupAnchor).length - 1, 1, "baseline must have one setup-branch join before background Home capture");
  const expectedCandidate = baseline.replace(oldBranchPrime, "").replace(joinedSetupAnchor, commonPrime);
  assert.equal(candidate, expectedCandidate, "candidate must contain only the Home diagnostic priming move");
  assert.equal(live, candidate, "the private diagnostic entry must be byte-identical to the reviewed candidate after apply");

  const backgroundSetup = candidate.indexOf('if (group.kind === "background" && !refreshSharedBackgroundDiagnosticMode) {');
  const setupElse = candidate.indexOf(["} else {", "              page = await newMobilePage("].join("\n"), backgroundSetup);
  const joinMarker = candidate.indexOf([
    "            }",
    "",
    "            // Prime after either pairing/setup branch has joined so the fixture response uses the sample stage.",
    '            if (refreshHomeMinuteBoundaryDiagnosticMode && group.kind === "background" && group.view === "home") {',
  ].join("\n"), setupElse);
  const primeGuard = candidate.indexOf('if (refreshHomeMinuteBoundaryDiagnosticMode && group.kind === "background" && group.view === "home") {');
  const backgroundWork = candidate.indexOf([
    'if (group.kind === "background") {',
    "              let initialMessageText = null;",
  ].join("\n"), backgroundSetup);
  const capture = candidate.indexOf('const initialHomeThreadPresentation = await captureHomeThreadPresentation(page, network, stage, expectedWorkspace);', backgroundWork);
  assert.ok(backgroundSetup >= 0 && setupElse > backgroundSetup && joinMarker > setupElse, "Home fixture priming must follow the full fresh-context/existing setup if/else");
  assert.ok(backgroundWork > primeGuard && capture > backgroundWork, "Home fixture priming must precede the shared background capture path");
  assert.equal(candidate.split("minuteBoundaryFixturePriming").length - 1, 1, "the Home-only prime must run exactly once");
  assert.match(candidate.slice(primeGuard, backgroundWork), /await page\.reload\(\{ waitUntil: "domcontentloaded", timeout: 60_000 \}\)/);
  assert.match(candidate.slice(primeGuard, backgroundWork), /await waitForGatewayRpcQuiescence\(network, 15_000, 100\)/);
  assert.match(candidate, /&& \(!refreshHomeMinuteBoundaryDiagnosticMode \|\| item\.stage === stage\)/, "exact sample-stage snapshot selection must remain intact");
  assert.match(candidate, /assert\.ok\(fixture, "the mock Gateway thread\/list response for the fixture Home row must be captured"\)/, "exact-stage fixture capture failure must remain a hard gate");
});
