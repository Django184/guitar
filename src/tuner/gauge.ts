import { s } from '../ui/dom';

/** Cadran : ±50 cents répartis sur ±70°, zone verte à ±5 cents. */
const CX = 160;
const CY = 172;
const RADIUS = 140;
const MAX_CENTS = 50;
const MAX_ANGLE = 70;
export const IN_TUNE_CENTS = 5;

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const angleFor = (cents: number): number =>
  (Math.max(-MAX_CENTS, Math.min(MAX_CENTS, cents)) / MAX_CENTS) * MAX_ANGLE;

function point(angleDeg: number, radius: number): [number, number] {
  return [CX + radius * Math.sin(toRad(angleDeg)), CY - radius * Math.cos(toRad(angleDeg))];
}

function arc(fromDeg: number, toDeg: number, radius: number): string {
  const [x1, y1] = point(fromDeg, radius);
  const [x2, y2] = point(toDeg, radius);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export interface Gauge {
  element: SVGSVGElement;
  /** Cible de l'aiguille, en cents (null = aucune mesure). */
  setTarget(cents: number | null, inTune: boolean): void;
  /** Avance l'animation d'une image ; renvoie false quand l'aiguille est immobile. */
  step(): boolean;
}

export function createGauge(): Gauge {
  const ticks = s('g', { class: 'gauge__ticks' });
  for (let cents = -MAX_CENTS; cents <= MAX_CENTS; cents += 5) {
    const major = cents % 25 === 0;
    const [x1, y1] = point(angleFor(cents), RADIUS - (major ? 18 : 10));
    const [x2, y2] = point(angleFor(cents), RADIUS);
    ticks.append(
      s('line', {
        x1: x1.toFixed(2),
        y1: y1.toFixed(2),
        x2: x2.toFixed(2),
        y2: y2.toFixed(2),
        class: major ? 'gauge__tick gauge__tick--major' : 'gauge__tick',
      }),
    );
  }

  const labels = s('g', { class: 'gauge__labels' });
  for (const cents of [-50, 0, 50]) {
    const [x, y] = point(angleFor(cents), RADIUS + 16);
    const text = cents === 0 ? '0' : cents > 0 ? `+${cents}` : `−${-cents}`;
    labels.append(s('text', { x: x.toFixed(2), y: (y + 4).toFixed(2), 'text-anchor': 'middle' }, text));
  }

  const needle = s(
    'g',
    { class: 'gauge__needle' },
    s('line', { x1: CX, y1: CY, x2: CX, y2: CY - RADIUS + 6 }),
    s('circle', { cx: CX, cy: CY, r: 8 }),
  );

  const svg = s(
    'svg',
    { class: 'gauge', viewBox: '0 0 320 190', role: 'img', 'aria-label': 'Aiguille de justesse, de −50 à +50 cents' },
    s('path', { class: 'gauge__track', d: arc(-MAX_ANGLE, MAX_ANGLE, RADIUS) }),
    s('path', { class: 'gauge__zone', d: arc(angleFor(-IN_TUNE_CENTS), angleFor(IN_TUNE_CENTS), RADIUS) }),
    ticks,
    labels,
    needle,
  );

  let target = 0;
  let current = 0;

  const draw = (): void => {
    needle.setAttribute('transform', `rotate(${current.toFixed(2)} ${CX} ${CY})`);
  };
  draw();

  return {
    element: svg,
    setTarget(cents, inTune) {
      svg.classList.toggle('is-idle', cents === null);
      svg.classList.toggle('is-in-tune', cents !== null && inTune);
      if (cents !== null) target = angleFor(cents);
    },
    step() {
      const delta = target - current;
      if (Math.abs(delta) < 0.05) {
        if (current !== target) {
          current = target;
          draw();
        }
        return false;
      }
      current += delta * 0.3;
      draw();
      return true;
    },
  };
}
