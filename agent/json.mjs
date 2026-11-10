// JSON parsing that does not lose money.
//
// The contract returns `u128` money fields (min_payout, max_payout, reserved,
// max_total_coverage, payout, premium, ...) as bare JSON numbers. A bare JSON
// number that exceeds Number.MAX_SAFE_INTEGER is silently rounded by
// JSON.parse, so 1000000000000000000000000 (1 NEAR) becomes
// 999999999999999983222784. A rounded bound makes an exact comparison wrong:
// a payout equal to the product's true max is rejected as "outside product
// bounds", which is exactly how the agent was blocked from buying at the top of
// a product's range.
//
// This parser keeps an integer literal as a string whenever it is larger than
// Number.MAX_SAFE_INTEGER, and as a number otherwise, so small integers
// (thresholds, basis points, day counters) stay numbers while money stays
// exact. `BigInt(value)` then reproduces the on-chain integer exactly.
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function parseBigIntJson(text) {
  let i = 0;
  const n = text.length;
  const fail = (m) => {
    throw new Error(`${m} at offset ${i}`);
  };
  const skipWs = () => {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };

  function parseString() {
    i++; // opening quote
    let out = "";
    for (;;) {
      if (i >= n) fail("unterminated string");
      const c = text[i++];
      if (c === '"') return out;
      if (c === "\\") {
        const e = text[i++];
        if (e === "u") {
          out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16));
          i += 4;
        } else if (e === "n") out += "\n";
        else if (e === "t") out += "\t";
        else if (e === "r") out += "\r";
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else out += e;
      } else {
        out += c;
      }
    }
  }

  function parseNumber() {
    const start = i;
    if (text[i] === "-") i++;
    while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    if (text[i] === "." || text[i] === "e" || text[i] === "E") {
      while (i < n && /[0-9eE+\-.]/.test(text[i])) i++;
      return Number(text.slice(start, i));
    }
    const literal = text.slice(start, i);
    const big = BigInt(literal);
    return big > MAX_SAFE || big < -MAX_SAFE ? literal : Number(literal);
  }

  function parseValue() {
    skipWs();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj = {};
      skipWs();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        skipWs();
        if (text[i] !== '"') fail("expected object key");
        const key = parseString();
        skipWs();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        obj[key] = parseValue();
        skipWs();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const arr = [];
      skipWs();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue());
        skipWs();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return parseString();
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    fail("unexpected token");
  }

  const value = parseValue();
  skipWs();
  if (i !== n) fail("trailing content");
  return value;
}
