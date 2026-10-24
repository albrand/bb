import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addWritingUsage,
  getWritingUsage,
  openWritingReservation,
  reserveWritingUsage,
  type DbConnection,
} from "../../src/index.js";
import { createMigratedConnection } from "../../src/testing.js";

function storedUsageKeys(db: DbConnection): string[] {
  return db.$client
    .prepare(
      "SELECT key FROM app_settings_values WHERE key LIKE 'writingAssistanceUsage%' ORDER BY key",
    )
    .all()
    .map((row) => (row as { key: string }).key);
}

describe("writing assistance usage", () => {
  let db: DbConnection;

  beforeEach(() => {
    db = createMigratedConnection();
  });

  afterEach(() => {
    db.$client.close();
  });

  it("keeps the next day's totals when a request reserved before midnight finishes after it", () => {
    reserveWritingUsage(db, "2026-10-17", { corrections: 1 }, () => true);
    reserveWritingUsage(db, "2026-10-18", { corrections: 5 }, () => true);
    addWritingUsage(db, "2026-10-17", { corrections: -1 });
    addWritingUsage(db, "2026-10-17", { inputChars: 40, outputChars: 12 });
    expect(getWritingUsage(db, "2026-10-18")).toMatchObject({
      day: "2026-10-18",
      corrections: 5,
      inputChars: 0,
    });
    expect(
      reserveWritingUsage(
        db,
        "2026-10-18",
        { corrections: 1 },
        (current) => current.corrections < 5,
      ),
    ).toBeNull();
    expect(getWritingUsage(db, "2026-10-18").corrections).toBe(5);
    expect(getWritingUsage(db, "2026-10-17")).toMatchObject({
      corrections: 0,
      inputChars: 40,
    });
  });

  it("ignores a duplicate refund across midnight without resetting either day's other totals", () => {
    reserveWritingUsage(db, "2026-10-17", { corrections: 1 }, () => true);
    addWritingUsage(db, "2026-10-17", { formattings: 2, inputChars: 40 });
    reserveWritingUsage(db, "2026-10-18", { corrections: 4 }, () => true);
    addWritingUsage(db, "2026-10-18", { audioSeconds: 6.5 });
    addWritingUsage(db, "2026-10-17", { corrections: -1 });
    expect(addWritingUsage(db, "2026-10-17", { corrections: -1 })).toMatchObject({
      corrections: 0,
      formattings: 2,
    });
    expect(getWritingUsage(db, "2026-10-17")).toMatchObject({
      corrections: 0,
      formattings: 2,
      inputChars: 40,
    });
    expect(getWritingUsage(db, "2026-10-18")).toMatchObject({
      corrections: 4,
      audioSeconds: 6.5,
    });
  });

  it("settles each reservation once, so a repeated late refund cannot take another request's reservation", () => {
    const first = openWritingReservation(db, "2026-10-17", { corrections: 1 }, () => true);
    const second = openWritingReservation(db, "2026-10-17", { corrections: 1 }, () => true);
    expect(first?.usage.corrections).toBe(1);
    expect(second?.usage.corrections).toBe(2);
    addWritingUsage(db, "2026-10-18", { corrections: 3, audioSeconds: 6.5 });
    expect(first?.settle({ corrections: -1 })).toMatchObject({ corrections: 1 });
    expect(first?.settle({ corrections: -1 })).toBeNull();
    expect(
      second?.settle({ corrections: 0, inputChars: 120, outputChars: 30 }),
    ).toMatchObject({ corrections: 1, inputChars: 120, outputChars: 30 });
    expect(first?.settle({ corrections: -1 })).toBeNull();
    expect(second?.settle({ corrections: -1 })).toBeNull();
    expect(getWritingUsage(db, "2026-10-17")).toMatchObject({
      corrections: 1,
      inputChars: 120,
      outputChars: 30,
    });
    expect(getWritingUsage(db, "2026-10-18")).toMatchObject({
      corrections: 3,
      audioSeconds: 6.5,
    });
  });

  it("does not open a reservation the limit refuses, and changes nothing", () => {
    addWritingUsage(db, "2026-10-17", { corrections: 2 });
    expect(
      openWritingReservation(db, "2026-10-17", { corrections: 1 }, (usage) => usage.corrections < 2),
    ).toBeNull();
    expect(getWritingUsage(db, "2026-10-17").corrections).toBe(2);
  });

  it("does not recreate a pruned day when a late refund arrives for it", () => {
    for (const day of ["2026-10-15", "2026-10-16", "2026-10-17"]) {
      addWritingUsage(db, day, { corrections: 1 });
    }
    addWritingUsage(db, "2026-10-15", { corrections: -1 });
    expect(storedUsageKeys(db)).toEqual([
      "writingAssistanceUsage:2026-10-16",
      "writingAssistanceUsage:2026-10-17",
    ]);
  });

  it("keeps the previous day and drops older days when usage is recorded", () => {
    for (const day of ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]) {
      addWritingUsage(db, day, { corrections: 1 });
    }
    expect(storedUsageKeys(db)).toEqual([
      "writingAssistanceUsage:2026-10-16",
      "writingAssistanceUsage:2026-10-17",
    ]);
  });
});
