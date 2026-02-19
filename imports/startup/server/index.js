import { Meteor } from 'meteor/meteor';

import { ensureMessagesIndexes } from '/imports/api/messages/server/indexes';
import { getDataDir } from '/imports/server/filePaths';
import { startMessagesPoller } from '/imports/startup/server/jobs/messagesPoller';

Meteor.startup(async () => {
  console.info(`[storage] data dir: ${getDataDir()}`);
  await ensureMessagesIndexes();
  await startMessagesPoller();
});
