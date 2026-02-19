import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Meteor } from 'meteor/meteor';

const DEFAULT_DATA_DIR = join(homedir(), '.sms-third-prototype-data');
const DATA_DIR = process.env.METEOR_DATA_DIR ?? Meteor.settings?.dataDir ?? DEFAULT_DATA_DIR;

let ensured = false;

export function ensureDataDir() {
  if (!ensured) {
    mkdirSync(DATA_DIR, { recursive: true });
    ensured = true;
  }

  return DATA_DIR;
}

export function dataPath(...parts) {
  return join(ensureDataDir(), ...parts);
}

export function getDataDir() {
  return ensureDataDir();
}
