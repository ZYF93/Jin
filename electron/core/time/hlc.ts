/**
 * A small hybrid logical clock.
 *
 * Wall time gives rough ordering; the counter preserves monotonicity within a
 * process; the actor id is the deterministic tie-breaker. The serialized form
 * is `0000019a2b3c4d:0001:user:joshua`.
 */
export interface Hlc {
  wall: number;
  counter: number;
  actor: string;
}

const MAX_COUNTER = 0xffff;

function normalize(wall: number, counter: number, actor: string): Hlc {
  if (counter > MAX_COUNTER) {
    return { wall: wall + 1, counter: 0, actor };
  }
  return { wall, counter, actor };
}

export function formatHlc(hlc: Hlc): string {
  return `${hlc.wall.toString(16).padStart(12, "0")}:${hlc.counter
    .toString(16)
    .padStart(4, "0")}:${hlc.actor}`;
}

export function parseHlc(value: string): Hlc {
  const first = value.indexOf(":");
  const second = value.indexOf(":", first + 1);
  if (first !== 12 || second < 0) {
    throw new Error(`Invalid HLC: ${value}`);
  }
  const wall = Number.parseInt(value.slice(0, first), 16);
  const counter = Number.parseInt(value.slice(first + 1, second), 16);
  const actor = value.slice(second + 1);
  if (!Number.isSafeInteger(wall) || !Number.isSafeInteger(counter) || !actor) {
    throw new Error(`Invalid HLC: ${value}`);
  }
  return { wall, counter, actor };
}

export function compareHlc(a: string, b: string): number {
  const left = parseHlc(a);
  const right = parseHlc(b);
  if (left.wall !== right.wall) return left.wall < right.wall ? -1 : 1;
  if (left.counter !== right.counter) return left.counter < right.counter ? -1 : 1;
  if (left.actor === right.actor) return 0;
  return left.actor < right.actor ? -1 : 1;
}

export class HlcClock {
  private last: Hlc;

  constructor(
    private readonly actorId: string,
    initial?: Hlc,
  ) {
    this.last = initial ?? { wall: 0, counter: 0, actor: actorId };
  }

  now(now = Date.now()): Hlc {
    if (now > this.last.wall) {
      this.last = normalize(now, 0, this.actorId);
    } else {
      this.last = normalize(this.last.wall, this.last.counter + 1, this.actorId);
    }
    return { ...this.last };
  }

  /** Merge a remote clock into ours, then produce a new local tick. */
  receive(remote: Hlc, now = Date.now()): Hlc {
    const wall = Math.max(now, this.last.wall, remote.wall);
    let counter = 0;
    if (wall === this.last.wall) counter = this.last.counter;
    if (wall === remote.wall) counter = Math.max(counter, remote.counter);
    this.last = normalize(wall, counter + 1, this.actorId);
    return { ...this.last };
  }

  peek(): Hlc {
    return { ...this.last };
  }
}
