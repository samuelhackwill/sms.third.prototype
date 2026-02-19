import { Meteor } from 'meteor/meteor';
import { ensureMessagesIndexes } from '/imports/api/messages/server/indexes';

Meteor.startup(async () => {
  await ensureMessagesIndexes();
});
