import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/templates",
  pretendToBeVisual: true,
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.Node = dom.window.Node;
g.getComputedStyle = dom.window.getComputedStyle;
g.requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
g.cancelAnimationFrame = (id: any) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
dom.window.HTMLDialogElement.prototype.close = function () {
  this.open = false;
};

const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { render, fireEvent, screen, within, cleanup } = await import(
  "@testing-library/react"
);
const { TemplateForm } = await import("./src/client/forms.js");
const { TimezoneProvider } = await import("./src/client/timezone.js");

const accounts = [
  {
    id: "acc-1",
    name: "Checking",
    type: "checking",
    currency: "USD",
    openingDate: "2026-01-01",
    openingBalance: "0",
    version: 1,
    balance: "0",
    archivedAt: null,
  },
] as any;
const categories = [
  { id: "cat-1", name: "Rent", kind: "expense", archivedAt: null, version: 1 },
] as any;

const writes: { path: string; body: any }[] = [];
g.fetch = async (input: any, init: any) => {
  const url = new URL(String(input), "http://localhost");
  if (init?.method === "PUT" || init?.method === "POST") {
    writes.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
    return Response.json({ ok: true });
  }
  if (url.pathname === "/api/auth/methods") {
    return Response.json({ notificationsAvailable: true });
  }
  return Response.json([]);
};

const template = (notification: any) =>
  ({
    id: "tpl-1",
    name: "Rent",
    version: 3,
    draft: { type: "withdrawal", payee: "Landlord" },
    notification,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }) as any;

const repeating = {
  frequency: "monthly",
  interval: 2,
  anchorDate: "2026-06-15",
  monthPolicy: "skip",
  weekendPolicy: "skip",
  position: null,
  time: "21:15",
  repeats: true,
  lastNotifiedDate: null,
  nextNotificationDate: "2026-06-15",
};

const mount = (notification: any) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        TimezoneProvider as any,
        { timezone: "UTC" },
        React.createElement(TemplateForm as any, {
          accounts,
          categories,
          template: template(notification),
          onDone: () => {},
        }),
      ),
    ),
  );
};

const settle = () => new Promise((r) => setTimeout(r, 50));

// PROBE 1: unchecking an existing reminder must send notification: null.
writes.length = 0;
mount(repeating);
fireEvent.click(screen.getByLabelText(/Email me to make this/));
fireEvent.click(screen.getByRole("button", { name: "Save template" }));
await settle();
console.log("PROBE 1 clear-a-reminder ->", JSON.stringify(writes[0]?.body?.notification));
cleanup();

// PROBE 2: switching a repeating reminder back to Once.
writes.length = 0;
mount(repeating);
fireEvent.click(screen.getByLabelText("Once"));
fireEvent.click(screen.getByRole("button", { name: "Save template" }));
await settle();
console.log(
  "PROBE 2 repeating->once keys ->",
  JSON.stringify(Object.keys(writes[0]?.body?.notification ?? {}).sort()),
  JSON.stringify(writes[0]?.body?.notification),
);
cleanup();

// PROBE 3: an interval the schema refuses. Does the form still submit?
writes.length = 0;
mount(repeating);
fireEvent.change(screen.getByLabelText(/^Every N/), { target: { value: "900" } });
await settle();
const alerts = [...document.querySelectorAll(".alert, [role=alert], [role=status]")].map(
  (n) => n.textContent,
);
console.log("PROBE 3 alerts shown ->", JSON.stringify(alerts));
const save = screen.getByRole("button", { name: "Save template" }) as any;
console.log("PROBE 3 save disabled ->", save.disabled);
fireEvent.click(save);
await settle();
console.log(
  "PROBE 3 submitted anyway ->",
  writes.length,
  JSON.stringify(writes[0]?.body?.notification),
);
cleanup();

// PROBE 4: monthly-by-position, then switch frequency to weekly and back.
writes.length = 0;
mount({ ...repeating, position: { ordinal: 1, weekday: 3 }, monthPolicy: "last_day" });
fireEvent.change(screen.getByLabelText("Repeats"), { target: { value: "weekly" } });
fireEvent.change(screen.getByLabelText("Repeats"), { target: { value: "monthly" } });
fireEvent.click(screen.getByRole("button", { name: "Save template" }));
await settle();
console.log(
  "PROBE 4 position after weekly round trip ->",
  JSON.stringify(writes[0]?.body?.notification),
);
cleanup();

// PROBE 5: does the reminder fieldset survive with an unnamed dialog / labelled controls?
mount(null);
const box = screen.getByLabelText(/Email me to make this/);
console.log("PROBE 5 checkbox found, checked ->", (box as any).checked);
cleanup();

// PROBE 6: the one invalid rule native HTML validation cannot catch.
writes.length = 0;
mount(repeating);
fireEvent.click(screen.getByLabelText("Repeatedly"));
fireEvent.change(screen.getByLabelText("Repeats"), { target: { value: "daily" } });
fireEvent.change(screen.getByLabelText(/^Every N/), { target: { value: "1" } });
const weekend = screen.getByLabelText(/When it lands on a weekend/) as any;
const options = [...weekend.querySelectorAll("option")].map(
  (o: any) => `${o.value}:${o.disabled ? "disabled" : "enabled"}`,
);
console.log("PROBE 6 weekend options ->", JSON.stringify(options));
fireEvent.change(weekend, { target: { value: "previous_business_day" } });
await settle();
const alerts6 = [...document.querySelectorAll(".alert, [role=alert], [role=status]")].map(
  (n) => n.textContent,
);
console.log("PROBE 6 alert ->", JSON.stringify(alerts6));
const save6 = screen.getByRole("button", { name: "Save template" }) as any;
console.log("PROBE 6 save disabled ->", save6.disabled);
fireEvent.click(save6);
await settle();
console.log(
  "PROBE 6 submitted anyway ->",
  writes.length,
  JSON.stringify(writes[0]?.body?.notification),
);
cleanup();

process.exit(0);
