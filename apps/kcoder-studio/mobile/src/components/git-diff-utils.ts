export interface GitStatusFile {
  code: string;
  path: string;
  staged: boolean;
  working: boolean;
}

interface DiffSection {
  start: number;
  end: number;
  oldPath: string | null;
  newPath: string | null;
}

function decodeGitQuotedPath(value: string): string {
  if (!(value.startsWith('"') && value.endsWith('"'))) return value;
  const source = value.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character !== "\\") {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint <= 0x7f) bytes.push(codePoint);
      else if (codePoint <= 0x7ff)
        bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
      else if (codePoint <= 0xffff)
        bytes.push(
          0xe0 | (codePoint >> 12),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        );
      else {
        bytes.push(
          0xf0 | (codePoint >> 18),
          0x80 | ((codePoint >> 12) & 0x3f),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        );
        index += 1;
      }
      continue;
    }
    const next = source[++index] ?? "";
    if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(source[index + 1] ?? ""))
        octal += source[++index];
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    const escapes: Record<string, number> = {
      n: 10,
      r: 13,
      t: 9,
      b: 8,
      f: 12,
      v: 11,
      "\\": 92,
      '"': 34,
    };
    bytes.push(escapes[next] ?? next.charCodeAt(0));
  }
  try {
    return decodeURIComponent(
      bytes.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""),
    );
  } catch {
    return bytes.map((byte) => String.fromCharCode(byte)).join("");
  }
}

function pathFromPatchLine(line: string, prefix: "a/" | "b/"): string | null {
  let raw = line.slice(4).replace(/\t.*$/, "");
  if (raw === "/dev/null") return null;
  raw = decodeGitQuotedPath(raw);
  return raw.startsWith(prefix) ? raw.slice(2) : raw;
}

function sections(diff: string): DiffSection[] {
  const starts = [...diff.matchAll(/^diff --git /gm)].flatMap((match) =>
    match.index === undefined ? [] : [match.index],
  );
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? diff.length;
    const block = diff.slice(start, end);
    const oldLine = block.match(/^--- .+$/m)?.[0];
    const newLine = block.match(/^\+\+\+ .+$/m)?.[0];
    return {
      start,
      end,
      oldPath: oldLine ? pathFromPatchLine(oldLine, "a/") : null,
      newPath: newLine ? pathFromPatchLine(newLine, "b/") : null,
    };
  });
}

export function diffForFile(diff: string, path: string | null): string {
  if (!path) return diff;
  const section = sections(diff).find(
    (candidate) => candidate.oldPath === path || candidate.newPath === path,
  );
  return section ? diff.slice(section.start, section.end).trimEnd() : "";
}

export function diffFilePaths(diff: string): string[] {
  return [
    ...new Set(
      sections(diff).flatMap(
        (section) => section.newPath ?? section.oldPath ?? [],
      ),
    ),
  ];
}

export function diffPathExistsAfter(diff: string, path: string): boolean {
  const section = sections(diff).find(
    (candidate) => candidate.oldPath === path || candidate.newPath === path,
  );
  return section?.newPath !== null;
}

export function diffTotals(diff: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

export function parseGitStatus(status: string): GitStatusFile[] {
  const nulDelimited = status.includes("\0");
  const records = nulDelimited ? status.split("\0") : status.split(/\r?\n/);
  const files: GitStatusFile[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const line = records[index] ?? "";
    if (line.length < 4) continue;
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    let path = line.slice(3);
    // porcelain -z follows rename/copy with the original path; the first path is the new path clients should operate on.
    if (nulDelimited && (x === "R" || x === "C" || y === "R" || y === "C"))
      index += 1;
    else if (!nulDelimited && path.includes(" -> "))
      path = path.split(" -> ").at(-1) ?? path;
    files.push({
      code: `${x}${y}`,
      path,
      staged: x !== " " && x !== "?",
      working: y !== " " || x === "?",
    });
  }
  return files;
}
