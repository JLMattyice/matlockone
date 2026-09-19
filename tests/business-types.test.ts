import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUSINESS_TYPES,
  DEFAULT_BUSINESS_TYPE,
  businessType,
  isBusinessType,
  vocabularyChanges,
  vocabularyColumns,
} from "@/lib/business-types";

/**
 * A business type is only a set of words, so most of what can go wrong is a
 * gap: a preset added with a label missing, or an id that no longer matches
 * what is stored on existing rows.
 */

const LABEL_KEYS = [
  "jobSingular",
  "jobPlural",
  "clientSingular",
  "clientPlural",
  "estimateSingular",
  "estimatePlural",
  "leadSingular",
  "leadPlural",
] as const;

describe("BUSINESS_TYPES", () => {
  it("gives every type a full set of labels", () => {
    for (const type of BUSINESS_TYPES) {
      for (const key of LABEL_KEYS) {
        expect(type.labels[key], `${type.id}.${key}`).toBeTruthy();
      }
      expect(type.name).toBeTruthy();
      expect(type.description).toBeTruthy();
    }
  });

  it("keeps ids unique, since one is stored on every organization", () => {
    const ids = BUSINESS_TYPES.map((type) => type.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("offers the fallback type", () => {
    expect(isBusinessType(DEFAULT_BUSINESS_TYPE)).toBe(true);
  });

  it("distinguishes the trades it claims to", () => {
    // The whole argument for presets is that the words actually differ. If two
    // of these ever collapse into the same vocabulary, one of them is noise on
    // the signup form.
    const agency = businessType("AGENCY").labels;
    const contractor = businessType("CONTRACTOR").labels;

    expect(agency.jobPlural).not.toBe(contractor.jobPlural);
    expect(agency.estimateSingular).not.toBe(contractor.estimateSingular);
  });
});

describe("businessType", () => {
  it("finds a known type", () => {
    expect(businessType("AGENCY").id).toBe("AGENCY");
  });

  it("falls back rather than throwing on anything else", () => {
    // A stored id can outlive the preset that wrote it. Rendering the page
    // with standard wording beats a settings screen that will not load.
    for (const value of ["MYSTERY", "", null, undefined]) {
      expect(businessType(value).id).toBe(DEFAULT_BUSINESS_TYPE);
    }
  });
});

describe("vocabularyColumns", () => {
  it("names the columns the organization actually has", () => {
    expect(vocabularyColumns("AGENCY")).toEqual({
      labelJobSingular: "Project",
      labelJobPlural: "Projects",
      labelClientSingular: "Client",
      labelClientPlural: "Clients",
      labelEstimateSingular: "Proposal",
      labelEstimatePlural: "Proposals",
      labelLeadSingular: "Opportunity",
      labelLeadPlural: "Opportunities",
    });
  });
});

describe("vocabularyChanges", () => {
  it("names only what a preset actually renames", () => {
    // An agency keeps "clients", so the line under the picker must not offer
    // "clients rather than clients", which reads as a bug in the sentence.
    const changes = vocabularyChanges("AGENCY");

    expect(changes).toContainEqual({ from: "jobs", to: "projects" });
    expect(changes).toContainEqual({ from: "estimates", to: "proposals" });
    expect(changes.some((change) => change.from === change.to)).toBe(false);
    expect(changes.some((change) => change.from === "clients")).toBe(false);
  });

  it("finds nothing to say about the standard vocabulary", () => {
    expect(vocabularyChanges(DEFAULT_BUSINESS_TYPE)).toEqual([]);
  });
});

describe("the default type against the schema", () => {
  /**
   * Existing organizations were created before any of this, so they carry the
   * column defaults and the GENERAL type they were backfilled with. Those two
   * have to agree, or an untouched workspace would report a business type
   * whose words are not the ones on its own screens.
   */
  it("matches the column defaults in schema.prisma", () => {
    const schema = fs.readFileSync(
      path.resolve("prisma/schema.prisma"),
      "utf8",
    );
    const columns = vocabularyColumns(DEFAULT_BUSINESS_TYPE);

    for (const [column, value] of Object.entries(columns)) {
      const declared = new RegExp(
        `${column}\\s+String\\s+@default\\("([^"]+)"\\)`,
      ).exec(schema);

      expect(declared?.[1], `${column} in schema.prisma`).toBe(value);
    }
  });
});
