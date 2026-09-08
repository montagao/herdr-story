import type Phaser from 'phaser';
import type { Rect } from '../decor';

let textureId = 0;
/** Record graphics in positive texture coordinates, then retain one crisp image per object.
 * The caller draws between begin/end. Oversized rooms keep their vector wall to cap memory. */
export function beginBakedGraphics(scene: Phaser.Scene, bounds: Rect) {
  const graphics = scene.add.graphics();
  const bake = bounds.w <= 4096 && bounds.h <= 4096 && bounds.w * bounds.h <= 4_000_000;
  if (bake) graphics.translateCanvas(-bounds.x, -bounds.y);
  return {
    graphics,
    finish(): Phaser.GameObjects.Image | Phaser.GameObjects.Graphics {
      if (!bake) return graphics;
      const key = `office-baked:${++textureId}`;
      graphics.generateTexture(key, Math.ceil(bounds.w), Math.ceil(bounds.h));
      const image = scene.add.image(bounds.x, bounds.y, key).setOrigin(0);
      image.once('destroy', () => scene.textures.remove(key));
      graphics.destroy();
      return image;
    },
  };
}
