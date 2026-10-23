import { total } from "../../src/cart";
import { products } from "../../src/catalog";

export default function Cart() {
  return <p>جمع سبد: {total(products.slice(0, 2))}</p>;
}
