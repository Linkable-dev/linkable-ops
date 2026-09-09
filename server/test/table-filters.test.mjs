import test from "node:test";
import assert from "node:assert/strict";
import { textFilter, numberFilter, dateFilter, boolFilter, minNumberFilter } from "../lib/tableQuery.js";

const run = (build, raw, start = []) => { const p = [...start]; return { sql: build(p, raw), params: p }; };

test("text: bare value is contains (unchanged behaviour)", () => {
  const r = run(textFilter("u.email"), "acme");
  assert.match(r.sql, /u\.email ILIKE \$1/);
  assert.deepEqual(r.params, ["%acme%"]);
});
test("text: operators", () => {
  assert.deepEqual(run(textFilter("a"), "starts:ac").params, ["ac%"]);
  assert.deepEqual(run(textFilter("a"), "ends:me").params, ["%me"]);
  const is = run(textFilter("a"), "is:Acme");
  assert.match(is.sql, /LOWER\(a::text\) = LOWER\(\$1\)/);
  assert.deepEqual(is.params, ["Acme"]);
});
test("text: a % in an 'is' term cannot act as a wildcard", () => {
  const r = run(textFilter("a"), "is:50%");
  assert.ok(!/ILIKE/.test(r.sql));
  assert.deepEqual(r.params, ["50%"]);
});
test("text: empty / notempty need no params", () => {
  assert.deepEqual(run(textFilter("a", "b"), "empty").params, []);
  assert.match(run(textFilter("a"), "notempty").sql, /^NOT /);
});
test("text: multi-expression OR shares one placeholder", () => {
  const r = run(textFilter("b.store_name", "b.store_website"), "acme");
  assert.equal(r.params.length, 1);
  assert.equal((r.sql.match(/\$1/g) || []).length, 2);
});
test("number: bare value still means >= (minNumberFilter compat)", () => {
  const r = run(minNumberFilter("f"), "1000");
  assert.match(r.sql, /f >= \$1/);
  assert.deepEqual(r.params, [1000]);
});
test("number: operators and range", () => {
  assert.match(run(numberFilter("f"), "<=5").sql, /f <= \$1/);
  assert.match(run(numberFilter("f"), "=5").sql, /f = \$1/);
  const btw = run(numberFilter("f"), "10..2");
  assert.match(btw.sql, /BETWEEN \$1 AND \$2/);
  assert.deepEqual(btw.params, [2, 10], "reversed range is normalised");
});
test("number: junk is skipped rather than 500ing", () => {
  assert.equal(run(numberFilter("f"), "abc").sql, null);
});
test("date: relative windows", () => {
  const last = run(dateFilter("t"), "last:30");
  assert.match(last.sql, /t >= NOW\(\) - \(\$1 \|\| ' days'\)::interval/);
  assert.deepEqual(last.params, [30]);
  assert.match(run(dateFilter("t"), "before:30").sql, /t IS NULL OR/, "never-signed-in counts as before");
});
test("date: <= covers the whole closing day", () => {
  assert.match(run(dateFilter("t"), "<=2026-03-03").sql, /< \(\$1::date \+ INTERVAL '1 day'\)/);
  assert.match(run(dateFilter("t"), "2026-03-01..2026-03-03").sql, /\+ INTERVAL '1 day'/);
});
test("date: rejects anything that is not a date", () => {
  assert.equal(run(dateFilter("t"), "2026-3-1").sql, null);
  assert.equal(run(dateFilter("t"), "'; DROP TABLE users; --").sql, null);
});
test("no builder ever splices raw input into SQL", () => {
  const evil = "'; DROP TABLE users; --";
  for (const b of [textFilter("a"), numberFilter("a"), dateFilter("a"), boolFilter("a")]) {
    const r = run(b, evil);
    assert.ok(r.sql === null || !r.sql.includes("DROP"), `leaked: ${r.sql}`);
  }
});
test("placeholders continue an existing params array", () => {
  const r = run(textFilter("a"), "x", ["%search%", 50, 0]);
  assert.match(r.sql, /\$4/);
});
test("bool", () => {
  assert.match(run(boolFilter("a"), "yes").sql, /= true/);
  assert.match(run(boolFilter("a"), "no").sql, /= false/);
  assert.equal(run(boolFilter("a"), "maybe").sql, null);
});
