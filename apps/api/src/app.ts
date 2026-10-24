import Fastify,{type FastifyRequest} from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import {Type,type Static} from '@sinclair/typebox';
import {verify} from 'argon2';
import {randomUUID} from 'node:crypto';
import type {Db,MongoClient} from 'mongodb';
import {ConfigInputSchema,ConfigSchema,DeviceId,ElementSchema,HeartbeatSchema,Id,OverrideSchema,SceneSchema,compileMappings,defaultConfig,validateConfig,type ConfigInput,type DeviceConfig,type Element,type Heartbeat,type Override,type Scene} from '../../../packages/models/src/index.js';
import {token,tokenHash,uniqueDeviceId} from '../../../packages/models/src/security.js';
import {type Bus,topics} from '../../../packages/messaging/src/index.js';
import {collections,mappingTransaction} from './store.js';
import {Events} from './events.js';

declare module 'fastify' {interface FastifyRequest {principal?:{kind:'admin'|'device';deviceId?:string;sessionHash?:string;expiresAt?:Date}}}
export interface ApiConfig {origin:string;adminHash:string;sessionHours:number;mqttPublicUrl:string;logLevel?:string}
const AnyRecord=Type.Record(Type.String(),Type.Unknown());
const Ok=Type.Object({ok:Type.Boolean()});
const IdParams=Type.Object({id:Id});
const ErrorSchema=Type.Object({error:Type.String(),message:Type.String(),statusCode:Type.Integer()});
const DeviceResponse=Type.Object({deviceId:DeviceId,hardwareId:Type.String(),name:Type.String(),config:ConfigSchema,createdAt:Type.String(),revoked:Type.Optional(Type.Boolean())});
function fault(code:number,message:string):never {throw Object.assign(new Error(message),{statusCode:code});}
const bearer=(req:FastifyRequest)=>req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
export async function createApp(db:Db,client:MongoClient,bus:Bus,config:ApiConfig) {
 if(!config.origin.startsWith('https://')||!config.adminHash.startsWith('$argon2id$'))throw new Error('HTTPS origin and Argon2id administrator hash required');
 const app=Fastify({logger:{level:config.logLevel??'info',redact:['req.headers.authorization','req.headers.cookie','res.headers.set-cookie']},bodyLimit:262144,ajv:{customOptions:{removeAdditional:false}}});
 const c=collections(db);const events=new Events(db,bus,error=>app.log.error(error));
 await app.register(cookie);await app.register(rateLimit,{global:false});
 await app.register(swagger,{openapi:{info:{title:'Lightshow API',version:'0.1.0'},components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer'},session:{type:'apiKey',in:'cookie',name:'__Host-lightshow'}}},security:[{bearerAuth:[]},{session:[]}]}});
 await app.register(swaggerUI,{routePrefix:'/v1/docs',staticCSP:true});
 app.addSchema({$id:'Error',...ErrorSchema});
 app.setErrorHandler((error,req,reply)=>{const e=error as Error&{statusCode?:number};const status=e.statusCode??500;if(status>=500)req.log.error(error);void reply.code(status).send({error:status>=500?'Server error':'Request rejected',message:status>=500?'Request could not be completed':e.message,statusCode:status});});
 app.addHook('onRequest',async(req)=>{
  const path=req.url.split('?')[0]!;
  if(path==='/v1/health'||path==='/v1/auth/login'||path==='/v1/devices/init')return;
  const deviceRoute=path==='/v1/devices/config'||path==='/v1/devices/heartbeat';
  const raw=bearer(req);
  if(raw){const cred=await c.credentials.findOne({_id:tokenHash(raw),kind:deviceRoute?'device':'admin'});if(!cred||cred.expiresAt&&cred.expiresAt<=new Date())fault(401,'Invalid or revoked credential');if(cred.deviceId&&!(await c.devices.findOne({_id:cred.deviceId,revoked:{$ne:true}})))fault(401,'Device revoked');req.principal={kind:deviceRoute?'device':'admin',deviceId:cred.deviceId};return;}
  if(deviceRoute)fault(401,'Device Bearer credential required');
  const session=req.cookies['__Host-lightshow'];const row=session?await c.sessions.findOne({_id:tokenHash(session),expiresAt:{$gt:new Date()}}):null;
  if(!row)fault(401,'Administrator authentication required');
  req.principal={kind:'admin',sessionHash:row._id,expiresAt:row.expiresAt};
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers.origin!==config.origin)fault(403,'Origin must match PUBLIC_ORIGIN');
 });
 const cookieOptions={httpOnly:true,secure:true,sameSite:'strict' as const,path:'/'};
 app.get('/v1/health',{schema:{response:{200:Ok}}},async()=>{await db.command({ping:1});if(bus.client&&!bus.client.connected)fault(503,'MQTT unavailable');return {ok:true};});
 app.post('/v1/auth/login',{config:{rateLimit:{max:5,timeWindow:60000}},schema:{body:Type.Object({password:Type.String({minLength:1,maxLength:1024})},{additionalProperties:false}),response:{200:Ok}}},async(req,reply)=>{
  if(req.headers.origin!==config.origin)fault(403,'Origin must match PUBLIC_ORIGIN');
  if(!await verify(config.adminHash,(req.body as {password:string}).password))fault(401,'Invalid password');
  if(req.cookies['__Host-lightshow'])await c.sessions.deleteOne({_id:tokenHash(req.cookies['__Host-lightshow']!)});
  const value=token();const expiresAt=new Date(Date.now()+config.sessionHours*3600000);await c.sessions.insertOne({_id:tokenHash(value),expiresAt});
  reply.setCookie('__Host-lightshow',value,{...cookieOptions,expires:expiresAt});return {ok:true};
 });
 app.post('/v1/auth/logout',{schema:{response:{200:Ok}}},async(req,reply)=>{if(req.principal?.sessionHash)await c.sessions.deleteOne({_id:req.principal.sessionHash});reply.clearCookie('__Host-lightshow',cookieOptions);return {ok:true};});
 app.get('/v1/auth/session',{schema:{response:{200:Type.Object({authenticated:Type.Boolean()})}}},async()=>({authenticated:true}));
 app.post('/v1/auth/tokens',{schema:{body:Type.Object({name:Type.String({minLength:1,maxLength:100}),days:Type.Integer({minimum:1,maximum:365})},{additionalProperties:false}),response:{200:Type.Object({id:Type.String(),token:Type.String()})}}},async req=>{const b=req.body as {name:string;days:number};const value=token(),id=randomUUID();await c.credentials.insertOne({_id:tokenHash(value),kind:'admin',id,name:b.name,expiresAt:new Date(Date.now()+b.days*86400000)});return {id,token:value};});
 app.get('/v1/auth/tokens',{schema:{response:{200:Type.Array(AnyRecord)}}},async()=>c.credentials.find({kind:'admin'},{projection:{_id:0,id:1,name:1,expiresAt:1}}).toArray());
 app.delete('/v1/auth/tokens/:id',{schema:{params:IdParams,response:{200:Ok}}},async req=>{await c.credentials.deleteOne({kind:'admin',id:(req.params as {id:string}).id});return {ok:true};});
 app.post('/v1/enrollments',{schema:{body:Type.Object({hardwareId:Type.String({minLength:3,maxLength:128}),minutes:Type.Integer({minimum:1,maximum:1440})},{additionalProperties:false}),response:{200:Type.Object({id:Type.String(),token:Type.String(),expiresAt:Type.String()})}}},async req=>{
  const b=req.body as {hardwareId:string;minutes:number};if(await c.devices.findOne({hardwareId:b.hardwareId}))fault(409,'Revoke existing device before issuing a recovery enrollment');
  const value=token(),id=randomUUID(),expiresAt=new Date(Date.now()+b.minutes*60000);await c.credentials.insertOne({_id:tokenHash(value),kind:'enrollment',id,hardwareId:b.hardwareId,expiresAt});return {id,token:value,expiresAt:expiresAt.toISOString()};
 });
 const InitBody=Type.Object({hardwareId:Type.String({minLength:3,maxLength:128}),board:Type.Union([Type.Literal('wt32-eth01'),Type.Literal('esp32dev')])},{additionalProperties:false});
 app.post('/v1/devices/init',{config:{rateLimit:{max:20,timeWindow:60000}},schema:{body:InitBody,response:{200:Type.Object({deviceId:DeviceId,token:Type.Optional(Type.String()),config:ConfigSchema,mqtt:Type.Object({url:Type.String(),username:Type.String(),password:Type.String()})})}}},async req=>{
  const b=req.body as Static<typeof InitBody>,raw=bearer(req);if(!raw)fault(401,'Enrollment or device Bearer credential required');
  const hash=tokenHash(raw);const cred=await c.credentials.findOne({_id:hash});if(!cred||cred.expiresAt&&cred.expiresAt<=new Date())fault(401,'Invalid credential');
  let device;let issued:string|undefined;
  if(cred.kind==='device') {device=await c.devices.findOne({_id:cred.deviceId,revoked:{$ne:true}});if(!device||device.hardwareId!==b.hardwareId||device.config.hardware.board!==b.board)fault(403,'Device identity mismatch');}
  else if(cred.kind==='enrollment') {
   if(cred.hardwareId!==b.hardwareId)fault(403,'Enrollment is bound to another hardware identity');
   if(cred.consumedDeviceId)fault(409,'Enrollment already consumed. Use saved device credential or administrator recovery.');
   const deviceId=await uniqueDeviceId(async id=>!!await c.devices.findOne({_id:id}));issued=token();
   const newDevice={_id:deviceId,deviceId,hardwareId:b.hardwareId,name:deviceId,config:defaultConfig(deviceId,b.board),createdAt:new Date().toISOString()};
   const session=client.startSession();
   try{await session.withTransaction(async()=>{
    const claim=await c.credentials.updateOne({_id:hash,consumedDeviceId:{$exists:false}},{$set:{consumedDeviceId:deviceId}},{session});if(!claim.modifiedCount)fault(409,'Enrollment already consumed');
    if(await c.devices.findOne({hardwareId:b.hardwareId},{session}))fault(409,'Hardware identity already enrolled');
    await c.devices.insertOne(newDevice,{session});await c.credentials.insertOne({_id:tokenHash(issued!),kind:'device',id:randomUUID(),deviceId},{session});
   });}finally{await session.endSession();}
   device=newDevice;
  }else fault(403,'Device or enrollment credential required');
  // Rotating MQTT secrets can be recovered by an authenticated device after response loss.
  const password=token();await bus.provision(device.deviceId,password);
  return {deviceId:device.deviceId,token:issued,config:device.config,mqtt:{url:config.mqttPublicUrl,username:device.deviceId,password}};
 });
 app.get('/v1/devices/config',{schema:{response:{200:ConfigSchema}}},async req=>{const dev=await c.devices.findOne({_id:req.principal!.deviceId});return dev!.config;});
 app.post('/v1/devices/heartbeat',{schema:{body:HeartbeatSchema,response:{200:Type.Object({ok:Type.Boolean(),configVersion:Type.Integer()})}}},async req=>{
  const deviceId=req.principal!.deviceId!;const data=req.body as Heartbeat;const dev=await c.devices.findOne({_id:deviceId});
  // IP used for DDP is independently reported by the device; treat it as deployment data, not auth.
  await c.statuses.replaceOne({_id:deviceId},{deviceId,...data,lastSeen:new Date().toISOString(),address:data.network.ip},{upsert:true});return {ok:true,configVersion:dev!.config.configVersion};
 });
 app.get('/v1/devices',{schema:{response:{200:Type.Array(DeviceResponse)}}},async()=>c.devices.find({},{projection:{_id:0}}).toArray());
 app.get('/v1/status',{schema:{response:{200:Type.Array(AnyRecord)}}},async()=>c.statuses.find({},{projection:{_id:0}}).toArray());
 app.get('/v1/devices/:id',{schema:{params:IdParams,response:{200:DeviceResponse}}},async req=>{const d=await c.devices.findOne({_id:(req.params as {id:string}).id});if(!d)fault(404,'Device not found');return d;});
 app.patch('/v1/devices/:id',{schema:{params:IdParams,body:Type.Object({name:Type.Optional(Type.String({minLength:1,maxLength:100})),config:Type.Optional(ConfigInputSchema),expectedVersion:Type.Integer({minimum:1})},{additionalProperties:false}),response:{200:DeviceResponse}}},async req=>{
  const id=(req.params as {id:string}).id;const b=req.body as {name?:string;config?:ConfigInput;expectedVersion:number};
  const device=await mappingTransaction(db,client,async session=>{
   const d=await c.devices.findOne({_id:id},{session});if(!d)fault(404,'Device not found');if(d.config.configVersion!==b.expectedVersion)fault(409,'Configuration changed. Reload and retry.');
   const next:DeviceConfig={...(b.config??d.config),deviceId:id,configVersion:d.config.configVersion+1};
   if(next.hardware.board!==d.config.hardware.board)fault(400,'Board profile cannot be changed');
   try{validateConfig(next);const devices=await c.devices.find({},{session}).toArray();compileMappings(devices.map(v=>v.deviceId===id?next:v.config),await c.elements.find({},{session}).toArray());}catch(e){fault(400,(e as Error).message);}
   const updated={...d,name:b.name??d.name,config:next};await c.devices.replaceOne({_id:id},updated,{session});return updated;
  });
  await bus.publish(topics.command(id),{type:'configUpdated',configVersion:device.config.configVersion}).catch(e=>app.log.error(e));return device;
 });
 app.post('/v1/devices/:id/refresh',{schema:{params:IdParams,response:{200:Ok}}},async req=>{const d=await c.devices.findOne({_id:(req.params as {id:string}).id});if(!d)fault(404,'Device not found');await bus.publish(topics.command(d.deviceId),{type:'configUpdated',configVersion:d.config.configVersion,force:true});return {ok:true};});
 app.post('/v1/devices/:id/revoke',{schema:{params:IdParams,response:{200:Ok}}},async req=>{
  const id=(req.params as {id:string}).id;const d=await c.devices.findOne({_id:id});if(!d)fault(404,'Device not found');
  // Disable broker before removing REST credentials; failed revocation remains retryable.
  await bus.revoke(id);await c.credentials.deleteMany({deviceId:id});await c.devices.updateOne({_id:id},{$set:{revoked:true}});return {ok:true};
 });
 app.delete('/v1/devices/:id',{schema:{params:IdParams,response:{200:Ok}}},async req=>{const id=(req.params as {id:string}).id;await mappingTransaction(db,client,async session=>{if(await c.elements.findOne({'segments.deviceId':id},{session}))fault(409,'Remove element mappings first');const d=await c.devices.findOne({_id:id},{session});if(!d?.revoked)fault(409,'Revoke the device first');await c.devices.deleteOne({_id:id},{session});await c.statuses.deleteOne({_id:id},{session});});return {ok:true};});
 app.get('/v1/elements',{schema:{response:{200:Type.Array(ElementSchema)}}},async()=>c.elements.find({},{projection:{_id:0}}).toArray());
 const saveElement=async(req:FastifyRequest)=>{
  const el=req.body as Element;const pathId=(req.params as {id?:string}).id;if(pathId&&pathId!==el.id)fault(400,'Element ID cannot be changed');
  await mappingTransaction(db,client,async session=>{
   const exists=await c.elements.findOne({_id:el.id},{session});if(req.method==='POST'&&exists)fault(409,'Element exists');if(pathId&&!exists)fault(404,'Element not found');
   const all=await c.elements.find({_id:{$ne:el.id}},{session}).toArray();const devices=await c.devices.find({},{session}).toArray();
   try{compileMappings(devices.map(d=>d.config),[...all,el]);}catch(e){fault(400,(e as Error).message);}
   await c.elements.replaceOne({_id:el.id},el,{upsert:true,session});
  });return el;
 };
 app.post('/v1/elements',{schema:{body:ElementSchema,response:{200:ElementSchema}}},saveElement);
 app.patch('/v1/elements/:id',{schema:{params:IdParams,body:ElementSchema,response:{200:ElementSchema}}},saveElement);
 app.delete('/v1/elements/:id',{schema:{params:IdParams,response:{200:Ok}}},async req=>{const id=(req.params as {id:string}).id;await mappingTransaction(db,client,async session=>{if(await c.scenes.findOne({'effects.targets':id},{session}))fault(409,'Remove scene references first');const show=await c.shows.findOne({_id:'desired'},{session});if(show?.overrides.some(o=>o.elementId===id))fault(409,'Clear debugger overrides first');await c.elements.deleteOne({_id:id},{session});});return {ok:true};});
 app.get('/v1/scenes',{schema:{response:{200:Type.Array(SceneSchema)}}},async()=>c.scenes.find({},{projection:{_id:0}}).toArray());
 for(const method of ['POST','PATCH'] as const)app.route({method,url:method==='POST'?'/v1/scenes':'/v1/scenes/:id',schema:{...(method==='PATCH'?{params:IdParams}:{}),body:SceneSchema,response:{200:SceneSchema}},handler:async req=>{
  const scene=req.body as Scene;if(method==='PATCH'&&(req.params as {id:string}).id!==scene.id)fault(400,'Scene ID cannot be changed');
  await mappingTransaction(db,client,async session=>{const elements=await c.elements.find({},{session}).toArray();for(const effect of scene.effects){if(effect.targets.some(id=>!elements.some(e=>e.id===id)))fault(400,'Unknown effect target');if((effect.params.minBrightness??0)>(effect.params.maxBrightness??1))fault(400,'Brightness bounds are reversed');}if(method==='POST'&&await c.scenes.findOne({_id:scene.id},{session}))fault(409,'Scene exists');await c.scenes.replaceOne({_id:scene.id},scene,{upsert:true,session});});return scene;
 }});
 app.get('/v1/show',{schema:{response:{200:AnyRecord}}},async()=>await c.shows.findOne({_id:'desired'},{projection:{_id:0}})??{});
 app.post('/v1/scenes/:id/activate',{schema:{params:IdParams,response:{200:Ok}}},async req=>{const id=(req.params as {id:string}).id;if(!await c.scenes.findOne({_id:id}))fault(404,'Scene not found');await c.shows.updateOne({_id:'desired'},{$set:{sceneId:id,startedAt:new Date().toISOString()},$inc:{version:1}});await bus.publish(topics.showCommand,{type:'reload'}).catch(e=>app.log.error(e));return {ok:true};});
 app.post('/v1/show/stop',{schema:{response:{200:Ok}}},async()=>{await c.shows.updateOne({_id:'desired'},{$set:{sceneId:null,overrides:[],startedAt:new Date().toISOString()},$inc:{version:1}});return {ok:true};});
 app.put('/v1/show/overrides',{schema:{body:Type.Array(OverrideSchema,{maxItems:256}),response:{200:Ok}}},async req=>{
  const overrides=req.body as Override[];await mappingTransaction(db,client,async session=>{
   for(const o of overrides){if(Boolean(o.elementId)===Boolean(o.deviceId))fault(400,'Select exactly one element or device output');if(o.elementId){const el=await c.elements.findOne({_id:o.elementId},{session});if(!el||o.pixel!==undefined&&o.pixel>=el.pixelCount)fault(400,'Invalid element/pixel');}else{const d=await c.devices.findOne({_id:o.deviceId},{session});const out=d?.config.outputs[o.outputIndex??-1];if(!out||o.pixel!==undefined&&o.pixel>=out.pixelCount)fault(400,'Invalid output/pixel');}}
   await c.shows.updateOne({_id:'desired'},{$set:{overrides},$inc:{version:1}},{session});
  });return {ok:true};
 });
 app.get('/v1/events',async(req,reply)=>{
  if(!req.principal?.sessionHash)fault(401,'SSE requires an administrator session cookie');
  reply.hijack();const response=reply.raw;response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});
  const remove=events.add(response);let disposed=false;
  const cleanup=()=>{if(disposed)return;disposed=true;clearInterval(authCheck);remove();};
  const authCheck=setInterval(()=>{void c.sessions.findOne({_id:req.principal!.sessionHash,expiresAt:{$gt:new Date()}}).then(row=>{if(!row)response.end();}).catch(()=>response.end());},5000);
  response.on('close',cleanup);events.send(response,'snapshot',await events.snapshot());
 });
 app.addHook('onClose',async()=>events.close());
 await app.ready();events.start();return app;
}
