// The office's own sense of order. A room is not a scatter of props: the game keeps its loose
// furniture where furniture goes, and so does this. The structure is fixed — a lounge beside
// the reception, plants along the back walls at a steady rhythm, one plant at the head of each
// desk bank, every team's whiteboard behind its desks, the trophy shelf and journal beside the
// entrance — and the seed only chooses between variants: which plant species, which table.
import type { RoomItem } from '../../shared/studio';
import { propKind, rng, type Prop } from '../decor';

/** Tile to screen, with the point on the tile's bottom that a prop stands on. */
export const tileAt = (c: number, r: number) => ({ x: (c - r) * 16, y: (c + r) * 8 + 8 });

export interface PodSite { id: string; col: number; row: number; pairs: number }
export interface Planned {
  item: RoomItem;
  /** Tiles worth trying first when the spot itself is taken (a board wants to stay behind its desks). */
  prefer?: (c: number, r: number) => boolean;
  /** Decoration on a rhythm: if the spot is taken it is left empty rather than nudged somewhere odd. */
  strict?: boolean;
}

const at = (id: string, kind: RoomItem['kind'], c: number, r: number, extra: Partial<RoomItem> = {}): RoomItem => ({ id, kind, ...extra, ...tileAt(c, r) });

/** Tidy changes positions, not ownership. Missing assets and crowded rooms must not erase
 * existing furnishings; the renderer can park them until there is room to display them. */
export function retainFurnishings(plan: Planned[], inventory: RoomItem[]): Planned[] {
  const existing = new Map(inventory.map(item => [item.id, item]));
  const planned = new Set(plan.map(({ item }) => item.id));
  return [
    ...plan.map(position => {
      const owned = existing.get(position.item.id);
      return owned ? { ...position, strict: false, item: { ...owned, x: position.item.x, y: position.item.y } } : position;
    }),
    ...inventory.filter(item => !planned.has(item.id)).map(item => ({ item: { ...item }, strict: false })),
  ];
}

export function planRoom(props: Prop[], W: number, H: number, pods: PodSite[], seed: number): Planned[] {
  const random = rng(seed);
  const pick = <T>(list: T[]): T | undefined => list.length ? list[Math.floor(random() * list.length)] : undefined;
  const of = (kind: ReturnType<typeof propKind>) => props.filter(p => propKind(p) === kind);
  const plants = of('plant'), tall = plants.filter(p => p.h >= 36), small = plants.filter(p => p.h < 36);
  // one species per role, so the room reads as furnished on purpose rather than from a catalogue
  const wallPlant = pick(tall) ?? pick(plants), deskPlant = pick(small) ?? pick(plants), table = pick(of('table'));
  const bench = pick(of('bench')), machine = pick(of('machine')), sign = pick(of('sign'));
  const out: Planned[] = [];
  // Reserve the executive desk before optional props, so Boss also fits in smaller offices.
  out.push({ item: at('studio-boss', 'boss', W - 4, 5), prefer: c => c >= W - 6 });
  const decor = (id: string, prop: Prop | undefined, c: number, r: number, strict = true) => { if (prop && c >= 1 && r >= 1 && c < W - 1 && r < H - 1) out.push({ item: at(id, 'decor', c, r, { asset: prop.id }), strict }); };

  // Every team's board stands behind its desks, off the aisle people walk down.
  for (const pod of pods) out.push({ item: at(`board:${pod.id}`, 'whiteboard', pod.col - 2, pod.row - 1, { project: pod.id }), prefer: (c, r) => c <= pod.col - 1 && r <= pod.row + 2 });
  // The entrance column — the four tiles along the door wall that no desk bank can claim — is
  // the reception's own: a waiting lounge of tables and benches behind the desk, then the journal
  // and the achievements right by the door where visitors see them.
  const wall = 2, door = W - 3;
  out.push({ item: at('studio-cabinet', 'cabinet', door, H - 13), prefer: c => c >= W - 5 });
  out.push({ item: at('studio-trophies', 'trophy', door, H - 9), prefer: c => c >= W - 5 });
  decor('plan:lounge:plant-a', wallPlant, door, 3);
  for (const [i, r] of [6, 14].entries()) {   // a table and its bench take eight rows
    if (r + 4 >= H - 13) break;   // a small office keeps the lounge to what fits before the cabinet
    decor(`plan:lounge:table-${i}`, table, door, r);
    decor(`plan:lounge:bench-${i}`, bench, door - 1, r + 3);   // in front of the table, toward the room
  }
  decor('plan:lounge:plant-b', wallPlant, door, 18);
  // The notice board in the back corner; plants on a steady beat along both back walls, with the
  // machine breaking the run once.
  if (sign) out.push({ item: at('plan:corner:sign', 'decor', wall, 6, { asset: sign.id }), prefer: (c, r) => c <= 4 && r <= 9 });
  for (let c = wall + 3, i = 0; c < W - 5; c += 5, i++) decor(`plan:back:${i}`, i === 2 && machine ? machine : wallPlant, c, wall);
  for (let r = 10, i = 0; r < H - 5; r += 5, i++) decor(`plan:left:${i}`, wallPlant, wall, r);
  // One plant at the head of every desk bank, the same species at every bank.
  for (const pod of pods) decor(`plan:pod:${pod.id}`, deskPlant, pod.col + 1, pod.row + 5, false);
  return out;
}
