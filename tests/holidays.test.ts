import { describe, expect, it } from "vitest";

import {
  easterSunday,
  holidaysBetween,
  holidaysIn,
  holidaysOn,
  showsUsHolidays,
} from "@/lib/holidays";

/**
 * Worked out from the date, so these pin the rules against dates anybody can
 * look up: the moving Mondays and Thursdays, Easter, and the weekday a
 * weekend federal holiday is observed on.
 */

const names = (date: string) => holidaysOn(date).map((holiday) => holiday.name);

describe("US holidays", () => {
  it("puts the moving holidays on their days in 2026", () => {
    expect(names("2026-01-19")).toEqual(["Martin Luther King Jr. Day"]);
    expect(names("2026-02-16")).toEqual(["Presidents' Day"]);
    expect(names("2026-05-25")).toEqual(["Memorial Day"]);
    expect(names("2026-09-07")).toEqual(["Labor Day"]);
    expect(names("2026-10-12")).toEqual(["Columbus Day"]);
    expect(names("2026-11-26")).toEqual(["Thanksgiving Day"]);
    expect(names("2026-05-10")).toEqual(["Mother's Day"]);
    expect(names("2026-06-21")).toEqual(["Father's Day"]);
  });

  it("finds Easter and Good Friday", () => {
    expect(easterSunday(2024)).toBe("2024-03-31");
    expect(easterSunday(2025)).toBe("2025-04-20");
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(names("2026-04-03")).toEqual(["Good Friday"]);
  });

  it("marks the weekday a weekend federal holiday is observed on", () => {
    // 4 July 2026 is a Saturday: observed Friday the 3rd.
    expect(names("2026-07-04")).toEqual(["Independence Day"]);
    expect(names("2026-07-03")).toEqual(["Independence Day (observed)"]);
    // Christmas 2027 is a Saturday, and 1 January 2028 too — observed on
    // Friday 31 December 2027, beside New Year's Eve, federal first.
    expect(names("2027-12-24")).toEqual(["Christmas Day (observed)", "Christmas Eve"]);
    expect(names("2027-12-31")).toEqual(["New Year's Day (observed)", "New Year's Eve"]);
    // Juneteenth 2027 is a Saturday; 2022's was a Sunday, observed Monday.
    expect(names("2027-06-18")).toEqual(["Juneteenth (observed)"]);
    expect(names("2022-06-20")).toEqual(["Juneteenth (observed)"]);
  });

  it("keeps Juneteenth to the years it has been a holiday", () => {
    expect(names("2020-06-19")).toEqual([]);
    expect(names("2021-06-19")).toEqual(["Juneteenth"]);
  });

  it("lists a range in date order, across a new year", () => {
    const list = holidaysBetween("2027-12-20", "2028-01-20");
    expect(list.map((holiday) => holiday.date)).toEqual([
      "2027-12-24",
      "2027-12-24",
      "2027-12-25",
      "2027-12-31",
      "2027-12-31",
      "2028-01-01",
      "2028-01-17",
    ]);
  });

  it("says which close the bank", () => {
    const year = holidaysIn(2026);
    const federal = year.filter((holiday) => holiday.kind === "federal" && !holiday.name.includes("observed"));
    expect(federal).toHaveLength(11);
    expect(year.find((holiday) => holiday.name === "Halloween")?.kind).toBe("observance");
  });

  it("is shown to businesses in the United States", () => {
    expect(showsUsHolidays("US")).toBe(true);
    expect(showsUsHolidays("U.S.A.")).toBe(true);
    expect(showsUsHolidays("")).toBe(true);
    expect(showsUsHolidays("CA")).toBe(false);
  });
});
