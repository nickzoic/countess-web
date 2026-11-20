import argparse
import asyncio
import logging
import multiprocessing
import os
import secrets
import signal
import sys
import time
import webbrowser

from aiohttp import web
import duckdb

from countess.core.config import read_config
from countess.core.pipeline import PipelineNode
from countess.core.plugins import get_plugin_classes

graph = None
ddbc = duckdb.connect()

# Most rows a node is run with when previewing it.
PREVIEW_ROW_LIMIT = 100000

# How long to wait after the page closes before shutting down.
# Reloading the page within this time keeps the server running.
QUIT_GRACE_SECONDS = 3

plugin_classes = {}  # plugin id -> plugin class, filled in by main()

quit_event = None   # set when the server should shut down
quit_timer = None   # pending shutdown after the page closed

def plugin_id(plugin_class):
    """A stable id for a plugin class: its module and class name,
    which is also how config files refer to it."""
    return plugin_class.__module__ + ":" + plugin_class.__name__

def node_ports(node):
    """The ports the DAG editor should draw on a node.  A node with no
    plugin yet gets both, like a new node in the editor."""
    return {
        "inputs": [{"id": "in", "label": ""}] if not node.plugin or node.plugin.num_inputs else [],
        "outputs": [{"id": "out", "label": ""}] if not node.plugin or node.plugin.num_outputs else [],
    }

def find_node(uuid):
    """The node with this uuid, or None"""
    return next((n for n in graph.traverse_nodes() if n.uuid == uuid), None)

async def root_handler(request):
    """just returns the index page"""
    return web.FileResponse("./static/index.html")

async def tree_handler(request):
    """returns the whole DAG in a format ready for
    use by the dag editor component"""
    return web.json_response({
        "version": 3,
        "nodes": [
            {
                "id": n.uuid,
                "label": n.name,
                "x": n.position[0],
                "y": n.position[1],
                **node_ports(n),
                "plugin": plugin_id(type(n.plugin)) if n.plugin else None,
            } for n in graph.traverse_nodes()
        ], "edges": [
            {
                "id": n1.uuid + "/" + n2.uuid,
                "fromNodeId": n1.uuid,
                "fromPortId": "out",
                "toNodeId": n2.uuid,
                "toPortId": "in"
            } for n1 in graph.traverse_nodes()
              for n2 in n1.child_nodes
        ]
    })

async def name_handler(request):
    """Set the name of the node.  Names must be unique (config files use
    them as section names), so a number may be added to the name: the
    name the node ends up with is returned."""
    node = find_node(request.match_info['uuid'])
    if node is None:
        raise web.HTTPNotFound(text="no such node")
    name = request.query.get('name', '').strip()
    if not name:
        raise web.HTTPBadRequest(text="a node needs a name")
    node.name = name
    graph.reset_node_name(node)
    return web.json_response({"name": node.name})

async def delete_handler(request):
    """Remove a node from the graph, with its edges"""
    node = find_node(request.match_info['uuid'])
    if node is None:
        raise web.HTTPNotFound(text="no such node")
    graph.del_node(node)
    return web.json_response("ok")

async def move_handler(request):
    """Move the position of the node"""
    node = graph.find_node_by_uuid(request.match_info['uuid'])
    node.position[0] = float(request.query['x']) * 1000
    node.position[1] = float(request.query['y']) * 1000
    return web.json_response("ok")

async def edge_handler(request):
    """Add or remove an edge between nodes"""
    node1 = find_node(request.match_info['uuid1'])
    node2 = find_node(request.match_info['uuid2'])
    if node1 is None or node2 is None:
        # e.g. removing the edges of a node which has just been deleted
        raise web.HTTPNotFound(text="no such node")
    op = request.match_info['op']
    if op == 'add':
        node2.add_parent(node1)
    elif op == 'del':
        node2.del_parent(node1)
    return web.json_response("ok")

async def plugins_handler(request):
    """Lists the plugins a node can use, sorted by name"""
    return web.json_response([
        {
            "id": pid,
            "name": pc.name,
            "description": pc.description,
            "num_inputs": pc.num_inputs,
            "num_outputs": pc.num_outputs,
            "link": pc.link,
        } for pid, pc in sorted(plugin_classes.items(), key=lambda x: x[1].name.lower())
    ])

async def new_node_handler(request):
    """Gives a node its plugin.  Nodes made in the DAG editor don't exist
    on the server until their plugin is chosen, so this creates the node,
    with the editor's id as its uuid, and connects it to the parents and
    children it already has in the editor.  A node from the config file
    which has no plugin is given one instead.

    Takes JSON {id, plugin, x, y, parents: [uuid], children: [uuid]}
    and returns {node, edges} in the same form as the tree handler, with
    only the edges which were actually made."""
    data = await request.json()
    plugin_class = plugin_classes.get(data.get("plugin"))
    if not plugin_class:
        raise web.HTTPBadRequest(text="unknown plugin")

    node = find_node(data.get("id"))
    if node is None:
        node = PipelineNode(
            name=plugin_class.name,
            uuid=data["id"],
            position=(float(data.get("x", 0.5)), float(data.get("y", 0.5))),
        )
        node.plugin = plugin_class()
        graph.add_node(node)    # also makes the name unique
    elif node.plugin:
        raise web.HTTPConflict(text="node already has a plugin")
    else:
        node.plugin = plugin_class()

    for uuid in data.get("parents", []):
        parent = find_node(uuid)
        if parent and parent is not node:
            node.add_parent(parent)
    for uuid in data.get("children", []):
        child = find_node(uuid)
        if child and child is not node:
            child.add_parent(node)

    # a node from the config may have had edges this plugin can't have
    if not plugin_class.num_inputs:
        for parent in list(node.parent_nodes):
            node.del_parent(parent)
    if not plugin_class.num_outputs:
        for child in list(node.child_nodes):
            child.del_parent(node)
    node.mark_dirty()

    return web.json_response({
        "node": {
            "id": node.uuid,
            "label": node.name,
            "x": node.position[0],
            "y": node.position[1],
            **node_ports(node),
            "plugin": plugin_id(plugin_class),
        },
        "edges": [
            {"id": p.uuid + "/" + c.uuid, "fromNodeId": p.uuid, "fromPortId": "out", "toNodeId": c.uuid, "toPortId": "in"}
            for p, c in [(p, node) for p in node.parent_nodes] + [(node, c) for c in node.child_nodes]
        ],
    })

async def conf_handler(request):
    """Retrieve configuration of a node"""
    node = graph.find_node_by_uuid(request.match_info['uuid'])

    return web.json_response({
        "id": node.uuid,
        "label": node.name,
        "plugin": node.plugin.name,
        "schema": node.plugin.get_json_schema(),
        "config": node.plugin.get_json_data(),
    })

async def post_handler(request):
    """Update configuration of a node."""
    node = graph.find_node_by_uuid(request.match_info['uuid'])
    data = await request.json()
    node.plugin.set_json_data(data)
    return web.json_response(node.plugin.get_json_data())

async def file_handler(request):
    """Gets a list of possible values for filenames"""
    path = request.match_info['path']
    return web.json_response(os.listdir(path))


async def view_handler(request):
    """Returns a preview of a table using 'ofs' and 'lim'
    parameters to restrict the number of rows"""
    node = graph.find_node_by_uuid(request.match_info['uuid'])
    offset = max(0, int(request.query.get('ofs', 0)))
    limit = min(max(1, int(request.query.get('lim', 1000))), 10000)

    def _view_query():
        cursor = ddbc.cursor()
        node.run(cursor, row_limit=PREVIEW_ROW_LIMIT)
        table = cursor.table(node.table_name)
        total = table.aggregate("count(*)").fetchall()[0][0]

        return {
            "columns": list(zip(table.columns, [ str(t) for t in table.dtypes ])),
            "data": table.limit(limit, offset=offset).fetchall(),
            "offset": offset,
            "limit": limit,
            "total": total,
            # the node was run with a row limit, so there may be more rows than this
            "truncated": total >= PREVIEW_ROW_LIMIT,
        }

    data = await asyncio.to_thread(_view_query)

    return web.json_response(data)

async def quit_handler(request):
    """The page calls this when its window or tab is closing.  The server
    shuts down after a short grace period, which any further request
    cancels, so that reloading the page doesn't stop the server."""
    global quit_timer
    if quit_timer:
        quit_timer.cancel()

    async def _quit_later():
        await asyncio.sleep(QUIT_GRACE_SECONDS)
        logging.info("page closed, shutting down")
        quit_event.set()

    quit_timer = asyncio.create_task(_quit_later())
    return web.json_response({'okay': 'bye'})

@web.middleware
async def keepalive_middleware(request, handler):
    """Any request other than a quit means a page is still open,
    so cancel a pending shutdown."""
    global quit_timer
    if quit_timer and request.match_info.handler is not quit_handler:
        quit_timer.cancel()
        quit_timer = None
    return await handler(request)

async def webview_task(url):
    """If using a webview this loads it in a separate
    process.  If interrupted it kills the webview too."""

    def _webview():
        import webview

        def _sigint(signum, frame):
            for window in webview.windows:
                window.destroy()
            sys.exit(0)
        signal.signal(signal.SIGINT, _sigint)

        webview.create_window("CountESS Web", url)
        webview.start()

    process = multiprocessing.Process(target=_webview)
    process.start()
    try:
        while process.is_alive():
            await asyncio.sleep(1)
    finally:
        print("terminating")
        process.terminate()
    process.join()

async def main(args):
    """Load and prepare the graph, then serve it until the page closes"""
    global quit_event
    quit_event = asyncio.Event()

    for plugin_class in get_plugin_classes():
        plugin_classes[plugin_id(plugin_class)] = plugin_class

    for n in graph.traverse_nodes():
        n.load_config()
        n.run(ddbc, row_limit=10000)

    key = secrets.token_hex(8)
    app = web.Application(middlewares=[keepalive_middleware])
    app.add_routes([
        web.get('/' + key + '/', root_handler),
        web.get('/' + key + '/tree', tree_handler),
        web.get('/' + key + '/plugins', plugins_handler),
        web.post('/' + key + '/node', new_node_handler),
        web.post('/' + key + '/name/{uuid}', name_handler),
        web.post('/' + key + '/delete/{uuid}', delete_handler),
        web.get('/' + key + '/conf/{uuid}', conf_handler),
        web.post('/' + key + "/post/{uuid}", post_handler),
        web.post('/' + key + '/move/{uuid1}', move_handler),
        web.post('/' + key + '/edge/{uuid1}/{uuid2}/{op}', edge_handler),
        web.get('/' + key + '/file/{path}', file_handler),
        web.get('/' + key + '/view/{uuid}', view_handler),
        web.post('/' + key + '/quit', quit_handler),
        web.static('/' + key + "/", "./static/", follow_symlinks=True),
    ])

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, port=0)
    await site.start()
    url = f'http://localhost:{site.port}/{key}/'

    try:
        if args.webview:
            # Stop when the webview window closes or the page asks to quit.
            viewer = asyncio.create_task(webview_task(url))
            quitter = asyncio.create_task(quit_event.wait())
            await asyncio.wait([viewer, quitter], return_when=asyncio.FIRST_COMPLETED)
            for task in (viewer, quitter):
                task.cancel()
            await asyncio.gather(viewer, quitter, return_exceptions=True)
        else:
            if args.browser:
                webbrowser.open(url)
            else:
                print(url)
            await quit_event.wait()
    finally:
        await runner.cleanup()


if __name__ == '__main__':
    root_logger = logging.getLogger()
    root_logger.addHandler(logging.StreamHandler())
    root_logger.setLevel(logging.DEBUG)

    parser = argparse.ArgumentParser(
        prog="server.py",
        description="CountESS Web",
    )
    parser.add_argument("filename")
    parser.add_argument("--browser", action="store_true")
    parser.add_argument("--webview", action="store_true")
    args = parser.parse_args()

    graph = read_config([args.filename])


    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        pass
