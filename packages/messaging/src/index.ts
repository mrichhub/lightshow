import mqtt, {type MqttClient} from 'mqtt';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
export const topics={command:(id:string)=>`lightshow/devices/${id}/command`,state:(id:string)=>`lightshow/devices/${id}/state`,availability:(id:string)=>`lightshow/devices/${id}/availability`,telemetry:(id:string)=>`lightshow/devices/${id}/telemetry`,showCommand:'lightshow/show/command',showState:'lightshow/show/state',config:'lightshow/events/config'};
export interface Bus {publish(topic:string,value:unknown,retain?:boolean):Promise<void>;provision(id:string,password:string):Promise<void>;revoke(id:string):Promise<void>;close():Promise<void>;client?:MqttClient}
export async function connectBus(role:'API'|'ENGINE'):Promise<Bus> {
 const url=process.env.MQTT_URL!;if(!url?.startsWith('mqtts://'))throw new Error('MQTT_URL must use TLS');
 const client=await mqtt.connectAsync(url,{username:process.env[`MQTT_${role}_USER`],password:process.env[`MQTT_${role}_PASSWORD`],ca:readFileSync(process.env.MQTT_CA_FILE!),rejectUnauthorized:true,reconnectPeriod:2000,connectTimeout:10000,clientId:`lightshow-${role.toLowerCase()}-${randomUUID()}`});
 client.on('error',e=>console.error('MQTT',e.message));
 const pending=new Map<string,{resolve:()=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
 if(role==='API') {
  await client.subscribeAsync('$CONTROL/dynamic-security/v1/response',{qos:1});
  client.on('message',(topic,payload)=>{
   if(topic!=='$CONTROL/dynamic-security/v1/response')return;
   try {for(const response of JSON.parse(payload.toString()).responses??[]){const item=pending.get(response.correlationData);if(item){clearTimeout(item.timer);pending.delete(response.correlationData);response.error?item.reject(new Error(response.error)):item.resolve();}}}catch{console.error('Malformed broker control response');}
  });
 }
 async function command(data:Record<string,unknown>):Promise<void> {
  const correlationData=randomUUID();
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>{pending.delete(correlationData);reject(new Error('Broker control timeout'));},8000);
   pending.set(correlationData,{resolve,reject,timer});
   client.publish('$CONTROL/dynamic-security/v1',JSON.stringify({commands:[{...data,correlationData}]}),{qos:1,retain:false},e=>{if(e){clearTimeout(timer);pending.delete(correlationData);reject(e);}});
  });
 }
 return {
  client,
  async publish(topic,value,retain=false){await client.publishAsync(topic,JSON.stringify(value),{qos:topic.endsWith('/telemetry')?0:1,retain});},
  async provision(id,password){
   const rolename=`device-${id}`;
   try {await command({command:'createRole',rolename,acls:[
    {acltype:'subscribeLiteral',topic:topics.command(id),allow:true},
    {acltype:'publishClientReceive',topic:topics.command(id),allow:true},
    ...[topics.state(id),topics.availability(id),topics.telemetry(id)].map(topic=>({acltype:'publishClientSend',topic,allow:true}))
   ]});}catch(e){if(!(e instanceof Error)||!e.message.includes('already exists'))throw e;}
   try {await command({command:'createClient',username:id,password,roles:[{rolename}]});}catch(e){if(!(e instanceof Error)||!e.message.includes('already exists'))throw e;}
   await command({command:'setClientPassword',username:id,password});
   await command({command:'enableClient',username:id});
  },
  async revoke(id){await command({command:'disableClient',username:id});},
  async close(){for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Broker closed'));}await client.endAsync();}
 };
}
