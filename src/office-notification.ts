/** Keep transient game windows over the office, excluding the roster. They stay under body
 * so pausing the office's animations does not also freeze the notification's entrance. */
export function anchorOfficeNotification(root: HTMLElement) {
  const game = document.getElementById('game');
  if (!game) return;
  const update = () => {
    const box = game.getBoundingClientRect();
    const left = Math.max(0, box.left), top = Math.max(0, box.top);
    const width = Math.max(0, Math.min(innerWidth, box.right) - left);
    const height = Math.max(0, Math.min(innerHeight, box.bottom) - top);
    for (const [name, value] of Object.entries({ left, top, width, height }))
      root.style.setProperty(`--office-${name}`, `${value}px`);
  };
  const observer = new ResizeObserver(update);
  observer.observe(game);
  // Collapsing replay controls moves the office without changing its own size.
  const controls = document.getElementById('replay-controls');
  if (controls) observer.observe(controls);
  window.addEventListener('resize', update);
  update();
}

const READ_MS = 1500;     // the least a window gets once the pointer has left it
const HOLD_MS = 20_000;   // the longest a resting pointer keeps one up

/** How long a transient window stays. It closes itself when its time is up, except that a pointer
 * moved onto it holds it there to be read, and leaving hands back the time it had left. */
export class Lifetime {
  private timer = 0;
  private endsAt = 0;
  private held = 0;
  constructor(private expire: () => void) {}
  get holding() { return this.held > 0; }
  /** Milliseconds the window still has; it does not run down while the pointer holds it. */
  get left() { return this.held || Math.max(0, this.endsAt - Date.now()); }
  start(ms: number) {
    if (this.held) { this.held = ms; return; }
    clearTimeout(this.timer);
    this.endsAt = Date.now() + ms;
    this.timer = window.setTimeout(this.expire, ms);
  }
  stop() { clearTimeout(this.timer); this.held = 0; }
  /** Call with the window each time it is drawn; the roots themselves let the pointer through.
   * It takes a move to hold one: a window that opens under a pointer left lying there is not
   * being read. The browser reports a move of its own when a window lands under a still pointer,
   * so the first one only says where the pointer is. */
  watch(win: HTMLElement) {
    let at: { x: number; y: number } | undefined;
    win.addEventListener('pointermove', (event) => {
      if (this.held) return;
      if (!at || (at.x === event.clientX && at.y === event.clientY)) { at = { x: event.clientX, y: event.clientY }; return; }
      this.held = Math.max(READ_MS, this.left);
      clearTimeout(this.timer);
      this.timer = window.setTimeout(this.expire, HOLD_MS);
    });
    win.addEventListener('pointerleave', () => {
      const left = this.held;
      this.held = 0;
      if (left) this.start(left);
    });
  }
}
