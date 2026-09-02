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
export function BrowserRouter({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(browserLocation);
  useEffect(() => {
    const onPopState = () => setLocation(browserLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const navigate = useCallback((to: To, options: NavigateOptions = {}) => {
    const url = toUrl(to, browserLocation());
    if (url.origin !== window.location.origin) {
      window.location.assign(url);
      return;
    }
    window.history[options.replace ? "replaceState" : "pushState"](
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    setLocation(browserLocation());
  }, []);
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
