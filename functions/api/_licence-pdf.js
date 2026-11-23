// functions/api/_licence-pdf.js — shared helper, NOT a route (zip 263).
//
// Builds the one-page LICENCE certificate (a real PDF) that a buyer gets after paying in full: licence number, who it is for, the product, their link,
// the money paid, when and how. No library: a PDF is a small text format, and this page needs only a few lines of text, two rectangles and one link.
// Text is limited to Latin-1 (the standard Helvetica font); any other character is shown as "?" rather than breaking the file.

const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
const clean = (v) => String(v == null ? '' : v).replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
const esc = (v) => clean(v).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const money = (n) => 'KES ' + Number(n || 0).toLocaleString('en-US');
const day = (t) => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(t)); } catch (e) { return new Date(t).toISOString().slice(0, 10); } };   // Nairobi date (zip 267)

// rows: [label, value]. Returns the PDF as bytes.
// zip 267: also builds the PAYMENT RECEIPT for a renewal or add-on (heading 'Payment receipt'). Optional: lines = [{ label, amount }] (the breakdown, discount as a negative amount),
// renewalNote = a sentence about the next renewal (Nairobi time). Without them the page is the same as before.
export function buildLicencePdf({ licenceNo, holder, phone, email, productLabel, kindLabel, link, amount, paidAt, method, reference, issuer, heading, subheading, lines, renewalNote }) {
  const W = 595, H = 842, M = 48;
  const ops = [];
  const text = (x, y, size, str, bold, rgb) => ops.push(`BT ${(rgb || [0.08, 0.16, 0.17]).join(' ')} rg /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${esc(str)}) Tj ET`);
  const rect = (x, y, w, h, rgb, stroke) => ops.push(stroke ? `${rgb.join(' ')} RG 1.2 w ${x} ${y} ${w} ${h} re S` : `${rgb.join(' ')} rg ${x} ${y} ${w} ${h} re f`);

  rect(M - 14, M - 14, W - 2 * (M - 14), H - 2 * (M - 14), [0.82, 0.8, 0.72], true);         // page border
  rect(M - 14, H - 150, W - 2 * (M - 14), 136, [0.063, 0.153, 0.165]);                       // header band (the brand's deep teal)
  rect(M - 14, H - 154, W - 2 * (M - 14), 4, [0.94, 0.64, 0.04]);                            // amber rule under it
  text(M, H - 76, 13, (issuer || 'MyDukaPOS').toUpperCase(), true, [0.94, 0.64, 0.04]);
  text(M, H - 112, 30, heading || 'Software Licence', true, [1, 1, 1]);
  text(M, H - 134, 11, subheading || 'Permanent licence certificate', false, [0.78, 0.86, 0.85]);

  let y = H - 200;
  text(M, y, 10, heading ? 'RECEIPT NUMBER' : 'LICENCE NUMBER', true, [0.36, 0.43, 0.44]); text(M, y - 22, 20, licenceNo, true); y -= 62;
  const row = (label, value) => {
    if (!value) return;
    text(M, y, 9.5, label.toUpperCase(), true, [0.36, 0.43, 0.44]);
    String(value).match(/.{1,70}/g).forEach((part, i) => text(M, y - 16 - i * 15, 12.5, part, false));
    y -= 16 + 15 * Math.ceil(String(value).length / 70) + 12;
  };
  row('Issued to', holder);
  row('Phone', phone);
  row('Email', email);
  row('Product', productLabel);
  row('Licence', kindLabel);
  row('Your link', link);
  const linkTop = y;                                                                       // (remembered only to place the clickable area below)
  if (Array.isArray(lines) && lines.length) {                                              // the price breakdown: what was quoted, any discount, and what was paid
    text(M, y, 9.5, 'WHAT YOU PAID FOR', true, [0.36, 0.43, 0.44]); y -= 16;
    for (const l of lines.slice(0, 8)) { text(M, y, 11.5, String(l.label).slice(0, 62), false); text(W - M - 110, y, 11.5, (l.amount < 0 ? '- ' : '') + money(Math.abs(l.amount)), false); y -= 16; }
    y -= 10;
  }

  rect(M, y - 74, W - 2 * M, 84, [0.91, 0.96, 0.93]);                                      // the payment box
  text(M + 16, y - 20, 9.5, 'PAID IN FULL', true, [0.07, 0.5, 0.3]);
  text(M + 16, y - 48, 24, money(amount), true, [0.07, 0.5, 0.3]);
  text(M + 250, y - 22, 10.5, 'Paid on ' + day(paidAt), false);
  text(M + 250, y - 38, 10.5, 'Method: ' + (method || 'M-Pesa'), false);
  if (reference) text(M + 250, y - 54, 10.5, 'Reference: ' + reference, false);
  y -= 110;

  if (renewalNote) { text(M, y, 10.5, renewalNote, false, [0.3, 0.37, 0.38]); y -= 16; }
  // zip 306: a reassuring note instead of a warning (the old line read "Anyone with the link can open the shop", which alarmed buyers). Every claim
  // here is true of the system: HTTPS only, Cloudflare stores KV / D1 / Durable Objects / R2 encrypted at rest, scheduled backups, sign-in needs the
  // shop password or a staff PIN.
  const note = [0.3, 0.37, 0.38];
  text(M, y, 10.5, heading ? 'Keep this receipt for your records.' : 'This licence is issued to you for the link above.', false, note);
  text(M, y - 18, 10.5, 'Your data is safe: it travels over a secure connection, is stored encrypted and is backed up regularly.', true, [0.07, 0.42, 0.27]);
  text(M, y - 34, 10.5, 'Only you and the staff you add can sign in, with your password or their own PIN. Keep your password private.', false, note);
  text(M, 70, 9, 'Issued ' + day(Date.now()) + ' by ' + (issuer || 'MyDukaPOS') + '. This document was generated automatically and is valid without a signature.', false, [0.5, 0.55, 0.55]);

  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Annots [7 0 R] >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    // the link is clickable in a PDF viewer (the box sits over the "Your link" lines)
    `<< /Type /Annot /Subtype /Link /Rect [${M} ${linkTop + 8} ${W - M} ${linkTop + 44}] /Border [0 0 0] /A << /S /URI /URI (${esc(link)}) >> >>`,
  ];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc(out);
}
