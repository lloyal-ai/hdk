import { describe, it, expect } from "vitest";
import { createBus } from "../src/index";

describe("createBus — replay-to-first-subscriber", () => {
  it("buffers before any subscriber and drains to the first synchronously", () => {
    const bus = createBus<number>();
    bus.send(1);
    bus.send(2);
    const got: number[] = [];
    bus.subscribe((n) => got.push(n));
    expect(got).toEqual([1, 2]); // drained synchronously on first subscribe
    bus.send(3);
    expect(got).toEqual([1, 2, 3]); // live after drain
  });

  it("later subscribers get only live events (no re-drain)", () => {
    const bus = createBus<string>();
    bus.send("a");
    const first: string[] = [];
    bus.subscribe((s) => first.push(s)); // drains ['a']
    const second: string[] = [];
    bus.subscribe((s) => second.push(s));
    bus.send("b");
    expect(first).toEqual(["a", "b"]);
    expect(second).toEqual(["b"]); // never sees 'a'
  });

  it("unsubscribe stops delivery", () => {
    const bus = createBus<number>();
    const got: number[] = [];
    const off = bus.subscribe((n) => got.push(n));
    bus.send(1);
    off();
    bus.send(2);
    expect(got).toEqual([1]);
  });
});
