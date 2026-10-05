/**
 * Zod told not to probe for `eval`, before any schema is built.
 *
 * The app's content security policy has no `'unsafe-eval'`, on the plan tab
 * or anywhere else, and it should not gain one. Zod asks whether it may
 * compile a faster parser by running `new Function("")` inside a try/catch the
 * first time an object schema is built — and under that policy the probe is
 * itself reported as a violation, even though Zod swallows the error. So every
 * page load reported one, and in the report-only rehearsal meant to check
 * Stripe's hosts the log filled with "would have blocked eval" noise that
 * invites exactly the wrong fix: adding `'unsafe-eval'`.
 *
 * Wherever that policy is enforced, `jitless` skips the probe and nothing
 * else: the compiled parser was refused anyway, so the browser was on the
 * interpreted one already. Two places do not enforce it, and there the setting
 * is the whole difference. Under `SB_CSP_REPORT_ONLY` the plan tab's policy is
 * sent report-only, which reports and blocks nothing, and the Vite dev server
 * sends no policy at all — so the probe would succeed and Zod would build its
 * fastpass. That is the whole of what `jitless` turns off: an object schema's
 * first synchronous parse compiles a function for that one shape with
 * `new Function`, and every later parse of it runs that instead of walking the
 * shape's keys and calling each field's parser. Nothing else in Zod uses it —
 * no other schema kind, and no async parse — so the cost is a key walk on the
 * objects this app parses, a form's worth of fields at a time. Worth paying: a
 * rehearsal whose log is to be read for Stripe's hosts must not be the one page
 * whose `eval` succeeds, and the parser the dev server runs should be the
 * parser production runs.
 *
 * What it does not change anywhere is what a parse answers. The two parsers
 * accept and reject the same values; only how fast they do it differs.
 *
 * **Its own module, imported first by `main.tsx`, and the order is the whole
 * fix.** ES imports are hoisted and evaluated before the importing module's
 * body, and `src/shared/domain.ts` builds its object schemas while it loads —
 * reached through `App.tsx` and `api.ts` — so a `z.config` call in the
 * entry's body runs after the probe it was meant to prevent. The setting is
 * global to the Zod instance, and it reads it when a schema is constructed.
 * `tests/zod-jitless.test.ts` loads the real entry and watches for the probe.
 *
 * Client-only rather than in `src/shared`: the server has no such policy and
 * keeps Zod's compiled parser.
 */
import { z } from "zod";

z.config({ jitless: true });
