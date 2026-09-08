type Frame = (time: number, delta: number) => void;

/** Keep browser RAF/input live while skipping expensive, unobserved office redraws.
 * Accumulated delta keeps walking and tweens at their original real-time speed. */
export class RenderBudget {
  private activeUntil = 0;
  private nextFrame = 0;
  private accumulated = 0;
  private previousTime = 0;
  private frame: Frame;
  constructor(frame: Frame, private now = () => performance.now()) { this.frame = frame; }

  /** Half rates throughout: the settings window's kindness to laptops and phones. */
  lowPower = false;
  get fps() { const active = this.now() < this.activeUntil; return this.lowPower ? (active ? 30 : 15) : (active ? 60 : 30); }

  boost(duration = 1000) {
    const now = this.now(), wasActive = now < this.activeUntil;
    this.activeUntil = Math.max(this.activeUntil, now + duration);
    // The next native input frame must not wait for an old idle deadline.
    if (!wasActive) this.nextFrame = Math.min(this.nextFrame, now);
  }

  reset() { this.nextFrame = 0; this.accumulated = 0; this.previousTime = 0; }

  step = (time: number, delta: number) => {
    // A sleeping/hidden scene resumes at its current position instead of teleporting.
    if (this.previousTime && time - this.previousTime > 250) this.reset();
    this.previousTime = time;
    this.accumulated += Math.min(delta, 100);
    if (time + 0.5 < this.nextFrame) return;
    const interval = 1000 / this.fps;
    this.nextFrame = this.nextFrame ? this.nextFrame + interval : time + interval;
    if (this.nextFrame <= time) this.nextFrame = time + interval;
    const elapsed = this.accumulated;
    this.accumulated = 0;
    this.frame(time, elapsed);
  };
}
