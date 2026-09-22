// The composite state word takes a write and ignores it, so this tries the individual traits
// instead. Only the target temperature is touched, one degree and back - the coldest thing that
// can go wrong is a degree for a few seconds.
//
// Run: AQARA_EMAIL=... AQARA_PASSWORD=... AQARA_REGION=RU node tools/verify-trait-write.js <hubDid>

import { AqaraCloud } from '../src/cloud/client.js';

const hub = process.argv[2] ?? 'lumi3.9cb7fc17db2b179d';
const STATE = '3.132.32922';
const CANDIDATES = ['3.141.32948', '3.141.32949'];

const cloud = new AqaraCloud({ region: process.env.AQARA_REGION ?? 'RU' });
const { token } = await cloud.login(process.env.AQARA_EMAIL, process.env.AQARA_PASSWORD);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function read(paths) {
  const traits = await cloud.readTraits(token, hub, paths);
  return Object.fromEntries(traits.map(t => [t.path, t.value]));
}

async function write(path, value) {
  const body = `{"deviceId": ${JSON.stringify(hub)}, "traits": [{"path": ${JSON.stringify(path)}, "value": ${JSON.stringify(String(value))}}]}`;
  return cloud.signedRequest('POST', `${cloud.area.server}/app/v1.0/lumi/app/qlink/trait/write`, { signSource: body, body, token });
}

for (const path of CANDIDATES) {
  const before = await read([path, STATE]);
  const was = Number(before[path]);
  if (!Number.isFinite(was)) {
    console.log(`${path}: reads ${JSON.stringify(before[path])}, skipping\n`);
    continue;
  }

  const wanted = was < 32 ? was + 1 : was - 1;
  console.log(`${path}: ${was} -> ${wanted}   (state ${before[STATE]})`);

  try {
    const reply = await write(path, wanted);
    console.log(`  write: ${reply.message ?? 'ok'}`);
  } catch (error) {
    console.log(`  write refused: ${error.message.slice(0, 110)}\n`);
    continue;
  }

  await sleep(3000);
  const after = await read([path, STATE]);
  const took = Number(after[path]) === wanted;
  console.log(`  now:   ${after[path]}   (state ${after[STATE]})`);
  console.log(took ? '  => THIS ONE WORKS' : '  => ignored');

  if (took) {
    await write(path, was);
    await sleep(3000);
    const restored = await read([path, STATE]);
    console.log(`  restored to ${restored[path]} (state ${restored[STATE]})`);
  }

  console.log();
}
