// 장바구니 합계를 계산한다.
const cache = new Map();

export function total(items, coupon) {
  const key = JSON.stringify(items);
  if (cache.has(key)) return cache.get(key);
  let sum = 0;
  for (const item of items) sum += item.price * item.qty;
  if (coupon) sum = sum - sum * coupon.rate;
  cache.set(key, sum);
  return sum;
}
