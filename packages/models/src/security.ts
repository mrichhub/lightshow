import { createHash, randomBytes, randomInt } from 'node:crypto';
export const token = () => randomBytes(32).toString('base64url');
export const tokenHash = (value:string) => createHash('sha256').update(value).digest('hex');
export function generateDeviceId():string {const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';return Array.from({length:6},()=>chars[randomInt(chars.length)]).join('');}
export async function uniqueDeviceId(exists:(id:string)=>Promise<boolean>):Promise<string> {
 for(let n=0;n<32;n++){const id=generateDeviceId();if(!await exists(id))return id;}throw new Error('Unable to allocate device ID');
}
