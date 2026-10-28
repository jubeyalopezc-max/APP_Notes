// Generador de PDF mínimo: cada página es una imagen JPEG, más marcadores
// (el índice lateral que muestran los lectores de PDF).

const enc = new TextEncoder();

// Texto para el PDF en UTF-16 (sirve para tildes, ñ y cualquier símbolo).
function pdfText(s) {
  let hex = 'FEFF';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp > 0xFFFF) {
      const v = cp - 0x10000;
      hex += (0xD800 + (v >> 10)).toString(16).padStart(4, '0') + (0xDC00 + (v & 0x3FF)).toString(16).padStart(4, '0');
    } else hex += cp.toString(16).padStart(4, '0');
  }
  return '<' + hex.toUpperCase() + '>';
}

function pdfDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `(D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())})`;
}

const num = n => (Math.round(n * 100) / 100).toString();

/**
 * pages:   [{ jpeg: Uint8Array, pxW, pxH, w, h }]  (w y h en puntos)
 * outline: [{ title, page, y, children? }]          (page empieza en 0; y en puntos desde arriba)
 */
export function buildPdf(pages, outline, title) {
  const parts = [];
  let len = 0;
  const offsets = [];
  const push = x => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, ...body) => { offsets[n] = len; push(`${n} 0 obj\n`); body.forEach(push); push('\nendobj\n'); };

  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A, 0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // %PDF-1.4

  const pageObj = i => 4 + i * 3;
  let next = 4 + pages.length * 3;

  // Numerar los marcadores.
  const root = outline.length ? next++ : 0;
  const flat = [];
  const assign = (list, parent) => {
    list.forEach(it => { it._n = next++; it._parent = parent; flat.push(it); });
    list.forEach((it, i) => {
      it._prev = list[i - 1];
      it._next = list[i + 1];
      if (it.children && it.children.length) assign(it.children, it._n);
    });
  };
  assign(outline, root);

  obj(1, `<< /Type /Catalog /Pages 2 0 R${root ? ` /Outlines ${root} 0 R /PageMode /UseOutlines` : ''} >>`);
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  obj(3, `<< /Title ${pdfText(title)} /Producer (NotesPro) /CreationDate ${pdfDate(new Date())} >>`);

  pages.forEach((pg, i) => {
    const n = pageObj(i);
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pg.w)} ${num(pg.h)}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    const content = `q ${num(pg.w)} 0 0 ${num(pg.h)} 0 0 cm /Im0 Do Q`;
    obj(n + 1, `<< /Length ${enc.encode(content).length} >>\nstream\n${content}\nendstream`);
    obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${pg.pxW} /Height ${pg.pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.jpeg.length} >>\nstream\n`, pg.jpeg, '\nendstream');
  });

  if (root) {
    obj(root, `<< /Type /Outlines /First ${outline[0]._n} 0 R /Last ${outline[outline.length - 1]._n} 0 R /Count ${flat.length} >>`);
    for (const it of flat) {
      const pg = pages[Math.min(pages.length - 1, Math.max(0, it.page))];
      const top = Math.max(0, Math.min(pg.h, pg.h - (it.y || 0)));
      const kids = it.children || [];
      let d = `<< /Title ${pdfText(it.title)} /Parent ${it._parent} 0 R /Dest [${pageObj(pages.indexOf(pg))} 0 R /XYZ 0 ${num(top)} null]`;
      if (it._prev) d += ` /Prev ${it._prev._n} 0 R`;
      if (it._next) d += ` /Next ${it._next._n} 0 R`;
      if (kids.length) d += ` /First ${kids[0]._n} 0 R /Last ${kids[kids.length - 1]._n} 0 R /Count ${kids.length}`;
      obj(it._n, d + ' >>');
    }
  }

  const xref = len;
  let x = `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let i = 1; i < next; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<< /Size ${next} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
