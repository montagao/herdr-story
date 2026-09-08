import { expect, test } from 'bun:test';
import { StudioSaves } from './studio-saves';
import type { OfficeClient } from './net/office-client';
const uncertain=()=>Object.assign(new Error('Lost reply'),{uncertain:true});
const storage=()=>{let value='';return {getItem:()=>value,setItem:(_key:string,next:string)=>{value=next;}};};
test('a confirmed lost reply fetches state without sending the edit twice',async()=>{
 const calls:string[]=[]; const result={revision:3};
 const saves=new StudioSaves({call:async(method:string)=>{calls.push(method);if(method==='studio.change')throw uncertain();return method==='studio.action.status'?{state:'confirmed'}:result;}} as OfficeClient,storage());
 expect(await saves.save({op:'entry.save'},'entry:new')).toBe(result as any);
 expect(calls).toEqual(['studio.change','studio.action.status','studio.get']);expect(saves.pending.size).toBe(0);
});
test('uncertain saves survive refresh; explicit retry checks status and reuses the original ID',async()=>{
 const disk=storage(),ids:string[]=[];let online=false;const calls:string[]=[];
 const client={call:async(method:string,params:any)=>{calls.push(method);if(method==='studio.action.status')return {state:'unknown'};ids.push(params.action_id);if(!online)throw uncertain();return {revision:4};}} as OfficeClient;
 let saves=new StudioSaves(client,disk);
 await expect(saves.save({op:'entry.save',title:'Draft'},'entry:new')).rejects.toThrow('not confirmed');
 saves=new StudioSaves(client,disk);const pending=[...saves.pending.values()][0];
 expect(pending.state).toBe('uncertain');expect(pending.params.title).toBe('Draft');
 await expect(saves.check(pending)).rejects.toThrow('not confirmed');expect(ids).toHaveLength(1);
 online=true;await saves.check(pending,true);expect(ids).toEqual([pending.id,pending.id]);expect(calls.slice(-2)).toEqual(['studio.action.status','studio.change']);expect(saves.pending.size).toBe(0);
});
test('unrelated saves complete independently and definite failures leave no uncertain receipt',async()=>{
 let release!:(value:any)=>void;
 const saves=new StudioSaves({call:async(_method:string,params:any)=>params.id==='a'?new Promise(resolve=>{release=resolve;}):params.id==='bad'?Promise.reject(new Error('Version conflict')):{revision:2}} as OfficeClient,storage());
 const first=saves.save({op:'entry.read',id:'a'},'entry:a');
 expect(await saves.save({op:'entry.read',id:'b'},'entry:b')).toEqual({revision:2} as any);
 expect(saves.pending.has('entry:a')).toBe(true);
 await expect(saves.save({op:'entry.read',id:'bad'},'entry:bad')).rejects.toThrow('Version conflict');expect(saves.pending.has('entry:bad')).toBe(false);
 release({revision:3});await first;expect(saves.pending.size).toBe(0);
});
