import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";

const baselineTables = [
  "block_head_observations", "collector_checkpoints", "collector_observation_gaps",
  "consensus_views", "rpc_responses", "sources", "view_gaps",
];
const database = new URL("../../db/", import.meta.url);

// Compare catalog details of the original tables before adopting an unversioned installation.
async function baselineShape(client: PoolClient) {
  const result = await client.query<{ table_name: string; shape: unknown }>(
    `
SELECT t.relname AS table_name,
  jsonb_build_object(
    'type', t.relkind::text,
    'columns', (SELECT jsonb_agg(jsonb_build_array(
        a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity::text,
        a.attgenerated::text, pg_get_expr(d.adbin, d.adrelid)
      ) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = t.oid AND d.adnum = a.attnum
      WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped),
    'constraints', (SELECT jsonb_agg(jsonb_build_array(c.conname, c.contype::text,
        pg_get_constraintdef(c.oid), c.convalidated) ORDER BY c.conname COLLATE "C")
      FROM pg_constraint c WHERE c.conrelid = t.oid AND c.contype <> 'n'),
    'indexes', (SELECT jsonb_agg(jsonb_build_array(ix.relname, am.amname, i.indisunique,
        i.indisvalid, pg_get_expr(i.indpred, i.indrelid),
        ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, false)
              FROM generate_series(1, i.indnatts::integer) AS k)
      ) ORDER BY ix.relname COLLATE "C")
      FROM pg_index i JOIN pg_class ix ON ix.oid = i.indexrelid
      JOIN pg_am am ON am.oid = ix.relam WHERE i.indrelid = t.oid)
  ) AS shape
FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = current_schema() AND t.relname = ANY($1::text[])
ORDER BY t.relname COLLATE "C"`,
    [baselineTables],
  );
  return Object.fromEntries(result.rows.map(({ table_name, shape }) => [table_name, shape]));
}

export async function applyMigrations(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(656157301)");
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY CHECK (version > 0),
    name text NOT NULL,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`);

  const names = (await readdir(database)).filter((file) => /^\d{3}_[a-z_]+\.sql$/.test(file)).sort();
  if (names[0] !== "001_init.sql") throw new Error("The baseline migration 001_init.sql is missing");
  const migrations = await Promise.all(names.map(async (name, index) => {
    const version = Number(name.slice(0, 3));
    if (version !== index + 1) throw new Error("Invalid migration sequence at " + name);
    const sql = (await readFile(new URL(name, database), "utf8")).replaceAll("\r\n", "\n");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    return { version, name, sql, sha256 };
  }));
  const applied = await client.query<{ version: number; name: string; sha256: string }>(
    "SELECT version, name, sha256 FROM schema_migrations ORDER BY version",
  );
  for (const [index, row] of applied.rows.entries()) {
    const file = migrations[index];
    if (!file || row.version !== file.version || row.name !== file.name || row.sha256 !== file.sha256) {
      throw new Error("Applied migration does not match the repository at version " + row.version);
    }
  }

  for (const file of migrations.slice(applied.rows.length)) {
    let adoptBaseline = false;
    if (file.version === 1) {
      const actual = await baselineShape(client);
      if (Object.keys(actual).length > 0) {
        const expected = JSON.parse(await readFile(new URL("001_baseline_shape.json", database), "utf8")) as
          Record<string, unknown>;
        const differences = baselineTables.filter((table) => !isDeepStrictEqual(actual[table], expected[table]));
        if (differences.length) throw new Error("Cannot adopt baseline. Check schema for " + differences.join(", "));
        adoptBaseline = true;
      }
    }
    if (!adoptBaseline) await client.query(file.sql);
    await client.query("INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, $2, $3)",
      [file.version, file.name, file.sha256]);
  }
}
