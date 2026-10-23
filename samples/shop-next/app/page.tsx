import { products } from "../src/catalog";

export default function Home() {
  return (
    <main>
      <h1>فروشگاه</h1>
      <ul>{products.map((p) => <li key={p.id}>{p.name} — {p.price} تومان</li>)}</ul>
    </main>
  );
}
