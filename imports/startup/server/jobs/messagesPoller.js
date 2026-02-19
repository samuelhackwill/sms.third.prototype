import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Meteor } from 'meteor/meteor';
import sqlite3 from 'sqlite3';

import { appendRawRecord } from '/imports/server/rawLog';

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1, 0, 0, 0, 0);
const NS_THRESHOLD = 1e12;
const DEFAULT_DB_PATH = join(homedir(), 'Library/Messages/chat.db');
const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_BATCH_SIZE = 200;

const state = {
  running: false,
  tickTimer: null,
  inFlight: false,
  db: null,
  dbPath: null,
  lastRowId: 0,
  intervalMs: DEFAULT_INTERVAL_MS,
  batchSize: DEFAULT_BATCH_SIZE,
};

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePollerConfig() {
  const env = process.env;
  const settings = Meteor.settings?.messagesPoller ?? {};
  const pausedValue = env.MESSAGES_POLLER_PAUSED ?? settings.paused;
  const dbPathValue = env.MESSAGES_DB_PATH ?? settings.dbPath;
  const intervalValue = env.MESSAGES_POLLER_INTERVAL_MS ?? settings.intervalMs;
  const batchSizeValue = env.MESSAGES_POLLER_BATCH_SIZE ?? settings.batchSize;

  return {
    paused: toBool(pausedValue, false),
    dbPath: dbPathValue ?? DEFAULT_DB_PATH,
    intervalMs: Math.max(100, toInt(intervalValue, DEFAULT_INTERVAL_MS)),
    batchSize: Math.max(1, toInt(batchSizeValue, DEFAULT_BATCH_SIZE)),
  };
}

function openDatabase(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(db);
    });
  });
}

function getAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row ?? null);
    });
  });
}

function allAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows ?? []);
    });
  });
}

function closeAsync(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        reject(err);
        return;
      }

      resolve();
    });
  });
}

function jsDateToAppleSeconds(date) {
  return Math.floor((date.getTime() - APPLE_EPOCH_MS) / 1000);
}

function appleDateValueToIso(rawValue) {
  const value = Number(rawValue ?? 0);

  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  const seconds = Math.abs(value) > NS_THRESHOLD ? value / 1_000_000_000 : value;
  const timestampMs = APPLE_EPOCH_MS + (seconds * 1000);

  if (!Number.isFinite(timestampMs)) {
    return null;
  }

  return new Date(timestampMs).toISOString();
}

async function initializeCursorAtBootTime(db, bootTime) {
  const bootSeconds = jsDateToAppleSeconds(bootTime);
  const bootNanoseconds = bootSeconds * 1_000_000_000;

  const row = await getAsync(
    db,
    `
      SELECT IFNULL(MAX(m.ROWID), 0) AS maxRowId
      FROM message m
      WHERE (
        CASE
          WHEN ABS(COALESCE(m.date, 0)) > ? THEN COALESCE(m.date, 0) <= ?
          ELSE COALESCE(m.date, 0) <= ?
        END
      )
    `,
    [NS_THRESHOLD, bootNanoseconds, bootSeconds],
  );

  return Number(row?.maxRowId ?? 0);
}

async function fetchRowsSinceCursor(db, lastRowId, limit) {
  return allAsync(
    db,
    `
      SELECT
        m.ROWID AS rowId,
        m.text AS body,
        m.date AS rawDate,
        h.id AS sender,
        m.is_from_me AS isFromMe
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ?
      ORDER BY m.ROWID ASC
      LIMIT ?
    `,
    [lastRowId, limit],
  );
}

async function reconnectDatabase() {
  if (!state.dbPath) {
    return;
  }

  if (state.db) {
    try {
      await closeAsync(state.db);
    } catch (err) {
      console.error('[messagesPoller] Failed to close sqlite DB during reconnect.', err);
    }

    state.db = null;
  }

  state.db = await openDatabase(state.dbPath);
}

async function tickOnce() {
  if (!state.db) {
    return;
  }

  const rows = await fetchRowsSinceCursor(state.db, state.lastRowId, state.batchSize);
  // console.info(
  //   `[messagesPoller] Poll tick (cursor=${state.lastRowId}, fetchedRows=${rows.length}, batchSize=${state.batchSize}).`,
  // );

  for (const row of rows) {
    const rowId = Number(row?.rowId ?? 0);
    // console.info(`[messagesPoller] Read message row (rowId=${rowId}, isFromMe=${Number(row?.isFromMe ?? 0)}).`);

    if (rowId > state.lastRowId) {
      state.lastRowId = rowId;
    }

    if (Number(row?.isFromMe ?? 0) === 1) {
      continue;
    }

    await appendRawRecord({
      source: 'osx_messages_app',
      phoneNumberId: 'primary',
      receivedAt: appleDateValueToIso(row?.rawDate),
      sender: row?.sender ?? null,
      body: row?.body ?? '',
      meta: {
        messagesRowId: rowId,
        rawMessagesDate: row?.rawDate ?? null,
      },
    });
  }
}

function scheduleNextTick() {
  if (!state.running) {
    return;
  }

  state.tickTimer = Meteor.setTimeout(async () => {
    if (!state.running || state.inFlight) {
      scheduleNextTick();
      return;
    }

    state.inFlight = true;

    try {
      await tickOnce();
    } catch (err) {
      console.error('[messagesPoller] Poll tick failed.', err);

      try {
        await reconnectDatabase();
      } catch (reconnectErr) {
        console.error('[messagesPoller] Reconnect failed.', reconnectErr);
      }
    } finally {
      state.inFlight = false;
      scheduleNextTick();
    }
  }, state.intervalMs);
}

export async function startMessagesPoller() {
  if (state.running) {
    return;
  }

  const { paused, intervalMs, batchSize, dbPath } = parsePollerConfig();

  if (paused) {
    console.info('[messagesPoller] Paused (MESSAGES_POLLER_PAUSED is true).');
    return;
  }

  state.intervalMs = intervalMs;
  state.batchSize = batchSize;
  state.dbPath = dbPath;

  try {
    await access(state.dbPath);
  } catch (err) {
    console.error(`[messagesPoller] chat.db not found or unreadable at ${state.dbPath}.`, err);
    return;
  }

  try {
    state.db = await openDatabase(state.dbPath);
    state.lastRowId = await initializeCursorAtBootTime(state.db, new Date());
    state.running = true;

    console.info(
      `[messagesPoller] Started (interval=${state.intervalMs}ms, batchSize=${state.batchSize}, cursor=${state.lastRowId}).`,
    );

    scheduleNextTick();
  } catch (err) {
    console.error('[messagesPoller] Failed to start.', err);

    if (state.db) {
      try {
        await closeAsync(state.db);
      } catch (closeErr) {
        console.error('[messagesPoller] Failed closing DB after start error.', closeErr);
      }

      state.db = null;
    }
  }
}

export async function stopMessagesPoller() {
  if (!state.running && !state.db) {
    return;
  }

  state.running = false;

  if (state.tickTimer) {
    Meteor.clearTimeout(state.tickTimer);
    state.tickTimer = null;
  }

  if (state.db) {
    try {
      await closeAsync(state.db);
    } catch (err) {
      console.error('[messagesPoller] Failed to close DB on stop.', err);
    }

    state.db = null;
  }

  state.inFlight = false;
}

export function isMessagesPollerRunning() {
  return state.running;
}
