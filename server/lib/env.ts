import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Repo-root .env first (where the keys live), then a local one. Existing process env always wins.
for (const p of ["../.env", ".env"]) {
  if (existsSync(p)) {
    try {
      process.loadEnvFile(resolve(p));
    } catch {
      /* unreadable env file: fall through to process env */
    }
  }
}

export const BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
