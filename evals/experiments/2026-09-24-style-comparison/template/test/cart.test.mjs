import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/cart.mjs";

const items = [{ price: 10000, qty: 2 }, { price: 5000, qty: 1 }];

test("쿠폰 없이 합계", () => assert.equal(total(items), 25000));
test("10% 쿠폰", () => assert.equal(total(items, { rate: 0.1 }), 22500));
