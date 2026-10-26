import { IN_SIMPLE_BALANCE } from "../learn/in-simple-balance.js";
import { LEARN_PACK } from "../learn/pack.js";
import { notFound } from "./errors.js";

/**
 * The money guides, read out of the pack this server carries.
 *
 * **No actor, and no database.** These read nothing of anybody's: the text is
 * the marketing site's, the same for every caller, and it is in memory. So the
 * functions take no actor and import nothing under `src/server/db`, and
 * `tests/mcp-learn.test.ts` holds that by reading this file's imports. "Never
 * accept a public userId" and "scope every finance read by it" have nothing to
 * scope here; a guide that started reading a ledger would be a different
 * function, and that test is where it would have to be argued.
 *
 * Whether the connection holds each mapped tool is not decided here. It is a
 * fact about the caller's grant, which only the transport has, the same way
 * `whoami`'s scopes are merged in the transport adapter rather than in
 * `getIdentity`.
 */
const articles = LEARN_PACK.articles.map((article) => ({
  summary: {
    slug: article.slug,
    title: article.title,
    description: article.description,
    url: article.url,
    updated: article.updated,
  },
  // Joined once rather than per call: the pack keeps lines for the sake of a
  // readable diff, and the copy an agent is handed is the site's exact bytes.
  markdown: article.lines.join("\n"),
}));

/**
 * Every guide, in the site's reading order, as one page.
 *
 * A `Page` with no next cursor rather than a bare array, because a listing
 * added now uses one of the two envelopes `http.md` allows. Twelve guides fit
 * in one reply with room to spare, so there is never a second page to ask for.
 */
export function listLearnArticles() {
  return { items: articles.map((article) => article.summary), nextCursor: null };
}

/**
 * One guide in full, with the tools that do each of its Simple Balance steps.
 *
 * An unknown slug names the ones there are, because the only way an agent
 * meets this refusal is by guessing a slug, and the list is the correction.
 */
export function getLearnArticle(slug: string) {
  const article = articles.find((candidate) => candidate.summary.slug === slug);
  if (!article) {
    throw notFound("No guide has that slug. `list_learn_articles` lists the ones there are.", {
      slug,
      available: articles.map((candidate) => candidate.summary.slug),
    });
  }
  return {
    ...article.summary,
    syncedAt: LEARN_PACK.source.syncedAt,
    markdown: article.markdown,
    inSimpleBalance: (IN_SIMPLE_BALANCE[slug] ?? []).map(({ step, how, tools }) => ({
      step,
      how,
      tools: [...tools],
    })),
  };
}
