/**
 * Modèle d'une journée de boucle fermée (Trio / Tai) pour la « Vue boucle » :
 * glycémies, SMB et bolus à leur heure exacte, basale appliquée vs programmée,
 * dérogations, cibles temporaires, évènements pompe/capteur, et état de la boucle (IOB…).
 * Fonctions pures : testables hors navigateur.
 */
import { NightscoutEntry, NightscoutTreatment } from "@/types/nightscout";
import { kind, tsOf } from "@/lib/trioAggregation";

export interface LoopStatus {
  t: number;
  iob: number | null;
  cob: number | null;
  target: number | null;
  isf: number | null;
  ratio: number | null;
  eventualBG: number | null;
  reason: string | null;
}

export interface Interval { s: number; e: number }
export interface Band extends Interval { label: string; color: string }
export interface BasalSeg extends Interval { rate: number }
export interface Dose { t: number; u: number; button?: boolean }
export interface DayEvent { t: number; label: string }

export interface DayModel {
  start: number;
  end: number;
  glucose: { t: number; v: number }[];
  smb: Dose[];
  manual: Dose[];
  tempBasal: BasalSeg[];
  scheduled: BasalSeg[];
  overrides: Band[];
  targets: (Band & { value: number })[];
  events: DayEvent[];
  status: LoopStatus[];
  totals: { smb: number; nSmb: number; manual: number; basal: number };
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const MIN_BAND_MIN = 5;

type TT = NightscoutTreatment & { targetBottom?: number };

export function overrideColor(name: string): string {
  if (/post/i.test(name)) return "#14b8a6"; // Post-sport
  if (/sport/i.test(name)) return "#22c55e";
  if (/repas/i.test(name)) return "#f59e0b";
  return "#94a3b8";
}

export function targetColor(v: number): string {
  if (v <= 85) return "#f97316"; // cible repas
  if (v >= 150) return "#22c55e"; // pré-sport / sport
  if (v >= 130) return "#ef4444"; // resucrage
  return "#6366f1";
}

/** Intervalles successifs : chaque élément s'arrête au plus tard au début du suivant. */
function chain<T extends NightscoutTreatment>(list: T[]) {
  const sorted = [...list].sort((a, b) => tsOf(a) - tsOf(b));
  return sorted.map((t, i) => {
    const s = tsOf(t);
    const next = sorted.slice(i + 1).find((n) => tsOf(n) > s);
    const e = Math.min(s + (t.duration || 0) * MIN, next ? tsOf(next) : Infinity);
    return { t, s, e };
  });
}

const clip = <I extends Interval>(x: I, start: number, end: number): I | null =>
  x.e <= start || x.s >= end ? null : { ...x, s: Math.max(x.s, start), e: Math.min(x.e, end) };

export function buildDay(
  entries: NightscoutEntry[],
  treatments: NightscoutTreatment[],
  dayStart: number,
  status: LoopStatus[],
  scheduledRateAt: (ms: number) => number
): DayModel {
  const start = dayStart;
  const end = dayStart + DAY;
  const inDay = (ms: number) => ms >= start && ms < end;

  const glucose = entries
    .filter((e) => e.sgv && inDay(Number(e.date)))
    .map((e) => ({ t: Number(e.date), v: e.sgv }))
    .sort((a, b) => a.t - b.t);

  // Cibles temporaires (le bouton = cible 80)
  const tts = chain(treatments.filter((t) => t.eventType === "Temporary Target") as TT[]);
  const buttonStarts = tts.filter(({ t }) => t.targetBottom === 80).map(({ s }) => s);

  const smb: Dose[] = [];
  const manual: Dose[] = [];
  for (const t of treatments) {
    if (typeof t.insulin !== "number" || t.insulin <= 0) continue;
    const ms = tsOf(t);
    if (!inDay(ms)) continue;
    const k = kind(t);
    if (k === "SMB") smb.push({ t: ms, u: t.insulin });
    else if (k === "Bolus" || /Bolus/.test(t.eventType)) {
      const button = buttonStarts.some((b) => ms >= b - 2 * MIN && ms <= b + 3 * MIN);
      manual.push({ t: ms, u: t.insulin, button });
    }
  }

  // Basale appliquée (temp basal) et programmée (profil) dans les trous
  const tempBasal = chain(treatments.filter((t) => t.eventType === "Temp Basal" && typeof t.rate === "number"))
    .map(({ t, s, e }) => clip({ s, e, rate: t.rate as number }, start, end))
    .filter((x): x is BasalSeg => !!x && x.e > x.s);

  const scheduled: BasalSeg[] = [];
  for (let m = start; m < end; m += MIN) {
    const rate = scheduledRateAt(m);
    const last = scheduled[scheduled.length - 1];
    if (last && last.rate === rate && last.e === m) last.e = m + MIN;
    else scheduled.push({ s: m, e: m + MIN, rate });
  }

  let basal = 0;
  for (const b of tempBasal) basal += (b.rate * (b.e - b.s)) / (60 * MIN);
  for (let m = start; m < end; m += MIN) {
    if (!tempBasal.some((b) => b.s <= m && m < b.e)) basal += scheduledRateAt(m) / 60;
  }

  const overrides = chain(treatments.filter((t) => t.eventType === "Exercise"))
    .filter(({ s, e }) => e - s >= MIN_BAND_MIN * MIN)
    .map(({ t, s, e }) => {
      const label = (t.notes || "Dérogation").trim();
      return clip({ s, e, label, color: overrideColor(label) }, start, end);
    })
    .filter((x): x is Band => !!x);

  const targets = tts
    .filter(({ t, s, e }) => typeof t.targetBottom === "number" && e - s >= MIN_BAND_MIN * MIN)
    .map(({ t, s, e }) => {
      const value = t.targetBottom as number;
      const name = (t.notes || "").trim();
      const generic = /^(temp target|custom target)$/i.test(name) || !name;
      const label = `${value}${generic ? "" : ` · ${name}`}`;
      return clip({ s, e, value, label, color: targetColor(value) }, start, end);
    })
    .filter((x): x is Band & { value: number } => !!x);

  const events: DayEvent[] = [];
  for (const t of treatments) {
    const ms = tsOf(t);
    if (!inDay(ms)) continue;
    if (t.eventType === "Site Change") events.push({ t: ms, label: "Pod" });
    else if (t.eventType === "Sensor Start") events.push({ t: ms, label: "Capteur" });
    else if (t.eventType === "Note") {
      const n = (t.notes || "").trim();
      events.push({ t: ms, label: n === "PumpSuspend" ? "Pompe suspendue" : n === "PumpResume" ? "Reprise pompe" : n });
    }
  }
  events.sort((a, b) => a.t - b.t);
  // Évènements à moins de 15 min d'écart regroupés (ex. suspension + reprise + changement de pod)
  const grouped: DayEvent[] = [];
  for (const ev of events) {
    const last = grouped[grouped.length - 1];
    if (last && ev.t - last.t <= 15 * MIN) last.label += ` · ${ev.label}`;
    else grouped.push({ ...ev });
  }

  const sum = (xs: Dose[]) => xs.reduce((s, x) => s + x.u, 0);
  return {
    start,
    end,
    glucose,
    smb: smb.sort((a, b) => a.t - b.t),
    manual: manual.sort((a, b) => a.t - b.t),
    tempBasal,
    scheduled,
    overrides,
    targets,
    events: grouped,
    status: status.filter((s) => inDay(s.t)),
    totals: { smb: sum(smb), nSmb: smb.length, manual: sum(manual), basal },
  };
}

/** Élément actif à l'instant `t` dans une liste d'intervalles. */
export const activeAt = <I extends Interval>(xs: I[], t: number) => xs.find((x) => x.s <= t && t < x.e);

/** État de boucle le plus proche de `t` (à 6 min près). */
export function statusAt(xs: LoopStatus[], t: number): LoopStatus | undefined {
  let best: LoopStatus | undefined;
  for (const s of xs) if (Math.abs(s.t - t) <= 6 * MIN && (!best || Math.abs(s.t - t) < Math.abs(best.t - t))) best = s;
  return best;
}
