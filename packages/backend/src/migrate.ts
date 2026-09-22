import { postgres, migrate } from "./db.js";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = postgres(process.env.DATABASE_URL);
try {
  await migrate(db);
  console.log("Database schema ready");
} finally {
  await db.close();
}
