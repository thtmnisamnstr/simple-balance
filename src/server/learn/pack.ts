import { z } from "zod";
import vendored from "./learn-pack.json" with { type: "json" };

/**
 * The money guides smpl.money publishes at `/learn`, as this server carries
 * them.
 *
 * **JSON imported, not a file read.** `tsc` emits an imported JSON module into
 * `dist` beside the code that imports it, so the guides reach the image through
 * the `COPY` of `dist` that is already there and are read from memory: no `fs`
 * call, nothing for a read-only root filesystem to refuse, and no path that
 * differs between `tsx` and the built server. A `.ts` module of string literals
 * would do the same and would count two thousand lines of the site's prose
 * toward this repository's comment density; `.md` files would need a copy step
 * `tsc` does not have.
 *
 * **Parsed once, at load.** A pack that does not parse is a server that does not
 * start, which is the right failure: `tests/learn-pack.test.ts` parses the same
 * file on every run, so a malformed pack fails CI long before an image carries
 * it, and the alternative is a tool that answers with half a guide.
 *
 * Not in `src/shared`, because the browser has no use for a hundred kilobytes of
 * text it would have to bundle.
 */
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const learnPackSchema = z.object({
  format: z.literal("simple-balance-learn-pack-1"),
  source: z.object({
    /** Where the guides are published; every copy's links point there. */
    site: z.string().min(1),
    /** The site itself, or the local build a preview pack was taken from. */
    from: z.string().min(1),
    /** When that build or that copy was made, where the source said. */
    builtAt: z.string().nullable(),
    llmsSha256: sha256Schema,
    syncedAt: isoDateSchema,
    license: z.string().min(1),
  }),
  articles: z
    .array(
      z.object({
        slug: z.string().regex(/^[a-z0-9-]+$/),
        title: z.string().min(1),
        description: z.string().min(1),
        url: z.string().min(1),
        updated: isoDateSchema,
        /** Over the copy's exact bytes, so a hand edit fails its own hash. */
        sha256: sha256Schema,
        /** The `###` steps under "How to do it in Simple Balance", as the site wrote them. */
        steps: z.array(z.string().min(1)),
        lines: z.array(z.string()),
      }),
    )
    .min(1),
});

export type LearnPack = z.infer<typeof learnPackSchema>;

export const LEARN_PACK: LearnPack = learnPackSchema.parse(vendored);
