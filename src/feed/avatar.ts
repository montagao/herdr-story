// Draws a pixel avatar (face over body) into a small canvas for the DOM feed and dialog.
import { BODY_POSE, FACE, FACE_H, FACE_W, lookFor } from '../sprites';

const cache = new Map<string, Promise<HTMLImageElement>>();
function img(src: string): Promise<HTMLImageElement> {
  const existing = cache.get(src); if (existing) return existing;
  const request = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src;
  }).catch(error => { cache.delete(src); throw error; });
  cache.set(src, request); return request;
}
export const FACE_OFFSET = { x: 0, y: -4 }; // face top-left relative to body top-left; tuned in lab

export function avatarCanvas(paneId: string, size = 44, custom?: { body: number; face: number }): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = 24; c.height = 24;
  // A readable initial remains when optional portrait sheets are unavailable.
  const fallback = c.getContext('2d')!;
  fallback.fillStyle = '#ece2c9'; fallback.fillRect(0, 0, 24, 24);
  fallback.fillStyle = '#514739'; fallback.font = 'bold 13px sans-serif'; fallback.textAlign = 'center';
  fallback.fillText(paneId.slice(-1).toUpperCase(), 12, 17);
  const look = custom ?? lookFor(paneId);
  Promise.all([img(`/assets/gds/body/body${look.body}.png`), img(`/assets/gds/face/face_${look.face}.png`)]).then(([b, f]) => {
    const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 24, 24);
    const p = BODY_POSE.standFront;
    const ox = 4, oy = 7;
    ctx.drawImage(b, p.x, p.y, p.w, p.h, ox, oy, p.w, p.h);
    const [fc, fr] = FACE.front;
    ctx.drawImage(f, fc * FACE_W, fr * FACE_H, FACE_W, FACE_H, ox + FACE_OFFSET.x, oy + FACE_OFFSET.y, FACE_W, FACE_H);
  }).catch(() => {});
  c.style.width = c.style.height = `${size}px`;
  return c;
}
