// Finds the endpoint that writes a trait, without disturbing anything: every candidate below is
// sent the value the air conditioner already holds, so a path that exists accepts a no-op and a
// path that does not exist answers 404. Only once one of them answers is it worth writing for real.
//
// Run: AQARA_EMAIL=... AQARA_PASSWORD=... AQARA_REGION=RU node tools/probe-write.js <hubDid>

import { AqaraCloud } from '../src/cloud/client.js';

const hub = process.argv[2] ?? 'lumi3.9cb7fc17db2b179d';
const TARGET_TEMPERATURE = '3.141.32948';

const cloud = new AqaraCloud({ region: process.env.AQARA_REGION ?? 'RU' });
const { token } = await cloud.login(process.env.AQARA_EMAIL, process.env.AQARA_PASSWORD);

const [trait] = await cloud.readTraits(token, hub, [TARGET_TEMPERATURE]);
const current = trait?.value;
console.log(`Target temperature reads ${JSON.stringify(current)} - writing that same value back.\n`);

if (current === undefined) {
  console.error('No current value to echo; refusing to guess one.');
  process.exit(1);
}

async function post(path, body) {
  return cloud.signedRequest('POST', `${cloud.area.server}${path}`, { signSource: body, body, token });
}

const did = JSON.stringify(hub);
const path = JSON.stringify(TARGET_TEMPERATURE);
const value = JSON.stringify(String(current));

const attempts = [
  ['qlink/trait/write', '/app/v1.0/lumi/app/qlink/trait/write',
    `{"devices": [{"deviceId": ${did}, "traits": [{"path": ${path}, "value": ${value}}]}]}`],
  ['qlink/trait/set', '/app/v1.0/lumi/app/qlink/trait/set',
    `{"devices": [{"deviceId": ${did}, "traits": [{"path": ${path}, "value": ${value}}]}]}`],
  ['qlink/trait/control', '/app/v1.0/lumi/app/qlink/trait/control',
    `{"devices": [{"deviceId": ${did}, "traits": [{"path": ${path}, "value": ${value}}]}]}`],
  ['res/write', '/app/v1.0/lumi/res/write',
    `{"data": [{"attrs": {${path}: ${value}}, "subjectId": ${did}}]}`],
  ['app/res/write', '/app/v1.0/lumi/app/res/write',
    `{"data": [{"attrs": {${path}: ${value}}, "subjectId": ${did}}]}`],
  ['app/device/control', '/app/v1.0/lumi/app/device/control',
    `{"did": ${did}, "attrs": [{"attr": ${path}, "value": ${value}}]}`],
];

for (const [label, url, body] of attempts) {
  try {
    const payload = await post(url, body);
    console.log(`OK   ${label}\n       ${JSON.stringify(payload).slice(0, 300)}\n`);
  } catch (error) {
    console.log(`--   ${label}: ${error.message.slice(0, 130)}`);
  }
}
