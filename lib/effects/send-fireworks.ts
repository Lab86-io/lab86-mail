// Adapted from Animate UI's Fireworks Background (MIT + Commons Clause, see animate-ui-LICENSE.md).
// https://animate-ui.com/r/components-backgrounds-fireworks.json
// Bounded launches, faster decay, DPR sizing, fixed-rate physics, and full cleanup
// adapt the continuous background to an email-send celebration.

const rand = (min: number, max: number): number => Math.random() * (max - min) + min;

const randInt = (min: number, max: number): number => Math.floor(Math.random() * (max - min) + min);

type ParticleType = {
  x: number;
  y: number;
  color: string;
  speed: number;
  direction: number;
  vx: number;
  vy: number;
  gravity: number;
  friction: number;
  alpha: number;
  decay: number;
  size: number;
  update: () => void;
  draw: (ctx: CanvasRenderingContext2D) => void;
  isAlive: () => boolean;
};

function createParticle(
  x: number,
  y: number,
  color: string,
  speed: number,
  direction: number,
  gravity: number,
  friction: number,
  size: number,
): ParticleType {
  const vx = Math.cos(direction) * speed;
  const vy = Math.sin(direction) * speed;
  const alpha = 1;
  const decay = rand(0.018, 0.028);

  return {
    x,
    y,
    color,
    speed,
    direction,
    vx,
    vy,
    gravity,
    friction,
    alpha,
    decay,
    size,
    update() {
      this.vx *= this.friction;
      this.vy *= this.friction;
      this.vy += this.gravity;
      this.x += this.vx;
      this.y += this.vy;
      this.alpha -= this.decay;
    },
    draw(ctx: CanvasRenderingContext2D) {
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.shadowColor = this.color;
      ctx.shadowBlur = 6;
      ctx.fillStyle = this.color;
      ctx.fill();
      ctx.restore();
    },
    isAlive() {
      return this.alpha > 0;
    },
  };
}

type FireworkType = {
  x: number;
  y: number;
  targetY: number;
  color: string;
  speed: number;
  size: number;
  angle: number;
  vx: number;
  vy: number;
  trail: { x: number; y: number }[];
  trailLength: number;
  exploded: boolean;
  update: () => boolean;
  explode: () => void;
  draw: (ctx: CanvasRenderingContext2D) => void;
};

function createFirework(
  x: number,
  y: number,
  targetY: number,
  color: string,
  speed: number,
  size: number,
  particleSpeed: { min: number; max: number } | number,
  particleSize: { min: number; max: number } | number,
  onExplode: (particles: ParticleType[]) => void,
): FireworkType {
  const angle = -Math.PI / 2 + rand(-0.3, 0.3);
  const vx = Math.cos(angle) * speed;
  const vy = Math.sin(angle) * speed;
  const trail: { x: number; y: number }[] = [];
  const trailLength = randInt(10, 25);

  return {
    x,
    y,
    targetY,
    color,
    speed,
    size,
    angle,
    vx,
    vy,
    trail,
    trailLength,
    exploded: false,
    update() {
      this.trail.push({ x: this.x, y: this.y });
      if (this.trail.length > this.trailLength) {
        this.trail.shift();
      }
      this.x += this.vx;
      this.y += this.vy;
      this.vy += 0.02;
      if (this.vy >= 0 || this.y <= this.targetY) {
        this.explode();
        return false;
      }
      return true;
    },
    explode() {
      const numParticles = 70;
      const particles: ParticleType[] = [];
      for (let i = 0; i < numParticles; i++) {
        const particleAngle = rand(0, Math.PI * 2);
        const localParticleSpeed = getValueByRange(particleSpeed);
        const localParticleSize = getValueByRange(particleSize);
        particles.push(
          createParticle(
            this.x,
            this.y,
            this.color,
            localParticleSpeed,
            particleAngle,
            0.05,
            0.98,
            localParticleSize,
          ),
        );
      }
      onExplode(particles);
    },
    draw(ctx: CanvasRenderingContext2D) {
      ctx.save();
      ctx.beginPath();
      if (this.trail.length > 1) {
        ctx.moveTo(this.trail[0]?.x ?? this.x, this.trail[0]?.y ?? this.y);
        for (const point of this.trail) {
          ctx.lineTo(point.x, point.y);
        }
      } else {
        ctx.moveTo(this.x, this.y);
        ctx.lineTo(this.x, this.y);
      }
      ctx.strokeStyle = this.color;
      ctx.lineWidth = this.size;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();
    },
  };
}

function getValueByRange(range: { min: number; max: number } | number): number {
  if (typeof range === 'number') {
    return range;
  }
  return rand(range.min, range.max);
}

let stopActive: (() => void) | undefined;

export function launchSendFireworks() {
  stopActive?.();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.dataset.sendCelebration = 'fireworks';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:10001';
  const width = window.innerWidth;
  const height = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  document.body.append(canvas);
  const stamp = document.createElement('div');
  stamp.dataset.sendStamp = '';
  stamp.setAttribute('aria-hidden', 'true');
  stamp.style.cssText =
    'position:fixed;inset:0;display:grid;place-items:center;pointer-events:none;z-index:10002';
  const ink = document.createElement('div');
  ink.style.cssText =
    'width:min(76vw,560px);padding:clamp(12px,3vw,24px);border:clamp(5px,.8vw,9px) solid currentColor;border-radius:20px;color:var(--color-accent,#b74379);background:var(--color-bg-elevated,#fff);box-shadow:0 14px 60px #00000026;outline:2px solid currentColor;outline-offset:-16px;text-align:center;transform:rotate(-12deg);font-family:var(--font-geist-sans),sans-serif';
  const title = document.createElement('div');
  title.textContent = 'SENT!';
  title.style.cssText =
    'font-size:clamp(64px,15vw,132px);font-weight:950;letter-spacing:-.055em;line-height:1.1';
  const subtitle = document.createElement('div');
  subtitle.textContent = 'SIGNED. SEALED. DELIVERED.';
  subtitle.style.cssText =
    'padding:4px 0 8px;font-size:clamp(8px,1.8vw,13px);font-weight:750;letter-spacing:.18em';
  ink.append(title, subtitle);
  stamp.append(ink);
  document.body.append(stamp);
  const stampAnimation =
    typeof ink.animate === 'function'
      ? ink.animate(
          [
            { transform: 'rotate(-22deg) scale(2.4)', opacity: 0, offset: 0 },
            { transform: 'rotate(-12deg) scale(.94)', opacity: 1, offset: 0.1 },
            { transform: 'rotate(-10deg) scale(1.04)', opacity: 1, offset: 0.15 },
            { transform: 'rotate(-12deg) scale(1)', opacity: 1, offset: 0.21 },
            { transform: 'rotate(-12deg) scale(1)', opacity: 1, offset: 0.76 },
            { transform: 'rotate(-8deg) scale(1.12)', opacity: 0, offset: 1 },
          ],
          { duration: 2_300, easing: 'ease-out', fill: 'both' },
        )
      : null;
  const explosions: ParticleType[] = [];
  const fireworks: FireworkType[] = [];
  const colors = ['#fbbf24', '#f472b6', '#a78bfa'];
  const start = performance.now();
  let launched = 0;
  let frame = 0;
  let last = start;
  let elapsed = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    window.clearTimeout(timeout);
    document.removeEventListener('visibilitychange', onVisibility);
    canvas.remove();
    stampAnimation?.cancel();
    stamp.remove();
    if (stopActive === stop) stopActive = undefined;
  };
  const onVisibility = () => {
    if (document.hidden) stop();
  };
  const timeout = window.setTimeout(stop, 3_200);
  document.addEventListener('visibilitychange', onVisibility);
  stopActive = stop;
  const animate = (now: number) => {
    if (stopped) return;
    if (launched < 3 && now - start >= launched * 200) {
      const x = width * [0.3, 0.7, 0.5][launched];
      const target = height * [0.42, 0.36, 0.28][launched];
      fireworks.push(
        createFirework(
          x,
          height,
          target,
          colors[launched],
          (height - target) / 24,
          2,
          { min: 2, max: width < 500 ? 4 : 6 },
          { min: 1, max: 2 },
          (particles) => explosions.push(...particles),
        ),
      );
      launched++;
    }
    elapsed += Math.min(50, now - last);
    last = now;
    // The registry's physics use frames. Step at 60 Hz on high-refresh displays too.
    while (elapsed >= 1_000 / 60) {
      for (let i = fireworks.length - 1; i >= 0; i--) if (!fireworks[i].update()) fireworks.splice(i, 1);
      for (let i = explosions.length - 1; i >= 0; i--) {
        explosions[i].update();
        if (!explosions[i].isAlive()) explosions.splice(i, 1);
      }
      elapsed -= 1_000 / 60;
    }
    ctx.clearRect(0, 0, width, height);
    for (const firework of fireworks) firework.draw(ctx);
    for (const particle of explosions) particle.draw(ctx);
    if (launched === 3 && !fireworks.length && !explosions.length) stop();
    else frame = requestAnimationFrame(animate);
  };
  frame = requestAnimationFrame(animate);
}
