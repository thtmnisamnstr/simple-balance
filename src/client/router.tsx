import {
  Children,
  createContext,
  isValidElement,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
export type Location = {
  pathname: string;
  search: string;
  hash: string;
};
export type To =
  | string
  | {
      pathname?: string;
      search?: string;
      hash?: string;
    };
type NavigateOptions = {
  replace?: boolean;
};
type RouterContextValue = {
  location: Location;
  navigate: (to: To, options?: NavigateOptions) => void;
};
const RouterContext = createContext<RouterContextValue | null>(null);
const ParamsContext = createContext<Record<string, string>>({});
function browserLocation(): Location {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  };
}
function normalizedPart(value: string | undefined, prefix: "?" | "#") {
  if (!value) return "";
  return value.startsWith(prefix) ? value : `${prefix}${value}`;
}
function toUrl(to: To, current: Location) {
  if (typeof to === "string") return new URL(to, window.location.href);
  return new URL(
    `${to.pathname ?? current.pathname}${normalizedPart(
      to.search,
      "?",
    )}${normalizedPart(to.hash, "#")}`,
    window.location.origin,
  );
}
function useRouter() {
  const router = useContext(RouterContext);
  if (!router) throw new Error("Router hooks must be used inside BrowserRouter");
  return router;
}
/**
 * Whether this document arrived under the plan tab's wider content security
 * policy.
 *
 * A policy belongs to the document it was served with, and the way *in* to
 * `/settings/plan` is a full page load for that reason. The way out has to be
 * one too: a `pushState` to the dashboard keeps the plan tab's policy over
 * every page after it, so the pages that render somebody's balances would run
 * with Stripe's hosts allowed for the life of the tab. Nothing is exploitable
 * in that — the wider policy adds three vendor origins and no `unsafe-inline`
 * or `unsafe-eval` — but a policy that widens on one page and then follows you
 * around is not the policy that was designed, and it is the kind of drift
 * nothing would ever notice.
 *
 * Read once at load rather than at click time: with this in place the path
 * cannot leave `/settings/plan` without a document load, so the answer stays
 * true for as long as the document does.
 */
const PLAN_SURFACE_PATH = "/settings/plan";

/**
 * Whether a path is the plan tab, normalized the way this router matches.
 *
 * Exported because two unrelated things need the same answer and must not
 * disagree about it: this file, deciding that leaving the tab has to be a
 * document load, and the shell, deciding that no ad may render there. The
 * second is a promise the product makes in three documents, and the content
 * security policy is *not* what keeps it — under `SB_CSP_REPORT_ONLY` nothing
 * on that page is enforced at all, so a slot left mounted would put live ads
 * beside the payment form rather than an empty box.
 */
export const isPlanSurfacePath = (pathname: string) =>
  `/${pathname.split("/").filter(Boolean).join("/")}` === PLAN_SURFACE_PATH;

const servedUnderPlanPolicy = () =>
  typeof window !== "undefined" && isPlanSurfacePath(window.location.pathname);

export function BrowserRouter({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(browserLocation);
  useEffect(() => {
    const onPopState = () => setLocation(browserLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const leavingPlanPolicy = useMemo(() => servedUnderPlanPolicy(), []);
  const navigate = useCallback(
    (to: To, options: NavigateOptions = {}) => {
      const url = toUrl(to, browserLocation());
      if (url.origin !== window.location.origin) {
        window.location.assign(url);
        return;
      }
      // A document load out of the plan tab, for the reason above: its policy
      // would otherwise travel to every page reached without one.
      if (leavingPlanPolicy) {
        window.location.assign(url);
        return;
      }
      window.history[options.replace ? "replaceState" : "pushState"](
        null,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
      setLocation(browserLocation());
    },
    [leavingPlanPolicy],
  );
  const value = useMemo(() => ({ location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}
export function useLocation() {
  return useRouter().location;
}
type SearchParamsSetter = (next: URLSearchParams, options?: NavigateOptions) => void;
export function useSearchParams(): [URLSearchParams, SearchParamsSetter] {
  const { location, navigate } = useRouter();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const setParams = useCallback<SearchParamsSetter>(
    (next, options) => {
      navigate(
        {
          pathname: location.pathname,
          search: next.toString(),
          hash: location.hash,
        },
        options,
      );
    },
    [location.hash, location.pathname, navigate],
  );
  return [params, setParams];
}
type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  to: To;
};
function shouldHandleNavigation(event: MouseEvent<HTMLAnchorElement>) {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    (!event.currentTarget.target || event.currentTarget.target.toLowerCase() === "_self")
  );
}
export function Link({ to, onClick, ...props }: LinkProps) {
  const { location, navigate } = useRouter();
  const url = toUrl(to, location);
  const href =
    url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : url.href;
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (shouldHandleNavigation(event) && url.origin === window.location.origin) {
          event.preventDefault();
          navigate(to);
        }
      }}
    />
  );
}
type NavLinkProps = LinkProps & {
  end?: boolean;
};
export function NavLink({ to, end = false, className, ...props }: NavLinkProps) {
  const location = useLocation();
  const target = toUrl(to, location).pathname.replace(/\/+$/, "") || "/";
  const current = location.pathname.replace(/\/+$/, "") || "/";
  const active = current === target || (!end && target !== "/" && current.startsWith(`${target}/`));
  return (
    <Link
      {...props}
      to={to}
      aria-current={active ? "page" : undefined}
      className={[className, active ? "active" : ""].filter(Boolean).join(" ")}
    />
  );
}
export function useParams<T extends Record<string, string | undefined>>() {
  return useContext(ParamsContext) as T;
}
type RouteProps = {
  path: string;
  element: ReactElement;
};
export function Route(_props: RouteProps) {
  return null;
}
function matchPath(pattern: string, pathname: string) {
  if (pattern === "*") return {};
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index]!;
    const pathPart = pathParts[index]!;
    if (patternPart.startsWith(":")) {
      try {
        params[patternPart.slice(1)] = decodeURIComponent(pathPart);
      } catch {
        return null;
      }
    } else if (patternPart !== pathPart) {
      return null;
    }
  }
  return params;
}
export function Routes({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  for (const child of Children.toArray(children)) {
    if (!isValidElement<RouteProps>(child)) continue;
    const params = matchPath(child.props.path, pathname);
    if (params !== null) {
      return <ParamsContext.Provider value={params}>{child.props.element}</ParamsContext.Provider>;
    }
  }
  return null;
}
export function Navigate({ to, replace = false }: { to: To; replace?: boolean }) {
  const { navigate } = useRouter();
  useEffect(() => navigate(to, { replace }), [navigate, replace, to]);
  return null;
}
/** The payee detail view is the transaction list filtered to one name. */
export function payeeDetailSearch(search: string, payee: string) {
  const params = new URLSearchParams(search);
  params.set("name", payee);
  return params.toString();
}

/**
 * The one query parameter that carries text from somebody's ledger: the payee
 * name the view above is addressed by. Everything else a URL here carries is a
 * date, a preset or an id.
 */
export const LEDGER_TEXT_PARAMETER = "name";

/**
 * A query string with the ledger's own text taken out, for a link leaving the
 * payee view.
 *
 * Links forward the query string so a date range survives moving between
 * pages, and forwarding it wholesale took the payee name along too — onto a
 * page that carries an ad, whose request tells Google the page's address.
 */
export function withoutLedgerText(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(LEDGER_TEXT_PARAMETER);
  return params.toString();
}

/**
 * Whether this document's address, or the page that opened it, carries text
 * from the ledger.
 *
 * An ad request sends Google the page's own address and the address it was
 * opened from, and a payee name in either is a person's name and who they pay
 * — "ZELLE TO JANE DOE" — handed to an advertiser, which is also what the
 * program's policy forbids a page to pass. The referrer is the one this
 * document arrived with, so a tab opened from the payee view keeps no ads for
 * as long as it lasts, even after it moves somewhere clean.
 */
export function addressCarriesLedgerText(
  search: string,
  referrer: string,
  origin: string,
): boolean {
  if (new URLSearchParams(search).has(LEDGER_TEXT_PARAMETER)) return true;
  if (!referrer) return false;
  try {
    const from = new URL(referrer);
    return from.origin === origin && from.searchParams.has(LEDGER_TEXT_PARAMETER);
  } catch {
    return false;
  }
}
