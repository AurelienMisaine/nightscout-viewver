"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NightscoutEntry, NightscoutProfile, NightscoutTreatment } from "@/types/nightscout";
import { useGlucoseUnits } from "@/lib/glucoseUnits";
import { isDemoMode } from "@/lib/demoData";
import { SCHEDULED_BASAL } from "@/lib/trioAggregation";
import { activeAt, buildDay, LoopStatus, statusAt } from "@/lib/loopView";

const H = 3600_000;
const L = 46; // marge gauche (étiquettes des axes)
const R = 12;
const ROW = { over: 18, target: 18, events: 16 };
const GAP = 8;
const HEIGHTS = { glucose: 230, insulin: 70, basal: 50, iob: 50, axis: 20 };

type Profile = NightscoutProfile | NightscoutProfile[] | undefined;

function scheduledRateFactory(profil: Profile, dayStart: number) {
  let active: NightscoutProfile | undefined;
  if (Array.isArray(profil)) {
    active = [...profil].filter((p) => (p.date || 0) <= dayStart).sort((a, b) => (b.date || 0) - (a.date || 0))[0] ?? profil[0];
  } else active = profil;
  const basal = active?.store?.[active.defaultProfile]?.basal as { time: string; value: number }[] | undefined;
  const sched: [number, number][] = basal?.length
    ? basal.map((b) => { const [h, m] = b.time.split(":").map(Number); return [h * 60 + (m || 0), Number(b.value)]; })
    : SCHEDULED_BASAL.map(([h, r]) => [h * 60, r]);
  return (ms: number) => {
    const d = new Date(ms);
    const min = d.getHours() * 60 + d.getMinutes();
    let r = sched[0][1];
    for (const [m, v] of sched) if (min >= m) r = v;
    return r;
  };
}

const fmtU = (u: number) => u.toFixed(u < 1 ? 2 : 1).replace(".", ",");
const hhmm = (ms: number) => format(new Date(ms), "HH:mm");

export function LoopDayChart({
  data,
  treatments,
  selectedDate,
  setSelectedDate,
  profil,
}: {
  data: NightscoutEntry[];
  treatments: NightscoutTreatment[];
  selectedDate: Date;
  setSelectedDate: (d: Date) => void;
  profil?: Profile;
}) {
  const { convertGlucose, unit } = useGlucoseUnits();
  const dayStart = new Date(selectedDate).setHours(0, 0, 0, 0);

  // --- Navigation entre les jours disponibles ---
  const availableDates = useMemo(
    () => Array.from(new Set(data.map((e) => new Date(e.date).setHours(0, 0, 0, 0)))).sort((a, b) => a - b),
    [data]
  );
  const prevDay = [...availableDates].reverse().find((d) => d < dayStart);
  const nextDay = availableDates.find((d) => d > dayStart);
  const lastAvailable = availableDates.length ? availableDates[availableDates.length - 1] : null;
  const selectedIsAvailable = availableDates.includes(dayStart);
  useEffect(() => {
    if (lastAvailable !== null && !selectedIsAvailable) setSelectedDate(new Date(lastAvailable));
  }, [lastAvailable, selectedIsAvailable, setSelectedDate]);

  // --- État de la boucle (IOB, cible, ISF…) du jour affiché ---
  const [status, setStatus] = useState<LoopStatus[]>([]);
  const [statusError, setStatusError] = useState<string | null>(null);
  useEffect(() => {
    const url = localStorage.getItem("nightscoutUrl");
    const token = localStorage.getItem("nightscoutToken") || "";
    setStatus([]);
    setStatusError(null);
    if (!url || isDemoMode(url)) return;
    let cancelled = false;
    fetch("/api/nightscout/devicestatus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, token, from: dayStart, to: dayStart + 24 * H }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
        return r.json();
      })
      .then((s: LoopStatus[]) => !cancelled && setStatus(s))
      .catch((e) => !cancelled && setStatusError(String(e.message || e)));
    return () => { cancelled = true; };
  }, [dayStart]);

  const model = useMemo(
    () => buildDay(data, treatments, dayStart, status, scheduledRateFactory(profil, dayStart)),
    [data, treatments, dayStart, status, profil]
  );

  // --- Largeur responsive ---
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    if (!boxRef.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, e.contentRect.width)));
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, []);

  // --- Géométrie ---
  const plotW = width - L - R;
  const x = (t: number) => L + ((t - model.start) / (model.end - model.start)) * plotW;
  let y0 = 0;
  const yOver = y0; y0 += ROW.over;
  const yTarget = y0; y0 += ROW.target;
  const yEvents = y0; y0 += ROW.events + GAP;
  const yG = y0; y0 += HEIGHTS.glucose + GAP;
  const yI = y0; y0 += HEIGHTS.insulin + GAP;
  const yB = y0; y0 += HEIGHTS.basal + GAP;
  const yIob = y0; y0 += HEIGHTS.iob;
  const yAxis = y0; y0 += HEIGHTS.axis;
  const totalH = y0;

  const gMax = Math.max(300, ...model.glucose.map((g) => g.v + 10));
  const gMin = 40;
  const yGl = (v: number) => yG + HEIGHTS.glucose - ((Math.min(v, gMax) - gMin) / (gMax - gMin)) * HEIGHTS.glucose;
  const insMax = Math.max(1, ...model.smb.map((d) => d.u), ...model.manual.map((d) => d.u));
  const yIns = (u: number) => yI + HEIGHTS.insulin - (u / insMax) * (HEIGHTS.insulin - 12);
  const bMax = Math.max(1, ...model.tempBasal.map((b) => b.rate), ...model.scheduled.map((b) => b.rate));
  const yBas = (r: number) => yB + HEIGHTS.basal - (r / bMax) * HEIGHTS.basal;
  const iobVals = model.status.map((s) => s.iob ?? 0);
  const iobMin = Math.min(0, ...iobVals);
  const iobMax = Math.max(1, ...iobVals);
  const yIo = (v: number) => yIob + HEIGHTS.iob - ((v - iobMin) / (iobMax - iobMin)) * HEIGHTS.iob;

  const stepPath = (segs: { s: number; e: number; rate: number }[]) =>
    segs.map((b) => `M${x(b.s)},${yBas(b.rate)}H${x(b.e)}`).join("");
  const iobPath = model.status
    .filter((s) => s.iob !== null)
    .map((s, i) => `${i ? "L" : "M"}${x(s.t)},${yIo(s.iob as number)}`)
    .join("");
  const targetPath = model.status
    .filter((s) => s.target !== null && (s.target as number) >= 60)
    .map((s, i) => `${i ? "L" : "M"}${x(s.t)},${yGl(s.target as number)}`)
    .join("");

  const gColor = (v: number) => (v < 70 ? "#ef4444" : v > 250 ? "#ea580c" : v > 180 ? "#f59e0b" : "#3b82f6");
  const hours = Array.from({ length: 9 }, (_, i) => model.start + i * 3 * H);
  const gTicks = [70, 180, 250].filter((v) => v < gMax);

  // --- Survol ---
  const [hover, setHover] = useState<number | null>(null);
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < L || px > width - R) return setHover(null);
    setHover(model.start + ((px - L) / plotW) * (model.end - model.start));
  };

  const tip = (() => {
    if (hover === null) return null;
    const near = (t: number, min: number) => Math.abs(t - hover) <= min * 60_000;
    const g = model.glucose.reduce<{ t: number; v: number } | null>(
      (b, p) => (near(p.t, 5) && (!b || Math.abs(p.t - hover) < Math.abs(b.t - hover)) ? p : b), null);
    const smb = model.smb.filter((d) => near(d.t, 2.5));
    const man = model.manual.filter((d) => near(d.t, 2.5));
    const tb = activeAt(model.tempBasal, hover);
    const sc = activeAt(model.scheduled, hover);
    const ov = activeAt(model.overrides, hover);
    const tt = activeAt(model.targets, hover);
    const st = statusAt(model.status, hover);
    return { g, smb, man, tb, sc, ov, tt, st };
  })();

  const t = model.totals;
  const total = t.smb + t.manual + t.basal;

  return (
    <Card className="w-full">
      <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <CardTitle>Vue boucle</CardTitle>
          <CardDescription>
            SMB : {fmtU(t.smb)} U ({t.nSmb}) · Bolus manuels : {fmtU(t.manual)} U · Basale : {fmtU(t.basal)} U · Total : {fmtU(total)} U
          </CardDescription>
        </div>
        <div className="flex items-center gap-2 justify-center">
          <button onClick={() => prevDay !== undefined && setSelectedDate(new Date(prevDay))} disabled={prevDay === undefined}
            aria-label="Jour précédent" className={prevDay === undefined ? "opacity-40 cursor-not-allowed" : ""}>
            <ChevronLeft />
          </button>
          <span className="font-semibold min-w-[190px] text-center">{format(selectedDate, "EEEE d MMMM yyyy", { locale: fr })}</span>
          <button onClick={() => nextDay !== undefined && setSelectedDate(new Date(nextDay))} disabled={nextDay === undefined}
            aria-label="Jour suivant" className={nextDay === undefined ? "opacity-40 cursor-not-allowed" : ""}>
            <ChevronRight />
          </button>
        </div>
      </CardHeader>
      <CardContent>
        <div ref={boxRef} className="relative w-full select-none">
          <svg width={width} height={totalH} onMouseMove={onMove} onMouseLeave={() => setHover(null)} className="block">
            {/* Grille horaire */}
            {hours.map((h) => (
              <g key={h}>
                <line x1={x(h)} x2={x(h)} y1={yG} y2={yAxis} stroke="#e5e7eb" />
                <text x={x(h)} y={yAxis + 14} fontSize={10} textAnchor="middle" fill="#6b7280">{format(new Date(h), "HH:mm")}</text>
              </g>
            ))}

            {/* Bandeaux : dérogations, cibles temporaires, évènements */}
            <text x={2} y={yOver + 12} fontSize={9} fill="#6b7280">Dérog.</text>
            {model.overrides.map((b, i) => (
              <g key={`o${i}`}>
                <rect x={x(b.s)} y={yOver + 2} width={Math.max(2, x(b.e) - x(b.s))} height={ROW.over - 4} rx={3} fill={b.color} opacity={0.85} />
                {x(b.e) - x(b.s) > 40 && <text x={x(b.s) + 4} y={yOver + 12} fontSize={9} fill="white">{b.label}</text>}
              </g>
            ))}
            <text x={2} y={yTarget + 12} fontSize={9} fill="#6b7280">Cible</text>
            {model.targets.map((b, i) => (
              <g key={`t${i}`}>
                <rect x={x(b.s)} y={yTarget + 2} width={Math.max(2, x(b.e) - x(b.s))} height={ROW.target - 4} rx={3} fill={b.color} opacity={0.75} />
                {x(b.e) - x(b.s) > 24 && <text x={x(b.s) + 3} y={yTarget + 12} fontSize={9} fill="white">{b.label}</text>}
              </g>
            ))}
            {model.events.map((ev, i) => (
              <g key={`e${i}`}>
                <line x1={x(ev.t)} x2={x(ev.t)} y1={yEvents} y2={yAxis} stroke="#a855f7" strokeDasharray="2 3" />
                <text x={x(ev.t) > width - 160 ? x(ev.t) - 3 : x(ev.t) + 3} y={yEvents + 11} fontSize={9} fill="#7e22ce"
                  textAnchor={x(ev.t) > width - 160 ? "end" : "start"}>{ev.label}</text>
              </g>
            ))}

            {/* Glycémie */}
            <text x={2} y={yG + 10} fontSize={9} fill="#6b7280">{unit}</text>
            <rect x={L} y={yGl(180)} width={plotW} height={yGl(70) - yGl(180)} fill="#22c55e" opacity={0.08} />
            {model.overrides.map((b, i) => (
              <rect key={`og${i}`} x={x(b.s)} y={yG} width={x(b.e) - x(b.s)} height={HEIGHTS.glucose} fill={b.color} opacity={0.07} />
            ))}
            {gTicks.map((v) => (
              <g key={v}>
                <line x1={L} x2={L + plotW} y1={yGl(v)} y2={yGl(v)} stroke={v === 70 ? "#ef4444" : "#f59e0b"} strokeDasharray="3 3" opacity={0.6} />
                <text x={L - 4} y={yGl(v) + 3} fontSize={9} textAnchor="end" fill="#6b7280">{convertGlucose(v)}</text>
              </g>
            ))}
            {targetPath && <path d={targetPath} fill="none" stroke="#6366f1" strokeWidth={1.5} strokeDasharray="5 3" opacity={0.8} />}
            {model.glucose.map((g) => (
              <circle key={g.t} cx={x(g.t)} cy={yGl(g.v)} r={2.4} fill={gColor(g.v)} />
            ))}

            {/* Insuline : SMB et bolus manuels à leur heure */}
            <text x={2} y={yI + 10} fontSize={9} fill="#6b7280">Bolus</text>
            <line x1={L} x2={L + plotW} y1={yI + HEIGHTS.insulin} y2={yI + HEIGHTS.insulin} stroke="#d1d5db" />
            {model.smb.map((d) => (
              <line key={`s${d.t}`} x1={x(d.t)} x2={x(d.t)} y1={yI + HEIGHTS.insulin} y2={yIns(d.u)} stroke="#0ea5e9" strokeWidth={2} />
            ))}
            {model.manual.map((d) => (
              <g key={`m${d.t}`}>
                <line x1={x(d.t)} x2={x(d.t)} y1={yI + HEIGHTS.insulin} y2={yIns(d.u)} stroke={d.button ? "#f97316" : "#7c3aed"} strokeWidth={4} />
                <text x={x(d.t)} y={yIns(d.u) - 2} fontSize={9} textAnchor="middle" fill={d.button ? "#c2410c" : "#6d28d9"}>{fmtU(d.u)}</text>
              </g>
            ))}

            {/* Basale appliquée vs programmée */}
            <text x={2} y={yB + 10} fontSize={9} fill="#6b7280">Basale</text>
            <line x1={L} x2={L + plotW} y1={yBas(0)} y2={yBas(0)} stroke="#d1d5db" />
            <path d={stepPath(model.scheduled)} stroke="#9ca3af" strokeDasharray="4 3" fill="none" />
            {model.tempBasal.map((b, i) => (
              <rect key={`b${i}`} x={x(b.s)} y={yBas(b.rate)} width={Math.max(0.5, x(b.e) - x(b.s))} height={yBas(0) - yBas(b.rate)} fill="#60a5fa" opacity={0.55} />
            ))}

            {/* IOB */}
            <text x={2} y={yIob + 10} fontSize={9} fill="#6b7280">IOB</text>
            {iobMin < 0 && <line x1={L} x2={L + plotW} y1={yIo(0)} y2={yIo(0)} stroke="#d1d5db" />}
            {iobPath ? (
              <path d={iobPath} stroke="#7c3aed" strokeWidth={1.5} fill="none" />
            ) : (
              <text x={L + 6} y={yIob + 28} fontSize={10} fill="#9ca3af">
                {statusError ? `État de la boucle indisponible (${statusError})` : "Pas d'état de boucle pour ce jour"}
              </text>
            )}
            {iobPath && <text x={L - 4} y={yIo(iobMax) + 8} fontSize={9} textAnchor="end" fill="#6b7280">{iobMax.toFixed(1)}</text>}

            {/* Curseur */}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={yAxis} stroke="#111827" opacity={0.35} />}
          </svg>

          {tip && hover !== null && (
            <div
              className="pointer-events-none absolute z-10 rounded-md border bg-white/95 p-2 text-xs shadow-md max-w-[300px]"
              style={{ top: yG + 4, left: x(hover) > width / 2 ? x(hover) - 310 : x(hover) + 10 }}
            >
              <div className="font-semibold">{hhmm(hover)}</div>
              {tip.g && <div>Glycémie : {convertGlucose(tip.g.v)} {unit}</div>}
              {tip.st?.target != null && <div>Cible active : {convertGlucose(tip.st.target)} {unit}</div>}
              {tip.ov && <div>Dérogation : {tip.ov.label} ({hhmm(tip.ov.s)}–{hhmm(tip.ov.e)})</div>}
              {tip.tt && <div>Cible temporaire : {tip.tt.label} ({hhmm(tip.tt.s)}–{hhmm(tip.tt.e)})</div>}
              {tip.man.map((d) => <div key={d.t}>Bolus {d.button ? "bouton" : "manuel"} : {fmtU(d.u)} U à {hhmm(d.t)}</div>)}
              {tip.smb.map((d) => <div key={d.t}>SMB : {fmtU(d.u)} U à {hhmm(d.t)}</div>)}
              <div>
                Basale : {tip.tb ? `${fmtU(tip.tb.rate)} U/h (temporaire)` : tip.sc ? `${fmtU(tip.sc.rate)} U/h (programmée)` : "–"}
              </div>
              {tip.st && (
                <div>
                  IOB {tip.st.iob?.toFixed(2) ?? "–"} U
                  {tip.st.cob ? ` · COB ${Math.round(tip.st.cob)} g` : ""}
                  {tip.st.isf != null ? ` · ISF ${Math.round(tip.st.isf)}` : ""}
                  {tip.st.ratio != null ? ` · sensib. ${Math.round(tip.st.ratio * 100)} %` : ""}
                  {tip.st.eventualBG != null ? ` · prévue ${convertGlucose(tip.st.eventualBG)}` : ""}
                </div>
              )}
              {tip.st?.reason && <div className="mt-1 text-[10px] leading-tight text-gray-500 line-clamp-4">{tip.st.reason}</div>}
            </div>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-600">
          <span><span className="inline-block w-3 h-[3px] bg-sky-500 align-middle mr-1" />SMB</span>
          <span><span className="inline-block w-3 h-[3px] bg-orange-500 align-middle mr-1" />Bolus du bouton</span>
          <span><span className="inline-block w-3 h-[3px] bg-violet-600 align-middle mr-1" />Autre bolus manuel</span>
          <span><span className="inline-block w-3 h-2 bg-blue-400/60 align-middle mr-1" />Basale appliquée</span>
          <span><span className="inline-block w-3 border-t border-dashed border-gray-400 align-middle mr-1" />Basale programmée</span>
          <span><span className="inline-block w-3 border-t-2 border-dashed border-indigo-500 align-middle mr-1" />Cible active</span>
        </div>
      </CardContent>
    </Card>
  );
}
