import assert from "node:assert/strict";
import test from "node:test";
import {
  ENTRY_PRICE_AGGRESSION_PUSD,
  MAX_ENTRY_PRICE_PUSD,
  MIN_ENTRY_PRICE_PUSD,
  calculateEntryLimitPrice,
  isEntryPriceWithinBand,
} from "../src/lib/entry-price-band.ts";

test("entry price band includes both configured boundaries", () => {
  assert.equal(isEntryPriceWithinBand(MIN_ENTRY_PRICE_PUSD), true);
  assert.equal(isEntryPriceWithinBand(MAX_ENTRY_PRICE_PUSD), true);
});

test("entry price band rejects prices outside the configured boundaries", () => {
  assert.equal(isEntryPriceWithinBand(0.39), false);
  assert.equal(isEntryPriceWithinBand(0.83), false);
  assert.equal(isEntryPriceWithinBand(Number.NaN), false);
});

test("entry limit adds two cents without exceeding the hard cap", () => {
  assert.equal(calculateEntryLimitPrice(0.4), 0.42);
  assert.equal(calculateEntryLimitPrice(0.7), 0.7 + ENTRY_PRICE_AGGRESSION_PUSD);
  assert.equal(calculateEntryLimitPrice(0.8), MAX_ENTRY_PRICE_PUSD);
  assert.equal(calculateEntryLimitPrice(MAX_ENTRY_PRICE_PUSD), MAX_ENTRY_PRICE_PUSD);
  assert.equal(calculateEntryLimitPrice(0.83), null);
});