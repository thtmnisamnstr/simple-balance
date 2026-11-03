import { expect, test } from "@playwright/test";

/**
 * The consent screen with the longest things it names, at phone width and in
 * the band above the sidebar breakpoint.
 *
 * A client's name, an email address and a host are each one unbroken word to a
 * browser, which breaks at neither `.` nor `@`, and a long reviewer address
 * once pushed the whole page sideways at 390px. Measured rather than looked at:
 * the document must not scroll sideways, and nor may the card.
 */
test("names a long account and host without widening the page", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Sign up" });
  const heading = page.getByRole("heading", { name: "Create your account" });
  await expect(heading.or(toggle)).toBeVisible();
  if (await toggle.isVisible()) await toggle.click();
  await page.getByLabel("Your name").fill("Consent Reviewer");
  await page.getByLabel("Email address").fill(`consent-${Date.now()}@example.com`);
  await page.getByLabel(/^Password/).fill("consent-password-123456");
  await page.getByLabel(/^Confirm password/).fill("consent-password-123456");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();

  // The screen reads one record from the server, so that reply is the state.
  await page.route("**/api/auth/oauth2/consent-request**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        clientId: "long",
        clientName: "AnAgentWhoseNameHasNoSpacesInItAnywhereAtAll",
        scopes: ["ledger:read"],
        redirectHost: "callbackhostwithoutanyhyphens.integrationprovider.example",
        redirectIsLoopback: false,
        accountEmail: "a.very.long.address.for.a.reviewer.account@subdomain.example.com",
      }),
    }),
  );
  for (const width of [390, 820]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/oauth/consent?consent_code=long");
    await expect(page.getByRole("button", { name: "Allow access" })).toBeVisible();
    const widened = await page.evaluate(() => {
      const card = document.querySelector(".auth-card")!;
      return {
        document: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        card: card.scrollWidth > card.clientWidth,
      };
    });
    expect(widened, `${width}px`).toEqual({ document: false, card: false });
  }
});
