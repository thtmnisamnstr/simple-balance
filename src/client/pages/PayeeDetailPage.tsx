import { ArrowLeft, UserRound } from "lucide-react";
import { Alert, DateRangeBar, PageHeader } from "../components.js";
import { Link, useLocation, useSearchParams } from "../router.js";
import { TransactionBrowser } from "../TransactionBrowser.js";

export default function PayeeDetailPage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const payee = searchParams.get("name") ?? "";
  if (!payee.trim()) return <Alert>Payee not found.</Alert>;
  const listSearch = new URLSearchParams(location.search);
  listSearch.delete("name");

  return (
    <>
      <Link className="back-link" to={{ pathname: "/payees", search: listSearch.toString() }}>
        <ArrowLeft size={16} /> All payees
      </Link>
      <PageHeader
        eyebrow="Payee"
        title={payee}
        description="Transactions associated with this payee."
        actions={
          <span className="account-icon">
            <UserRound size={18} />
          </span>
        }
      />
      <DateRangeBar />
      <section className="account-transactions">
        <div className="section-title">
          <div>
            <h2>Transactions</h2>
            <p>Filter, search, export, or add activity for this payee.</p>
          </div>
        </div>
        <TransactionBrowser includeStaged fixedPayee={payee} showDateRange={false} />
      </section>
    </>
  );
}
