import 'dotenv/config';
import dgram from 'node:dgram';
import { createServer } from 'node:http';
import { MongoClient } from 'mongodb';
import { collections } from '../../api/src/store.js';
import { connectBus, topics } from '@lightshow/messaging';
import { DdpEncoder } from '@lightshow/ddp';
import { Renderer } from './renderer.js';
const fps = Number(process.env.TARGET_FPS ?? 40);
if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('TARGET_FPS must be 1..120');
const mongo = new MongoClient(process.env.MONGO_URL!);
await mongo.connect();
const db = mongo.db(),
  c = collections(db),
  bus = await connectBus('ENGINE');
const udp = dgram.createSocket('udp4');
udp.on('error', (e) => console.error('DDP transport', e));
let renderer: Renderer | undefined,
  started = Date.now(),
  sceneId: string | null = null,
  version = 0,
  closed = false,
  loadedAt = 0;
let targets: { id: string; address: string; port: number; encoder: DdpEncoder; busy: number }[] =
  [];
let loading: Promise<void> | undefined,
  dirty = false;
function reload(): Promise<void> {
  dirty = true;
  if (loading) return loading;
  loading = (async () => {
    while (dirty) {
      dirty = false;
      const [devices, elements, scenes, statuses, show] = await Promise.all([
        c.devices.find({ revoked: { $ne: true } }).toArray(),
        c.elements.find({}, { projection: { _id: 0 } }).toArray(),
        c.scenes.find().toArray(),
        c.statuses.find().toArray(),
        c.shows.findOne({ _id: 'desired' }),
      ]);
      // Revoked devices retain mapping definitions so other devices in a spanning element keep working.
      const all = await c.devices.find().toArray();
      const next = new Renderer(
        all.map((d) => d.config),
        elements,
        scenes.find((s) => s.id === show?.sceneId) ?? null,
        show?.overrides ?? [],
      );
      const destinations = devices
        .filter((d) => d.config.mode === 'listening')
        .flatMap((d) => {
          const s = statuses.find((s) => s.deviceId === d.deviceId);
          return s
            ? [
                {
                  id: d.deviceId,
                  address: s.address,
                  port: d.config.ddp.port,
                  encoder: new DdpEncoder(next.physical.get(d.deviceId)!.length),
                  busy: 0,
                },
              ]
            : [];
        });
      renderer = next;
      targets = destinations;
      started = Date.parse(show?.startedAt ?? new Date().toISOString());
      sceneId = show?.sceneId ?? null;
      version = show?.version ?? 0;
      loadedAt = Date.now();
      await bus.publish(topics.showState, { sceneId, version, fps }, true);
    }
  })().finally(() => {
    loading = undefined;
  });
  return loading;
}
await bus.client!.subscribeAsync([topics.showCommand, topics.config], { qos: 1 });
bus.client!.on(
  'message',
  () => void reload().catch((e) => console.error('Configuration reload', e)),
);
bus.client!.on('connect', () => void reload().catch(console.error));
await reload();
// Polling reconciles lost MQTT notifications and new simulator IPs. Never query in the frame path.
const refresh = setInterval(() => void reload().catch(console.error), 5000);
let deadline = performance.now(),
  timer: NodeJS.Timeout,
  sent = 0,
  dropped = 0;
function tick() {
  if (closed) return;
  const frames = renderer!.frame(Date.now() - started);
  for (const target of targets) {
    if (target.busy) {
      dropped++;
      continue;
    }
    const packets = target.encoder.encode(frames.get(target.id)!);
    target.busy = packets.length;
    for (const packet of packets)
      udp.send(packet, target.port, target.address, (e) => {
        target.busy--;
        if (e) console.error('DDP send', e.message);
      });
    sent++;
  }
  deadline += 1000 / fps;
  const now = performance.now();
  if (deadline < now) deadline = now;
  timer = setTimeout(tick, Math.max(0, deadline - now));
}
tick();
const health = createServer((_, res) => {
  res.statusCode = bus.client!.connected && Date.now() - loadedAt < 20000 ? 200 : 503;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ fps, sceneId, version, sent, dropped, targets: targets.length }));
}).listen(3001, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    closed = true;
    clearInterval(refresh);
    clearTimeout(timer);
    health.close();
    udp.close();
    void bus
      .close()
      .then(() => mongo.close())
      .then(() => process.exit(0));
  });
