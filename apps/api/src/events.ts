import type { Db, ChangeStream } from 'mongodb';
import type { ServerResponse } from 'node:http';
import { collections } from './store.js';
import { classifyHealth } from '@lightshow/models';
import type { Bus } from '@lightshow/messaging';
import { topics } from '@lightshow/messaging';

export class Events {
  private clients = new Set<ServerResponse>();
  private stream?: ChangeStream;
  private stopped = false;
  private health = new Map<string, string>();
  private retry?: NodeJS.Timeout;
  private tick?: NodeJS.Timeout;
  constructor(
    private db: Db,
    private bus: Bus,
    private log: (error: unknown) => void,
  ) {}
  async snapshot() {
    const c = collections(this.db);
    const [devices, statuses, elements, scenes, show] = await Promise.all([
      c.devices.find({}, { projection: { _id: 0 } }).toArray(),
      c.statuses.find({}, { projection: { _id: 0 } }).toArray(),
      c.elements.find({}, { projection: { _id: 0 } }).toArray(),
      c.scenes.find({}, { projection: { _id: 0 } }).toArray(),
      c.shows.findOne({ _id: 'desired' }, { projection: { _id: 0 } }),
    ]);
    return { devices, statuses, elements, scenes, show };
  }
  send(response: ServerResponse, event: string, data: unknown) {
    if (!response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) {
      response.destroy();
      this.clients.delete(response);
    }
  }
  add(response: ServerResponse) {
    if (this.clients.size >= 128) throw new Error('SSE capacity reached');
    this.clients.add(response);
    return () => this.clients.delete(response);
  }
  get atCapacity() {
    return this.clients.size >= 128;
  }
  broadcast(event: string, data: unknown) {
    for (const response of this.clients) this.send(response, event, data);
  }
  start() {
    this.watch();
    this.tick = setInterval(() => void this.updateHealth(), 2000);
  }
  private async updateHealth() {
    try {
      const statuses = await collections(this.db).statuses.find().toArray();
      const current = new Set(statuses.map((s) => s.deviceId));
      for (const id of this.health.keys()) if (!current.has(id)) this.health.delete(id);
      for (const status of statuses) {
        const value = classifyHealth(status);
        const key = JSON.stringify(value);
        if (this.health.get(status.deviceId) !== key) {
          this.health.set(status.deviceId, key);
          this.broadcast('health', { deviceId: status.deviceId, ...value });
        }
      }
      for (const client of this.clients) {
        if (!client.write(': keepalive\n\n')) client.destroy();
      }
    } catch (e) {
      this.log(e);
    }
  }
  private watch() {
    if (this.stopped) return;
    // One shared stream. A fresh snapshot on reconnect reconciles missed events.
    this.stream = this.db.watch(
      [
        {
          $match: {
            'ns.coll': { $in: ['device_status', 'devices', 'elements', 'scenes', 'shows'] },
          },
        },
      ],
      { fullDocument: 'updateLookup', maxAwaitTimeMS: 1000 },
    );
    this.stream.on('change', (change) => {
      void (async () => {
        if (!('ns' in change) || !('coll' in change.ns)) return;
        const collection = change.ns.coll;
        const document = 'fullDocument' in change ? change.fullDocument : null;
        this.broadcast(
          !document
            ? 'configuration'
            : collection === 'device_status'
              ? 'status'
              : collection === 'devices'
                ? 'device'
                : collection === 'shows'
                  ? 'show'
                  : 'configuration',
          document ?? {},
        );
        if (collection === 'devices' && document) {
          const d = document as unknown as {
            deviceId: string;
            config: { configVersion: number };
          };
          await this.bus.publish(topics.command(d.deviceId), {
            type: 'configUpdated',
            configVersion: d.config.configVersion,
          });
        }
        if (collection !== 'device_status') await this.bus.publish(topics.config, { collection });
      })().catch(this.log);
    });
    this.stream.on('error', (error) => {
      this.log(error);
      this.reconnect();
    });
    this.stream.on('close', () => this.reconnect());
  }
  private reconnect() {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.watch();
      void this.snapshot()
        .then((data) => this.broadcast('snapshot', data))
        .catch(this.log);
    }, 2000);
    void this.stream?.close().catch(this.log);
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.tick);
    await this.stream?.close();
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}
