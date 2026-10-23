import { Pool } from "pg";

// Required: the app cannot start its order routes without a database.
const connectionString = process.env.DATABASE_URL;

let pool: Pool | null = null;

export async function query(sql: string, params: unknown[] = []) {
  if (!connectionString) throw new Error("DATABASE_URL is not defined");
  pool ??= new Pool({ connectionString });
  const res = await pool.query(sql, params);
  return res.rows;
}
