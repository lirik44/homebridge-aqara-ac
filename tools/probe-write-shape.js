// Two write endpoints exist - they answer 302/303 rather than 404 - so what is left is the shape
// of the body. Every candidate below writes the state the air conditioner already holds, so a
// shape that is accepted changes nothing in the room.
//
// The traits all carry propertyId 8.0.2116, which is the resource the whole air conditioner state
// lives in, as one word: P<power>_M<mode>_T<temperature>_S<fan>_D<swing>.
//
// Run: AQARA_EMAIL=... AQARA_PASSWORD=... AQARA_REGION=RU node tools/probe-write-shape.js <hubDid>

import { AqaraCloud } from '../src/cloud/client.js';

const hub = process.argv[2] ?? 'lumi3.9cb7fc17db2b179d';
const STATE_TRAIT = '3.132.32922';
const STATE_RESOURCE = '8.0.2116';

const cloud = new AqaraCloud({ region: process.env.AQARA_REGION ?? 'RU' });
const { token } = await cloud.login(process.env.AQARA_EMAIL, process.env.AQARA_PASSWORD);

const [trait] = await cloud.readTraits(token, hub, [STATE_TRAIT]);
const state = trait?.value;

if (!state) {
  console.error('Could not read the current state word; refusing to invent one.');
  process.exit(1);
}

console.log(`Current state is ${state} - every attempt below writes exactly that back.\n`);

async function post(path, body) {
  return cloud.signedRequest('POST', `${cloud.area.server}${path}`, { signSource: body, body, token });
}

const did = JSON.stringify(hub);
const value = JSON.stringify(state);
const resource = JSON.stringify(STATE_RESOURCE);
const traitPath = JSON.stringify(STATE_TRAIT);

const attempts = [
  ['res/write  attrs object',
    '/app/v1.0/lumi/res/write',
    `{"data": [{"attrs": {${resource}: ${value}}, "subjectId": ${did}}]}`],

  ['res/write  options list',
    '/app/v1.0/lumi/res/write',
    `{"data": [{"options": [{"attr": ${resource}, "value": ${value}}], "subjectId": ${did}}]}`],

  ['res/write  params list',
    '/app/v1.0/lumi/res/write',
    `{"data": [{"params": [{"res_name": ${resource}, "value": ${value}}], "subjectId": ${did}}]}`],

  ['res/write  flat did/attrs',
    '/app/v1.0/lumi/res/write',
    `{"did": ${did}, "attrs": [{"attr": ${resource}, "value": ${value}}]}`],

  ['res/write  resourceId/value',
    '/app/v1.0/lumi/res/write',
    `{"data": [{"subjectId": ${did}, "resourceId": ${resource}, "value": ${value}}]}`],

  ['trait/write  needParam',
    '/app/v1.0/lumi/app/qlink/trait/write',
    `{"devices": [{"deviceId": ${did}, "traits": [{"path": ${traitPath}, "value": ${value}}]}], "needParam": true}`],

  ['trait/write  with propertyId',
    '/app/v1.0/lumi/app/qlink/trait/write',
    `{"devices": [{"deviceId": ${did}, "traits": [{"path": ${traitPath}, "propertyId": [${resource}], "value": ${value}}]}]}`],

  ['trait/write  single device',
    '/app/v1.0/lumi/app/qlink/trait/write',
    `{"deviceId": ${did}, "traits": [{"path": ${traitPath}, "value": ${value}}]}`],
];

for (const [label, url, body] of attempts) {
  try {
    const payload = await post(url, body);
    console.log(`ACCEPTED  ${label}`);
    console.log(`          body:  ${body}`);
    console.log(`          reply: ${JSON.stringify(payload).slice(0, 300)}\n`);
  } catch (error) {
    console.log(`--        ${label}: ${error.message.slice(0, 110)}`);
  }
}
