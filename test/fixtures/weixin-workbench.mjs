// Test driver ONLY. All writes go to a newly created private WB_DATA_DIR.
import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
const dataDir = process.env.WB_DATA_DIR;
if (!dataDir || !basename(dataDir).startsWith('codex-tern-weixin-')) throw Error('An isolated test WB_DATA_DIR is required');
const input = JSON.parse(readFileSync(0, 'utf8'));
const root = process.argv[2];
const { channelStore } = await import(pathToFileURL(resolve(root, 'runtime/weixin/store.mjs')));
const { relayTargets, relayControl, relaySchema, relaySweep, queueMessage } = await import(pathToFileURL(resolve(root, 'runtime/weixin/relay.mjs')));
const store = channelStore(dataDir);
try {
  relaySchema(store);
  let result;
  if (input.action === 'bind') { store.bind({ bot_token: 'isolated-test-token', ilink_bot_id: 'fixture', ilink_user_id: 'fixture-owner', baseurl: 'https://ilinkai.weixin.qq.com' }); result = { bound: true }; }
  else if (input.action === 'send') result = queueMessage(store, input.ref, input.text, input.inbox);
  else if (input.action === 'control') {
    // The native integration tests model a user who has read the complete
    // request. Keep the production details-before-consent rule intact.
    if (input.deliverDetails === true) {
      const code = /^(?:允许|回答) (R-[a-f0-9]{16})(?:\s|$)/.exec(input.text)?.[1];
      if (!code) throw Error('Fixture details delivery requires an exact request code');
      relayControl(store, { id: 'details-' + input.inbox, text: '详情 ' + code });
      const details = store.get('SELECT text FROM outbox WHERE id=?', 'relay-detail-' + code + ':0');
      if (!details?.text) throw Error('Fixture did not receive complete request details');
      store.run("UPDATE outbox SET status='sent' WHERE id LIKE ?", 'relay-detail-' + code + ':%');
    }
    result = { handled: relayControl(store, { id: input.inbox, text: input.text }) };
  }
  else if (input.action === 'sweep') {
    if (input.expire) store.run("UPDATE relay_commands SET updated_at='1970-01-01T00:00:00.000Z' WHERE id=?", input.expire);
    relaySweep(store); result = { swept: true };
  } else if (input.action === 'state') result = {
    targets: relayTargets(store), snapshots: store.all('SELECT ref,data,updated_at FROM relay_targets').map(row => ({ ref: row.ref, updated_at: row.updated_at, ...JSON.parse(row.data) })),
    notices: store.all('SELECT code,kind,status,target,data FROM relay_notices').map(row => ({ ...row, data: JSON.parse(row.data) })),
    commands: store.all('SELECT id,status,result FROM relay_commands'), outbox: store.all('SELECT text,status FROM outbox'),
  };
  else throw Error('Unsupported test action');
  process.stdout.write(JSON.stringify(result));
} finally { store.close(); }
