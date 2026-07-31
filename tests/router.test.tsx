// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
  useSearchParams,
} from "../src/client/router.js";

function AccountRoute() {
  const { accountId } = useParams<{ accountId: string }>();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  return (
    <>
      <p>{`Account ${accountId} ${location.search}`}</p>
      <button
        onClick={() => {
          const updated = new URLSearchParams(params);
          updated.set("end", "2026-07-31");
          setParams(updated, { replace: true });
        }}
      >
        Set range
      </button>
    </>
  );
}

describe("embedded browser router", () => {
  it("navigates links, extracts params, and preserves linkable query state", () => {
    window.history.replaceState(null, "", "/accounts");
    render(
      <BrowserRouter>
        <Routes>
          <Route
            path="/accounts"
            element={
              <Link to={{ pathname: "/accounts/account-1", search: "start=2026-07-01" }}>
                Open account
              </Link>
            }
          />
          <Route path="/accounts/:accountId" element={<AccountRoute />} />
          <Route path="*" element={<Navigate to="/accounts" replace />} />
        </Routes>
      </BrowserRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Open account" }));
    expect(
      screen.getByText("Account account-1 ?start=2026-07-01"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Set range" }));
    expect(
      screen.getByText(
        "Account account-1 ?start=2026-07-01&end=2026-07-31",
      ),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/accounts/account-1");
  });

  it("preserves the origin in external link hrefs", () => {
    window.history.replaceState(null, "", "/accounts");
    render(
      <BrowserRouter>
        <Link to="https://docs.example.com/accounting?from=app">
          Documentation
        </Link>
      </BrowserRouter>,
    );

    expect(
      screen.getByRole("link", { name: "Documentation" }),
    ).toHaveAttribute(
      "href",
      "https://docs.example.com/accounting?from=app",
    );
  });
});
