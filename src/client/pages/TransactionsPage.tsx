import { PageHeader } from "../components.js";
import { TransactionBrowser } from "../TransactionBrowser.js";

export default function TransactionsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Ledger"
        title="Transactions"
        description="Deposits, withdrawals, and transfers."
      />
      <TransactionBrowser />
    </>
  );
}
