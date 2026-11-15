import { describe, it, expect } from "vitest";
import { userAgent } from "../src/agent";
import { classifyClient } from "../../admin/src/events";

describe("om user agent", () => {
  it("is recognised by the admin's access-log parser, with the OS", () => {
    for (const [p, os] of [["win32", "windows"], ["darwin", "macos"], ["linux", "linux"]] as const) {
      const c = classifyClient(userAgent(p));
      expect(c.kind).toBe("om");
      expect(c.os).toBe(os);
      expect(c.version).toMatch(/^0\./);
    }
  });
});
