// Cart helpers used by /cart and the checkout API.
//
// Items come from src/catalog.ts. The CMS sends prices as text, which is why
// `price` is typed as string | number here.

export interface CartItem {
  id: number;
  name: string;
  price: string | number;
}

export function itemCount(items: CartItem[]): number {
  return items.length;
}

export function isEmpty(items: CartItem[]): boolean {
  return items.length === 0;
}

// FAULT cart_total_string_concat: prices are strings, so `+=` concatenates
// ("0" + "1000" + "200" = "01000200"). Fixed by converting to a number.
// See samples/shop-next/FAULTS.md.

export function total(items: CartItem[]) {
  let sum: any = 0;
  for (const i of items) sum += i.price;
  return sum;
}
