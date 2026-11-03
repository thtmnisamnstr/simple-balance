import { describe, expect, it } from "vitest";
import { redirectDestination } from "../src/server/api.js";

/**
 * Where the consent screen says approving sends the code.
 *
 * Registration is open, so a client's name is its own claim and the host is the
 * check the screen adds. Only over http is a host a site: `myapp://chatgpt.com`
 * goes to whichever program owns `myapp:`, and showing "chatgpt.com" there
 * would turn the check into the lie it exists to catch.
 */
describe("the consent screen's redirect host", () => {
  it.each([
    ["https://chatgpt.com/connector/oauth/cb", "chatgpt.com", false],
    ["http://127.0.0.1:7777/callback", "127.0.0.1", true],
    ["http://localhost:33418/cb", "localhost", true],
    ["http://[::1]:8080/cb", "[::1]", true],
    ["myapp://chatgpt.com/cb", "myapp://chatgpt.com", false],
    ["myapp://127.0.0.1/cb", "myapp://127.0.0.1", false],
    ["com.example.app:/oauth", "com.example.app", false],
  ])("names %s as %s", (uri, host, loopback) => {
    expect(redirectDestination(uri)).toEqual({ redirectHost: host, redirectIsLoopback: loopback });
  });

  it("names nothing it cannot parse", () => {
    expect(redirectDestination("not a url")).toEqual({
      redirectHost: null,
      redirectIsLoopback: false,
    });
    expect(redirectDestination(null)).toEqual({ redirectHost: null, redirectIsLoopback: false });
  });
});
