import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('chunkRender inactivity is at least five hours while a higher override remains', async () => {
  const file = new URL('../node/chunk-stall.mjs', import.meta.url);
  assert.equal(fs.existsSync(file), true, 'five-hour stall floor is not implemented');
  const {chunkStallMs}=await import(file);
  for (const value of [undefined,'', '10800000','-1','invalid','0']) assert.equal(chunkStallMs(value),18000000);
  assert.equal(chunkStallMs('21600000'),21600000);
});
