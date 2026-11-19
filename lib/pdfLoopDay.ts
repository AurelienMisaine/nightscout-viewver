/**
 * Page PDF « Vue boucle » d'une journée (dessin vectoriel jsPDF, en mm, A4 portrait).
 * Même lecture que l'écran : dérogations, cibles, évènements, glycémie + cible appliquée,
 * SMB à leur minute, bolus manuels, basale appliquée vs programmée, IOB,
 * puis statistiques du jour et liste horodatée.
 */
import jsPDF from "jspdf";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { DayModel } from "@/lib/loopView";

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
/** Couleur éclaircie (équivalent d'une opacité sur fond blanc). */
const tint = (h: string, a: number): RGB => hex(h).map((c) => Math.round(255 - (255 - c) * a)) as RGB;

const H = 3600_000;
const X0 = 22;
const X1 = 200;
const fmt = (u: number) => u.toFixed(u < 1 ? 2 : 1).replace(".", ",");
const hm = (ms: number) => format(new Date(ms), "HH:mm");

export function drawLoopDayPage(
  doc: jsPDF,
  m: DayModel,
  opts: { unit: string; convert: (mgdl: number) => number }
) {
  const W = X1 - X0;
  const x = (t: number) => X0 + ((t - m.start) / (m.end - m.start)) * W;
  const cv = (v: number) => {
    const c = opts.convert(v);
    return opts.unit === "mmol/L" ? c.toFixed(1).replace(".", ",") : String(Math.round(c));
  };
  const setFill = (c: RGB) => doc.setFillColor(c[0], c[1], c[2]);
  const setDraw = (c: RGB) => doc.setDrawColor(c[0], c[1], c[2]);
  const setText = (c: RGB) => doc.setTextColor(c[0], c[1], c[2]);
  const label = (s: string, y: number) => { doc.setFontSize(6.5); setText(hex("#6b7280")); doc.text(s, 4, y); };

  // --- En-tête ---
  const t = m.totals;
  doc.setFontSize(16);
  setText(hex("#0066cc"));
  doc.text("Vue boucle", 15, 16);
  doc.setFontSize(12);
  setText([0, 0, 0]);
  const day = format(new Date(m.start), "EEEE d MMMM yyyy", { locale: fr });
  doc.text(day.charAt(0).toUpperCase() + day.slice(1), 15, 23);
  doc.setFontSize(8.5);
  setText(hex("#374151"));
  doc.text(
    `SMB : ${fmt(t.smb)} U (${t.nSmb})   ·   Bolus manuels : ${fmt(t.manual)} U   ·   Basale : ${fmt(t.basal)} U   ·   Total : ${fmt(t.smb + t.manual + t.basal)} U`,
    15, 29
  );

  // --- Bandes ---
  const yOver = 33, yTgt = 38.5, yEv = 44;
  const yG = 50, hG = 80;
  const yI = yG + hG + 4, hI = 22;
  const yB = yI + hI + 4, hB = 14;
  const yO = yB + hB + 4, hO = 14;
  const yAx = yO + hO;

  // Grille horaire
  doc.setLineWidth(0.1);
  setDraw(hex("#e5e7eb"));
  doc.setFontSize(6.5);
  setText(hex("#6b7280"));
  for (let i = 0; i <= 8; i++) {
    const h = m.start + i * 3 * H;
    doc.line(x(h), yG, x(h), yAx);
    doc.text(format(new Date(h), "HH:mm"), x(h), yAx + 3.5, { align: "center" });
  }

  // Dérogations / cibles temporaires
  label("Dérog.", yOver + 3);
  for (const b of m.overrides) {
    setFill(tint(b.color, 0.85));
    doc.roundedRect(x(b.s), yOver, Math.max(0.6, x(b.e) - x(b.s)), 4, 0.6, 0.6, "F");
    if (x(b.e) - x(b.s) > 14) { doc.setFontSize(6); doc.setTextColor(255, 255, 255); doc.text(b.label, x(b.s) + 1, yOver + 2.9, { maxWidth: x(b.e) - x(b.s) - 2 }); }
  }
  label("Cible", yTgt + 3);
  for (const b of m.targets) {
    setFill(tint(b.color, 0.75));
    doc.roundedRect(x(b.s), yTgt, Math.max(0.6, x(b.e) - x(b.s)), 4, 0.6, 0.6, "F");
    if (x(b.e) - x(b.s) > 8) { doc.setFontSize(6); doc.setTextColor(255, 255, 255); doc.text(b.label, x(b.s) + 0.8, yTgt + 2.9, { maxWidth: x(b.e) - x(b.s) - 1.5 }); }
  }
  for (const ev of m.events) {
    setDraw(hex("#a855f7"));
    doc.setLineDashPattern([0.6, 0.8], 0);
    doc.line(x(ev.t), yEv, x(ev.t), yAx);
    doc.setLineDashPattern([], 0);
    doc.setFontSize(6);
    setText(hex("#7e22ce"));
    const right = x(ev.t) > X1 - 45;
    doc.text(ev.label, right ? x(ev.t) - 0.8 : x(ev.t) + 0.8, yEv + 3, { align: right ? "right" : "left" });
  }

  // --- Glycémie ---
  const gMax = Math.max(300, ...m.glucose.map((g) => g.v + 10));
  const yGl = (v: number) => yG + hG - ((Math.min(v, gMax) - 40) / (gMax - 40)) * hG;
  label(opts.unit, yG + 3);
  setFill(tint("#22c55e", 0.08));
  doc.rect(X0, yGl(180), W, yGl(70) - yGl(180), "F");
  for (const b of m.overrides) { setFill(tint(b.color, 0.1)); doc.rect(x(b.s), yG, x(b.e) - x(b.s), hG, "F"); }
  doc.setLineWidth(0.15);
  for (const v of [70, 180, 250]) {
    if (v >= gMax) continue;
    setDraw(hex(v === 70 ? "#ef4444" : "#f59e0b"));
    doc.setLineDashPattern([1, 1], 0);
    doc.line(X0, yGl(v), X1, yGl(v));
    doc.setLineDashPattern([], 0);
    doc.setFontSize(6.5);
    setText(hex("#6b7280"));
    doc.text(cv(v), X0 - 1, yGl(v) + 1, { align: "right" });
  }
  setDraw(hex("#cbd5e1"));
  doc.rect(X0, yG, W, hG);
  // Cible appliquée par la boucle
  const tgt = m.status.filter((s) => s.target !== null && s.target >= 60);
  if (tgt.length > 1) {
    setDraw(hex("#6366f1"));
    doc.setLineWidth(0.3);
    doc.setLineDashPattern([1.2, 0.8], 0);
    for (let i = 1; i < tgt.length; i++) {
      if (tgt[i].t - tgt[i - 1].t > 15 * 60_000) continue;
      doc.line(x(tgt[i - 1].t), yGl(tgt[i - 1].target as number), x(tgt[i].t), yGl(tgt[i].target as number));
    }
    doc.setLineDashPattern([], 0);
  }
  for (const g of m.glucose) {
    setFill(hex(g.v < 70 ? "#ef4444" : g.v > 250 ? "#ea580c" : g.v > 180 ? "#f59e0b" : "#3b82f6"));
    doc.circle(x(g.t), yGl(g.v), 0.42, "F");
  }

  // --- Insuline ---
  label("Bolus", yI + 3);
  const insMax = Math.max(1, ...m.smb.map((d) => d.u), ...m.manual.map((d) => d.u));
  const yIn = (u: number) => yI + hI - (u / insMax) * (hI - 4);
  setDraw(hex("#cbd5e1")); doc.setLineWidth(0.15);
  doc.line(X0, yI + hI, X1, yI + hI);
  doc.setLineWidth(0.45);
  setDraw(hex("#0ea5e9"));
  for (const d of m.smb) doc.line(x(d.t), yI + hI, x(d.t), yIn(d.u));
  for (const d of m.manual) {
    setFill(hex(d.button ? "#f97316" : "#7c3aed"));
    doc.rect(x(d.t) - 0.5, yIn(d.u), 1, yI + hI - yIn(d.u), "F");
    doc.setFontSize(6); setText(hex(d.button ? "#c2410c" : "#6d28d9"));
    doc.text(fmt(d.u), x(d.t), yIn(d.u) - 0.8, { align: "center" });
  }
  doc.setFontSize(6); setText(hex("#6b7280"));
  doc.text(`${fmt(insMax)} U`, X0 - 1, yI + 4, { align: "right" });

  // --- Basale ---
  label("Basale", yB + 3);
  const bMax = Math.max(1, ...m.tempBasal.map((b) => b.rate), ...m.scheduled.map((b) => b.rate));
  const yBa = (r: number) => yB + hB - (r / bMax) * hB;
  setFill(tint("#60a5fa", 0.6));
  for (const b of m.tempBasal) doc.rect(x(b.s), yBa(b.rate), Math.max(0.15, x(b.e) - x(b.s)), yBa(0) - yBa(b.rate), "F");
  setDraw(hex("#6b7280")); doc.setLineWidth(0.2);
  doc.setLineDashPattern([0.8, 0.6], 0);
  for (const b of m.scheduled) doc.line(x(b.s), yBa(b.rate), x(b.e), yBa(b.rate));
  doc.setLineDashPattern([], 0);
  setDraw(hex("#cbd5e1")); doc.setLineWidth(0.15);
  doc.line(X0, yB + hB, X1, yB + hB);
  doc.setFontSize(6); setText(hex("#6b7280"));
  doc.text(`${fmt(bMax)} U/h`, X0 - 1, yB + 3, { align: "right" });

  // --- IOB ---
  label("IOB", yO + 3);
  const io = m.status.filter((s) => s.iob !== null);
  if (io.length > 1) {
    const vals = io.map((s) => s.iob as number);
    const lo = Math.min(0, ...vals), hi = Math.max(1, ...vals);
    const yIo = (v: number) => yO + hO - ((v - lo) / (hi - lo)) * hO;
    if (lo < 0) { setDraw(hex("#cbd5e1")); doc.setLineWidth(0.15); doc.line(X0, yIo(0), X1, yIo(0)); }
    setDraw(hex("#7c3aed")); doc.setLineWidth(0.35);
    for (let i = 1; i < io.length; i++) {
      if (io[i].t - io[i - 1].t > 15 * 60_000) continue;
      doc.line(x(io[i - 1].t), yIo(io[i - 1].iob as number), x(io[i].t), yIo(io[i].iob as number));
    }
    doc.setFontSize(6); setText(hex("#6b7280"));
    doc.text(`${fmt(hi)} U`, X0 - 1, yO + 3, { align: "right" });
  } else {
    doc.setFontSize(7); setText(hex("#9ca3af"));
    doc.text("État de la boucle non disponible pour ce jour", X0 + 2, yO + 8);
  }

  // --- Légende ---
  let lx = 15;
  const ly = yAx + 9;
  const leg = (c: string, txt: string, kind: "bar" | "dash" = "bar") => {
    if (kind === "bar") { setFill(hex(c)); doc.rect(lx, ly - 1.6, 4, 1.4, "F"); }
    else { setDraw(hex(c)); doc.setLineWidth(0.3); doc.setLineDashPattern([1, 0.7], 0); doc.line(lx, ly - 0.9, lx + 4, ly - 0.9); doc.setLineDashPattern([], 0); }
    doc.setFontSize(6.5); setText(hex("#374151")); doc.text(txt, lx + 5, ly);
    lx += 7 + doc.getTextWidth(txt) + 3;
  };
  leg("#0ea5e9", "SMB"); leg("#f97316", "Bolus du bouton"); leg("#7c3aed", "Autre bolus manuel");
  leg("#93c5fd", "Basale appliquée"); leg("#6b7280", "Basale programmée", "dash"); leg("#6366f1", "Cible appliquée", "dash");

  // --- Statistiques et chronologie ---
  let y = ly + 8;
  const vals = m.glucose.map((g) => g.v);
  const pct = (f: (v: number) => boolean) => (vals.length ? Math.round((vals.filter(f).length / vals.length) * 100) : 0);
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const sd = vals.length ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) : 0;
  doc.setFontSize(9); setText([0, 0, 0]);
  doc.text("Statistiques du jour", 15, y);
  doc.text("Chronologie", 95, y);
  y += 5;
  doc.setFontSize(7.5); setText(hex("#374151"));
  const stats = [
    `Glycémie moyenne : ${cv(mean)} ${opts.unit}`,
    `Min : ${vals.length ? cv(Math.min(...vals)) : "–"} · Max : ${vals.length ? cv(Math.max(...vals)) : "–"} ${opts.unit}`,
    `Coefficient de variation : ${mean ? Math.round((sd / mean) * 100) : 0} %`,
    `Dans la cible 70–180 : ${pct((v) => v >= 70 && v <= 180)} %`,
    `Au-dessus de 180 : ${pct((v) => v > 180)} % · au-dessus de 250 : ${pct((v) => v > 250)} %`,
    `Sous 70 : ${pct((v) => v < 70)} % · sous 54 : ${pct((v) => v < 54)} %`,
    "",
    `SMB : ${fmt(t.smb)} U en ${t.nSmb} SMB`,
    `Bolus manuels : ${fmt(t.manual)} U (${m.manual.length})`,
    `Basale délivrée : ${fmt(t.basal)} U`,
    `Insuline totale : ${fmt(t.smb + t.manual + t.basal)} U`,
  ];
  stats.forEach((s, i) => s && doc.text(s, 15, y + i * 4));

  const chrono = [
    ...m.overrides.map((b) => ({ t: b.s, s: `${hm(b.s)}–${hm(b.e)}  ${/d[ée]rogation/i.test(b.label) ? b.label : `Dérogation ${b.label}`}` })),
    ...m.targets.map((b) => ({ t: b.s, s: `${hm(b.s)}–${hm(b.e)}  Cible temporaire ${b.label}` })),
    ...m.manual.map((d) => ({ t: d.t, s: `${hm(d.t)}  Bolus ${d.button ? "du bouton" : "manuel"} ${fmt(d.u)} U` })),
    ...m.events.map((e) => ({ t: e.t, s: `${hm(e.t)}  ${e.label}` })),
  ].sort((a, b) => a.t - b.t);
  const maxLines = Math.floor((290 - y) / 3.6);
  const shown = chrono.length > maxLines ? chrono.slice(0, maxLines - 1) : chrono;
  doc.setFontSize(7);
  shown.forEach((c, i) => doc.text(c.s, 95, y + i * 3.6, { maxWidth: 105 }));
  if (shown.length < chrono.length) doc.text(`… et ${chrono.length - shown.length} autre(s)`, 95, y + shown.length * 3.6);
  if (!chrono.length) doc.text("Aucune dérogation, cible temporaire ni bolus manuel", 95, y);
  setText([0, 0, 0]);
}
