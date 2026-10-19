import { expect, test } from "bun:test";
import { sameOrigin, validLocalHost, validToken } from "../src/security";

test("rejects foreign Host, cross-site writes and missing session tokens", () => {
  expect(validLocalHost("evil.example:18943", 18943)).toBe(false);
  expect(validLocalHost("127.0.0.1:18943", 18943)).toBe(true);
  expect(sameOrigin(new Request("http://127.0.0.1:18943/api/input", { headers: { host: "127.0.0.1:18943", origin: "https://foreign.example" } }))).toBe(false);
  expect(validToken(null, "session-token")).toBe(false);
  expect(validToken("session-token", "session-token")).toBe(true);
});
