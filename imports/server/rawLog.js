import { mkdir, appendFile } from "node:fs/promises"
import { dirname, join } from "node:path"

// rawLog.js currently does three things:

// Defines canonical raw log paths.
// Exports those paths for other modules.
// Implements write logic (appendRawRecord) to append normalized NDJSON records.
// So it acts as both path registry and raw-log writer utility.

const RAW_LOG_PATHS_BY_SOURCE = {
  osx_messages_app: join(process.cwd(), "data/raw/hot-osx_messages_app.ndjson"),
  sim_router: join(process.cwd(), "data/raw/hot-sim_router.ndjson"),
}

const SCHEMA_VERSION = 1

// SCHEMA VERSION defines a fixed version tag added to each raw log record (schema_version), so readers/importers know which record format they’re parsing. You bump SCHEMA_VERSION when you introduce a breaking/raw-format change, then update importer logic to handle the new version (or both versions during migration).

// That manual bump is useful because it forces an explicit decision: “is this a schema change that downstream code must know about?”

function resolveTargetPath(source) {
  const targetPath = RAW_LOG_PATHS_BY_SOURCE[source]

  if (!targetPath) {
    throw new Error(
      `Unsupported source: ${source}. We need to know who's sending data, because we're only explicitly writing to two files : one for data coming from the osx messages app (primary phone), and another for data coming from the sim card router (fallback phone). Only supported sources are : 'osx_messages_app' and 'sim_router'`,
    )
  }

  return targetPath
}

export async function appendRawRecord({ source, phoneNumberId, receivedAt, sender, body, meta } = {}) {
  const targetPath = resolveTargetPath(source)

  await mkdir(dirname(targetPath), { recursive: true })

  const record = {
    source,
    // source is the only input data that will throw if it's missing (because we need to know to which log file we're writing)
    phoneNumberId: phoneNumberId ?? null,
    receivedAt: receivedAt ?? null,
    sender: sender ?? null,
    body: typeof body === "string" ? body : body == null ? "" : String(body),
    meta: meta ?? {},
    schema_version: SCHEMA_VERSION,
    ingestedAt: new Date().toISOString(),
  }

  await appendFile(targetPath, `${JSON.stringify(record)}\n`, "utf8")
}

export const RAW_LOG_HOT_FILES = {
  osx_messages_app: RAW_LOG_PATHS_BY_SOURCE.osx_messages_app,
  sim_router: RAW_LOG_PATHS_BY_SOURCE.sim_router,
}
