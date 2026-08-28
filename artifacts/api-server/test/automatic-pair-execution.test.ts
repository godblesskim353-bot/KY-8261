import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ENTRY_PRICE_PUSD,
  MIN_ENTRY_PRICE_PUSD,
  isEntryPriceWithinBand,
} from "../src/lib/entry-price-band.ts";

test("entry price band includes both configured boundaries", () => {
  assert.equal(isEntryPriceWithinBand(MIN_ENTRY_PRICE_PUSD), true);
  assert.equal(isEntryPriceWithinBand(MAX_ENTRY_PRICE_PUSD), true);
});

test("entry price band rejects prices outside the configured boundaries", () => {
  assert.equal(isEntryPriceWithinBand(0.39), false);
  assert.equal(isEntryPriceWithinBand(0.76), false);
  assert.equal(isEntryPriceWithinBand(Number.NaN), false);
});