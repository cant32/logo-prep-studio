// Artwork proof: one A4 page to send the client or supplier before printing.
// It shows the logo at its real print size on the garment colour, the inks,
// the size and method, the print checks and a sign-off box. A technical
// proof, not a mock-up.

import { addSvgPage } from './export.js';

const NAVY = [27, 34, 42], ORANGE = [243, 118, 38], GREY = [110, 118, 128];
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
// a simple CMYK guide value; printers will set their own
const cmyk = h => {
  const [r, g, b] = hexRgb(h).map(v => v / 255), k = 1 - Math.max(r, g, b);
  if (k >= 0.999) return '0/0/0/100';
  return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k].map(v => Math.round(v * 100)).join('/');
};

export async function proofBlob({ built, job, version, method, methodLabel, garment, inks, issues, mirrored, liveText, logoSvg }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const W = 210, M = 14;
  // header band with the Stacked Merch logo
  doc.setFillColor(...NAVY); doc.rect(0, 0, W, 24, 'F');
  if (logoSvg) { try { await addSvgPage(doc, logoSvg, M, 7, 48, 10); } catch { /* text fallback below */ } }
  doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
  doc.text('ARTWORK PROOF', W - M, 15, { align: 'right' });
  // job details
  doc.setTextColor(...NAVY); doc.setFontSize(16);
  doc.text(job || 'Untitled job', M, 36);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GREY);
  const today = new Date().toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });
  doc.text(`${version || 'v1'}  ·  ${today}`, M, 42);
  const rows = [
    ['Print method', methodLabel],
    ['Print size', `${built.widthMm.toFixed(0)} × ${built.heightMm.toFixed(0)} mm`],
    ['Colours', `${inks.length}`],
    ['Mirrored', mirrored ? 'Yes' : 'No'],
    ['Text', liveText ? 'Live text: NOT yet converted to curves' : 'Outlined (no fonts needed)'],
  ];
  let y = 50;
  doc.setFontSize(9);
  for (const [k, v] of rows) { doc.setTextColor(...GREY); doc.text(k, M, y); doc.setTextColor(...NAVY); doc.text(String(v), M + 32, y); y += 5.5; }

  // artwork on the garment colour, at real size when it fits
  const boxY = y + 4, boxW = W - M * 2, boxH = 120;
  const fit = Math.min(1, (boxW - 16) / built.widthMm, (boxH - 16) / built.heightMm);
  const g = garment && garment !== 'checker' ? hexRgb(garment) : [255, 255, 255];
  doc.setFillColor(...g); doc.setDrawColor(220); doc.rect(M, boxY, boxW, boxH, 'FD');
  const aw = built.widthMm * fit, ah = built.heightMm * fit;
  await addSvgPage(doc, built.svg, M + (boxW - aw) / 2, boxY + (boxH - ah) / 2, aw, ah);
  doc.setFontSize(8); doc.setTextColor(...GREY);
  doc.text(fit < 1 ? `Shown at ${Math.round(fit * 100)}% of print size` : 'Shown at actual print size', M, boxY + boxH + 4.5);
  doc.text(garment && garment !== 'checker' ? `On garment colour ${garment.toUpperCase()}` : 'On white', W - M, boxY + boxH + 4.5, { align: 'right' });

  // inks
  y = boxY + boxH + 13;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...NAVY); doc.text('Inks', M, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); y += 5;
  doc.setTextColor(...GREY); doc.text('Colour', M + 9, y); doc.text('Hex', M + 50, y); doc.text('CMYK guide', M + 80, y); doc.text('Pantone (confirm with printer)', M + 120, y); y += 4;
  for (const ink of inks) {
    doc.setFillColor(...hexRgb(ink)); doc.setDrawColor(200); doc.rect(M, y - 3.2, 6, 4.2, 'FD');
    doc.setTextColor(...NAVY); doc.text(`Ink ${inks.indexOf(ink) + 1}`, M + 9, y); doc.text(ink.toUpperCase(), M + 50, y); doc.text(cmyk(ink), M + 80, y);
    doc.setDrawColor(190); doc.line(M + 120, y + 0.8, W - M, y + 0.8);
    y += 6.2;
  }

  // checks
  y += 2;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...NAVY); doc.text('Print checks', M, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); y += 5;
  for (const i of issues.slice(0, 6)) {
    const lines = doc.splitTextToSize(`${i.level === 'warn' ? '!  ' : '•  '}${i.text}`, W - M * 2);
    doc.setTextColor(...(i.level === 'warn' ? ORANGE : NAVY)); doc.text(lines, M, y); y += lines.length * 4;
  }

  // sign-off
  const sy = Math.max(y + 6, 262);
  doc.setDrawColor(...NAVY); doc.setLineWidth(0.3); doc.rect(M, sy, W - M * 2, 20);
  doc.setFontSize(8.5); doc.setTextColor(...NAVY);
  doc.text('Approved by', M + 3, sy + 6); doc.line(M + 25, sy + 6.5, M + 95, sy + 6.5);
  doc.text('Date', M + 100, sy + 6); doc.line(M + 110, sy + 6.5, W - M - 3, sy + 6.5);
  doc.text('Signature', M + 3, sy + 15); doc.line(M + 25, sy + 15.5, M + 95, sy + 15.5);
  doc.setTextColor(...GREY); doc.setFontSize(7);
  doc.text('Colours on screen and in this proof are approximate. Please check spelling, size and colours before approving.', M, 290);
  return doc.output('blob');
}
