import { readFileSync } from "node:fs";
import path from "node:path";

import { blankComments } from "./source.js";

/**
 * Reading a Pulumi program as text, which is how this repository checks the
 * things Pulumi's own types cannot say.
 *
 * The programs cannot be imported: they need `@pulumi/pulumi` from
 * `deploy/pulumi/node_modules`, which the job running this suite does not
 * install, and half of what matters is a resource *option* rather than a value
 * — `protect`, `ignoreChanges`, `deleteBeforeReplace` — which no render would
 * show anyway. So the rules that would otherwise be nobody's are held here, on
 * the source.
 *
 * Shared rather than copied into each file because there are five readers now —
 * the two program suites, the cloud-init suite, and the encryption and ingress
 * suites — and a call finder that is subtly wrong in one copy is a test that
 * reads the wrong declaration and passes.
 */

const root = path.resolve(import.meta.dirname, "..", "..");

export const readProgram = (relative: string) => readFileSync(path.join(root, relative), "utf8");

export const AWS_SINGLE = "deploy/pulumi/aws-single/index.ts";
export const OCI_SINGLE = "deploy/pulumi/oci-single/index.ts";

/** The three `ha` programs, one per managed-Kubernetes cloud. */
export const AWS_CLUSTER = "deploy/pulumi/aws/index.ts";
export const GCP_CLUSTER = "deploy/pulumi/gcp/index.ts";
export const OCI_CLUSTER = "deploy/pulumi/oci/index.ts";

/**
 * The program with every comment blanked to spaces, for a check about what it
 * does rather than what it says.
 *
 * `docs/standards/code/comments.md` asks for comments at a density that makes
 * this necessary: "the word `instance` appears nowhere in this resource" is a
 * fair rule about code and a false alarm against the paragraph explaining why
 * the instance is somewhere else. Blanked rather than deleted so that every
 * offset still lines up with the original, which is what lets the two be used
 * against each other.
 */
export const programCode = (program: string) => blankComments(program);

/**
 * Every `new <kind>(...)` call in a program, each from `new` to its matching
 * close paren.
 *
 * Found by counting parentheses rather than by looking for a `);` at the start
 * of a line, which is what these suites used to do. That worked while every
 * resource was declared at the top level; the database node's are declared
 * inside a conditional and a ternary, whose calls close at an indent and with
 * no semicolon — so the old reader ran on past the end into the next
 * declaration, and a check written about one resource silently read another and
 * passed.
 *
 * Counted on the blanked copy, so a parenthesis inside a comment cannot
 * unbalance it, and sliced out of the original, so what comes back is what
 * somebody reads.
 */
export function resourceCalls(program: string, kind: string): string[] {
  const code = programCode(program);
  const calls: string[] = [];
  const opening = `new ${kind}(`;
  for (let at = code.indexOf(opening); at > -1; at = code.indexOf(opening, at + 1)) {
    calls.push(program.slice(at, callEnd(code, at + opening.length - 1)));
  }
  return calls;
}

/** The same calls with their comments blanked, for the checks that are about code. */
export const resourceCallsCode = (program: string, kind: string) =>
  resourceCalls(program, kind).map(programCode);

/**
 * Where the call opened at `open` closes.
 *
 * A quote is skipped whole, because a parenthesis inside one is text: the
 * programs' `nextSteps` are pages of prose in a template literal, and several
 * of their sentences have a bracket in them. Comments are already spaces by the
 * time this runs.
 */
function callEnd(code: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let at = open; at < code.length; at += 1) {
    const character = code[at]!;
    if (quote) {
      if (character === "\\") at += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return code.length;
}
