// The infrared air conditioner matched on the M200 is not in the ordinary device list, so this
// asks the cloud where else it might be. Read-only: every call here queries, none of them write.
//
// Run: AQARA_EMAIL=... AQARA_PASSWORD=... AQARA_REGION=RU node tools/probe-ir.js <hubDid>

import { writeFileSync } from 'node:fs';

import { AqaraCloud } from '../src/cloud/client.js';

const hub = process.argv[2] ?? 'lumi3.9cb7fc17db2b179d';
const cloud = new AqaraCloud({ region: process.env.AQARA_REGION ?? 'RU' });
const { token } = await cloud.login(process.env.AQARA_EMAIL, process.env.AQARA_PASSWORD);
console.log(`logged in, probing for the infrared devices behind ${hub}\n`);

/** A GET whose signature covers the bare query string, which is how this API signs them. */
async function get(path, query) {
  return cloud.signedRequest('GET', `${cloud.area.server}${path}?${query}`, { signSource: query, token });
}

/** A POST whose signature covers the body, spaced the way the app's serialiser spaces it. */
async function post(path, body) {
  return cloud.signedRequest('POST', `${cloud.area.server}${path}`, { signSource: body, body, token });
}

const attempts = [
  ['GET  layout panels (hub)', () => get('/app/v1.0/lumi/app/layout/collection/panels', `subjectIds=${hub}&types=device_endpoint_panel`)],
  ['GET  device list, subDevice', () => get('/app/v1.0/lumi/app/position/device/query', 'size=300&startIndex=0&subDevice=true')],
  ['GET  irdevice/query', () => get('/app/v1.0/lumi/irdevice/query', `did=${hub}`)],
  ['GET  app/irdevice/query', () => get('/app/v1.0/lumi/app/irdevice/query', `did=${hub}`)],
  ['GET  app/ir/device/query', () => get('/app/v1.0/lumi/app/ir/device/query', `did=${hub}`)],
  ['GET  app/ir/list', () => get('/app/v1.0/lumi/app/ir/list', `did=${hub}`)],
  ['GET  app/virtual/device/query', () => get('/app/v1.0/lumi/app/virtual/device/query', `did=${hub}`)],
  ['POST irdevice/query', () => post('/app/v1.0/lumi/irdevice/query', `{"did": ${JSON.stringify(hub)}}`)],
  ['POST app/ir/device/list', () => post('/app/v1.0/lumi/app/ir/device/list', `{"did": ${JSON.stringify(hub)}}`)],
];

const found = {};

for (const [label, run] of attempts) {
  try {
    const payload = await run();
    const text = JSON.stringify(payload.result ?? payload);
    found[label] = payload.result ?? payload;
    console.log(`OK   ${label}\n       ${text.slice(0, 400)}\n`);
  } catch (error) {
    console.log(`--   ${label}: ${error.message.slice(0, 120)}`);
  }
}

writeFileSync('probe-ir-dump.json', JSON.stringify(found, null, 2));
console.log('\nWhatever answered is in probe-ir-dump.json');
