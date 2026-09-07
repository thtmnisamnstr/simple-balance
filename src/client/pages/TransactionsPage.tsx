import { TransactionBrowser } from "../TransactionBrowser.js";

export default function TransactionsPage() {
  // The header comes from the browser rather than from here, because the two
  // buttons that belong in it are built from filter state the browser owns.
  return (
    <TransactionBrowser
      heading={{
        kind: "page",
        eyebrow: "Ledger",
        title: "Transactions",
        description: "Deposits, withdrawals, and transfers.",
      }}
    />
  );
}
