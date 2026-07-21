const PDFDocument = require('pdfkit');

/**
 * Stream a plain title + table PDF straight to an Express response — no
 * pixel-perfect design, this is an accounting/ops export a merchant or their
 * accountant opens once, not a branded document. Text-column table (no
 * pdfkit table plugin) is fine at this row count and gives predictable
 * pagination via a simple bottom-margin check.
 */
function pdfResponse(res, filename, { title, subtitle, columns, rows }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);

  doc.font('Helvetica-Bold').fontSize(16).fillColor('#111').text(title);
  if (subtitle) {
    doc.font('Helvetica').fontSize(10).fillColor('#666').text(subtitle);
  }
  doc.moveDown();

  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = usableWidth / columns.length;

  function drawRow(cells, bold) {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(bold ? '#111' : '#222');
    cells.forEach((cell, i) => {
      doc.text(String(cell == null ? '' : cell), startX + i * colWidth, y, { width: colWidth - 6 });
    });
    doc.moveDown(0.7);
  }

  drawRow(columns, true);
  doc.moveTo(startX, doc.y).lineTo(startX + usableWidth, doc.y).strokeColor('#ccc').stroke();
  doc.moveDown(0.3);

  for (const row of rows) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 30) {
      doc.addPage();
    }
    drawRow(row, false);
  }

  doc.end();
}

module.exports = { pdfResponse };
