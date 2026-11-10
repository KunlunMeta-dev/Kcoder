/** Parses bounded peer JSON while rejecting duplicate names at every depth. */
export function parseMobilePeerJson(raw) {
  let index = 0;
  const skipSpace = () => { while (index < raw.length && /\s/.test(raw[index])) index += 1; };
  const parseString = () => {
    const start = index;
    if (raw[index] !== '"') throw new TypeError('Invalid JSON string');
    index += 1;
    while (index < raw.length) {
      if (raw[index] === '"') { index += 1; return JSON.parse(raw.slice(start, index)); }
      if (raw[index] === '\\') index += 1;
      index += 1;
    }
    throw new TypeError('Unterminated JSON string');
  };
  const parseValue = depth => {
    if (depth > 32) throw new TypeError('Peer JSON nesting limit exceeded');
    skipSpace();
    if (raw[index] === '{') {
      index += 1; skipSpace();
      const result = Object.create(null); const keys = new Set();
      if (raw[index] === '}') { index += 1; return result; }
      while (index < raw.length) {
        skipSpace(); const key = parseString();
        if (keys.has(key)) throw new TypeError('Duplicate peer JSON property');
        keys.add(key); skipSpace();
        if (raw[index++] !== ':') throw new TypeError('Invalid peer JSON object');
        result[key] = parseValue(depth + 1); skipSpace();
        if (raw[index] === '}') { index += 1; return result; }
        if (raw[index++] !== ',') throw new TypeError('Invalid peer JSON object');
      }
      throw new TypeError('Unterminated peer JSON object');
    }
    if (raw[index] === '[') {
      index += 1; skipSpace(); const result = [];
      if (raw[index] === ']') { index += 1; return result; }
      while (index < raw.length) {
        result.push(parseValue(depth + 1)); skipSpace();
        if (raw[index] === ']') { index += 1; return result; }
        if (raw[index++] !== ',') throw new TypeError('Invalid peer JSON array');
      }
      throw new TypeError('Unterminated peer JSON array');
    }
    if (raw[index] === '"') return parseString();
    const start = index;
    while (index < raw.length && !/[\s,}\]]/.test(raw[index])) index += 1;
    if (start === index) throw new TypeError('Invalid peer JSON value');
    return JSON.parse(raw.slice(start, index));
  };
  if (typeof raw !== 'string') throw new TypeError('Invalid peer JSON input');
  const result = parseValue(0); skipSpace();
  if (index !== raw.length) throw new TypeError('Trailing peer JSON data');
  return result;
}
