import dgram,{type Socket} from 'node:dgram';
import {createServer,type Server} from 'node:http';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {networkInterfaces} from 'node:os';
import mqtt,{type MqttClient} from 'mqtt';
import {Agent,fetch} from 'undici';
import {DdpReceiver} from '../../../packages/ddp/src/index.js';
import {validateConfig,type DeviceConfig,type Heartbeat} from '../../../packages/models/src/index.js';
import {topics} from '../../../packages/messaging/src/index.js';
import {compileEffect} from '../../../packages/effects/src/index.js';
interface Identity {deviceId:string;token:string;config:DeviceConfig;mqtt:{url:string;username:string;password:string}}
export interface SimulatorOptions {apiUrl:string;hardwareId:string;provisioningToken?:string;stateFile:string;httpsCA:string;mqttCA:string;inspectPort:number;inspectHost?:string;ip?:string}
const address=()=>Object.values(networkInterfaces()).flat().find(i=>i&&i.family==='IPv4'&&!i.internal)?.address??'127.0.0.1';
export class Simulator {
 identity?:Identity;receiver?:DdpReceiver;private udp?:Socket;private mqtt?:MqttClient;private server?:Server;
 private heartbeat?:NodeJS.Timeout;private render?:NodeJS.Timeout;private reconnect?:NodeJS.Timeout;private busy=false;private closed=false;
 private boot=performance.now();private lastFrames=0;private fps=0;private agent:Agent;
 constructor(readonly options:SimulatorOptions){if(!options.apiUrl.startsWith('https://'))throw new Error('Simulator requires HTTPS');this.agent=new Agent({connect:{ca:options.httpsCA,rejectUnauthorized:true}});}
 async request<T>(path:string,body?:unknown,credential=this.identity?.token):Promise<T>{
  const response=await fetch(new URL(path,this.options.apiUrl),{dispatcher:this.agent,method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${credential??''}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error(`${path}: ${response.status} ${await response.text()}`);return await response.json() as T;
 }
 private async save(){await mkdir(dirname(this.options.stateFile),{recursive:true});const temp=this.options.stateFile+'.tmp';await writeFile(temp,JSON.stringify(this.identity),{mode:0o600});await rename(temp,this.options.stateFile);}
 private async configure(config:DeviceConfig){
  validateConfig(config);const bytes=config.outputs.reduce((n,o)=>n+o.pixelCount*3,0);const next=new DdpReceiver(bytes,config.ddp.allowedSources,config.ddp.timeoutMs);
  if(!this.udp||this.identity?.config.ddp.port!==config.ddp.port){if(this.udp)await new Promise<void>(r=>this.udp!.close(()=>r()));const socket=dgram.createSocket('udp4');socket.on('message',(data,remote)=>{if(this.identity?.config.mode==='listening')this.receiver?.accept(data,remote.address);});socket.on('error',e=>console.error('Simulator UDP',e.message));await new Promise<void>((resolve,reject)=>{socket.once('error',reject);socket.bind(config.ddp.port,'0.0.0.0',()=>{socket.removeListener('error',reject);resolve();});});this.udp=socket;}
  this.receiver=next;if(this.identity)this.identity.config=config;await this.save();
 }
 private async initialize(){
  const response=await this.request<Identity>('/v1/devices/init',{hardwareId:this.options.hardwareId,board:'esp32dev'},this.identity?.token??this.options.provisioningToken);
  const identity={...response,token:response.token??this.identity!.token};validateConfig(identity.config);
  // Persist the REST credential before MQTT connection attempts; restarts can recover broker provisioning.
  this.identity=identity;await this.save();await this.configure(identity.config);
  if(this.mqtt)await this.mqtt.endAsync();
  if(!identity.mqtt.url.startsWith('mqtts://'))throw new Error('MQTT TLS required');
  this.mqtt=mqtt.connect(identity.mqtt.url,{username:identity.mqtt.username,password:identity.mqtt.password,ca:this.options.mqttCA,rejectUnauthorized:true,clientId:`device-${identity.deviceId}`,reconnectPeriod:2000,will:{topic:topics.availability(identity.deviceId),payload:'offline',qos:1,retain:true}});
  this.mqtt.on('error',e=>console.error('Simulator MQTT',e.message));
  this.mqtt.on('connect',()=>{void this.mqtt!.subscribeAsync(topics.command(identity.deviceId),{qos:1}).then(()=>this.mqtt!.publishAsync(topics.availability(identity.deviceId),'online',{qos:1,retain:true})).then(()=>this.sync()).catch(console.error);});
  this.mqtt.on('message',(_,payload)=>{try{const cmd=JSON.parse(payload.toString());if(cmd.type==='configUpdated'&&(cmd.force||cmd.configVersion>this.identity!.config.configVersion))void this.sync().catch(console.error);}catch{console.error('Invalid device command');}});
 }
 private syncing?:Promise<void>;
 private sync():Promise<void>{if(this.syncing)return this.syncing;this.syncing=(async()=>{const config=await this.request<DeviceConfig>('/v1/devices/config');if(config.configVersion!==this.identity!.config.configVersion)await this.configure(config);await this.mqtt?.publishAsync(topics.state(this.identity!.deviceId),JSON.stringify({configVersion:config.configVersion,mode:config.mode}),{qos:1,retain:true});})().finally(()=>{this.syncing=undefined;});return this.syncing;}
 async start(){
  try{this.identity=JSON.parse(await readFile(this.options.stateFile,'utf8')) as Identity;validateConfig(this.identity.config);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(this.identity)await this.configure(this.identity.config);
  await this.initialize().catch(e=>{if(!this.identity)throw e;console.error('Using cached configuration:',e.message);});
  const local=compileEffect({type:'rainbow',targets:['local'],params:{durationMs:4000,maxBrightness:0.25}});
  this.render=setInterval(()=>{if(this.identity!.config.mode==='local')local(this.receiver!.pixels,performance.now()-this.boot);else this.receiver!.tick();},25);
  this.heartbeat=setInterval(()=>void this.beat(),5000);await this.beat();
  this.reconnect=setInterval(()=>{if(!this.mqtt&&!this.closed)void this.initialize().catch(console.error);},10000);
  this.server=createServer((req,res)=>{res.setHeader('cache-control','no-store');if(req.url==='/pixels'||req.url==='/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({deviceId:this.identity!.deviceId,configVersion:this.identity!.config.configVersion,mode:this.identity!.config.mode,frames:this.receiver!.frames,fps:this.fps,dropped:this.receiver!.dropped,incomplete:this.receiver!.incomplete,pixels:Array.from(this.receiver!.pixels)}));return;}res.setHeader('content-type','text/html');res.end(`<!doctype html><title>Lightshow simulated pixels</title><style>body{background:#10151e;color:#edf1f5;font:16px system-ui;padding:30px}canvas{width:100%;image-rendering:pixelated}pre{color:#9aa8b6}</style><h1>Simulated ESP</h1><pre id="info"></pre><canvas width="1000" height="200"></canvas><script>const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');setInterval(async()=>{const d=await(await fetch('/pixels')).json();document.querySelector('#info').textContent=JSON.stringify({...d,pixels:undefined},null,2);ctx.clearRect(0,0,1000,200);d.pixels.forEach((v,i)=>{if(i%3)return;const p=i/3;ctx.fillStyle='rgb('+d.pixels.slice(i,i+3).join(',')+')';ctx.fillRect(p%50*20,Math.floor(p/50)*20,17,17)});},100)</script>`);}).listen(this.options.inspectPort,this.options.inspectHost??'127.0.0.1');
 }
 private async beat(){if(this.busy||!this.identity)return;this.busy=true;
  try{const r=this.receiver!,cfg=this.identity.config;this.fps=(r.frames-this.lastFrames)/5;this.lastFrames=r.frames;
   const h:Heartbeat={uptime:(performance.now()-this.boot)/1000,firmwareVersion:'sim-0.1.0',board:cfg.hardware.board,mode:cfg.mode,network:{type:'wifi',connected:true,ip:this.options.ip??address(),rssi:-35},freeHeap:process.memoryUsage().heapTotal-process.memoryUsage().heapUsed,minHeap:100000,networkStack:8192,lightingStack:8192,ddpFps:this.fps,ledFps:40,droppedFrames:r.dropped,incompleteFrames:r.incomplete,lastDdpMs:r.lastValidAt===null?null:performance.now()-r.lastValidAt,renderDurationUs:0,configVersion:cfg.configVersion};
   const result=await this.request<{configVersion:number}>('/v1/devices/heartbeat',h);if(result.configVersion!==cfg.configVersion)await this.sync();
  }catch(e){console.error('Simulator heartbeat',e);}finally{this.busy=false;}
 }
 async close(){this.closed=true;clearInterval(this.render);clearInterval(this.heartbeat);clearInterval(this.reconnect);this.server?.closeAllConnections();await new Promise<void>(resolve=>this.server?this.server.close(()=>resolve()):resolve());if(this.udp)await new Promise<void>(r=>this.udp!.close(()=>r()));if(this.mqtt){await this.mqtt.publishAsync(topics.availability(this.identity!.deviceId),'offline',{qos:1,retain:true}).catch(()=>{});await this.mqtt.endAsync(true);}await this.agent.close();}
}
