#!/usr/bin/env bash
# Produces the PDF fixtures the ingress tests read. Run once; commit the outputs.
# Every producer and flag is recorded here so a regeneration is reproducible.
#
#   tagged.pdf     Chrome's print-to-pdf with a document outline: a structure tree
#                  (H1/H2/P/Table/Figure), bookmarks, three pages — text, table, image.
#   scanned.pdf    assembled by hand below: one page whose only content is a JPEG raster,
#                  no characters — what a scanner produces.
#   untagged.pdf   Ghostscript from PostScript: two pages, headings only by font size.
#   encrypted.pdf  untagged.pdf re-written by Ghostscript with a user password.
set -euo pipefail
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PNG="$(node -e "require('sharp')({create:{width:96,height:64,channels:3,background:'#0a7'}}).png().toBuffer().then(b=>process.stdout.write(b.toString('base64')))")"

cat > tagged.html <<HTML
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A Tagged Paper</title>
<style>body{font-family:serif;font-size:12pt;margin:1in} table{border-collapse:collapse} td,th{border:1px solid #333;padding:4px 8px} .pb{page-break-before:always}</style>
</head><body>
<h1>A Tagged Paper</h1>
<h2>Introduction</h2>
<p>This introduction paragraph carries enough prose to survive any minimum-length floor a chunker may apply, and it mentions the retrieval budget explicitly so a search for the word budget lands here.</p>
<p>A second paragraph follows the first, so the section holds more than one block of text and the paragraph splitter has something to do.</p>
<h2>Method</h2>
<p>The method section describes the procedure in ordinary prose without any table or figure, so its page should count no image objects.</p>
<div class="pb"></div>
<h2>Results</h2>
<p>Table 1 reports the measured values for each configuration.</p>
<table><caption>Table 1. Measured values.</caption>
<tr><th>Configuration</th><th>Cells</th><th>Seconds</th></tr>
<tr><td>baseline</td><td>803</td><td>4.2</td></tr>
<tr><td>four images</td><td>1591</td><td>7.9</td></tr>
</table>
<div class="pb"></div>
<h2>Discussion</h2>
<figure><img src="data:image/png;base64,$PNG" alt="A solid green rectangle" width="192" height="128"><figcaption>Figure 1. A solid green rectangle used as the chart stand-in.</figcaption></figure>
<p>The discussion refers to Figure 1 above and closes the document.</p>
</body></html>
HTML


# One fresh profile per call (a shared one blocks the second launch on its lock)
# and a hard alarm, so a wedged renderer fails the script instead of hanging it.
for name in tagged; do
  PROFILE="$(mktemp -d)"
  # Chrome sometimes lingers after the file is written; the alarm ends it and
  # the file on disk is the verdict, not the exit code.
  perl -e 'alarm shift; exec @ARGV' 45 "$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
    --user-data-dir="$PROFILE" --no-pdf-header-footer --generate-pdf-document-outline --virtual-time-budget=2000 \
    --print-to-pdf="$PWD/$name.pdf" "file://$PWD/$name.html" >/dev/null 2>&1 || true
  rm -rf "$PROFILE"
  [ -s "$PWD/$name.pdf" ] || { echo "chrome produced no $name.pdf" >&2; exit 1; }
done


# scanned.pdf — a minimal PDF assembled by hand: catalog, pages, one page, one
# DCTDecode image XObject painted full-bleed. No producer, no dates: byte-stable.
node - <<'JS'
const sharp = require('sharp'); const fs = require('fs');
(async () => {
  const W = 850, H = 1100;
  const svg = `<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#f4f4f0"/>` +
    `<rect x="80" y="90" width="690" height="18" fill="#333"/><rect x="80" y="130" width="600" height="12" fill="#555"/>` +
    `<rect x="80" y="156" width="650" height="12" fill="#555"/><rect x="80" y="182" width="560" height="12" fill="#555"/></svg>`;
  const jpg = await sharp(Buffer.from(svg)).jpeg({ quality: 75 }).toBuffer();
  const w = 612, h = 792;
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let pos = parts[0].length; const offsets = [];
  const add = (n, head, stream) => {
    offsets[n] = pos;
    let b = Buffer.from(`${n} 0 obj\n${head}\n`, 'latin1');
    if (stream) b = Buffer.concat([b, Buffer.from('stream\n', 'latin1'), stream, Buffer.from('\nendstream\n', 'latin1')]);
    b = Buffer.concat([b, Buffer.from('endobj\n', 'latin1')]);
    parts.push(b); pos += b.length;
  };
  const content = Buffer.from(`q ${w} 0 0 ${h} 0 0 cm /Im1 Do Q`, 'latin1');
  add(1, '<< /Type /Catalog /Pages 2 0 R >>');
  add(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>`);
  add(4, `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>`, jpg);
  add(5, `<< /Length ${content.length} >>`, content);
  let x = `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  x += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(x, 'latin1'));
  fs.writeFileSync('scanned.pdf', Buffer.concat(parts));
})();
JS

cat > untagged.ps <<'PS'
%!PS-Adobe-3.0
/Helvetica-Bold findfont 18 scalefont setfont 72 720 moveto (An Untagged Report) show
/Helvetica-Bold findfont 14 scalefont setfont 72 688 moveto (First Section) show
/Helvetica findfont 10 scalefont setfont
72 670 moveto (Body text line one of the first section, set in the body size.) show
72 656 moveto (Body text line two of the first section continues the paragraph.) show
/Helvetica-Bold findfont 14 scalefont setfont 72 620 moveto (Second Section) show
/Helvetica findfont 10 scalefont setfont
72 602 moveto (Body text of the second section, also in the body size.) show
showpage
/Helvetica findfont 10 scalefont setfont
72 720 moveto (Page two carries a single body line and no heading.) show
showpage
PS
gs -q -dBATCH -dNOPAUSE -sDEVICE=pdfwrite -sOutputFile=untagged.pdf untagged.ps
gs -q -dBATCH -dNOPAUSE -sDEVICE=pdfwrite -sOwnerPassword=owner -sUserPassword=user -dEncryptionR=3 -dKeyLength=128 \
  -sOutputFile=encrypted.pdf untagged.pdf

rm -f tagged.html untagged.ps
ls -la ./*.pdf

# matrix.pdf — text set at font size 1 under scaled text matrices (22× title,
# 11× body), the way some publisher pipelines emit it. PDFium then reports a
# nominal font size of 1 for every glyph; the reader must measure size and
# spacing from the loose (advance) boxes instead. Written by hand: Ghostscript
# would fold the scale back into the font size and hide the case.
python3 - matrix.pdf <<'PY'
import io, sys
content = b"""BT
/F1 1 Tf
22 0 0 22 72 700 Tm
(Scaled Title Line) Tj
11 0 0 11 72 660 Tm
(Body text set at size one under a scaled matrix.) Tj
11 0 0 11 72 644 Tm
(Second line of body text with several words.) Tj
ET
"""
objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"endstream",
]
out = io.BytesIO(); out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"); offsets = []
for i, o in enumerate(objs, 1):
    offsets.append(out.tell()); out.write(f"{i} 0 obj\n".encode() + o + b"\nendobj\n")
xref = out.tell()
out.write(f"xref\n0 {len(objs)+1}\n".encode() + b"0000000000 65535 f \n")
for off in offsets: out.write(f"{off:010d} 00000 n \n".encode())
out.write(f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
open(sys.argv[1], 'wb').write(out.getvalue())
PY

# Bounds fixtures, hand-written (Ghostscript would normalise them away):
#  clipped.pdf  — a 1×1 red image painted into a 2000-pt square on a 100-pt page:
#                 the visible figure is the page; the crop must not be the square.
#  form.pdf     — a 2×2 green image inside a Form XObject (/Matrix translate 10,10
#                 under an outer cm translate 40,40): the image is nested, at
#                 page-space [50,50]–[150,150].
#  bigimage.pdf — a direct image whose dictionary says 10001×10000 pixels.
#  bigform.pdf  — the same image inside a Form XObject.
python3 - <<'PY'
import io
def pdf(path, objs):
    out = io.BytesIO(); out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"); offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(out.tell()); out.write(f"{i} 0 obj\n".encode() + o + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objs)+1}\n".encode() + b"0000000000 65535 f \n")
    for off in offsets: out.write(f"{off:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    open(path, 'wb').write(out.getvalue())
def stream(dict_head, data): return dict_head + b" /Length " + str(len(data)).encode() + b" >>\nstream\n" + data + b"\nendstream"
def image(w, h, rgb, data=None):
    data = data if data is not None else bytes(rgb) * (w * h)
    return stream(b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8" % (w, h), data)
def page(box, content, xobjects):
    return b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Resources << /XObject << %s >> >> /Contents 4 0 R >>" % (box, box, xobjects)
CAT = b"<< /Type /Catalog /Pages 2 0 R >>"; PAGES = b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"
pdf('clipped.pdf', [CAT, PAGES, page(100, None, b"/Im1 5 0 R"),
    stream(b"<<", b"q 2000 0 0 2000 -950 -950 cm /Im1 Do Q"), image(1, 1, (255, 0, 0))])
form = stream(b"<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 10 10] /Resources << /XObject << /Im1 6 0 R >> >>", b"q 100 0 0 100 0 0 cm /Im1 Do Q")
pdf('form.pdf', [CAT, PAGES, page(200, None, b"/Fx1 5 0 R"),
    stream(b"<<", b"q 1 0 0 1 40 40 cm /Fx1 Do Q"), form, image(2, 2, (0, 170, 119))])
big = image(10001, 10000, (0, 0, 0), data=b"\x00\x00\x00")
pdf('bigimage.pdf', [CAT, PAGES, page(100, None, b"/Im1 5 0 R"), stream(b"<<", b"q 100 0 0 100 0 0 cm /Im1 Do Q"), big])
bigform = stream(b"<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /XObject << /Im1 6 0 R >> >>", b"q 100 0 0 100 0 0 cm /Im1 Do Q")
pdf('bigform.pdf', [CAT, PAGES, page(100, None, b"/Fx1 5 0 R"), stream(b"<<", b"q /Fx1 Do Q"), bigform, big])
PY
ls -la clipped.pdf form.pdf bigimage.pdf bigform.pdf

# Inspection-limit fixtures, hand-written: the walk's caps and what lies just
# past them. A document the reader cannot finish inspecting is refused; these
# pin both sides of each cap.
#  form8.pdf       — a 2×2 green image behind exactly eight nested Form XObjects:
#                    the image sits at walk depth 8 and is inspected.
#  deepform.pdf    — the 10001×10000 image behind nine: the ninth form sits at
#                    depth 8 and is not descended, so the image is never seen.
#  paths19999.pdf  — 19,999 path objects then a 2×2 image, the 20,000th object.
#  manypaths.pdf   — 20,000 path objects then the 10001×10000 image as the 20,001st.
#  nodim.pdf       — an /Image XObject with no /Width or /Height.
python3 - <<'PY'
import io
def pdf(path, objs):
    out = io.BytesIO(); out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"); offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(out.tell()); out.write(f"{i} 0 obj\n".encode() + o + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objs)+1}\n".encode() + b"0000000000 65535 f \n")
    for off in offsets: out.write(f"{off:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    open(path, 'wb').write(out.getvalue())
def stream(dict_head, data): return dict_head + b" /Length " + str(len(data)).encode() + b" >>\nstream\n" + data + b"\nendstream"
def image(w, h, rgb, data=None):
    data = data if data is not None else bytes(rgb) * (w * h)
    return stream(b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8" % (w, h), data)
def page(box, content, xobjects):
    return b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Resources << /XObject << %s >> >> /Contents 4 0 R >>" % (box, box, xobjects)
CAT = b"<< /Type /Catalog /Pages 2 0 R >>"; PAGES = b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"
small = image(2, 2, (0, 170, 119))
big = image(10001, 10000, (0, 0, 0), data=b"\x00\x00\x00")
# n Form XObjects nested one inside the next (objects 5..4+n), the innermost painting the image (object 5+n).
def nested(name, n, img):
    forms = []
    for k in range(n):
        inner = (b"/Fx %d 0 R" % (6 + k)) if k < n - 1 else (b"/Im1 %d 0 R" % (5 + n))
        paint = b"q /Fx Do Q" if k < n - 1 else b"q 100 0 0 100 0 0 cm /Im1 Do Q"
        forms.append(stream(b"<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /XObject << " + inner + b" >> >>", paint))
    pdf(name, [CAT, PAGES, page(100, None, b"/Fx1 5 0 R"), stream(b"<<", b"q /Fx1 Do Q"), *forms, img])
nested('form8.pdf', 8, small)      # the image sits at walk depth 8: inspected
nested('deepform.pdf', 9, big)     # the ninth form sits at depth 8: past the cap
# N path objects, then the image as object N+1.
def paths(name, n, img):
    content = b"0 0 1 1 re f\n" * n + b"q 100 0 0 100 0 0 cm /Im1 Do Q"
    pdf(name, [CAT, PAGES, page(100, None, b"/Im1 5 0 R"), stream(b"<<", content), img])
paths('paths19999.pdf', 19999, small)   # the image is the 20,000th object: inspected
paths('manypaths.pdf', 20000, big)      # the image is the 20,001st: past the cap
# An image whose dictionary names no size at all.
nodim = stream(b"<< /Type /XObject /Subtype /Image /ColorSpace /DeviceRGB /BitsPerComponent 8", b"\x00\x00\x00")
pdf('nodim.pdf', [CAT, PAGES, page(100, None, b"/Im1 5 0 R"), stream(b"<<", b"q 100 0 0 100 0 0 cm /Im1 Do Q"), nodim])
PY
ls -la form8.pdf deepform.pdf paths19999.pdf manypaths.pdf nodim.pdf
