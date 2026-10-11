import { readFile } from "node:fs/promises";

const APPROVED_PROVIDER_FIELDS = Object.freeze([
  "KUNLUNMETA_BASE_API_KEY",
  "KUNLUNMETA_BASE_URL",
  "KUNLUNMETA_BASE_MODEL",
]);

/** Read only the approved MiniMax environment tuple from the repository dotenv. */
export async function loadApprovedProviderEnvironment(
  dotenvPath,
  processEnvironment = process.env,
) {
  let contents;
  try {
    contents = await readFile(dotenvPath, "utf8");
  } catch {
    throw new Error("UNMET_PREREQUISITE: approved Provider dotenv is unavailable");
  }
  return selectApprovedProviderEnvironment(
    parseApprovedProviderDotenv(contents),
    processEnvironment,
  );
}

/** Parse only the three supported fields; unrelated dotenv values stay opaque. */
export function parseApprovedProviderDotenv(contents) {
  if (typeof contents !== "string") {
    throw new TypeError("approved Provider dotenv contents must be text");
  }
  const allowed = new Set(APPROVED_PROVIDER_FIELDS);
  const values = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!assignment || !allowed.has(assignment[1])) continue;
    const [, name, rawValue] = assignment;
    if (Object.hasOwn(values, name)) {
      throw new Error("duplicate approved Provider environment field");
    }
    values[name] = parseDotenvValue(rawValue);
  }
  return values;
}

/** Process environment follows the CLI's dotenv precedence and cannot be overwritten. */
export function selectApprovedProviderEnvironment(
  dotenvValues,
  processEnvironment = process.env,
) {
  const values = {};
  const sourceRoles = {};
  for (const name of APPROVED_PROVIDER_FIELDS) {
    const processValue = nonEmpty(processEnvironment?.[name]);
    const dotenvValue = nonEmpty(dotenvValues?.[name]);
    if (processValue) {
      values[name] = processValue;
      sourceRoles[name] = "process-environment";
    } else if (dotenvValue) {
      values[name] = dotenvValue;
      sourceRoles[name] = "repo-root-dotenv";
    } else {
      sourceRoles[name] = "missing";
    }
  }
  return { values, sourceRoles };
}

function parseDotenvValue(input) {
  const value = input.trim();
  if (!value) return "";
  const quote = value[0];
  if (quote === "'" || quote === '"') {
    const closeAt = findClosingQuote(value, quote);
    if (closeAt < 0) {
      throw new Error("malformed approved Provider dotenv value");
    }
    const suffix = value.slice(closeAt + 1).trim();
    if (suffix && !suffix.startsWith("#")) {
      throw new Error("malformed approved Provider dotenv value");
    }
    const quoted = value.slice(1, closeAt);
    return quote === '"' ? decodeDoubleQuoted(quoted) : quoted;
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function findClosingQuote(value, quote) {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== quote) continue;
    let backslashes = 0;
    for (let before = index - 1; before > 0 && value[before] === "\\"; before -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return index;
  }
  return -1;
}

function decodeDoubleQuoted(value) {
  return value.replace(/\\([\\"nrt$])/g, (_match, escaped) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return escaped;
    }
  });
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
