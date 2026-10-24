import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Simulator } from './simulator.js';
const simulator = new Simulator({
  apiUrl: process.env.SIM_API_URL ?? 'https://lightshow.home.arpa',
  hardwareId: process.env.SIM_HARDWARE_ID ?? 'sim-yard-1',
  provisioningToken: process.env.SIM_PROVISIONING_TOKEN,
  stateFile: process.env.SIM_STATE_FILE ?? '.local/simulator-1.json',
  httpsCA: readFileSync(process.env.HTTPS_CA_FILE!, 'utf8'),
  mqttCA: readFileSync(process.env.MQTT_CA_FILE!, 'utf8'),
  inspectPort: Number(process.env.SIM_INSPECT_PORT ?? 4090),
  inspectHost: '0.0.0.0',
  ip: process.env.SIM_IP,
  mqttUrl: process.env.SIM_MQTT_URL,
});
await simulator.start();
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => void simulator.close().then(() => process.exit(0)));
