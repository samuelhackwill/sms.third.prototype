import { Meteor } from 'meteor/meteor';

import { ensureMessagesIndexes } from '/imports/api/messages/server/indexes';
import '/imports/api/messages/methods';
import '/imports/api/messages/publications';
import { ensureApnsIndexes } from '/imports/api/apns/server/indexes';
import '/imports/api/apns/methods';
import '/imports/api/apns/publications';
import '/imports/api/video/methods';
import '/imports/api/wall/publications';
import { ensureTickerIndexes } from '/imports/api/ticker/server/indexes';
import '/imports/api/ticker/methods';
import '/imports/api/ticker/publications';
import '/imports/api/television/methods';
import '/imports/api/television/publications';
import { getDataDir } from '/imports/server/filePaths';
import '/imports/startup/server/apns';
import { startMessagesPoller } from '/imports/startup/server/jobs/messagesPoller';

Meteor.startup(async () => {
  console.info(`[storage] data dir: ${getDataDir()}`);
  await ensureMessagesIndexes();
  await ensureApnsIndexes();
  await ensureTickerIndexes();
  await startMessagesPoller();
});
