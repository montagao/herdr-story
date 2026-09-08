// Sprite lab. ?lab=1 shows body/face cells; ?lab=pod renders one pod with all four seats occupied.
// Extra params: body=N face=N fx=N fy=N
import Phaser from 'phaser';
import { BODY_POSE, FACE, bodyKey, defineFrames, faceKey, loadSheets } from '../sprites';
import { FACE_OFFSET } from '../feed/avatar';
import { buildPod, type Workstation } from './OfficeScene';
import type { AgentStatus } from '../../shared/types';

export class LabScene extends Phaser.Scene {
  private stations: Workstation[] = [];
  private tickN = -1;
  constructor() { super('lab'); }
  /** Desks animate off the shared clock, same as the office. */
  update(time: number) {
    const t = Math.floor(time / 125);
    if (t !== this.tickN) { this.tickN = t; for (const st of this.stations) st.tick(t); }
  }
  preload() { loadSheets(this.load); }
  create() {
    defineFrames(this.textures);
    const q = new URLSearchParams(location.search);
    const mode = q.get('lab');
    const cam = this.cameras.main;
    cam.setBackgroundColor(mode === 'pod' ? '#8a5a3c' : '#ff77ff');
    const label = (x: number, y: number, t: string) => this.add.text(x, y, t, { fontFamily: 'DotGothic16', fontSize: '6px', color: mode === 'pod' ? '#fff' : '#000' }).setResolution(4);
    if (mode === 'pod') {
      (window as any).__quiet = q.has('quiet'); // no bubbles/popups while measuring
      cam.setZoom(4); cam.centerOn(26, 40);   // centre of the four seat anchors
      const stations = this.stations = buildPod(this, 2, 2);
      const seats = Number(q.get('seats') ?? stations.length);
      for (const st of stations.slice(seats)) st.destroy();
      stations.length = Math.min(stations.length, seats);
      const statuses: AgentStatus[] = (q.get('st') ?? 'working,blocked,idle,working').split(',') as AgentStatus[];
      stations.forEach((st, i) => {
        st.setAgent({ pane_id: `w${i + 1}:p1`, agent: ['claude', 'codex', 'cursor', 'gemini'][i], agent_status: statuses[i] ?? 'working', state_change_seq: 0 });
      });
      if (q.has('quiet')) for (const st of stations) st.tag.setVisible(false);
      label(-150, -50, `POD lab: seats top, right, left, bottom. ?st=working,blocked,idle,done`);
      return;
    }
    const b = Number(q.get('body') ?? 0), f = Number(q.get('face') ?? 0);
    const fx = Number(q.get('fx') ?? FACE_OFFSET.x), fy = Number(q.get('fy') ?? FACE_OFFSET.y);
    cam.setZoom(3); cam.setScroll(-cam.width / 3 + 4, -cam.height / 3 + 4);
    let i = 0;
    for (const [name, p] of Object.entries(BODY_POSE)) {
      const x = 4 + (i % 6) * 36, y = 24 + Math.floor(i / 6) * 34; i++;
      const body = this.add.image(x, y, bodyKey(b), name).setOrigin(0, 0);
      this.add.image(x + fx, y + fy, faceKey(f), 'frontL').setOrigin(0, 0);
      label(x, y + body.height + 1, `${name} ${p.x},${p.y}`);
    }
    let j = 0;
    for (const name of Object.keys(FACE)) { const x = 4 + j * 24, y = 170; this.add.image(x, y, faceKey(f), name).setOrigin(0, 0); label(x, y + 16, name); j++; }
    ['back', 'faceSE', 'faceSW', 'side'].forEach((n, k) => { this.add.image(230 + k * 26, 24, 'chair_002', n).setOrigin(0, 0); label(230 + k * 26, 58, n); });
    ['alongSE', 'alongSW', 'extra'].forEach((n, k) => { this.add.image(230 + k * 60, 70, 'desk_002', n).setOrigin(0, 0); label(230 + k * 60, 134, n); });
    ['back', 'on0', 'on1', 'on2', 'on3', 'on4'].forEach((n, k) => { this.add.image(230 + k * 52, 140, 'pc_001', n).setOrigin(0, 0); label(230 + k * 52, 172, n); });
    label(4, 4, `LAB body${b} face_${f}  — ?body=N&face=N&fx=N&fy=N   ?lab=pod for a desk pod`);
  }
}
