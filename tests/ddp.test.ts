import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DdpEncoder, DdpReceiver, decodePacket, encodeFrame } from '../packages/ddp/src/index.js';
test('DDP RGB24 headers, byte offsets, push and packet sequence wrap', () => {
  const pixels = Buffer.alloc(3000, 42),
    encoder = new DdpEncoder(pixels.length, 300);
  const packets = encoder.encode(pixels);
  for (let i = 0; i < packets.length; i++) {
    const p = decodePacket(packets[i]!);
    assert.equal(p.offset, i * 300);
    assert.equal(p.sequence, i + 1);
    assert.equal(p.push, i === packets.length - 1);
    assert.equal(p.data.length, 300);
    assert.equal(packets[i]![2], 0x0b);
  }
  encoder.encode(pixels);
  assert.equal(packets[5]![1], 1);
  assert.throws(() => decodePacket(Buffer.alloc(9)));
  const malformed = Buffer.from(packets[0]!);
  malformed[2] = 1;
  assert.throws(() => decodePacket(malformed));
});
test('multi-packet frames display atomically and recover after lost/reordered packets', () => {
  const r = new DdpReceiver(3000, ['10.0.0.1']);
  const frames = encodeFrame(Buffer.alloc(3000, 77), 1000);
  assert.equal(r.accept(frames[0]!, '10.0.0.1', 100), false);
  assert.equal(r.pixels[0], 0);
  assert.equal(r.accept(frames[2]!, '10.0.0.1', 101), false);
  assert.equal(r.incomplete, 1);
  assert.equal(r.pixels[0], 0);
  frames.forEach((p, i) => r.accept(p, '10.0.0.1', 200 + i));
  assert.equal(r.frames, 1);
  assert.ok(r.pixels.every((v) => v === 77));
  r.accept(frames[0]!, '10.0.0.1', 300);
  frames.forEach((p, i) => r.accept(p, '10.0.0.1', 400 + i));
  assert.equal(r.frames, 2);
});
test('allowlist, active sender lock and timeout preserve local mode', () => {
  const r = new DdpReceiver(3, ['10.0.0.1', '10.0.0.2']),
    p = encodeFrame(Buffer.from([1, 2, 3]))[0]!;
  r.accept(p, '10.0.0.9', 1);
  assert.equal(r.lastValidAt, null);
  r.accept(p, '10.0.0.1', 100);
  assert.equal(r.accept(p, '10.0.0.2', 101), false);
  assert.equal(r.frames, 1);
  assert.equal(r.tick(5099), false);
  assert.equal(r.tick(5100, 'local'), false);
  assert.equal(r.pixels[0], 1);
  assert.equal(r.tick(5100), true);
  assert.deepEqual([...r.pixels], [0, 0, 0]);
  assert.equal(r.accept(p, '10.0.0.2', 5101), true);
});

test('a partial frame cannot complete across the inactivity timeout', () => {
  const receiver = new DdpReceiver(6, ['10.0.0.1']);
  const packets = encodeFrame(Buffer.from([1, 2, 3, 4, 5, 6]), 3);
  receiver.accept(packets[0]!, '10.0.0.1', 1);
  assert.equal(receiver.accept(packets[1]!, '10.0.0.1', 5002), false);
  assert.equal(receiver.frames, 0);
  assert.ok(receiver.pixels.every((n) => n === 0));
  receiver.accept(packets[0]!, '10.0.0.1', 5003);
  assert.equal(receiver.accept(packets[1]!, '10.0.0.1', 5004), true);
});
