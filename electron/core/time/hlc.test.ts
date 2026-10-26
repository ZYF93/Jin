import { describe, expect, it } from "vite-plus/test";
import { HlcClock, compareHlc, formatHlc, parseHlc } from "./hlc";

describe("hybrid logical clock", () => {
  it("increments the counter within the same wall millisecond", () => {
    const clock = new HlcClock("alice");
    const first = clock.now(1000);
    const second = clock.now(1000);
    const third = clock.now(1100);
    expect(first.counter).toBe(0);
    expect(second.counter).toBe(1);
    expect(third.counter).toBe(0);
    expect(third.wall).toBe(1100);
  });

  it("round-trips and compares formatted clocks", () => {
    const clock = new HlcClock("alice");
    const value = clock.now(1234);
    const formatted = formatHlc(value);
    expect(parseHlc(formatted)).toEqual(value);
    expect(compareHlc(formatted, formatHlc(clock.now(1234)))).toBe(-1);
  });

  it("merges remote clocks", () => {
    const clock = new HlcClock("alice");
    clock.now(1000);
    const merged = clock.receive(
      { wall: 2000, counter: 3, actor: "bob" },
      1500,
    );
    expect(merged.wall).toBe(2000);
    expect(merged.counter).toBe(4);
    expect(merged.actor).toBe("alice");
  });
});
