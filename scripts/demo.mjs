import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { lookup } from 'node:dns';
import { Agent, fetch } from 'undici';

// Development convenience: create a real simulated show through the authenticated public API.
// The socket connects locally; the URL hostname, deployment CA and certificate are still validated.
const origin = process.env.PUBLIC_ORIGIN;
const agent = new Agent({
  connect: {
    ca: readFileSync('.secrets/trust/https-ca.crt'),
    rejectUnauthorized: true,
    lookup: (_host, options, callback) => lookup('127.0.0.1', options, callback),
  },
});
let cookie = '';
async function request(path, method = 'GET', body) {
  const response = await fetch(origin + '/v1' + path, {
    dispatcher: agent,
    method,
    headers: {
      origin,
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  if (path === '/auth/login') cookie = response.headers.get('set-cookie').split(';')[0];
  return response.json();
}
async function until(work) {
  for (let i = 0; i < 150; i++) {
    const value = await work();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Simulator did not become ready');
}
try {
  await request('/auth/login', 'POST', {
    password: readFileSync('.local/admin-password', 'utf8').trim(),
  });
  const hardwareId = process.env.SIM_HARDWARE_ID ?? 'sim-yard-1';
  let device = (await request('/devices')).find((d) => d.hardwareId === hardwareId);
  if (!device) {
    const issued = await request('/enrollments', 'POST', { hardwareId, minutes: 60 });
    process.env.SIM_PROVISIONING_TOKEN = issued.token;
    const env = readFileSync('.env', 'utf8');
    writeFileSync(
      '.env',
      env.replace(/^SIM_PROVISIONING_TOKEN=.*$/m, `SIM_PROVISIONING_TOKEN='${issued.token}'`),
      { mode: 0o600 },
    );
  }
  execFileSync(
    'docker',
    ['compose', '--profile', 'simulator', 'up', '-d', '--build', '--no-deps', 'esp-simulator'],
    { stdio: 'inherit' },
  );
  device = await until(async () =>
    (await request('/devices')).find((d) => d.hardwareId === hardwareId),
  );
  if (device.revoked)
    throw new Error('Default simulator was revoked. Complete administrator recovery first.');
  const engineIp = execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'show-engine', 'hostname', '-i'],
    { encoding: 'utf8' },
  )
    .trim()
    .split(/\s+/)
    .find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  if (!engineIp) throw new Error('Unable to determine engine IPv4 address');
  const { deviceId, configVersion, ...input } = device.config;
  input.mode = 'listening';
  input.ddp.allowedSources = [...new Set([...input.ddp.allowedSources, engineIp])];
  device = await request('/devices/' + deviceId, 'PATCH', {
    name: 'Yard simulator',
    expectedVersion: configVersion,
    config: input,
  });
  const physical = device.config.outputs[0].pixelCount,
    skippedPixels = [4, 20, 50, 88].filter((p) => p < physical);
  const element = {
    id: 'demo-yard',
    name: 'Yard lights',
    pixelCount: physical - skippedPixels.length,
    segments: [
      {
        deviceId,
        outputIndex: 0,
        startPixel: 0,
        physicalPixelCount: physical,
        elementStartPixel: 0,
        skippedPixels,
      },
    ],
  };
  const existing = (await request('/elements')).some((e) => e.id === element.id);
  await request(
    '/elements' + (existing ? '/' + element.id : ''),
    existing ? 'PATCH' : 'POST',
    element,
  );
  const scene = {
    id: 'demo-pulse',
    name: 'Autumn glow',
    effects: [
      {
        type: 'pulse',
        targets: [element.id],
        params: { color: '#ff6600', durationMs: 2000, minBrightness: 0.1, maxBrightness: 0.6 },
      },
    ],
  };
  const saved = (await request('/scenes')).some((s) => s.id === scene.id);
  await request('/scenes' + (saved ? '/' + scene.id : ''), saved ? 'PATCH' : 'POST', scene);
  await request('/scenes/' + scene.id + '/activate', 'POST');
  const pixels = await until(async () => {
    try {
      const r = await fetch(
        'http://127.0.0.1:' + (process.env.SIM_INSPECT_PORT ?? 4090) + '/pixels',
      );
      const data = await r.json();
      return data.frames > 10 && data.pixels.some((p) => p > 0) ? data : null;
    } catch {
      return null;
    }
  });
  console.log(
    `Demo active: ${deviceId}, ${pixels.frames} received frames. Dashboard: ${origin}; pixels: http://127.0.0.1:${process.env.SIM_INSPECT_PORT ?? 4090}`,
  );
} finally {
  if (cookie) await request('/auth/logout', 'POST').catch(() => {});
  await agent.close();
}
