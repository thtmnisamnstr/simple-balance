/**
 * The released version, written once.
 *
 * The MCP server announces this to every client that connects, so it has to
 * move with the release rather than being a literal somebody remembers to
 * change. `npm run set-version` rewrites it alongside the manifests, and a test
 * fails if it ever disagrees with package.json.
 */
export const APP_VERSION = "0.1.4";
