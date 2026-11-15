import { describe, it, expect } from "vitest";
import { retainedVersions } from "../src/retention";

const keep = (vs: string[], r = {}) => [...retainedVersions(vs, r)].sort();

describe("retention policy", () => {
  const history = ["2.1.4", "2.1.3", "2.1.2", "2.1.1", "2.1.0", "2.0.9", "2.0.0", "1.9.5", "1.9.4", "1.0.0", "0.5.0"];
  it("keeps the newest patches, the latest of the newest minors and of the newest majors", () => {
    // patches 3: 2.1.4 2.1.3 2.1.2; minors 3: 2.1.4 2.0.9 1.9.5; majors 2: 2.1.4 1.9.5
    expect(keep(history)).toEqual(["1.9.5", "2.0.9", "2.1.2", "2.1.3", "2.1.4"]);
  });
  it("a burst of patch releases does not push out the last release of an older line", () => {
    const burst = ["1.4.9", "1.4.8", "1.4.7", "1.4.6", "1.4.5", "1.3.2", "1.2.7", "1.1.0"];
    expect(keep(burst, { patches: 2, minors: 3, majors: 1 })).toEqual(["1.2.7", "1.3.2", "1.4.8", "1.4.9"]);
  });
  it("zero turns a rule off, and the order of the input does not matter", () => {
    expect(keep(history, { patches: 1, minors: 0, majors: 0 })).toEqual(["2.1.4"]);
    expect(keep([...history].reverse(), { patches: 1, minors: 0, majors: 0 })).toEqual(["2.1.4"]);
  });
  it("sorts numerically, not as text, and uses defaults for bad values", () => {
    expect(keep(["1.10.0", "1.9.0", "1.2.0"], { patches: 1, minors: 1, majors: 1 })).toEqual(["1.10.0"]);
    expect(keep(["1.0.3", "1.0.2", "1.0.1", "1.0.0"], { patches: -1 as number })).toEqual(["1.0.1", "1.0.2", "1.0.3"]);
  });
  it("always keeps tags that are not plain versions so the normal checks can reject them", () => {
    expect(keep(["nightly", "1.0.0"], { patches: 0, minors: 0, majors: 0 })).toEqual(["nightly"]);
  });
  it("handles an empty list", () => { expect(keep([])).toEqual([]); });
});
