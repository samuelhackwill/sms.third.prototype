## Run locally

1. Install Meteor.
2. Install npm dependencies:
   ```bash
   meteor npm install
   ```
3. Start the app:
   ```bash
   npm start
   ```

## Runtime data directory

data is written to .data/

## Data model (T-010)

- Canonical collection: `Messages` in `imports/api/messages/messages.js`.
- Indexed fields: unique `id`, plus `receivedAt`, `status`, and `source`.
