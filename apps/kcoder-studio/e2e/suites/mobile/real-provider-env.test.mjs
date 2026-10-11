import assert from "node:assert/strict";
import test from "node:test";
import {
  parseApprovedProviderDotenv,
  selectApprovedProviderEnvironment,
} from "./real-provider-env.mjs";

test("parses only the approved MiniMax environment fields", () => {
  const values = parseApprovedProviderDotenv(`
UNRELATED_TOKEN=do-not-return
export KUNLUNMETA_BASE_API_KEY='test-api-key-value'
KUNLUNMETA_BASE_URL="http://model.example:8080/v1" # route metadata
KUNLUNMETA_BASE_MODEL=MiniMax-M3
`);

  assert.deepEqual(values, {
    KUNLUNMETA_BASE_API_KEY: "test-api-key-value",
    KUNLUNMETA_BASE_URL: "http://model.example:8080/v1",
    KUNLUNMETA_BASE_MODEL: "MiniMax-M3",
  });
  assert.equal(Object.hasOwn(values, "UNRELATED_TOKEN"), false);
});

test("uses an existing process override ahead of the approved dotenv value", () => {
  const selection = selectApprovedProviderEnvironment(
    {
      KUNLUNMETA_BASE_API_KEY: "dotenv-api-key-value",
      KUNLUNMETA_BASE_URL: "http://dotenv.example/v1",
      KUNLUNMETA_BASE_MODEL: "MiniMax-M3",
    },
    {
      KUNLUNMETA_BASE_URL: "http://process.example/v1",
    },
  );

  assert.equal(
    selection.values.KUNLUNMETA_BASE_URL,
    "http://process.example/v1",
  );
  assert.equal(selection.sourceRoles.KUNLUNMETA_BASE_URL, "process-environment");
  assert.equal(selection.sourceRoles.KUNLUNMETA_BASE_MODEL, "repo-root-dotenv");
});

test("rejects duplicate assignments for approved fields", () => {
  assert.throws(
    () =>
      parseApprovedProviderDotenv(
        "KUNLUNMETA_BASE_MODEL=MiniMax-M3\nKUNLUNMETA_BASE_MODEL=other\n",
      ),
    /duplicate approved Provider environment field/,
  );
});

test("rejects malformed quoted values without including their contents", () => {
  assert.throws(
    () =>
      parseApprovedProviderDotenv(
        'KUNLUNMETA_BASE_URL="http://secret.example/path\n',
      ),
    /malformed approved Provider dotenv value/,
  );
});
