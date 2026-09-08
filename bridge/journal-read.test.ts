import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioStore } from './studio';
import { pageJournal } from '../shared/journal-page';

test('read archive persists, pages correctly, preserves content and restores unread', async () => {
 const dir=mkdtempSync(join(tmpdir(),'herdr-journal-read-'));
 let store=new StudioStore(dir,{asyncWrite:true});
 try {
  for(let i=0;i<3;i++)await store.run(()=>store.change({op:'entry.save',title:`Memory ${i}`,notes:'Keep this content',kind:'note',project:'',contributors:[],url:''},[],{snapshot:false}));
  const entry=store.journalPage({limit:10}).entries[1];
  await store.run(()=>store.change({op:'entry.read',id:entry.id,version:entry.version,read:true},[],{snapshot:false}));
  expect(store.journalPage({read:false}).total).toBe(2);
  expect(store.journalPage({read:true}).entries.map(e=>e.id)).toEqual([entry.id]);
  const all=store.journalPage({}).entries;
  expect(pageJournal(all,[],{read:true},0,'test').entries.map(e=>e.id)).toEqual([entry.id]);
  await store.close(); store=new StudioStore(dir,{asyncWrite:true});
  const archived=store.journalPage({read:true}).entries[0];
  expect(archived.notes).toBe('Keep this content'); expect(archived.readAt).toBeGreaterThan(0);
  expect(()=>store.change({op:'entry.read',id:entry.id,version:0,read:false},[])).toThrow();
  await store.run(()=>store.change({op:'entry.save',...archived,title:'Edited archive',project:''},[],{snapshot:false}));
  expect(store.journalPage({read:true}).total).toBe(1);
  const edited=store.journalPage({read:true}).entries[0];
  await store.run(()=>store.change({op:'entry.read',id:edited.id,version:edited.version,read:false},[],{snapshot:false}));
  expect(store.journalPage({read:true}).total).toBe(0);expect(store.journalPage({read:false}).total).toBe(3);
 } finally {await store.close();rmSync(dir,{recursive:true,force:true});}
});
