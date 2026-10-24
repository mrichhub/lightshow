import {MongoClient,type Db,type ClientSession} from 'mongodb';
import type {Device,DeviceStatus,Element,Scene,DesiredShow} from '../../../packages/models/src/index.js';
export interface Credential {_id:string;kind:'device'|'admin'|'enrollment';id:string;deviceId?:string;hardwareId?:string;expiresAt?:Date;consumedDeviceId?:string;name?:string}
export interface Session {_id:string;expiresAt:Date}
export function collections(db:Db) {
 return {devices:db.collection<Device&{_id:string}>('devices'),statuses:db.collection<DeviceStatus&{_id:string}>('device_status'),elements:db.collection<Element&{_id:string}>('elements'),scenes:db.collection<Scene&{_id:string}>('scenes'),credentials:db.collection<Credential>('credentials'),sessions:db.collection<Session>('sessions'),shows:db.collection<DesiredShow&{_id:string}>('shows'),locks:db.collection<{_id:string;revision:number}>('locks')};
}
export async function openDatabase(url:string):Promise<{client:MongoClient;db:Db}> {
 const client=new MongoClient(url,{serverSelectionTimeoutMS:15000});await client.connect();const db=client.db();const c=collections(db);
 await Promise.all([
  c.devices.createIndex({deviceId:1},{unique:true}),c.devices.createIndex({hardwareId:1},{unique:true}),
  c.statuses.createIndex({lastSeen:1}),c.elements.createIndex({id:1},{unique:true}),c.scenes.createIndex({id:1},{unique:true}),
  c.sessions.createIndex({expiresAt:1},{expireAfterSeconds:0}),c.credentials.createIndex({expiresAt:1},{expireAfterSeconds:0}),c.credentials.createIndex({id:1},{unique:true}),c.credentials.createIndex({deviceId:1,kind:1})
 ]);
 await c.locks.updateOne({_id:'mapping'},{$setOnInsert:{revision:0}},{upsert:true});
 await c.shows.updateOne({_id:'desired'},{$setOnInsert:{sceneId:null,overrides:[],version:1,startedAt:new Date().toISOString()}},{upsert:true});
 return {client,db};
}
export async function mappingTransaction<T>(db:Db,client:MongoClient,work:(session:ClientSession)=>Promise<T>):Promise<T> {
 const session=client.startSession();try{return await session.withTransaction(async()=>{await collections(db).locks.updateOne({_id:'mapping'},{$inc:{revision:1}},{session});return work(session);});}finally{await session.endSession();}
}
