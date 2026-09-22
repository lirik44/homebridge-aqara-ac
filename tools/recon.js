// What the Aqara cloud knows about an account, dumped so the infrared air conditioner behind a
// hub can be found and its shape read off. Nothing here writes anything.
//
// Run:  AQARA_EMAIL=... AQARA_PASSWORD=... AQARA_REGION=EU node tools/recon.js
//
// It prints a summary and leaves the raw replies in recon-dump.json, which is the thing worth
// reading afterwards: the device list alone usually says what a matched remote looks like.

import { writeFileSync } from 'node:fs';

import { AqaraCloud } from '../src/cloud/client.js';

const email = process.env.AQARA_EMAIL;
const password = process.env.AQARA_PASSWORD;
const region = process.env.AQARA_REGION ?? 'EU';

if (!email || !password) {
  console.error('Set AQARA_EMAIL and AQARA_PASSWORD (and AQARA_REGION, default EU).');
  process.exit(1);
}

// Resource ids worth trying on whatever looks like the air conditioner. None of these are known
// to exist on it - the point is to see which ones answer. Aqara numbers a resource `a.b.c`, and
// the low ranges below are the ones its hubs use for climate and infrared.
const PROBE_RESOURCES = [
  '0.1.85', // temperature, on most Aqara sensors
  '0.2.85', // humidity
  '4.1.85', // power / on-off on many devices
  '4.21.85',
  '8.0.2032',
  '14.1.85', // the air conditioner state word on Aqara's AC partner
  '14.2.85',
  '14.8.85',
];

/** Anything whose model or name suggests a hub, an infrared blaster, or an air conditioner. */
function looksInteresting(device) {
  const haystack = `${device.model ?? ''} ${device.deviceName ?? ''} ${device.parentModel ?? ''}`.toLowerCase();
  return /ir|infrared|acpartner|aircondition|airrtc|gateway|hub|m200|m2|remote/.test(haystack);
}

const cloud = new AqaraCloud({ region });
const dump = { region, at: new Date().toISOString() };

console.log(`Logging in to the ${region} cloud as ${email} ...`);
const session = await cloud.login(email, password);
console.log(`  ok - userId ${session.userId}\n`);

const devices = await cloud.listDevices(session.token);
dump.devices = devices;
console.log(`${devices.length} device(s) on the account:\n`);

for (const device of devices) {
  const mark = looksInteresting(device) ? '*' : ' ';
  console.log(`${mark} ${device.did ?? '?'}`);
  console.log(`    name:   ${device.deviceName ?? '-'}`);
  console.log(`    model:  ${device.model ?? '-'}`);
  console.log(`    parent: ${device.parentDeviceId ?? '-'} ${device.parentModel ?? ''}`);
  const extra = Object.keys(device).filter(k => !['did', 'deviceName', 'model', 'parentDeviceId', 'parentModel'].includes(k));
  console.log(`    other keys: ${extra.join(', ') || '-'}`);
  console.log();
}

const candidates = devices.filter(looksInteresting);
console.log(`Probing ${candidates.length} candidate(s) marked * above.\n`);

dump.candidates = [];

for (const device of candidates) {
  const entry = { did: device.did, model: device.model, name: device.deviceName };
  console.log(`--- ${device.deviceName ?? device.did} (${device.model ?? '?'}) ---`);

  try {
    entry.detail = await cloud.deviceDetail(session.token, device.did);
    console.log(`  detail: ${JSON.stringify(entry.detail)}`);
  } catch (error) {
    entry.detailError = error.message;
    console.log(`  detail failed: ${error.message}`);
  }

  try {
    entry.resources = await cloud.readResources(session.token, device.did, PROBE_RESOURCES);
    const answered = Object.entries(entry.resources);
    console.log(answered.length
      ? `  resources: ${answered.map(([k, v]) => `${k}=${v}`).join(', ')}`
      : '  resources: none of the probed ids answered');
  } catch (error) {
    entry.resourcesError = error.message;
    console.log(`  resources failed: ${error.message}`);
  }

  dump.candidates.push(entry);
  console.log();
}

writeFileSync('recon-dump.json', JSON.stringify(dump, null, 2));
console.log('Raw replies written to recon-dump.json');
