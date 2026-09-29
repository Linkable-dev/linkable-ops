import test from "node:test";
import assert from "node:assert/strict";
import { searchState } from "../lib/prospector-run.js";

const at = (min) => new Date(Date.UTC(2026, 8, 29, 11, 0) + min * 60_000).toISOString();
const now = Date.parse(at(0));

test("never pressed: available, nothing running", () => {
  assert.deepEqual(searchState({ requestedAt: null, feedUpdatedAt: at(-60), now }),
    { requestedAt: null, running: false, availableAt: null });
});

test("pressed and the worker has not reported since: running, then cooling down", () => {
  const s = searchState({ requestedAt: at(-5), feedUpdatedAt: at(-60), now });
  assert.equal(s.running, true);
  assert.equal(s.availableAt, at(25));
});

test("the worker reported after the press: done, still cooling down", () => {
  const s = searchState({ requestedAt: at(-10), feedUpdatedAt: at(-2), now });
  assert.equal(s.running, false);
  assert.equal(s.availableAt, at(20));
});

test("half an hour after the press the button is back", () => {
  const s = searchState({ requestedAt: at(-31), feedUpdatedAt: at(-20), now });
  assert.equal(s.running, false);
  assert.equal(s.availableAt, null);
});

test("a run that never reported is not 'running' for ever", () => {
  const s = searchState({ requestedAt: at(-26), feedUpdatedAt: at(-60), now });
  assert.equal(s.running, false, "25 minutes without a report reads as finished (failed), not running");
});
