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
