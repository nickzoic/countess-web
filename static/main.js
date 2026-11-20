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
var preview_request = 0;

// DuckDB types that hold numbers, so their columns can be right-aligned.
var NUMERIC_TYPE = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL)/i;

function showPreviewMessage(text, is_error) {
    var p = document.createElement('p');
    p.className = 'preview-message' + (is_error ? ' is-error' : '');
    p.textContent = text;
    view_container.replaceChildren(p);
    view_status.textContent = '';
}

function renderPreview(json) {
    var columns = json.columns || [];
    var rows = json.data || [];
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
    view_container.replaceChildren(table);
    view_status.textContent = rows.length + (rows.length == 1 ? ' row' : ' rows') +
        ', ' + columns.length + (columns.length == 1 ? ' column' : ' columns');
}

function loadPreview(node) {
    var request = ++preview_request;
    view_status.textContent = 'Loading\u2026';
    fetch('view/' + node.id).then(r => {
        if (!r.ok) throw new Error('The server returned ' + r.status + ' ' + r.statusText + '.');
        return r.json();
    }).then(json => {
        if (request == preview_request) renderPreview(json);
    }).catch(err => {
        if (request == preview_request) showPreviewMessage('Couldn\u2019t load the preview. ' + err.message, true);
    });
}

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
                        loadPreview(node);
                    });
            });
    });
    selected_node = node;
    loadPreview(node);
};

dag_edit.onAddEdge = function(edge) {
    fetch('edge/' + edge.fromNodeId + '/' + edge.toNodeId + '/add', { method: 'POST' }).then(r => { if (!r.ok) throw new Error('not okay'); });
}

dag_edit.onDeleteEdge = function(edge) {
    fetch('edge/' + edge.fromNodeId + '/' + edge.toNodeId + '/del', { method: 'POST' }).then(r => { if (!r.ok) throw new Error('not okay'); });
}
