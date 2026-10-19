import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import {
  addDays,
  filterSlots,
  hourArg,
  isoDateArg,
  nonNegativeInt,
  nonNegativeNumber,
  skuArg,
  slotView,
  ukParts,
} from "../src/cli.js";
import type { Slot } from "../src/index.js";

describe("cli numeric parsers", () => {
  it("nonNegativeInt accepts valid, rejects junk/negative", () => {
    expect(nonNegativeInt("10")).toBe(10);
    expect(() => nonNegativeInt("abc")).toThrow(InvalidArgumentError);
    expect(() => nonNegativeInt("-1")).toThrow(InvalidArgumentError);
    expect(() => nonNegativeInt("NaN")).toThrow(InvalidArgumentError);
    expect(() => nonNegativeInt("1.5")).toThrow(InvalidArgumentError);
  });
  it("nonNegativeNumber accepts decimals, rejects junk/negative", () => {
    expect(nonNegativeNumber("8.5")).toBe(8.5);
    expect(() => nonNegativeNumber("-2")).toThrow(InvalidArgumentError);
    expect(() => nonNegativeNumber("abc")).toThrow(InvalidArgumentError);
  });
});

describe("cli voice-shopping helpers", () => {
  it("skuArg accepts numeric SKUs and echoes bad input", () => {
    expect(skuArg("322246580")).toBe("322246580");
    expect(() => skuArg("null")).toThrow('got "null"');
    expect(() => skuArg("Tesco milk")).toThrow(InvalidArgumentError);
  });
  it("isoDateArg and hourArg validate", () => {
    expect(isoDateArg("2026-10-27")).toBe("2026-10-27");
    expect(() => isoDateArg("27/10/2026")).toThrow(InvalidArgumentError);
    expect(hourArg("9")).toBe(9);
    expect(() => hourArg("25")).toThrow(InvalidArgumentError);
  });
  it("ukParts converts to UK local time across the BST/GMT change", () => {
    expect(ukParts("2026-10-20T06:00:00Z")).toMatchObject({ date: "2026-10-20", time: "07:00" }); // BST
    expect(ukParts("2026-10-27T07:00:00Z")).toMatchObject({ date: "2026-10-27", time: "07:00" }); // GMT
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });
  it("filterSlots applies a UK-local date and time window", () => {
    const slot = (start: string, end: string, status = "Available") =>
      ({ id: start, start, end, status, charge: 4 }) as unknown as Slot;
    const slots = [
      slot("2026-10-27T06:00:00Z", "2026-10-27T07:00:00Z"),
      slot("2026-10-27T07:00:00Z", "2026-10-27T08:00:00Z"),
      slot("2026-10-27T08:00:00Z", "2026-10-27T09:00:00Z", "Unavailable"),
      slot("2026-10-27T09:00:00Z", "2026-10-27T10:00:00Z"),
      slot("2026-10-27T23:00:00Z", "2026-10-28T00:00:00Z"),
    ];
    const ids = (f: Parameters<typeof filterSlots>[1]) => filterSlots(slots, f).map((s) => s.id);
    expect(ids({ date: "2026-10-27", from: 7, to: 9 })).toEqual([
      "2026-10-27T07:00:00Z",
      "2026-10-27T08:00:00Z",
    ]);
    expect(ids({ from: 7, to: 9, available: true })).toEqual(["2026-10-27T07:00:00Z"]);
    expect(ids({ from: 23, to: 24 })).toEqual(["2026-10-27T23:00:00Z"]);
    expect(slotView(slots[1]!)).toEqual({
      id: "2026-10-27T07:00:00Z",
      date: "2026-10-27",
      day: "Tue",
      start: "07:00",
      end: "08:00",
      charge: 4,
      status: "Available",
    });
  });
});
