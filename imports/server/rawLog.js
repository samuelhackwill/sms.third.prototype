import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { dataPath } from '/imports/server/filePaths';

const RAW_LOG_PATHS_BY_SOURCE = {
  osx_messages_app: dataPath('raw', 'hot-osx_messages_app.ndjson'),
  sim_router: dataPath('raw', 'hot-sim_router.ndjson'),
};

const SCHEMA_VERSION = 1;

function resolveTargetPath(source) {
  const targetPath = RAW_LOG_PATHS_BY_SOURCE[source];

  if (!targetPath) {
    throw new Error(
      `Unsupported source: ${source}. Supported sources are: 'osx_messages_app' and 'sim_router'.`,
    );
  }

  return targetPath;
}

export async function appendRawRecord({ source, phoneNumberId, receivedAt, sender, body, meta } = {}) {
  const targetPath = resolveTargetPath(source);
  await mkdir(dirname(targetPath), { recursive: true });

  const record = {
    source,
    phoneNumberId: phoneNumberId ?? null,
    receivedAt: receivedAt ?? null,
    sender: sender ?? null,
    body: typeof body === 'string' ? body : body == null ? '' : String(body),
    meta: meta ?? {},
    schema_version: SCHEMA_VERSION,
    ingestedAt: new Date().toISOString(),
  };

  await appendFile(targetPath, `${JSON.stringify(record)}\n`, 'utf8');
}

export const RAW_LOG_HOT_FILES = {
  osx_messages_app: RAW_LOG_PATHS_BY_SOURCE.osx_messages_app,
  sim_router: RAW_LOG_PATHS_BY_SOURCE.sim_router,
};
