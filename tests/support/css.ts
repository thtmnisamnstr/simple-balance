import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Reading the stylesheet the way the tests here need to read it.
 *
 * Four tests grew their own parser, and all four were the same regex:
 * `/([^{}]+)\{([^{}]*)\}/g`. It cannot see nesting. Given
 * `@media (prefers-color-scheme: dark) { :root { --ink: white } }` it reports a
 * top-level `:root` rule and drops the at-rule that qualifies it, so a token
 * defined only under a media query reads as though it were unconditional. Every
 * guard about two themes turns on exactly that distinction, so the parser has to
 * carry the enclosing at-rules rather than discard them.
 *
 * Two of those tests also matched a rule by the first occurrence of a substring,
 * which made them depend on where in a 3000-line file a rule happens to sit. A
 * test that fails because a block moved is a test that fails for the wrong
 * reason.
 */
export type Block = {
  /** The selector as written, e.g. `:root[data-theme="dark"]`. */
  selector: string;
  /** The declarations between its braces, unparsed. */
  body: string;
  /** Enclosing at-rules, outermost first. Empty for a top-level rule. */
  context: string[];
};

/**
 * jsdom gives `import.meta.url` an http origin and `readFileSync` refuses it,
 * so the path is joined from this directory rather than resolved as a URL. That
 * lets a jsdom test and a node test share this.
 */
export function stylesheet() {
  return readFileSync(path.join(import.meta.dirname, "..", "..", "src/client/styles.css"), "utf8");
}

export function blocks(css: string): Block[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: Block[] = [];
  const walk = (text: string, context: string[]) => {
    let depth = 0;
    let start = 0;
    let bodyStart = 0;
    let selector = "";
    for (let i = 0; i < text.length; i++) {
      const character = text[i];
      if (character === "{") {
        if (depth === 0) {
          selector = text.slice(start, i).trim();
          bodyStart = i + 1;
        }
        depth++;
      } else if (character === "}") {
        depth--;
        if (depth === 0) {
          const body = text.slice(bodyStart, i);
          // An at-rule that contains rules is a wrapper; one that contains
          // declarations (@font-face, a keyframe step) is a rule in its own right.
          if (selector.startsWith("@") && body.includes("{")) {
            walk(body, [...context, selector]);
          } else {
            found.push({ selector, body, context });
          }
          start = i + 1;
        }
      }
    }
  };
  walk(clean, []);
  return found;
}

/** The one top-level rule whose selector is exactly this, by selector not position. */
export function ruleFor(css: string, selector: string) {
  const matches = blocks(css).filter(
    (block) =>
      block.context.length === 0 &&
      block.selector
        .split(",")
        .map((one) => one.trim())
        .includes(selector),
  );
  return matches;
}

/** Every `--custom-property` declared by blocks the predicates accept. */
export function tokensIn(css: string, matches: (block: Block) => boolean): Record<string, string> {
  const found: Record<string, string> = {};
  for (const block of blocks(css)) {
    if (!matches(block)) continue;
    for (const declaration of block.body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+)/gi)) {
      found[declaration[1]!] = declaration[2]!.trim();
    }
  }
  return found;
}
