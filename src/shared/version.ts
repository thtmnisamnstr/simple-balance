/**
 * The released version, written once.
 *
 * The MCP server announces this to every client that connects, so it has to
 * move with the release rather than being a literal somebody remembers to
 * change. `npm run set-version` rewrites it alongside the manifests, and a test
 * fails if it ever disagrees with package.json.
 */
export const APP_VERSION = "0.1.6";

/**
 * The product's name, written once.
 *
 * It reaches the browser tab, the sign-in screen, the sidebar and the name
 * Better Auth puts on an email. Four literals is three chances for one of
 * them to say something else after a rename, and the tab is the one nobody
 * looks at while working.
 *
 * `index.html` carries it a fifth time and cannot import this — it is served
 * before any module runs. `tests/app-name.test.ts` holds the two together,
 * the same way the theme-color literals in that file are held to the
 * stylesheet.
 */
export const APP_NAME = "Simple Balance";
