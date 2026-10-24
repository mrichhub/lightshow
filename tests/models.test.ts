import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileMappings,
  defaultConfig,
  validateConfig,
  classifyHealth,
  type Element,
  type DeviceStatus,
} from '../packages/models/src/index.js';
import {
  generateDeviceId,
  uniqueDeviceId,
  token,
  tokenHash,
} from '../packages/models/src/security.js';
test('device identities have six recognizable characters and collision retries', async () => {
  const ids = new Set(Array.from({ length: 1000 }, generateDeviceId));
  for (const id of ids) assert.match(id, /^[A-Z0-9]{6}$/);
  let calls = 0;
  assert.match(await uniqueDeviceId(async () => ++calls < 3), /^[A-Z0-9]{6}$/);
  assert.equal(calls, 3);
  await assert.rejects(() => uniqueDeviceId(async () => true));
  const candidates = ['AAAAAA', 'AAAAAA', 'BBBBBB'];
  assert.equal(
    await uniqueDeviceId(
      async (id) => id === 'AAAAAA',
      () => candidates.shift()!,
    ),
    'BBBBBB',
  );
  assert.equal(Buffer.from(token(), 'base64url').length, 32);
  assert.equal(tokenHash('same'), tokenHash('same'));
  assert.notEqual(tokenHash(token()), tokenHash(token()));
});
test('board pin restrictions, duplicate pins and pixel limits', () => {
  const d = defaultConfig('ABC123', 'wt32-eth01');
  validateConfig(d);
  d.outputs[0]!.gpio = 23;
  assert.throws(() => validateConfig(d), /GPIO/);
  d.outputs[0]!.gpio = 4;
  d.outputs.push({ ...d.outputs[0]!, id: 1 });
  assert.throws(() => validateConfig(d), /Duplicate/);
});
test('skips preserve logical indexing, black reservations and cross-device segments', () => {
  const a = defaultConfig('ABC123', 'esp32dev'),
    b = defaultConfig('DEF456', 'esp32dev');
  a.outputs[0]!.pixelCount = 200;
  const e: Element = {
    id: 'ghost',
    name: 'Ghost',
    pixelCount: 196,
    segments: [
      {
        deviceId: a.deviceId,
        outputIndex: 0,
        startPixel: 0,
        physicalPixelCount: 200,
        elementStartPixel: 0,
        skippedPixels: [4, 20, 102, 188],
      },
    ],
  };
  const c = compileMappings([a], [e]);
  assert.deepEqual(
    c.mappings[0]!.links.find((l) => l.physical === 5),
    { physical: 5, logical: 4 },
  );
  assert.deepEqual(
    c.mappings[0]!.links.find((l) => l.physical === 25),
    { physical: 25, logical: 23 },
  );
  assert.deepEqual(c.skipped.get(a.deviceId), [4, 20, 102, 188]);
  e.pixelCount = 198;
  e.segments.push({
    deviceId: b.deviceId,
    outputIndex: 0,
    startPixel: 0,
    physicalPixelCount: 2,
    elementStartPixel: 196,
    skippedPixels: [],
  });
  assert.equal(compileMappings([a, b], [e]).mappings.length, 2);
  assert.throws(() => compileMappings([a, b], [e, { ...e, id: 'overlap' }]), /overlap/);
  e.segments[0]!.skippedPixels = [4, 4];
  assert.throws(() => compileMappings([a, b], [e]));
  e.segments[0]!.skippedPixels = [201];
  assert.throws(() => compileMappings([a, b], [e]));
});
test('heartbeat freshness and operational health are independent', () => {
  const now = Date.now();
  const s = {
    lastSeen: new Date(now - 9000).toISOString(),
    freeHeap: 100000,
    network: { connected: true },
  } as DeviceStatus;
  assert.deepEqual(classifyHealth(s, now), { connectivity: 'online', health: 'healthy' });
  assert.equal(classifyHealth(s, now + 2000).connectivity, 'warning');
  assert.equal(classifyHealth(s, now + 12000).connectivity, 'offline');
  s.lastError = 'output stalled';
  assert.equal(classifyHealth(s, now).health, 'warning');
});
