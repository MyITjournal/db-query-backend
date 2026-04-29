import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { determineAgeGroup } from "../src/helpers/helperFunctions.js";
import { parseNaturalLanguageQuery } from "../src/helpers/nlq.js";

describe("determineAgeGroup", () => {
  it("returns child for age 5", () => {
    assert.equal(determineAgeGroup(5), "child");
  });

  it("returns teenager for age 15", () => {
    assert.equal(determineAgeGroup(15), "teenager");
  });

  it("returns adult for age 30", () => {
    assert.equal(determineAgeGroup(30), "adult");
  });

  it("returns senior for age 65", () => {
    assert.equal(determineAgeGroup(65), "senior");
  });

  it("returns null for null input", () => {
    assert.equal(determineAgeGroup(null), null);
  });
});

describe("parseNaturalLanguageQuery", () => {
  it("parses gender from query", () => {
    const result = parseNaturalLanguageQuery("women over 30 from nigeria");
    assert.equal(result.gender, "female");
  });

  it("parses min_age from query", () => {
    const result = parseNaturalLanguageQuery("men over 25");
    assert.equal(result.min_age, 25);
  });

  it("parses age_group from query", () => {
    const result = parseNaturalLanguageQuery("elderly men");
    assert.equal(result.age_group, "senior");
  });

  it("parses country from query", () => {
    const result = parseNaturalLanguageQuery("women from nigeria");
    assert.equal(result.country_id, "NG");
  });

  it("returns empty object for unrecognised query", () => {
    const result = parseNaturalLanguageQuery("xyzzy");
    assert.deepEqual(result, {});
  });
});
