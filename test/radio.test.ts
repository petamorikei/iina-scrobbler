import assert from "node:assert/strict";
import { test } from "vitest";
import { IcyTitleTracker, parseIcyTitle, RADIO_REPEAT_WINDOW_MS } from "../src/main/radio.ts";

test("parseIcyTitle splits 'Artist - Title' and rejects non-song titles", () => {
  assert.deepEqual(parseIcyTitle("Keston And Westdal - Vaccine"), { artist: "Keston And Westdal", title: "Vaccine" });
  assert.deepEqual(parseIcyTitle("Moon Boots - The Life Aquatic (Radio Edit)"), {
    artist: "Moon Boots",
    title: "The Life Aquatic (Radio Edit)",
  });
  assert.equal(parseIcyTitle(""), null);
  assert.equal(parseIcyTitle("Groove Salad"), null);
});

test("the tracker reports new songs, unchanged titles, and titles that are not songs", () => {
  const t = new IcyTitleTracker();
  assert.deepEqual(t.update("", 0), { type: "same" }); // icy-title arrives a few seconds late
  const first = t.update("A - One", 1000);
  assert.equal(first.type, "new");
  assert.deepEqual(t.update("A - One", 2000), { type: "same" });
  assert.deepEqual(t.update("a - one", 3000), { type: "same" }); // case-insensitive
  assert.equal(t.update("B - Two", 4000).type, "new");
  assert.deepEqual(t.update("Station ID", 5000), { type: "end" });
  assert.deepEqual(t.update("Station ID", 6000), { type: "same" });
});

test("a song already scrobbled comes back as alreadyScrobbled within the window", () => {
  const t = new IcyTitleTracker();
  const one = t.update("A - One", 0);
  assert.ok(one.type === "new" && !one.alreadyScrobbled);
  if (one.type === "new") t.markScrobbled(one.key, 40_000);
  t.update("Station ID", 200_000);
  const again = t.update("A - One", 210_000);
  assert.ok(again.type === "new" && again.alreadyScrobbled);
  t.update("B - Two", 220_000);
  const later = t.update("A - One", 40_000 + RADIO_REPEAT_WINDOW_MS + 1);
  assert.ok(later.type === "new" && !later.alreadyScrobbled);
});
