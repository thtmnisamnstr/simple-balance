import { Component, type ErrorInfo, type ReactNode } from "react";
import { ApiClientError } from "./api.js";

/**
 * One boundary above the routes, so a render throw does not blank the page.
 *
 * Without it a single bad render unmounts the whole tree and leaves white. Four
 * modules already guarded against exactly that at the leaves — `timezone.tsx`
 * and `theme.ts` catch, `money.ts` guards with `Number.isNaN`, and
 * `idempotency.ts` checks for `crypto.randomUUID` — which is the same problem
 * solved five times instead of once at the root. Those guards stay: each of
 * them keeps a specific screen useful rather than merely non-blank. This is the
 * backstop for everything nobody predicted.
 *
 * React gives no way to write this as a function component, so it is the one
 * class in the client.
 */
type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept to the console rather than sent anywhere. This deployment has no
    // error reporting service and adding one is a decision about somebody's
    // financial data leaving their server, not a detail of this component.
    console.error("Unhandled render error", error, info.componentStack);
  }

  private readonly reset = () => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    // An `ApiClientError` already carries a sentence somebody wrote for a
    // person to read. Anything else does not, and its message is a stack-trace
    // fragment, so it gets the general sentence instead.
    const message =
      error instanceof ApiClientError
        ? error.message
        : "Something on this page stopped working. Your data is safe; nothing was saved or changed.";

    return (
      <div className="panel error-boundary" role="alert">
        <h1>This page could not be shown</h1>
        <p>{message}</p>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={this.reset}>
            Try again
          </button>
          <a className="button button-primary" href="/">
            Go to the dashboard
          </a>
        </div>
      </div>
    );
  }
}
