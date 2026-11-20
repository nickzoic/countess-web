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

async def root_handler(request):
    return web.FileResponse("./static/index.html")

async def tree_handler(request):
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
    node = graph.find_node_by_uuid(request.match_info['uuid'])
    node.name = request.query['name']

async def move_handler(request):
    node = graph.find_node_by_uuid(request.match_info['uuid'])
    node.position[0] = float(request.query['x']) / 100
    node.position[1] = float(request.query['y']) / 100

async def edge_handler(request):
    node1 = graph.find_node_by_uuid(request.match_info['uuid1'])
    node2 = graph.find_node_by_uuid(request.match_info['uuid2'])
    op = request.match_info['op']
    if op == 'add':
        node2.add_parent(node1)
    elif op == 'del':
        node2.del_parent(node1)

async def conf_handler(request):
    node = graph.find_node_by_uuid(request.match_info['uuid'])

    return web.json_response({
        "id": node.uuid,
        "label": node.name,
        "plugin": node.plugin.name,
        "schema": node.plugin.get_json_schema(),
        "config": node.plugin.get_json_data(),
    })

async def post_handler(request):
    node = graph.find_node_by_uuid(request.match_info['uuid'])
    data = await request.json()
    node.plugin.set_json_data(data)
    return web.json_response(node.plugin.get_json_data())

async def file_handler(request):
    path = request.match_info['path']
    return web.json_response(os.listdir(path))


async def view_handler(request):
    node = graph.find_node_by_uuid(request.match_info['uuid'])
    offset = int(request.query.get('ofs', 0))
    limit = int(request.query.get('lim', 1000))

    def _view_query():
        cursor = ddbc.cursor()
        node.run(cursor, row_limit=100000)
        table = cursor.table(node.table_name)

        return {
            "columns": list(zip(table.columns, [ str(t) for t in table.dtypes ])),
            "data": table.limit(limit, offset=offset).fetchall()
        }

    data = await asyncio.to_thread(_view_query)

    return web.json_response(data)

async def quit_handler(request):

    async def _intr_task():
        await asyncio.sleep(1)
        signal.raise_signal(signal.SIGINT)

    await asyncio.create_task(_intr_task)
    return web.json_response({'okay': 'bye'})

async def webview_task(url):

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

    for n in graph.traverse_nodes():
        n.load_config()

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

    while True:
        await asyncio.sleep(1)
        

    
if __name__ == '__main__':
    root_logger = logging.getLogger()
    root_logger.addHandler(logging.StreamHandler())
    root_logger.setLevel(logging.INFO)

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
    #web.run_app(main(), port=0)


