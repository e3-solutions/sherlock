import { describe, expect, it } from "vitest";

import { authorizeBasic, hasDashboardCredentials } from "./auth.js";

const config = { username: "sherlock", password: "elementary:watson" };
const basic = (value) => `Basic ${Buffer.from(value).toString("base64")}`;

describe("dashboard Basic authentication", () => {
  it("accepts only the configured complete credential pair", () => {
    expect(authorizeBasic(basic("sherlock:elementary:watson"), config)).toBe(true);
    expect(authorizeBasic(basic("sherlock:wrong"), config)).toBe(false);
    expect(authorizeBasic(basic("wrong:elementary:watson"), config)).toBe(false);
  });

  it("fails closed for malformed or missing configuration", () => {
    expect(authorizeBasic(undefined, config)).toBe(false);
    expect(authorizeBasic("Bearer token", config)).toBe(false);
    expect(authorizeBasic("Basic !!!", config)).toBe(false);
    expect(hasDashboardCredentials({ username: "", password: "" })).toBe(false);
  });
});
