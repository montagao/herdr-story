import { expect, test } from 'bun:test';
import { planRoom, retainFurnishings } from './roomPlan';
import type { RoomItem } from '../../shared/studio';
const plants: RoomItem[] = [
 {id:'plan:back:1',kind:'decor',asset:'zephilie-foliage-plant',x:128,y:104},
 {id:'custom-plant',kind:'decor',asset:'floor18_244_45',x:64,y:256},
];
test('tidy with unavailable catalogs retains every existing plant',()=>{
 const planned=planRoom([],35,31,[],1);
 const result=retainFurnishings(planned,plants);
 for(const plant of plants)expect(result.find(p=>p.item.id===plant.id)?.item).toEqual(plant);
});
test('tidy repositions owned plants without replacing their assets or dropping obstructed items',()=>{
 const result=retainFurnishings([{item:{...plants[0],asset:'other-plant',x:10,y:20},strict:true}],plants);
 expect(result).toHaveLength(2);
 expect(result[0]).toMatchObject({strict:false,item:{...plants[0],x:10,y:20}});
 expect(plants[0].x).toBe(128);
});
