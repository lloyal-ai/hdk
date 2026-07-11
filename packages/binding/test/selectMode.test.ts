import { describe, it, expect } from "vitest";
import { selectMode } from "../src/node";

describe("selectMode", () => {
  it("RR_BRIDGE forces the bridge transport regardless of TTY/jsonl", () => {
    expect(selectMode({ env: { RR_BRIDGE: "1" }, isTTY: true })).toBe("bridge");
    expect(
      selectMode({ env: { RR_BRIDGE: "1" }, isTTY: false, jsonl: true }),
    ).toBe("bridge");
  });

  it("a TTY without jsonl mounts Ink", () => {
    expect(selectMode({ env: {}, isTTY: true })).toBe("ink");
  });

  it("non-TTY, or jsonl, falls to JSONL", () => {
    expect(selectMode({ env: {}, isTTY: false })).toBe("jsonl");
    expect(selectMode({ env: {}, isTTY: true, jsonl: true })).toBe("jsonl");
  });
});
