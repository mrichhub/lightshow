import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hash, argon2id } from 'argon2';

if (existsSync('.env') || existsSync('.secrets'))
  throw new Error(
    'Existing deployment found. Refusing to replace credentials. See docs/provisioning.md.',
  );
const hostname = process.env.LIGHTSHOW_HOST || 'lightshow.home.arpa';
if (!/^[a-z0-9.-]+$/.test(hostname)) throw new Error('Invalid LIGHTSHOW_HOST');
const secret = () => randomBytes(32).toString('hex');
const admin = process.env.LIGHTSHOW_SETUP_PASSWORD || secret();
const mongo = secret(),
  mongoApi = secret(),
  mongoEngine = secret(),
  api = secret(),
  engine = secret();
for (const dir of ['.secrets', '.secrets/trust', '.secrets/mqtt', '.secrets/broker', '.local'])
  mkdirSync(dir, { recursive: true });
chmodSync('.secrets', 0o700);
const openssl = (...args) => execFileSync('openssl', args, { stdio: 'ignore' });
openssl(
  'req',
  '-x509',
  '-newkey',
  'rsa:3072',
  '-sha256',
  '-nodes',
  '-keyout',
  '.secrets/mqtt/ca.key',
  '-out',
  '.secrets/trust/mqtt-ca.crt',
  '-days',
  '3650',
  '-subj',
  '/CN=Lightshow MQTT CA',
);
openssl(
  'req',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  '.secrets/mqtt/server.key',
  '-out',
  '.secrets/mqtt/server.csr',
  '-subj',
  `/CN=${hostname}`,
);
writeFileSync(
  '.secrets/mqtt/extensions.conf',
  `subjectAltName=DNS:${hostname},DNS:mosquitto\nextendedKeyUsage=serverAuth\n`,
);
openssl(
  'x509',
  '-req',
  '-in',
  '.secrets/mqtt/server.csr',
  '-CA',
  '.secrets/trust/mqtt-ca.crt',
  '-CAkey',
  '.secrets/mqtt/ca.key',
  '-CAcreateserial',
  '-out',
  '.secrets/mqtt/server.crt',
  '-days',
  '825',
  '-sha256',
  '-extfile',
  '.secrets/mqtt/extensions.conf',
);
writeFileSync('.secrets/mongo-key', randomBytes(512).toString('base64'), { mode: 0o600 });
const acl = (acltype, topic) => ({ acltype, topic, allow: true });
const role = (rolename, topics) => ({
  rolename,
  acls: topics.flatMap(([topic, types]) => types.map((type) => acl(type, topic))),
});
const all = ['publishClientSend', 'publishClientReceive', 'subscribePattern', 'unsubscribePattern'];
const roles = [
  role('api', [
    ['lightshow/#', all],
    ['$CONTROL/dynamic-security/#', all],
  ]),
  role('engine', [
    ['lightshow/show/command', ['subscribeLiteral', 'publishClientReceive']],
    ['lightshow/show/state', ['publishClientSend']],
    ['lightshow/events/#', ['subscribePattern', 'publishClientReceive']],
  ]),
];
function client(username, password) {
  const salt = randomBytes(12),
    iterations = 210000;
  return {
    username,
    password: pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('base64'),
    salt: salt.toString('base64'),
    iterations,
    roles: [{ rolename: username }],
  };
}
writeFileSync(
  '.secrets/broker/dynamic-security.json',
  JSON.stringify(
    {
      defaultACLAccess: {
        publishClientSend: false,
        publishClientReceive: false,
        subscribe: false,
        unsubscribe: true,
      },
      clients: [client('api', api), client('engine', engine)],
      groups: [],
      roles,
    },
    null,
    2,
  ),
);
// The broker image drops to uid 1883 and must atomically rewrite this directory.
chmodSync('.secrets/broker', 0o700);
chmodSync('.secrets/broker/dynamic-security.json', 0o600);
chmodSync('.secrets/mqtt/server.key', 0o644);
const passwordHash = await hash(admin, { type: argon2id, memoryCost: 65536, timeCost: 3 });
const env = {
  LIGHTSHOW_HOST: hostname,
  PUBLIC_ORIGIN: `https://${hostname}`,
  HTTPS_PORT: '443',
  HTTP_PORT: '80',
  API_PORT: '3000',
  LOG_LEVEL: 'info',
  ADMIN_PASSWORD_HASH: passwordHash,
  SESSION_HOURS: '24',
  MONGO_ROOT_USER: 'lightshow',
  MONGO_ROOT_PASSWORD: mongo,
  MONGO_API_PASSWORD: mongoApi,
  MONGO_ENGINE_PASSWORD: mongoEngine,
  MONGO_URL: `mongodb://lightshow-api:${mongoApi}@mongo:27017/lightshow?authSource=lightshow&replicaSet=rs0`,
  MONGO_ENGINE_URL: `mongodb://lightshow-engine:${mongoEngine}@mongo:27017/lightshow?authSource=lightshow&replicaSet=rs0`,
  MQTT_URL: 'mqtts://mosquitto:8883',
  MQTT_PUBLIC_URL: `mqtts://${hostname}:8883`,
  MQTT_API_USER: 'api',
  MQTT_API_PASSWORD: api,
  MQTT_ENGINE_USER: 'engine',
  MQTT_ENGINE_PASSWORD: engine,
  MQTT_CA_FILE: '/run/trust/mqtt-ca.crt',
  HTTPS_CA_FILE: '/run/trust/https-ca.crt',
  CADDY_TLS: 'internal',
  TARGET_FPS: '40',
  DDP_PORT: '4048',
  SIM_HARDWARE_ID: 'sim-yard-1',
  SIM_STATE_FILE: '/state/identity.json',
  SIM_API_URL: `https://${hostname}`,
  SIM_INSPECT_PORT: '4090',
  SIM_PROVISIONING_TOKEN: '',
};
// Compose interpolates dollar signs even inside env files; single quotes preserve Argon2 encoding.
writeFileSync(
  '.env',
  Object.entries(env)
    .map(([k, v]) => `${k}='${v}'`)
    .join('\n') + '\n',
  { mode: 0o600 },
);
writeFileSync('.local/admin-password', admin + '\n', { mode: 0o600 });
console.log(
  'Private deployment generated. Administrator password is in .local/admin-password. Start Compose, then run pnpm trust.',
);
