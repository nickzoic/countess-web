/*
 * preview-select.js: spreadsheet-style selection for the preview table,
 * copied to the clipboard as CSV.
 *
 *   click a cell             select it
 *   drag across cells        select the rectangle
 *   shift-click              extend the selection
 *   click/drag on headers    select whole columns (this page's rows)
 *   double-click, Ctrl+A     select the whole page
 *   Ctrl+C                   copy again;  Escape clears
 *
 * Each selection is copied as soon as it is made.  Strings are quoted and
 * numbers and booleans are not; nulls are empty.  When whole columns are
 * selected the column names come first, as a header row.
 */
function attachCellSelection(container, options) {
    'use strict';
    // options.getData() -> { columns: [[name, dtype]], rows: [[...]] }
    // options.onCopied({ rows, columns, header }) after each copy
    var NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL|BOOLEAN)/i;
    var EDGE = 28;          // autoscroll when the pointer is this close to an edge

    var sel = null;         // { ar, ac, fr, fc, columns }: anchor and focus cells
    var dragging = false;
    var pointer = null;     // last pointer position while dragging
    var scroll_frame = 0;
    var paint_frame = 0;
    var down_on_cell = false;

    var outline = document.createElement('div');
    outline.className = 'cell-selection';
    outline.hidden = true;

    function table() { return container.querySelector('table.preview-table'); }
    function rowCount() { return options.getData().rows.length; }
    function colCount() { return options.getData().columns.length; }

    function bounds() {
        return {
            r1: Math.min(sel.ar, sel.fr), r2: Math.max(sel.ar, sel.fr),
            c1: Math.min(sel.ac, sel.fc), c2: Math.max(sel.ac, sel.fc),
        };
    }

    /* ── What is under the pointer ── */

    function cellFromElement(el) {
        var cell = el && el.closest && el.closest('td, th');
        var t = table();
        if (!cell || !t || !t.contains(cell)) return null;
        if (cell.tagName == 'TH') return { header: true, c: cell.cellIndex };
        if (cell.colSpan > 1) return null;   // the "No rows." cell
        return { header: false, r: cell.parentElement.sectionRowIndex, c: cell.cellIndex };
    }

    // The cell at a point, with the point pulled inside the pane so that
    // dragging past an edge still finds the nearest cell.
    function cellAtPoint(x, y) {
        var box = container.getBoundingClientRect();
        x = Math.min(Math.max(x, box.left + 1), box.right - 2);
        y = Math.min(Math.max(y, box.top + 1), box.bottom - 2);
        var cell = cellFromElement(document.elementFromPoint(x, y));
        if (cell && cell.header && sel && !sel.columns) {
            // over the sticky header while selecting cells: use the row under it
            var head = table().tHead.getBoundingClientRect();
            cell = cellFromElement(document.elementFromPoint(x, head.bottom + 1)) || cell;
        }
        if (!cell) {
            // right of the last column, or below the last row
            var t = table();
            if (!t || !t.tBodies[0] || !t.tBodies[0].rows.length) return null;
            var rows = t.tBodies[0].rows;
            var last = rows[rows.length - 1].getBoundingClientRect();
            var tbox = t.getBoundingClientRect();
            cell = cellFromElement(document.elementFromPoint(
                Math.min(x, tbox.right - 2), Math.min(y, last.bottom - 2)));
        }
        return cell;
    }

    /* ── Changing the selection ── */

    function start(cell, extend) {
        if (extend && sel) {
            moveFocus(cell);
            return;
        }
        if (cell.header) sel = { ar: 0, ac: cell.c, fr: rowCount() - 1, fc: cell.c, columns: true };
        else sel = { ar: cell.r, ac: cell.c, fr: cell.r, fc: cell.c, columns: false };
        paintSoon();
    }

    function moveFocus(cell) {
        if (!cell || !sel) return;
        if (sel.columns) {
            sel.fc = cell.c;
        } else {
            if (!cell.header) sel.fr = cell.r;
            sel.fc = cell.c;
        }
        paintSoon();
    }

    function selectAll() {
        if (!rowCount() || !colCount()) return false;
        sel = { ar: 0, ac: 0, fr: rowCount() - 1, fc: colCount() - 1, columns: true };
        paint();
        return true;
    }

    function clear() {
        sel = null;
        paint();
    }

    /* ── Drawing it ── */

    function paintSoon() {
        if (!paint_frame) paint_frame = requestAnimationFrame(() => { paint_frame = 0; paint(); });
    }

    function paint() {
        var t = table();
        container.querySelectorAll('.is-selected').forEach(el => el.classList.remove('is-selected'));
        if (!t || !sel) { outline.hidden = true; return; }
        var b = bounds();
        var rows = t.tBodies[0].rows;
        for (var r = b.r1; r <= b.r2; r++) {
            var cells = rows[r] && rows[r].cells;
            if (!cells) continue;
            for (var c = b.c1; c <= b.c2; c++) if (cells[c]) cells[c].classList.add('is-selected');
        }
        var heads = t.tHead.rows[0].cells;
        for (var h = b.c1; h <= b.c2; h++) heads[h].classList.add('is-selected');

        // one outline round the whole range, in the table's own coordinates
        var first = rows[b.r1] && rows[b.r1].cells[b.c1];
        var last = rows[b.r2] && rows[b.r2].cells[b.c2];
        if (!first || !last) { outline.hidden = true; return; }
        if (outline.parentNode != container) container.appendChild(outline);
        outline.style.left = (t.offsetLeft + first.offsetLeft) + 'px';
        outline.style.top = (t.offsetTop + first.offsetTop) + 'px';
        outline.style.width = (last.offsetLeft + last.offsetWidth - first.offsetLeft) + 'px';
        outline.style.height = (last.offsetTop + last.offsetHeight - first.offsetTop) + 'px';
        outline.hidden = false;
    }

    /* ── Copying it ── */

    function csvField(value, numeric) {
        if (value === null || value === undefined) return '';
        if (numeric) return String(value);
        var text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return '"' + text.replace(/"/g, '""') + '"';
    }

    function toCSV() {
        var data = options.getData();
        var b = bounds();
        var numeric = data.columns.map(c => NUMERIC.test(c[1]));
        var lines = [];
        if (sel.columns) {
            lines.push(data.columns.slice(b.c1, b.c2 + 1).map(c => csvField(c[0], false)).join(','));
        }
        for (var r = b.r1; r <= b.r2 && r < data.rows.length; r++) {
            var row = data.rows[r];
            var fields = [];
            for (var c = b.c1; c <= b.c2; c++) fields.push(csvField(row[c], numeric[c]));
            lines.push(fields.join(','));
        }
        return lines.join('\n') + '\n';
    }

    function fallbackCopy(text) {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
        area.remove();
        container.focus({ preventScroll: true });
        return ok;
    }

    function copy() {
        if (!sel) return;
        var text = toCSV();
        var b = bounds();
        var info = { rows: b.r2 - b.r1 + 1, columns: b.c2 - b.c1 + 1, header: sel.columns };
        var done = ok => options.onCopied && options.onCopied(Object.assign(info, { ok: ok }));
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => done(true), () => done(fallbackCopy(text)));
        } else {
            done(fallbackCopy(text));
        }
    }

    /* ── Autoscroll while dragging past an edge ── */

    function autoscroll() {
        scroll_frame = 0;
        if (!dragging || !pointer) return;
        var box = container.getBoundingClientRect();
        var head = table() && table().tHead ? table().tHead.offsetHeight : 0;
        var dx = 0, dy = 0;
        if (pointer.x < box.left + EDGE) dx = pointer.x - (box.left + EDGE);
        else if (pointer.x > box.right - EDGE) dx = pointer.x - (box.right - EDGE);
        if (pointer.y < box.top + head + EDGE) dy = pointer.y - (box.top + head + EDGE);
        else if (pointer.y > box.bottom - EDGE) dy = pointer.y - (box.bottom - EDGE);
        if (!dx && !dy) return;
        container.scrollLeft += Math.max(-40, Math.min(40, dx / 2));
        container.scrollTop += Math.max(-40, Math.min(40, dy / 2));
        moveFocus(cellAtPoint(pointer.x, pointer.y));
        scroll_frame = requestAnimationFrame(autoscroll);
    }

    /* ── Events ── */

    container.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        var cell = cellFromElement(e.target);
        if (!cell) return;
        down_on_cell = true;
        e.preventDefault();               // no text selection; we draw our own
        container.focus({ preventScroll: true });
        start(cell, e.shiftKey);
        // On touch, a tap selects a cell but dragging scrolls as usual.
        if (e.pointerType == 'touch') { copy(); return; }
        dragging = true;
        pointer = { x: e.clientX, y: e.clientY };
        container.setPointerCapture(e.pointerId);
    });

    container.addEventListener('pointermove', e => {
        if (!dragging) return;
        pointer = { x: e.clientX, y: e.clientY };
        moveFocus(cellAtPoint(e.clientX, e.clientY));
        if (!scroll_frame) scroll_frame = requestAnimationFrame(autoscroll);
    });

    function endDrag() {
        if (!dragging) return;
        dragging = false;
        pointer = null;
        if (scroll_frame) { cancelAnimationFrame(scroll_frame); scroll_frame = 0; }
        if (paint_frame) { cancelAnimationFrame(paint_frame); paint_frame = 0; }
        paint();
        copy();
    }
    container.addEventListener('pointerup', endDrag);
    container.addEventListener('pointercancel', endDrag);
    container.addEventListener('lostpointercapture', endDrag);

    // Double-click or double-tap.  Pointer events always have a detail of 0,
    // so use the click count; the click's target is the container, which
    // captured the pointer, so remember whether it began on a cell.
    container.addEventListener('click', e => {
        if (e.detail == 2 && down_on_cell && selectAll()) copy();
    });
    container.addEventListener('pointerdown', e => {
        if (!cellFromElement(e.target)) down_on_cell = false;
    }, true);

    container.addEventListener('keydown', e => {
        var mod = e.ctrlKey || e.metaKey;
        if (mod && !e.altKey && e.key.toLowerCase() == 'a' && table()) {
            e.preventDefault();
            if (selectAll()) copy();
        } else if (e.key == 'Escape' && sel) {
            e.preventDefault();               // don't also restore an expanded pane
            clear();
        }
    });

    // Ctrl+C (or Copy from the browser's menu) with the table focused.
    container.addEventListener('copy', e => {
        if (!sel || !e.clipboardData) return;
        e.clipboardData.setData('text/plain', toCSV());
        e.preventDefault();
        var b = bounds();
        options.onCopied && options.onCopied({ rows: b.r2 - b.r1 + 1, columns: b.c2 - b.c1 + 1, header: sel.columns, ok: true });
    });

    // A resized pane can move the cells under the outline.
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (sel) paintSoon(); }).observe(container);

    return {
        // Call after the table is replaced (a new page or node).
        reset() { sel = null; dragging = false; outline.hidden = true; },
        selectAll() { if (selectAll()) copy(); },
        get selection() { return sel ? Object.assign(bounds(), { columns: sel.columns }) : null; },
        toCSV() { return sel ? toCSV() : ''; },
    };
}
