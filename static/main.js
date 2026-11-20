var dag_edit = new DAGEditor(document.getElementById('dag-container'));
var config_container = document.getElementById('config-container');
var view_container = document.getElementById('view-container');

fetch('tree').then(response => {
    if (!response.ok) throw new Error('not okay');
    return response.text();
}).then(text => {
    dag_edit.importJSON(text);
});

var config_edit;
var selected_node;

dag_edit.onSelectNode = function(node) {
    if (node == selected_node) return;
    console.log("hello " + node.id);
    if (config_edit) config_edit.destroy();
    fetch('conf/' + node.id).then(response => {
            if (!response.ok) throw new Error('not okay');
            return response.json();
    }).then(json => {
            config_edit = new SchemaEditor(config_container, json.schema, json.config);
            config_edit.onChange(function(doc) {
                    console.log("whoa! " + doc);
                    var opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) };
                    fetch('post/' + node.id, opts).then(r => {
                        if (!r.ok) throw new Error('not okay');
                        fetch('view/' + node.id).then( r => {
                            if (!r.ok) throw new Error('not okay');
                            return r.json();
                        }).then(json => {
                            view_container.innerText = JSON.stringify(json);
                        });
                    });
            });
    });
    selected_node = node;
};

dag_edit.onAddEdge = function(edge) {
    fetch('edge/' + edge.fromNodeId + '/' + edge.toNodeId + '/add', { method: 'POST' }).then(r => { if (!r.ok) throw new Error('not okay'); });
}

dag_edit.onDeleteEdge = function(edge) {
    fetch('edge/' + edge.fromNodeId + '/' + edge.toNodeId + '/del', { method: 'POST' }).then(r => { if (!r.ok) throw new Error('not okay'); });
}

