/** One depth convention for everything standing on the floor.
 *
 *  Objects are keyed by the top row of their floor footprint, less 10: a desk's footprint starts
 *  10px below its seat anchor, so this reproduces the game's anchor-y sort for desks and gives
 *  props, furnishings and the reception counter the same reference. People are keyed by their
 *  foot point (container y + 20, the point the wander grid tests) less 12, so someone on the free
 *  tile row just behind a desk sorts behind it and someone on the row in front of a prop sorts in
 *  front. Keying walkers by foot - 2, as before, put the whole 8px band behind every desk in
 *  front of it. */
export const FLOOR_LIFT = 10;
export function floorDepth(footprintTop: number) { return (footprintTop - FLOOR_LIFT) * 10; }
export function walkerDepth(y: number) { return (y + 20 - FLOOR_LIFT - 2) * 10 + 6; }
