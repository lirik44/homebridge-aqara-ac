// The infrared air conditioner is an endpoint on the hub rather than a device of its own. This
// finds it and reads every trait behind it, with units, ranges and enumerations, so each `3.x.y`
// path can be given a meaning. Read-only.
//
// Run: AQARA_EMAIL=... AQARA_PASSWORD=... AQARA_REGION=RU node tools/dump-ac.js <hubDid>

import { writeFileSync } from 'node:fs';

import { AqaraCloud } from '../src/cloud/client.js';

const hub = process.argv[2] ?? 'lumi3.9cb7fc17db2b179d';
const cloud = new AqaraCloud({ region: process.env.AQARA_REGION ?? 'RU' });
const { token } = await cloud.login(process.env.AQARA_EMAIL, process.env.AQARA_PASSWORD);

const endpoints = await cloud.panels(token, hub);
const ac = endpoints.find(e => /aircondition/i.test(e.deviceTypes ?? '') || /air condition/i.test(e.endpointName ?? ''));

if (!ac) {
  console.error(`No air conditioner endpoint on ${hub}. Endpoints seen: ${endpoints.map(e => `${e.endpointId}:${e.endpointName}`).join(', ')}`);
  process.exit(1);
}

console.log(`Air conditioner: endpoint ${ac.endpointId} on ${hub}`);
console.log(`${ac.paths.length} trait(s), plus objProperties ${JSON.stringify(ac.objProperties ?? [])}\n`);

const traits = await cloud.readTraits(token, hub, ac.paths);

for (const trait of traits) {
  const bits = [`value=${JSON.stringify(trait.value)}`];
  if (trait.unit !== undefined && trait.unit !== null) bits.push(`unit=${trait.unit}`);
  if (trait.min !== undefined) bits.push(`min=${trait.min}`);
  if (trait.max !== undefined) bits.push(`max=${trait.max}`);
  if (trait.step !== undefined) bits.push(`step=${trait.step}`);

  console.log(`${trait.path}`);
  console.log(`  ${bits.join(' ')}`);
  if (trait.name || trait.propertyName) console.log(`  name: ${trait.name ?? trait.propertyName}`);
  if (trait.enums) console.log(`  enums: ${JSON.stringify(trait.enums)}`);
  const rest = Object.keys(trait).filter(k => !['path', 'value', 'unit', 'min', 'max', 'step', 'enums', 'name', 'propertyName'].includes(k));
  if (rest.length) console.log(`  other: ${rest.map(k => `${k}=${JSON.stringify(trait[k])}`).join(' ')}`);
  console.log();
}

writeFileSync('ac-traits.json', JSON.stringify({ endpoint: ac, traits }, null, 2));
console.log('Written to ac-traits.json');
