import { useEffect, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import { PUBLIC_ASTRID_SKY_PIXEL, renderPublicAstridSky, skyLevelBounds, skyState, sunTimes, type PublicAstridSkyRenderInput, type PublicAstridSkyState } from '@/pages/Home/publicAstridSkyRender';
import { visitorLocation } from '@/pages/Home/publicAstridLocation';
import { todayAtHour, useAppTheme } from '@/shared/hooks/core/useAppTheme';
import { usePersistentState } from '@/shared/hooks/usePersistentState';
import { Switch } from '@/shared/components/ui/switch';

/**
 * The app's appearance as a time on a 24-hour clock, midnight to midnight, as on the public site. By
 * default it follows the real sky where the person is (the clock shows the time now); choosing a time
 * fixes the app at the sky's brightness then.
 */
export function useTimeOfDayTheme() {
  const { setTime, followsSky, followSky, hours, darkness, darkMode } = useAppTheme();
  const setHours = (value: number) => setTime(Math.min(24, Math.max(0, value)));
  return { hours, setHours, followsSky, followSky, darkness, darkMode };
}

/** "8:00 am", "12:30 pm": a time on the clock as people say it. */
export function formatClockTime(hours: number): string {
  const total = Math.round(Math.min(24, Math.max(0, hours)) * 60) % (24 * 60);
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`;
}

/** The real sky where the person is, at a time today. */
function skyAtHour(hours: number) {
  const at = todayAtHour(hours);
  return { ...skyState(hours % 24, sunTimes(at, visitorLocation(at))), hours: hours % 24 };
}

type Rgb = readonly [number, number, number];
const SKY_STOPS: ReadonlyArray<readonly [number, Rgb, Rgb]> = [
  // position, sky top, sky bottom: the site's paper by day, its dusky taupe, the near-black of night
  [0, [247, 244, 237], [244, 222, 202]],
  [0.38, [236, 226, 212], [240, 196, 160]],
  [0.5, [124, 113, 101], [214, 140, 96]],
  [0.62, [44, 40, 34], [86, 66, 52]],
  [1, [14, 13, 11], [34, 31, 26]],
];
const mix = (a: Rgb, b: Rgb, t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as unknown as Rgb;
const rgb = (c: Rgb) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

function skyAt(value: number): { top: string; bottom: string } {
  for (let i = 1; i < SKY_STOPS.length; i += 1) {
    const [at, top, bottom] = SKY_STOPS[i];
    const [prevAt, prevTop, prevBottom] = SKY_STOPS[i - 1];
    if (value <= at) {
      const t = (value - prevAt) / (at - prevAt);
      return { top: rgb(mix(prevTop, top, t)), bottom: rgb(mix(prevBottom, bottom, t)) };
    }
  }
  const last = SKY_STOPS[SKY_STOPS.length - 1];
  return { top: rgb(last[1]), bottom: rgb(last[2]) };
}

/** The preview's art pixel, in CSS px. */
const PREVIEW_PIXEL = 4;
/** The sun's and moon's size against the preview's height (the moon the smaller), and a lower arc than
 *  the home page's so at their highest they stay within the frame. */
const PREVIEW_SUN_SIZE = 0.3;
const PREVIEW_MOON_SCALE = 0.62;
const PREVIEW_ARC_LIFT = -0.34;
/** The preview's moon fades in as dusk deepens to full dark, and out again before first light: from just above
 *  the sky's darkness when the moon rises (about 0.57) to just short of fully dark (1). */
const PREVIEW_MOON_FADE = { from: 0.6, to: 0.95 } as const;
/** The share of its arc the preview's moon crosses through the night. The real moon rises low on the far left,
 *  which in a frame this small is off the edge and behind the hills until well after full dark, the darkest
 *  level a person can choose; kept to the middle of the arc, it is in view whenever it is up. */
const PREVIEW_MOON_TRACK = { from: 0.3, to: 0.7 } as const;

interface SkyFrame {
  /** The sky to draw: the real one, with the preview's moon kept within the frame. */
  state: PublicAstridSkyState;
  showSun: boolean;
  /** How far the moon has faded in, 0 to 1; 0 leaves it out. */
  moon: number;
}

/**
 * Which of the sun and moon a sky shows. With the environment off it is only its colour: no sun or moon (nor
 * stars, clouds and hills). Otherwise the sun by day and the moon by night, the preview's moon fading in with
 * the dark and crossing the middle of the frame; the twilight between them stays empty.
 */
export function skyFrame(state: PublicAstridSkyState, environment: boolean, variant: 'preview' | 'background'): SkyFrame {
  if (!environment || state.body === 'none') return { state, showSun: false, moon: 0 };
  if (state.body === 'sun') return { state, showSun: true, moon: 0 };
  if (variant === 'background') return { state, showSun: false, moon: 1 };
  const fade = Math.min(1, Math.max(0, (state.night - PREVIEW_MOON_FADE.from) / (PREVIEW_MOON_FADE.to - PREVIEW_MOON_FADE.from)));
  const progress = PREVIEW_MOON_TRACK.from + (PREVIEW_MOON_TRACK.to - PREVIEW_MOON_TRACK.from) * state.progress;
  return {
    state: { ...state, progress, altitude: Math.sin(Math.PI * progress), rising: progress < 0.5 },
    showSun: false,
    moon: fade * fade * (3 - 2 * fade),
  };
}

/** What the sky renderer is asked to paint for a sky, at the preview's or the app background's scale. */
export function skyRenderInput(columns: number, rows: number, sky: PublicAstridSkyState, environment: boolean, variant: 'preview' | 'background'): PublicAstridSkyRenderInput {
  const { state, showSun, moon } = skyFrame(sky, environment, variant);
  const intensity = variant === 'background' ? 0.3 + 0.15 * state.night : 0.5;
  return {
    columns,
    rows,
    state,
    phase: 0.5,
    // The intensity only sets the sun's or moon's strength, so it carries the moon's fade.
    intensity: moon > 0 ? intensity * moon : intensity,
    path: 'arc',
    size: variant === 'background' ? 1.18 : PREVIEW_SUN_SIZE,
    lift: variant === 'background' ? 0 : PREVIEW_ARC_LIFT,
    moonScale: PREVIEW_MOON_SCALE,
    showSun,
    showMoon: moon > 0,
    showEnvironment: environment,
  };
}

/** Gentle hills along the bottom of the preview, as the height of the ground (in art pixels) per column:
 *  a far ridge and a nearer one. */
function hillHeights(columns: number, rows: number) {
  const far: number[] = [];
  const near: number[] = [];
  for (let x = 0; x < columns; x += 1) {
    const t = x / columns;
    far.push(Math.round(rows * (0.3 + 0.06 * Math.sin(t * 5.2 + 0.6) + 0.03 * Math.sin(t * 11 + 2))));
    near.push(Math.round(rows * (0.18 + 0.05 * Math.sin(t * 3.4 + 2.4) + 0.025 * Math.sin(t * 9 + 1))));
  }
  return { far, near };
}

const HILL_TONES = {
  // The North Star sage, by day and by night.
  far: { day: [206, 218, 190] as Rgb, night: [40, 46, 35] as Rgb },
  near: { day: [182, 198, 162] as Rgb, night: [28, 32, 25] as Rgb },
};

/**
 * A small pixel sky at a time of day, drawn by the public site's own sky renderer from the real sky where
 * the person is, so it matches the home page and makes physical sense: the sun rises and sets behind the
 * hills, a smaller moon rises after dark, twilight comes and goes, stars come out, and the clouds move
 * with the time. Nothing ever turns into anything else.
 */
export type SkyPreviewVisibility = {
  environment: boolean;
};

export const SKY_PREVIEW_KEYS = {
  environment: 'theme-include-environment',
} as const;

export function useSkyPreviewVisibility(): SkyPreviewVisibility & {
  setEnvironment: Dispatch<SetStateAction<boolean>>;
} {
  const [environment, setEnvironment] = usePersistentState(SKY_PREVIEW_KEYS.environment, true);
  return { environment, setEnvironment };
}

export function TimeOfDaySky({
  hours,
  className = '',
  visibility = { environment: true },
  variant = 'preview',
}: {
  hours: number;
  className?: string;
  visibility?: SkyPreviewVisibility;
  variant?: 'preview' | 'background';
}) {
  const { environment } = visibility;
  const sky = skyAtHour(hours);
  const { top, bottom } = skyAt(sky.night);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ columns: 0, rows: 0 });

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const pixel = variant === 'background' ? PUBLIC_ASTRID_SKY_PIXEL : PREVIEW_PIXEL;
    const measure = () => setSize({
      columns: Math.max(1, Math.round(wrap.clientWidth / pixel)),
      rows: Math.max(1, Math.round(wrap.clientHeight / pixel)),
    });
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [variant]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const { columns, rows } = size;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || !columns || !rows) return;
    canvas.width = columns;
    canvas.height = rows;
    const input = skyRenderInput(columns, rows, skyAtHour(hours), environment, variant);
    const { state } = input;
    const image = context.createImageData(columns, rows);
    image.data.set(renderPublicAstridSky(input));
    // The hills last, in front of everything, so the sun and moon rise and set behind them.
    if (environment) {
      const hills = hillHeights(columns, rows);
      const paint = (heights: number[], tone: Rgb) => {
        for (let x = 0; x < columns; x += 1) {
          for (let y = rows - heights[x]; y < rows; y += 1) {
            const i = (y * columns + x) * 4;
            image.data[i] = tone[0]; image.data[i + 1] = tone[1]; image.data[i + 2] = tone[2]; image.data[i + 3] = 255;
          }
        }
      };
      paint(hills.far, mix(HILL_TONES.far.day, HILL_TONES.far.night, state.night));
      paint(hills.near, mix(HILL_TONES.near.day, HILL_TONES.near.night, state.night));
    }
    context.putImageData(image, 0, 0);
  }, [size, hours, variant, environment]);

  return (
    <div
      ref={wrapRef}
      className={`${variant === 'background' ? 'fixed inset-0 z-0' : 'relative rounded-xl'} overflow-hidden ${className}`}
      style={{ background: environment ? `linear-gradient(${top}, ${bottom})` : 'hsl(var(--card))' } as CSSProperties}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ imageRendering: 'pixelated' }} />
    </div>
  );
}

/** A 24-hour clock, midnight to midnight: 8am a third of the way along, noon in the middle. */
export function TimeOfDaySlider({ hours, onChange, label = 'Time of day', min = 0, max = 24 }: { hours: number; onChange: (hours: number) => void; label?: string; min?: number; max?: number }) {
  return (
    <div className="space-y-1">
      <input
        type="range"
        min={min}
        max={max}
        step={0.25}
        value={hours}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
        aria-valuetext={formatClockTime(hours)}
        className="h-2 w-full cursor-pointer accent-primary"
      />
    </div>
  );
}

function todaySkyLevelBounds(now = new Date()): { firstLight: number; fullDark: number } {
  const date = todayAtHour(0, now);
  const times = sunTimes(date, visitorLocation(date));
  const bounds = skyLevelBounds(times);
  // Keep the range usable at the edges of the clock, including high-latitude days.
  if (times.sunrise === times.sunset) return { firstLight: 0, fullDark: 24 };
  return {
    firstLight: Math.max(0, Math.min(24, bounds.firstLight)),
    fullDark: Math.max(0, Math.min(24, bounds.fullDark)),
  };
}

/**
 * The brightness picker as used in onboarding and settings: follow the time of day where the person is
 * (the default; the clock shows the time now and moves with it), or choose a time and keep the app as
 * bright as the sky is then.
 */
export function TimeOfDayControl({ compact = false }: { compact?: boolean }) {
  const { hours, setHours, followsSky, followSky } = useTimeOfDayTheme();
  const visibility = useSkyPreviewVisibility();
  const levelBounds = todaySkyLevelBounds();
  const fixedHours = Math.max(levelBounds.firstLight, Math.min(levelBounds.fullDark, hours));
  const displayedHours = followsSky ? hours : fixedHours;
  const chooseFixedLevel = () => setHours(fixedHours);
  useEffect(() => {
    if (!followsSky && hours !== fixedHours) setHours(fixedHours);
  }, [fixedHours, followsSky, hours, setHours]);
  const options = [
    { follows: true, title: 'Follow the time of day', note: 'Light by day, dark by night, like the sky where you are.', choose: followSky },
    { follows: false, title: 'Choose a level', note: 'Choose from first light through full dark.', choose: chooseFixedLevel },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] sm:items-center">
      <div className="min-w-0">
        <div className="space-y-2" role="radiogroup" aria-label="Brightness">
          {options.map((option) => {
            const selected = followsSky === option.follows;
            return (
              <button
                key={option.title}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={option.choose}
                className={`block w-full rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${selected ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}
              >
                <span className="block text-sm font-medium text-foreground">{option.title}</span>
                {!compact && <span className="mt-1 block text-xs text-muted-foreground">{option.note}</span>}
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-background/40 p-3">
          <div className="min-w-0">
            <span className="block text-sm font-medium text-foreground">Include environment</span>
          </div>
          <Switch
            size="sm"
            checked={visibility.environment}
            onCheckedChange={visibility.setEnvironment}
            aria-label="Include environment"
          />
        </div>
      </div>
      <div className="min-w-0 space-y-2">
        <TimeOfDaySky hours={displayedHours} visibility={visibility} className={compact ? 'h-24 sm:h-28' : 'h-36'} />
        <span className="block text-xs tabular-nums text-muted-foreground">{formatClockTime(displayedHours)}</span>
        <TimeOfDaySlider
          hours={displayedHours}
          onChange={setHours}
          min={followsSky ? 0 : levelBounds.firstLight}
          max={followsSky ? 24 : levelBounds.fullDark}
          label={followsSky ? 'Time of day (now, where you are)' : 'Brightness level from first light to full dark'}
        />
      </div>
    </div>
  );
}

/** The same live sky used by Brightness, painted behind the app shell. */
export function AppSkyBackground() {
  const { hours } = useTimeOfDayTheme();
  const visibility = useSkyPreviewVisibility();
  return <TimeOfDaySky hours={hours} visibility={visibility} variant="background" className="pointer-events-none opacity-50" />;
}
