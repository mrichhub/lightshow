import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const integer = (min: number, max: number) => Type.Integer({ minimum: min, maximum: max });
export const Id = Type.String({ pattern: '^[a-zA-Z0-9_-]{1,64}$' });
export const DeviceId = Type.String({ pattern: '^[A-Z0-9]{6}$' });
export const IPv4 = Type.String({
  pattern:
    '^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$',
});
export const Mode = Type.Union([Type.Literal('listening'), Type.Literal('local')]);
export const OutputSchema = Type.Object(
  {
    id: integer(0, 7),
    gpio: integer(0, 39),
    chipset: Type.Literal('WS2811'),
    pixelCount: integer(1, 2048),
    colorOrder: Type.Union(
      (['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR'] as const).map((v) => Type.Literal(v)),
    ),
  },
  { additionalProperties: false },
);
export const ConfigFields = {
  hardware: Type.Object(
    {
      board: Type.Union([Type.Literal('wt32-eth01'), Type.Literal('esp32dev')]),
      networkType: Type.Union([Type.Literal('ethernet'), Type.Literal('wifi')]),
    },
    { additionalProperties: false },
  ),
  mode: Mode,
  ddp: Type.Object(
    {
      port: integer(1024, 65535),
      timeoutMs: integer(1000, 60000),
      allowedSources: Type.Array(IPv4, { maxItems: 16, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
  outputs: Type.Array(OutputSchema, { minItems: 1, maxItems: 4 }),
};
export const ConfigInputSchema = Type.Object(ConfigFields, { additionalProperties: false });
export const ConfigSchema = Type.Object(
  { deviceId: DeviceId, configVersion: integer(1, 2147483647), ...ConfigFields },
  { additionalProperties: false },
);
export type DeviceConfig = Static<typeof ConfigSchema>;
export type ConfigInput = Static<typeof ConfigInputSchema>;
export const SegmentSchema = Type.Object(
  {
    deviceId: DeviceId,
    outputIndex: integer(0, 3),
    startPixel: integer(0, 8191),
    physicalPixelCount: integer(1, 8192),
    elementStartPixel: integer(0, 32767),
    skippedPixels: Type.Array(integer(0, 8191), { maxItems: 8192, uniqueItems: true }),
  },
  { additionalProperties: false },
);
export const ElementSchema = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1, maxLength: 100 }),
    pixelCount: integer(1, 32768),
    segments: Type.Array(SegmentSchema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);
export type Element = Static<typeof ElementSchema>;
export const Color = Type.String({ pattern: '^#[0-9a-fA-F]{6}$' });
export const EffectSchema = Type.Object(
  {
    type: Type.Union(
      (['solid', 'pulse', 'fade', 'chase', 'rainbow', 'flicker'] as const).map((v) =>
        Type.Literal(v),
      ),
    ),
    targets: Type.Array(Id, { minItems: 1, maxItems: 256, uniqueItems: true }),
    params: Type.Object(
      {
        color: Type.Optional(Color),
        color2: Type.Optional(Color),
        durationMs: Type.Optional(integer(50, 3600000)),
        minBrightness: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        maxBrightness: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        width: Type.Optional(integer(1, 32768)),
        seed: Type.Optional(integer(0, 2147483647)),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type Effect = Static<typeof EffectSchema>;
export const SceneSchema = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1, maxLength: 100 }),
    effects: Type.Array(EffectSchema, { maxItems: 256 }),
  },
  { additionalProperties: false },
);
export type Scene = Static<typeof SceneSchema>;
export const OverrideSchema = Type.Object(
  {
    elementId: Type.Optional(Id),
    deviceId: Type.Optional(DeviceId),
    outputIndex: Type.Optional(integer(0, 3)),
    color: Color,
    brightness: Type.Number({ minimum: 0, maximum: 1 }),
    pixel: Type.Optional(integer(0, 32767)),
  },
  { additionalProperties: false },
);
export type Override = Static<typeof OverrideSchema>;
export const HeartbeatSchema = Type.Object(
  {
    uptime: Type.Number({ minimum: 0 }),
    firmwareVersion: Type.String({ maxLength: 64 }),
    board: Type.String({ maxLength: 32 }),
    mode: Mode,
    network: Type.Object(
      {
        type: Type.Union([Type.Literal('ethernet'), Type.Literal('wifi')]),
        connected: Type.Boolean(),
        ip: IPv4,
        rssi: Type.Optional(Type.Number({ minimum: -150, maximum: 0 })),
      },
      { additionalProperties: false },
    ),
    freeHeap: Type.Number({ minimum: 0 }),
    minHeap: Type.Number({ minimum: 0 }),
    networkStack: Type.Number({ minimum: 0 }),
    lightingStack: Type.Number({ minimum: 0 }),
    ddpFps: Type.Number({ minimum: 0 }),
    ledFps: Type.Number({ minimum: 0 }),
    droppedFrames: Type.Number({ minimum: 0 }),
    incompleteFrames: Type.Number({ minimum: 0 }),
    lastDdpMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    renderDurationUs: Type.Number({ minimum: 0 }),
    configVersion: integer(1, 2147483647),
    lastError: Type.Optional(Type.String({ maxLength: 512 })),
  },
  { additionalProperties: false },
);
export type Heartbeat = Static<typeof HeartbeatSchema>;
export const StatusSchema = Type.Object({
  ...HeartbeatSchema.properties,
  deviceId: DeviceId,
  lastSeen: Type.String(),
  address: IPv4,
});
export type DeviceStatus = Static<typeof StatusSchema>;
export type Device = {
  deviceId: string;
  hardwareId: string;
  name: string;
  config: DeviceConfig;
  createdAt: string;
  revoked?: boolean;
};
export const ShowSchema = Type.Object({
  sceneId: Type.Union([Id, Type.Null()]),
  overrides: Type.Array(OverrideSchema),
  version: Type.Integer({ minimum: 1 }),
  startedAt: Type.String(),
});
export type DesiredShow = Static<typeof ShowSchema>;
export const safePins: Record<DeviceConfig['hardware']['board'], readonly number[]> = {
  'wt32-eth01': [4, 14, 32, 33],
  esp32dev: [4, 13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33],
};
export function validateConfig(config: DeviceConfig): void {
  if (!Value.Check(ConfigSchema, config)) throw new Error('Invalid device configuration');
  const pins = new Set<number>();
  const ids = new Set<number>();
  let total = 0;
  if (
    config.hardware.networkType !== (config.hardware.board === 'wt32-eth01' ? 'ethernet' : 'wifi')
  )
    throw new Error('Board/network profile mismatch');
  for (const output of config.outputs) {
    if (!safePins[config.hardware.board].includes(output.gpio))
      throw new Error(`GPIO ${output.gpio} is unavailable on ${config.hardware.board}`);
    if (pins.has(output.gpio) || ids.has(output.id)) throw new Error('Duplicate GPIO or output ID');
    pins.add(output.gpio);
    ids.add(output.id);
    total += output.pixelCount;
  }
  if (total > 4096) throw new Error('Firmware supports at most 4096 physical pixels');
}
export function defaultConfig(
  deviceId: string,
  board: DeviceConfig['hardware']['board'],
): DeviceConfig {
  return {
    deviceId,
    configVersion: 1,
    hardware: { board, networkType: board === 'wt32-eth01' ? 'ethernet' : 'wifi' },
    mode: 'listening',
    ddp: { port: 4048, timeoutMs: 5000, allowedSources: [] },
    outputs: [{ id: 0, gpio: 4, chipset: 'WS2811', pixelCount: 100, colorOrder: 'GRB' }],
  };
}
export function classifyHealth(
  status: DeviceStatus | undefined,
  now = Date.now(),
): { connectivity: 'online' | 'warning' | 'offline'; health: 'healthy' | 'warning' | 'unknown' } {
  const age = status ? now - Date.parse(status.lastSeen) : Infinity;
  return {
    connectivity: age > 20000 ? 'offline' : age > 10000 ? 'warning' : 'online',
    health:
      !status || age > 20000
        ? 'unknown'
        : status.lastError || status.freeHeap < 20000 || !status.network.connected
          ? 'warning'
          : 'healthy',
  };
}

export type PixelLink = { logical: number; physical: number };
export type CompiledMapping = { elementId: string; deviceId: string; links: PixelLink[] };
export function compileMappings(
  devices: DeviceConfig[],
  elements: Element[],
): { mappings: CompiledMapping[]; skipped: Map<string, number[]> } {
  for (const d of devices) validateConfig(d);
  const configs = new Map(devices.map((d) => [d.deviceId, d]));
  const occupied = new Set<string>();
  const mappings: CompiledMapping[] = [];
  const skipped = new Map<string, number[]>();
  const elementIds = new Set<string>();
  for (const el of elements) {
    if (!Value.Check(ElementSchema, el) || elementIds.has(el.id))
      throw new Error('Invalid or duplicate element');
    elementIds.add(el.id);
    const logicalUsed = new Set<number>();
    for (const seg of el.segments) {
      const dev = configs.get(seg.deviceId);
      const out = dev?.outputs[seg.outputIndex];
      if (!dev || !out || seg.startPixel + seg.physicalPixelCount > out.pixelCount)
        throw new Error(`Segment outside output: ${el.id}`);
      const omitted = new Set(seg.skippedPixels);
      if (
        omitted.size !== seg.skippedPixels.length ||
        seg.skippedPixels.some((p) => p < 0 || p >= seg.physicalPixelCount)
      )
        throw new Error('Invalid skipped pixel indexes (relative to segment)');
      const base =
        dev.outputs.slice(0, seg.outputIndex).reduce((n, o) => n + o.pixelCount, 0) +
        seg.startPixel;
      let logical = seg.elementStartPixel;
      const links: PixelLink[] = [];
      for (let p = 0; p < seg.physicalPixelCount; p++) {
        const physical = base + p;
        const key = `${seg.deviceId}:${physical}`;
        if (occupied.has(key)) throw new Error(`Physical overlap at ${key}`);
        occupied.add(key);
        if (omitted.has(p)) {
          const list = skipped.get(seg.deviceId) ?? [];
          list.push(physical);
          skipped.set(seg.deviceId, list);
          continue;
        }
        if (logical >= el.pixelCount || logicalUsed.has(logical))
          throw new Error(`Logical overlap or boundary: ${el.id}`);
        logicalUsed.add(logical);
        links.push({ logical: logical++, physical });
      }
      mappings.push({ elementId: el.id, deviceId: seg.deviceId, links });
    }
    if (logicalUsed.size !== el.pixelCount)
      throw new Error(`Element ${el.id} must map every logical pixel exactly once`);
  }
  return { mappings, skipped };
}
