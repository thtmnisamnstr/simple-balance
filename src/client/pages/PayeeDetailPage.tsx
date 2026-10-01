import { ArrowLeft } from "lucide-react";
import { Alert, DateRangeBar, PageHeader } from "../components.js";
import { Link, useLocation, useSearchParams } from "../router.js";
import { TransactionBrowser } from "../TransactionBrowser.js";

export default function PayeeDetailPage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const payee = searchParams.get("name") ?? "";
  const listSearch = new URLSearchParams(location.search);
  listSearch.delete("name");

  /**
   * The back link and the page header, before any of the four states rather
   * than after them.
   *
   * `web.md` 12.1 says four states per list, and nothing said the four states
   * are states of the page's BODY. So this page returned its skeleton and its
   * alert from above the header and took the title, the eyebrow and the way
   * back to the list down with them — and `document.title` is set inside
   * `PageHeader`, whose own comment is that two windows of this app are
   * otherwise indistinguishable in a task switcher. A fresh tab on this URL
   * read the bare app name until the query landed, and forever if it failed.
   *
   * The eyebrow waits for the name, because an eyebrow and an `h1` saying the
   * same word is decoration that reads as structure (16).
   */
  const header = (
    <>
      <Link className="back-link" to={{ pathname: "/payees", search: listSearch.toString() }}>
        <ArrowLeft size={16} /> All payees
      </Link>
      {/* No `actions`, where the other three detail pages badge a varying fact
          and the six list pages put a button. A payee has no archived state and
          no kind, so there is nothing to badge — and the 36px tile that used to
          sit here said "payee", which is the word the eyebrow two lines above
          already says. The slot takes actions and status, never decoration
          (web.md 7.5), and at 780px it goes full width, so a lone green square
          on a row of its own was what the page actually rendered on a phone. */}
      <PageHeader
        eyebrow={payee.trim() ? "Payee" : undefined}
        title={payee.trim() || "Payee"}
        description="Transactions associated with this payee."
      />
    </>
  );

  if (!payee.trim())
    return (
      <>
        {header}
        <Alert>Payee not found.</Alert>
      </>
    );

  return (
    <>
      {header}
      <DateRangeBar />
      <section className="account-transactions">
        <TransactionBrowser
          heading={{
            kind: "section",
            title: "Transactions",
            description: "Filter, search, export, or add activity for this payee.",
          }}
          includeStaged
          fixedPayee={payee}
          showDateRange={false}
        />
      </section>
    </>
  );
}
