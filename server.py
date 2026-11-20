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

graph = None
ddbc = duckdb.connect()

# Most rows a node is run with when previewing it.
PREVIEW_ROW_LIMIT = 100000

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
                "inputs": [{"id": "in", "label": ""}] if n.plugin.num_inputs else [],
                "outputs": [{"id": "out", "label": ""}] if n.plugin.num_outputs else [],
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
    """Set the name of the node"""
    node = graph.find_node_by_uuid(request.match_info['uuid'])
    node.name = request.query['name']
    return web.json_response("ok")

async def move_handler(request):
    """Move the position of the node"""
    node = graph.find_node_by_uuid(request.match_info['uuid'])
    node.position[0] = float(request.query['x']) * 1000
    node.position[1] = float(request.query['y']) * 1000
    return web.json_response("ok")

async def edge_handler(request):
    """Add or remove an edge between nodes"""
    node1 = graph.find_node_by_uuid(request.match_info['uuid1'])
    node2 = graph.find_node_by_uuid(request.match_info['uuid2'])
    op = request.match_info['op']
    if op == 'add':
        node2.add_parent(node1)
    elif op == 'del':
        node2.del_parent(node1)
    return web.json_response("ok")

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
    """The browser calls this when exiting to make the
    server go away.  When this returns, it should close
    the window as well."""

    async def _intr_task():
        await asyncio.sleep(1)
        signal.raise_signal(signal.SIGINT)

    await asyncio.create_task(_intr_task)
    return web.json_response({'okay': 'bye'})

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
    """Load and prepare the graph"""

    for n in graph.traverse_nodes():
        n.load_config()
        n.run(ddbc, row_limit=10000)

    key = secrets.token_hex(8)
    app = web.Application()
    app.add_routes([
        web.get('/' + key + '/', root_handler),
        web.get('/' + key + '/tree', tree_handler),
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

    if args.webview:
        await asyncio.create_task(webview_task(url))
    elif args.browser:
        webbrowser.open(url)
    else:
        print(url)

    # wait forever.
    while True:
        await asyncio.sleep(1)
        

    
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


    asyncio.run(main(args))
