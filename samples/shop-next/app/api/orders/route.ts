import { query } from "../../../src/db";

export async function GET() {
  const rows = await query("SELECT id, total FROM orders ORDER BY id DESC LIMIT 20");
  return Response.json(rows);
}
