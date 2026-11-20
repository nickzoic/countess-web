var dag_edit = new DAGEditor(document.getElementById('dag-container'));
var config_container = document.getElementById('config-container');
var config_subject = document.getElementById('config-subject');
var view_container = document.getElementById('view-container');
var view_status = document.getElementById('view-status');

fetch('tree').then(response => {
    if (!response.ok) throw new Error('not okay');
    return response.text();
}).then(text => {
    dag_edit.importJSON(text);
});

var config_edit;
var selected_node;

/* ── Preview, a page at a time ─────────────────────────────────────── */

var pager = document.getElementById('view-pager');
var page_size_select = document.getElementById('page-size');
var page_range = document.getElementById('page-range');
var page_number = document.getElementById('page-number');
var page_count = document.getElementById('page-count');
var page_buttons = {
    first: document.getElementById('page-first'),
    prev: document.getElementById('page-prev'),
    next: document.getElementById('page-next'),
    last: document.getElementById('page-last'),
};

var PAGE_SIZE_KEY = 'countess-web.pageSize';
var preview = { node: null, offset: 0, limit: 100, total: null, truncated: false, rows: 0, request: 0 };

try {
    var stored_size = parseInt(localStorage.getItem(PAGE_SIZE_KEY), 10);
    if ([50, 100, 250, 500, 1000].includes(stored_size)) preview.limit = stored_size;
} catch (e) { /* storage unavailable */ }
page_size_select.value = String(preview.limit);

var number_format = new Intl.NumberFormat();
function fmt(n) { return number_format.format(n); }
function plural(n, word) { return fmt(n) + ' ' + word + (n == 1 ? '' : 's'); }

// DuckDB types that hold numbers, so their columns can be right-aligned.
var NUMERIC_TYPE = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL)/i;

function showPreviewMessage(text, is_error) {
    var p = document.createElement('p');
    p.className = 'preview-message' + (is_error ? ' is-error' : '');
    p.textContent = text;
    view_container.replaceChildren(p);
    view_container.classList.remove('is-loading');
    view_status.textContent = '';
    pager.hidden = true;
}

function lastPageOffset() {
    if (!preview.total) return 0;
    return Math.floor((preview.total - 1) / preview.limit) * preview.limit;
}

function hasNextPage() {
    // Older servers don't send a total: assume more rows while pages come back full.
    if (preview.total === null) return preview.rows == preview.limit;
    return preview.offset + preview.limit < preview.total;
}

function updatePager() {
    var first_row = preview.offset + 1;
    var last_row = preview.offset + preview.rows;
    var page = Math.floor(preview.offset / preview.limit) + 1;

    if (preview.total !== null) {
        var total_text = fmt(preview.total) + (preview.truncated ? '+' : '');
        view_status.textContent = total_text + (preview.total == 1 && !preview.truncated ? ' row' : ' rows');
        page_range.textContent = preview.rows ? 'Rows ' + fmt(first_row) + '\u2013' + fmt(last_row) + ' of ' + total_text : '';
        var pages = Math.max(1, Math.ceil(preview.total / preview.limit));
        page_count.textContent = 'of ' + fmt(pages) + (preview.truncated ? '+' : '');
        page_number.max = pages;
    } else {
        view_status.textContent = '';
        page_range.textContent = preview.rows ? 'Rows ' + fmt(first_row) + '\u2013' + fmt(last_row) : '';
        page_count.textContent = '';
        page_number.removeAttribute('max');
    }
    page_number.value = page;

    page_buttons.first.disabled = page_buttons.prev.disabled = preview.offset == 0;
    page_buttons.next.disabled = !hasNextPage();
    page_buttons.last.disabled = preview.total === null || !hasNextPage();
    pager.hidden = false;
}

function renderPreview(json) {
    var columns = json.columns || [];
    var rows = json.data || [];
    preview.total = typeof json.total == 'number' ? json.total : null;
    preview.truncated = !!json.truncated;
    preview.rows = rows.length;

    // Settings changes can leave us past the end: go to the new last page.
    if (preview.total !== null && preview.total > 0 && preview.offset >= preview.total) {
        loadPreview(preview.node, lastPageOffset());
        return;
    }
    if (!columns.length) {
        showPreviewMessage('This node has no output columns.');
        return;
    }
    var numeric = columns.map(c => NUMERIC_TYPE.test(c[1]));

    var table = document.createElement('table');
    table.className = 'preview-table';
    var head = table.createTHead().insertRow();
    columns.forEach((c, i) => {
        var th = document.createElement('th');
        th.scope = 'col';
        if (numeric[i]) th.className = 'num';
        th.textContent = c[0];
        var dtype = document.createElement('span');
        dtype.className = 'dtype';
        dtype.textContent = c[1];
        th.appendChild(dtype);
        head.appendChild(th);
    });
    var body = table.createTBody();
    rows.forEach(row => {
        var tr = body.insertRow();
        row.forEach((value, i) => {
            var td = tr.insertCell();
            if (value === null) {
                td.className = 'null';
                td.textContent = 'null';
            } else {
                if (numeric[i]) td.className = 'num';
                td.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);
            }
        });
    });
    if (!rows.length) {
        var tr = body.insertRow();
        var td = tr.insertCell();
        td.colSpan = columns.length;
        td.className = 'null';
        td.textContent = 'No rows.';
    }
    view_container.replaceChildren(table);
    view_container.classList.remove('is-loading');
    updatePager();
    view_status.textContent += (view_status.textContent ? ', ' : '') + plural(columns.length, 'column');
}

function loadPreview(node, offset) {
    var request = ++preview.request;
    var page_changed = node != preview.node || offset != preview.offset;
    preview.node = node;
    preview.offset = Math.max(0, offset);
    view_container.classList.add('is-loading');
    Object.values(page_buttons).forEach(b => b.disabled = true);
    fetch('view/' + node.id + '?ofs=' + preview.offset + '&lim=' + preview.limit).then(r => {
        if (!r.ok) throw new Error('The server returned ' + r.status + ' ' + r.statusText + '.');
        return r.json();
    }).then(json => {
        if (request != preview.request) return;
        renderPreview(json);
        if (page_changed) view_container.scrollTop = 0;
    }).catch(err => {
        if (request == preview.request) showPreviewMessage('Couldn\u2019t load the preview. ' + err.message, true);
    });
}

function goToPage(page) {
    if (!preview.node) return;
    var pages = preview.total !== null ? Math.max(1, Math.ceil(preview.total / preview.limit)) : Infinity;
    page = Math.min(Math.max(1, page), pages);
    var offset = (page - 1) * preview.limit;
    if (offset == preview.offset) { page_number.value = page; return; }
    loadPreview(preview.node, offset);
}

page_buttons.first.onclick = () => loadPreview(preview.node, 0);
page_buttons.prev.onclick = () => loadPreview(preview.node, preview.offset - preview.limit);
page_buttons.next.onclick = () => loadPreview(preview.node, preview.offset + preview.limit);
page_buttons.last.onclick = () => loadPreview(preview.node, lastPageOffset());

page_number.addEventListener('change', () => {
    var page = parseInt(page_number.value, 10);
    if (isNaN(page)) page_number.value = Math.floor(preview.offset / preview.limit) + 1;
    else goToPage(page);
});

page_size_select.addEventListener('change', () => {
    preview.limit = parseInt(page_size_select.value, 10);
    try { localStorage.setItem(PAGE_SIZE_KEY, String(preview.limit)); } catch (e) { /* ignore */ }
    if (!preview.node) return;
    // Stay on the page that holds the first row currently shown.
    loadPreview(preview.node, Math.floor(preview.offset / preview.limit) * preview.limit);
});

dag_edit.onSelectNode = function(node) {
    if (node == selected_node) return;
    if (config_edit) { config_edit.destroy(); config_edit = null; }
    config_subject.textContent = node.label || '';
    fetch('conf/' + node.id).then(response => {
            if (!response.ok) throw new Error('not okay');
            return response.json();
    }).then(json => {
            if (node != selected_node) return;
            config_edit = new SchemaEditor(config_container, json.schema, json.config);
            config_edit.onChange(function(doc) {
                    var opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) };
                    fetch('post/' + node.id, opts).then(r => {
                        if (!r.ok) throw new Error('not okay');
                        if (node == selected_node) loadPreview(node, preview.offset);
                    });
            });
    });
    selected_node = node;
    loadPreview(node, 0);
};

dag_edit.onAddEdge = function(edge) {
    fetch('edge/' + edge.fromNodeId + '/' + edge.toNodeId + '/add', { method: 'POST' }).then(r => { if (!r.ok) throw new Error('not okay'); });
}

dag_edit.onDeleteEdge = function(edge) {
    fetch('edge/' + edge.fromNodeId + '/' + edge.toNodeId + '/del', { method: 'POST' }).then(r => { if (!r.ok) throw new Error('not okay'); });
}
