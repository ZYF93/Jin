import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeTime(now: number): string {
  let time = Math.floor(now);
  const chars: string[] = [];
  for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
    chars[i] = ENCODING[time % 32];
    time = Math.floor(time / 32);
  }
  return chars.join("");
}

function encodeRandom(): string {
  const bytes = randomBytes(10); // exactly 80 bits = 16 base32 chars
  let value = 0n;
  let bits = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
    bits += 8;
    while (bits >= 5) {
      out += ENCODING[Number((value >> BigInt(bits - 5)) & 31n)];
      bits -= 5;
    }
  }
  return out.slice(0, RANDOM_LEN);
}

/** Generate a canonical 26-character Crockford base32 ULID. */
export function ulid(now = Date.now()): string {
  return `${encodeTime(now)}${encodeRandom()}`;
}

export function isUlid(value: unknown): value is string {
  return typeof value === "string" && ULID_RE.test(value);
}

/** Extract the millisecond timestamp encoded in a ULID. */
export function ulidTime(value: string): number {
  if (!isUlid(value)) throw new Error("Invalid ULID: " + String(value));
  let time = 0n;
  for (const char of value.slice(0, TIME_LEN)) {
    const index = ENCODING.indexOf(char);
    if (index < 0) throw new Error(`Invalid ULID character: ${char}`);
    time = time * 32n + BigInt(index);
  }
  return Number(time);
}
