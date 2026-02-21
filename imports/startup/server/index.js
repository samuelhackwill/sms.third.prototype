import { Meteor } from 'meteor/meteor';

import { ensureMessagesIndexes } from '/imports/api/messages/server/indexes';
import { ensureTickerIndexes } from '/imports/api/ticker/server/indexes';
import '/imports/api/ticker/methods';
import '/imports/api/ticker/publications';
import { initTickerStreamerBridge } from '/imports/api/ticker/streamerBridge';
import { getDataDir } from '/imports/server/filePaths';
import { startMessagesPoller } from '/imports/startup/server/jobs/messagesPoller';

Meteor.startup(async () => {
  console.info(`[storage] data dir: ${getDataDir()}`);
  await ensureMessagesIndexes();
  await ensureTickerIndexes();
  initTickerStreamerBridge();
  await startMessagesPoller();
});
