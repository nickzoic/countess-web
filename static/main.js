var dag_edit = new DAGEditor(document.getElementById('dag-container'));
var config_container = document.getElementById('config-container');
var config_subject = document.getElementById('config-subject');
var view_container = document.getElementById('view-container');
var view_status = document.getElementById('view-status');

// Nodes the server knows about.  A node made in the editor isn't one of
// these until its plugin is chosen.
var server_nodes = new Set();
// Server nodes which have no plugin yet.
var needs_plugin = new Set();
// The name the server has for each node, so renames can be spotted.
var server_names = new Map();
/* ── Unsaved changes ────────────────────────────────────────────────── */

// Every request that changes the graph goes through changeFetch, which
// counts it.  The config is unsaved while the count is past the count at
// the last save.  Requests still on their way are kept so that a save can
// wait for them.
var changes = 0;
var saved_changes = 0;
var pending_changes = new Set();
var file_name = '';

function changeFetch(url, options) {
    changes++;
    updateSaveState();
    var request = fetch(url, options);
    pending_changes.add(request);
    var forget = () => pending_changes.delete(request);
    request.then(forget, forget);
    return request;
}

function isUnsaved() { return changes > saved_changes; }

var save_button = document.getElementById('save-button');
var save_label = document.getElementById('save-label');
var save_status = document.getElementById('save-status');
var save_status_timer = 0;

function updateSaveState() {
    var unsaved = isUnsaved();
    save_button.classList.toggle('is-dirty', unsaved);
    save_label.textContent = unsaved ? 'Save' : 'Saved';
    document.title = (unsaved ? '\u2022 ' : '') + (file_name ? file_name + ' \u2014 ' : '') + 'CountESS';
}

function showSaveStatus(text, is_error) {
    clearTimeout(save_status_timer);
    save_status.textContent = text;
    save_status.classList.toggle('is-error', !!is_error);
    if (!is_error) save_status_timer = setTimeout(() => { save_status.textContent = ''; }, 3000);
}

// The edges the server has, as 'from>to' node id pairs.
var server_edges = new Set();
// The position the server has for each node, as the editor's normalised [x, y].
var server_positions = new Map();
function edgeKey(from_id, to_id) { return from_id + '>' + to_id; }

function isPending(node_id) {
    return !server_nodes.has(node_id) || needs_plugin.has(node_id);
}

fetch('tree').then(response => {
    if (!response.ok) throw new Error('not okay');
    return response.text();
}).then(text => {
    JSON.parse(text).nodes.forEach(n => {
        server_nodes.add(n.id);
        server_names.set(n.id, n.label);
        if (!n.plugin) needs_plugin.add(n.id);
    });
    var tree = JSON.parse(text);
    tree.edges.forEach(e => server_edges.add(edgeKey(e.fromNodeId, e.toNodeId)));
    tree.nodes.forEach(n => server_positions.set(n.id, [n.x, n.y]));
    if (tree.filename) {
        document.getElementById('file-name').textContent = tree.filename;
        file_name = tree.filename;
        updateSaveState();
    }
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
var preview = { node: null, offset: 0, limit: 100, total: null, truncated: false, rows: 0, request: 0,
                data: { columns: [], rows: [] } };

/* Selecting cells copies them as CSV; say so briefly in the pane header. */
var copy_status = document.getElementById('copy-status');
var copy_status_timer = 0;
var cell_selection = attachCellSelection(view_container, {
    getData: () => preview.data,
    onCopied: info => {
        var what = info.rows == 1 && info.columns == 1 ? '1 cell'
            : plural(info.rows, 'row') + ' \u00d7 ' + plural(info.columns, 'column');
        copy_status.textContent = info.ok ? 'Copied ' + what + ' as CSV' : 'Couldn\u2019t copy to the clipboard';
        copy_status.classList.add('is-shown');
        clearTimeout(copy_status_timer);
        copy_status_timer = setTimeout(() => copy_status.classList.remove('is-shown'), 2500);
    },
});

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
    preview.data = { columns: [], rows: [] };
    cell_selection.reset();
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
    if (json.error) {
        showPreviewMessage('This node couldn\u2019t be run.\n\n' + json.error, true);
        return;
    }
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
    preview.data = { columns: columns, rows: rows };
    cell_selection.reset();
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

/* ── Choosing a plugin for a new node ──────────────────────────────── */

var plugin_list = fetch('plugins').then(r => {
    if (!r.ok) throw new Error('The server returned ' + r.status + ' ' + r.statusText + '.');
    return r.json();
});
plugin_list.catch(() => {});   // reported when the list is shown
var plugin_filter = '';
var choosing = false;   // a plugin choice is on its way to the server

// The node's edges in the editor, as the ids of its parents and children.
function editorNeighbours(node_id) {
    var edges = dag_edit.getGraph().edges;
    return {
        parents: edges.filter(e => e.toNodeId == node_id).map(e => e.fromNodeId),
        children: edges.filter(e => e.fromNodeId == node_id).map(e => e.toNodeId),
    };
}

function showPluginChooser(node) {
    var focused_filter = document.activeElement && document.activeElement.classList.contains('plugin-filter');
    config_subject.textContent = 'Choose a plugin for ' + (node.label || 'this node');

    plugin_list.then(plugins => {
        if (node != selected_node || !isPending(node.id)) return;
        var neighbours = editorNeighbours(node.id);
        var has_parents = neighbours.parents.length > 0;
        var has_children = neighbours.children.length > 0;

        // As in the CountESS GUI: a node with no inputs loads data, a node
        // with inputs processes it, and a node with outputs must have them.
        var usable = plugins.filter(p =>
            (has_parents ? p.num_inputs > 0 : p.num_inputs == 0) &&
            !(has_children && p.num_outputs == 0));

        var chooser = document.createElement('div');
        chooser.className = 'plugin-chooser';

        var hint = document.createElement('p');
        hint.className = 'plugin-hint';
        hint.textContent = has_parents
            ? 'These plugins can process this node\u2019s input.'
            : 'This node has no input, so these plugins load data. To process data instead, connect an input to it first.';
        chooser.appendChild(hint);

        var filter = document.createElement('input');
        filter.type = 'search';
        filter.className = 'plugin-filter';
        filter.placeholder = 'Filter plugins';
        filter.setAttribute('aria-label', 'Filter plugins');
        filter.value = plugin_filter;
        chooser.appendChild(filter);

        var list = document.createElement('ul');
        list.className = 'plugin-list';
        chooser.appendChild(list);

        var empty = document.createElement('p');
        empty.className = 'plugin-hint';
        chooser.appendChild(empty);

        var status = document.createElement('p');
        status.className = 'plugin-status';
        status.setAttribute('role', 'status');
        chooser.appendChild(status);

        usable.forEach(p => {
            var li = document.createElement('li');
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'plugin-button';
            button.disabled = choosing;
            var name = document.createElement('span');
            name.className = 'plugin-name';
            name.textContent = p.name;
            button.appendChild(name);
            if (p.description) {
                var desc = document.createElement('span');
                desc.className = 'plugin-desc';
                desc.textContent = p.description;
                button.appendChild(desc);
            }
            button.onclick = () => choosePlugin(node, p, status);
            li.appendChild(button);
            li.dataset.search = (p.name + ' ' + (p.description || '')).toLowerCase();
            list.appendChild(li);
        });

        function applyFilter() {
            plugin_filter = filter.value;
            var words = plugin_filter.toLowerCase().split(/\s+/).filter(Boolean);
            var shown = 0;
            Array.from(list.children).forEach(li => {
                li.hidden = !words.every(w => li.dataset.search.includes(w));
                if (!li.hidden) shown++;
            });
            empty.hidden = shown > 0;
            empty.textContent = usable.length == 0
                ? 'No plugins fit this node\u2019s connections.'
                : 'No plugins match \u201c' + plugin_filter.trim() + '\u201d.';
        }
        filter.addEventListener('input', applyFilter);
        applyFilter();

        config_container.replaceChildren(chooser);
        if (focused_filter) filter.focus();
    }).catch(err => {
        if (node != selected_node) return;
        var p = document.createElement('p');
        p.className = 'preview-message is-error';
        p.textContent = 'Couldn\u2019t load the list of plugins. ' + err.message;
        config_container.replaceChildren(p);
    });
}

// Editor changes made to match the server, which shouldn't be sent back to it.
var applying_server_changes = false;

function choosePlugin(node, plugin, status) {
    if (choosing) return;
    choosing = true;
    config_container.querySelectorAll('.plugin-button').forEach(b => b.disabled = true);
    status.classList.remove('is-error');
    status.textContent = 'Adding ' + plugin.name + '\u2026';

    // Send only the edges whose other end the server knows about; edges to
    // other new nodes are sent when those nodes get their plugins.
    var neighbours = editorNeighbours(node.id);
    var position = (dag_edit.toJSON().nodes || []).find(n => n.id == node.id) || {};
    var body = {
        id: node.id,
        plugin: plugin.id,
        x: position.x,
        y: position.y,
        parents: neighbours.parents.filter(id => server_nodes.has(id)),
        children: neighbours.children.filter(id => server_nodes.has(id)),
    };
    changeFetch('node', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => {
        if (!r.ok) return r.text().then(t => { throw new Error(t || r.status + ' ' + r.statusText); });
        return r.json();
    }).then(json => {
        choosing = false;
        server_nodes.add(node.id);
        server_names.set(node.id, json.node.label);
        server_positions.set(node.id, [json.node.x, json.node.y]);
        json.edges.forEach(e => server_edges.add(edgeKey(e.fromNodeId, e.toNodeId)));
        needs_plugin.delete(node.id);
        applyServerNode(json.node, json.edges);
        if (node == selected_node) showNodeConfig(node);
    }).catch(err => {
        choosing = false;
        if (node != selected_node) return;
        config_container.querySelectorAll('.plugin-button').forEach(b => b.disabled = false);
        status.classList.add('is-error');
        status.textContent = 'Couldn\u2019t add ' + plugin.name + '. ' + err.message;
    });
}

// Make the editor's node match the server's: its name (which the server
// may have made unique), its ports, and the edges the server accepted.
function applyServerNode(server_node, server_edges) {
    applying_server_changes = true;
    try {
        var id = server_node.id;
        dag_edit.setNodeLabel(id, server_node.label);   // the server may have changed it
        var node = dag_edit.getGraph().nodes.find(n => n.id == id);
        if (!server_node.inputs.length) node.inputs.slice().forEach(p => dag_edit.removePort(id, 'input', p.id));
        if (!server_node.outputs.length) node.outputs.slice().forEach(p => dag_edit.removePort(id, 'output', p.id));

        var accepted = new Set(server_edges.map(e => e.fromNodeId + '/' + e.toNodeId));
        dag_edit.getGraph().edges.forEach(e => {
            if (e.fromNodeId != id && e.toNodeId != id) return;
            var other = e.fromNodeId == id ? e.toNodeId : e.fromNodeId;
            if (server_nodes.has(other) && !accepted.has(e.fromNodeId + '/' + e.toNodeId)) dag_edit.deleteEdge(e.id);
        });
    } finally {
        applying_server_changes = false;
    }
}

/* ── Renaming and deleting nodes ───────────────────────────────────── */

var name_row = document.getElementById('node-name-row');
var name_input = document.getElementById('node-name');
var name_error = document.getElementById('node-name-error');

function setNameError(text) {
    name_error.textContent = text;
    if (text) name_input.setAttribute('aria-invalid', 'true');
    else name_input.removeAttribute('aria-invalid');
}

function showNameField(node) {
    name_input.value = node.label || '';
    setNameError('');
    name_row.hidden = false;
}

// Commit the name on Enter or leaving the field; Escape puts it back.
name_input.addEventListener('change', () => {
    if (!selected_node) return;
    var name = name_input.value.trim();
    if (!name) {
        setNameError('A node needs a name.');
        return;
    }
    setNameError('');
    dag_edit.setNodeLabel(selected_node.id, name);   // calls onUpdateNode
});
name_input.addEventListener('keydown', e => {
    if (e.key == 'Enter') name_input.blur();
    else if (e.key == 'Escape' && selected_node) {
        e.preventDefault();   // don't also restore an expanded pane
        name_input.value = selected_node.label;
        setNameError('');
    }
});

function setLabelFromServer(node_id, label) {
    applying_server_changes = true;
    try { dag_edit.setNodeLabel(node_id, label); }
    finally { applying_server_changes = false; }
    if (selected_node && selected_node.id == node_id) {
        if (document.activeElement != name_input) name_input.value = label;
        if (!isPending(node_id)) config_subject.textContent = label;
    }
}

// Called for label and port changes; only a changed label matters here.
dag_edit.onUpdateNode = function(node) {
    if (applying_server_changes) return;
    if (!server_nodes.has(node.id) || node.label == server_names.get(node.id)) {
        if (selected_node && selected_node.id == node.id && isPending(node.id)) showPluginChooser(node);
        return;
    }
    renameOnServer(node);
};

function renameOnServer(node) {
    var old_name = server_names.get(node.id);
    server_names.set(node.id, node.label);
    changeFetch('name/' + node.id + '?name=' + encodeURIComponent(node.label), { method: 'POST' }).then(r => {
        if (!r.ok) return r.text().then(t => { throw new Error(t || r.status + ' ' + r.statusText); });
        return r.json();
    }).then(json => {
        // the server may have added a number to keep names unique
        server_names.set(node.id, json.name);
        setLabelFromServer(node.id, json.name);
    }).catch(err => {
        server_names.set(node.id, old_name);
        setLabelFromServer(node.id, old_name);
        if (selected_node && selected_node.id == node.id) setNameError('Couldn\u2019t rename the node. ' + err.message);
    });
}

// Empty the settings and preview panes, back to their prompts.
function clearSelection() {
    selected_node = null;
    if (config_edit) { config_edit.destroy(); config_edit = null; }
    config_container.replaceChildren();
    config_subject.textContent = '';
    name_row.hidden = true;
    preview.node = null;
    preview.request++;
    preview.data = { columns: [], rows: [] };
    cell_selection.reset();
    view_container.replaceChildren();
    view_container.classList.remove('is-loading');
    view_status.textContent = '';
    pager.hidden = true;
}

// The editor reports the node's edges as deleted first (and, for a node
// with one input and one output, then adds edges bridging the gap).
dag_edit.onDeleteNode = function(node) {
    if (selected_node && selected_node.id == node.id) clearSelection();
    if (server_nodes.has(node.id)) deleteOnServer(node.id);
};

// What the server returned for each node it deleted (its plugin, config,
// name and notes), so that undoing the deletion can make it again.
var deleted_nodes = new Map();
// Nodes being made again after an undo.
var restoring = new Set();

function deleteOnServer(node_id) {
    server_nodes.delete(node_id);
    server_positions.delete(node_id);
    needs_plugin.delete(node_id);
    server_names.delete(node_id);
    server_edges.forEach(key => {
        var ends = key.split('>');
        if (ends[0] == node_id || ends[1] == node_id) server_edges.delete(key);
    });
    changeFetch('delete/' + node_id, { method: 'POST' }).then(r => {
        if (!r.ok) throw new Error('not okay');
        return r.json();
    }).then(snapshot => {
        deleted_nodes.set(node_id, snapshot);
        // undone before the server had answered
        if (editorNode(node_id)) restoreOnServer(node_id);
    });
}

function editorNode(node_id) {
    return dag_edit.getGraph().nodes.find(n => n.id == node_id);
}

// Make a deleted node again, with the config it had, and the edges it now
// has in the editor to nodes the server knows.
function restoreOnServer(node_id) {
    var snapshot = deleted_nodes.get(node_id);
    if (!snapshot || !snapshot.plugin || restoring.has(node_id) || server_nodes.has(node_id)) return;
    restoring.add(node_id);
    var neighbours = editorNeighbours(node_id);
    var position = (dag_edit.toJSON().nodes || []).find(n => n.id == node_id) || {};
    var body = {
        id: node_id,
        plugin: snapshot.plugin,
        name: (editorNode(node_id) || {}).label || snapshot.name,
        config: snapshot.config,
        notes: snapshot.notes,
        x: position.x,
        y: position.y,
        parents: neighbours.parents.filter(id => server_nodes.has(id)),
        children: neighbours.children.filter(id => server_nodes.has(id)),
    };
    changeFetch('node', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => {
        if (!r.ok) throw new Error('not okay');
        return r.json();
    }).then(json => {
        restoring.delete(node_id);
        deleted_nodes.delete(node_id);
        if (!editorNode(node_id)) {
            // deleted again (redo) while this was on its way
            deleteOnServer(node_id);
            return;
        }
        server_nodes.add(node_id);
        server_names.set(node_id, json.node.label);
        server_positions.set(node_id, [json.node.x, json.node.y]);
        json.edges.forEach(e => server_edges.add(edgeKey(e.fromNodeId, e.toNodeId)));
        applyServerNode(json.node, json.edges);
        if (selected_node && selected_node.id == node_id) showNodeConfig(selected_node);
    }).catch(() => {
        // it's left as a new node, which can be given a plugin again
        restoring.delete(node_id);
    });
}

/* ── Undo and redo ──────────────────────────────────────────────────── */

// The editor's undo and redo (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y) replace its
// whole graph without calling any hooks, so afterwards compare the graph
// with what the server has and send the differences.
['undo', 'redo'].forEach(method => {
    var original = dag_edit[method].bind(dag_edit);
    dag_edit[method] = function() {
        original();
        syncAfterRestore();
    };
});

function syncAfterRestore() {
    var graph = dag_edit.getGraph();
    var in_editor = new Set(graph.nodes.map(n => n.id));

    // the editor deselects everything when it restores
    clearSelection();

    // nodes the undo removed, then nodes it brought back
    Array.from(server_nodes).forEach(id => { if (!in_editor.has(id)) deleteOnServer(id); });
    graph.nodes.forEach(n => {
        if (!server_nodes.has(n.id) && deleted_nodes.has(n.id)) restoreOnServer(n.id);
    });

    // names
    graph.nodes.forEach(n => {
        if (server_nodes.has(n.id) && n.label != server_names.get(n.id)) renameOnServer(n);
    });

    // edges between nodes the server has (restored nodes bring their own)
    var wanted = new Set(graph.edges
        .filter(e => server_nodes.has(e.fromNodeId) && server_nodes.has(e.toNodeId))
        .map(e => edgeKey(e.fromNodeId, e.toNodeId)));
    wanted.forEach(key => { if (!server_edges.has(key)) sendEdge(key, 'add'); });
    Array.from(server_edges).forEach(key => { if (!wanted.has(key)) sendEdge(key, 'del'); });

    sendPositions();
}

function sendEdge(key, op) {
    var ends = key.split('>');
    if (op == 'add') server_edges.add(key); else server_edges.delete(key);
    changeFetch('edge/' + ends[0] + '/' + ends[1] + '/' + op, { method: 'POST' }).then(r => { if (!r.ok) throw new Error('not okay'); });
}

/* ── Selecting, configuring and connecting nodes ───────────────────── */

function showNodeConfig(node) {
    if (config_edit) { config_edit.destroy(); config_edit = null; }
    config_container.replaceChildren();
    config_subject.textContent = node.label || '';
    showNameField(node);
    fetch('conf/' + node.id).then(response => {
            if (!response.ok) throw new Error('not okay');
            return response.json();
    }).then(json => {
            if (node != selected_node) return;
            config_edit = new SchemaEditor(config_container, json.schema, json.config);
            config_edit.onChange(function(doc) {
                    var opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) };
                    changeFetch('post/' + node.id, opts).then(r => {
                        if (!r.ok) throw new Error('not okay');
                        if (node == selected_node) loadPreview(node, preview.offset);
                    });
            });
    });
    loadPreview(node, 0);
}

dag_edit.onSelectNode = function(node) {
    if (node == selected_node) return;
    selected_node = node;
    if (isPending(node.id)) {
        if (config_edit) { config_edit.destroy(); config_edit = null; }
        name_row.hidden = true;
        plugin_filter = '';
        showPluginChooser(node);
        preview.node = null;
        preview.request++;
        showPreviewMessage('Choose a plugin to preview this node\u2019s output.');
    } else {
        showNodeConfig(node);
    }
};

// A node made in the editor needs a plugin before anything else, so on a
// narrow screen show the settings pane, where the plugins are listed.
dag_edit.onAddNode = function(node) {
    if (isPending(node.id) && window.countessLayout) window.countessLayout.show('config');
};

// Re-list the plugins when the selected new node's connections change.
function edgeChanged(edge) {
    if (selected_node && isPending(selected_node.id) &&
        (edge.fromNodeId == selected_node.id || edge.toNodeId == selected_node.id)) {
        showPluginChooser(selected_node);
    }
}

dag_edit.onAddEdge = function(edge) {
    if (applying_server_changes) return;
    if (server_nodes.has(edge.fromNodeId) && server_nodes.has(edge.toNodeId)) {
        sendEdge(edgeKey(edge.fromNodeId, edge.toNodeId), 'add');
    }
    edgeChanged(edge);
}

dag_edit.onDeleteEdge = function(edge) {
    if (applying_server_changes) return;
    if (server_nodes.has(edge.fromNodeId) && server_nodes.has(edge.toNodeId)) {
        sendEdge(edgeKey(edge.fromNodeId, edge.toNodeId), 'del');
    }
    edgeChanged(edge);
}

/* ── Positions and layout ───────────────────────────────────────────── */

// The editor's normalised positions for the nodes the server has.  These
// are relative to the whole graph, so moving one node can move them all.
function editorPositions() {
    var positions = {};
    (dag_edit.toJSON().nodes || []).forEach(n => {
        if (server_nodes.has(n.id)) positions[n.id] = [n.x, n.y];
    });
    return positions;
}

// Send the positions which have changed, if any.
function sendPositions() {
    var changed = {};
    var any = false;
    Object.entries(editorPositions()).forEach(([id, xy]) => {
        var old = server_positions.get(id);
        if (!old || Math.abs(old[0] - xy[0]) > 1e-4 || Math.abs(old[1] - xy[1]) > 1e-4) {
            changed[id] = xy;
            server_positions.set(id, xy);
            any = true;
        }
    });
    if (!any) return;
    changeFetch('positions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changed) })
        .then(r => { if (!r.ok) throw new Error('not okay'); });
}

dag_edit.onMoveNode = function() { sendPositions(); };

var layout_button = document.getElementById('layout-button');
var layout_pin = document.getElementById('layout-pin');

layout_button.addEventListener('click', () => dag_edit.autoLayout(true));
layout_pin.addEventListener('click', () => dag_edit.setLayoutPinned(!dag_edit.layoutPinned));

// Layout doesn't call onMoveNode, so send positions when a run finishes.
dag_edit.onLayoutChange = function(active) {
    layout_button.classList.toggle('is-busy', active);
    if (!active) sendPositions();
};
dag_edit.onPinChange = function(pinned) {
    layout_pin.setAttribute('aria-pressed', String(pinned));
};

/* ── Saving ─────────────────────────────────────────────────────────── */

var saving = false;

function save() {
    if (saving) return;
    saving = true;
    save_button.disabled = true;
    showSaveStatus('Saving\u2026');
    // let changes already sent arrive first, so they're in the file
    Promise.allSettled(Array.from(pending_changes)).then(() => {
        var saving_changes = changes;
        var positions = editorPositions();
        return fetch('save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ positions: positions }) }).then(r => {
            if (!r.ok) return r.text().then(t => { throw new Error(t || r.status + ' ' + r.statusText); });
            return r.json();
        }).then(json => {
            saved_changes = Math.max(saved_changes, saving_changes);
            Object.entries(positions).forEach(([id, xy]) => server_positions.set(id, xy));
            // writing the file can make names unique
            Object.entries(json.names || {}).forEach(([id, name]) => {
                if (server_names.get(id) != name) {
                    server_names.set(id, name);
                    setLabelFromServer(id, name);
                }
            });
            showSaveStatus('Saved ' + json.filename);
        });
    }).catch(err => {
        showSaveStatus('Couldn\u2019t save. ' + err.message, true);
    }).finally(() => {
        saving = false;
        save_button.disabled = false;
        updateSaveState();
    });
}

save_button.addEventListener('click', save);

document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() == 's') {
        e.preventDefault();
        save();
    }
});

// With unsaved changes, ask before the window or tab is closed or reloaded.
// Browsers show their own wording (such as "Leave site? Changes you made
// may not be saved.") and won't show a custom message or a Save button.
window.addEventListener('beforeunload', e => {
    if (!isUnsaved() && !saving) return;
    e.preventDefault();
    e.returnValue = '';
});

updateSaveState();

/* ── Shut the server down when the page closes ─────────────────────── */

// The server waits a few seconds before quitting, and any request in that
// time (such as reloading the page) cancels it, so a reload is safe.
window.addEventListener('pagehide', function() {
    navigator.sendBeacon('quit');
});

// Coming back from the browser's back/forward cache sends no request,
// so tell the server the page is still here.
window.addEventListener('pageshow', function(event) {
    if (event.persisted) fetch('./', { method: 'HEAD' });
});
