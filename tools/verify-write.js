// Proves the write actually reaches the air conditioner, rather than merely being accepted: nudges
// the target temperature by one degree, reads it back, and puts it where it was.
//
// Run: AQARA_EMAIL=... AQARA_PASSWORD=... AQARA_REGION=RU node tools/verify-write.js <hubDid>

import { AqaraCloud } from '../src/cloud/client.js';

const hub = process.argv[2] ?? 'lumi3.9cb7fc17db2b179d';
const STATE_TRAIT = '3.132.32922';

const cloud = new AqaraCloud({ region: process.env.AQARA_REGION ?? 'RU' });
const { token } = await cloud.login(process.env.AQARA_EMAIL, process.env.AQARA_PASSWORD);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readState() {
  const [trait] = await cloud.readTraits(token, hub, [STATE_TRAIT]);
  return trait?.value;
}

async function writeState(value) {
  const body = `{"deviceId": ${JSON.stringify(hub)}, "traits": [{"path": ${JSON.stringify(STATE_TRAIT)}, "value": ${JSON.stringify(value)}}]}`;
  return cloud.signedRequest('POST', `${cloud.area.server}/app/v1.0/lumi/app/qlink/trait/write`, { signSource: body, body, token });
}

const before = await readState();
console.log(`before: ${before}`);

const temperature = Number(before.match(/_T(\d+)_/)?.[1]);
if (!Number.isFinite(temperature)) {
  console.error(`Could not find a temperature in ${before}; stopping rather than guessing.`);
  process.exit(1);
}

// One degree up, or down if that would leave the range the traits declare (16-32).
const nudged = temperature < 32 ? temperature + 1 : temperature - 1;
const wanted = before.replace(/_T\d+_/, `_T${nudged}_`);

console.log(`writing: ${wanted}`);
await writeState(wanted);

await sleep(3000);
const after = await readState();
console.log(`after:   ${after}`);
console.log(after === wanted ? '\n=> the write took effect' : '\n=> the state did not follow the write');

console.log(`\nrestoring: ${before}`);
await writeState(before);
await sleep(3000);
console.log(`now:     ${await readState()}`);
