import { describe, expect, it } from "vitest";
import { APP_JS } from "../src/ui";

describe("served UI script", () => {
  it("is syntactically valid JavaScript (template-literal escapes must survive)", () => {
    expect(() => new Function(APP_JS)).not.toThrow();
  });
});
