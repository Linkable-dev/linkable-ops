// The verified facts about Linkable (data/blog/facts.md): the only things an
// automatic writer here may state as facts. Read once.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let factsCache = null;

export function facts() {
  if (factsCache == null) factsCache = readFileSync(join(here, "..", "data", "blog", "facts.md"), "utf-8");
  return factsCache;
}
