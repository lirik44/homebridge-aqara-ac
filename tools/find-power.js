// Which trait moves the P field of the state word. Each candidate is written the other value it
// declares, the state word is read back, and whatever was there before is put back - so the air
// conditioner spends at most a few seconds in the wrong state, and only if the trait works.
//
// Run: AQARA_EMAIL=... AQARA_PASSWORD=... AQARA_REGION=RU node tools/find-power.js <hubDid>

import { AqaraCloud } from '../src/cloud/client.js';

const hub = process.argv[2] ?? 'lumi3.9cb7fc17db2b179d';
const STATE = '3.132.32922';

// Everything on the endpoint that is not already accounted for as temperature, name or subtype.
const CANDIDATES = [
  { path: '3.130.33012', values: ['0', '1'] },
  { path: '3.142.32951', values: ['0', '1', '2', '3'] },
  { path: '3.132.32920', values: ['0', '1'] },
  { path: '3.130.32915', values: ['0', '1'] },
  { path: '3.141.32947', values: ['0', '1', '2', '3', '4', '5'] },
];

const cloud = new AqaraCloud({ region: process.env.AQARA_REGION ?? 'RU' });
const { token } = await cloud.login(process.env.AQARA_EMAIL, process.env.AQARA_PASSWORD);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const powerOf = word => word?.match(/^P(\d)/)?.[1];

async function readState() {
  const [trait] = await cloud.readTraits(token, hub, [STATE]);
  return trait?.value;
}

async function readOne(path) {
  const [trait] = await cloud.readTraits(token, hub, [path]);
  return trait?.value;
}

async function write(path, value) {
  const body = `{"deviceId": ${JSON.stringify(hub)}, "traits": [{"path": ${JSON.stringify(path)}, "value": ${JSON.stringify(String(value))}}]}`;
  return cloud.signedRequest('POST', `${cloud.area.server}/app/v1.0/lumi/app/qlink/trait/write`, { signSource: body, body, token });
}

const startedAt = await readState();
console.log(`The air conditioner starts at ${startedAt} (power ${powerOf(startedAt)})\n`);

for (const { path, values } of CANDIDATES) {
  const before = await readOne(path);
  const stateBefore = await readState();
  const other = values.find(v => v !== String(before)) ?? values[0];

  console.log(`${path}: ${JSON.stringify(before)} -> ${other}`);

  try {
    await write(path, other);
  } catch (error) {
    console.log(`  refused: ${error.message.slice(0, 100)}\n`);
    continue;
  }

  await sleep(4000);
  const stateAfter = await readState();
  const moved = powerOf(stateAfter) !== powerOf(stateBefore);

  console.log(`  state ${stateBefore} -> ${stateAfter}`);
  console.log(moved ? '  => THIS MOVES THE POWER' : '  => power unchanged');

  // Put it back whatever happened, so nothing is left switched.
  if (before !== undefined) {
    await write(path, before);
    await sleep(3000);
  }
  console.log(`  restored, state now ${await readState()}\n`);
}

const endedAt = await readState();
console.log(`Finished at ${endedAt} (power ${powerOf(endedAt)}), started at ${startedAt}`);
