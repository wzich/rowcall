from rowcall import node
# this is where you may add something like:
# import pandas as pd
# or
# import polars as pl

@node(id="n_start", outputs=["name"])
def start():
    name = "World"
    return {"name": name}

@node(id="n_0d110q1m3e", outputs=["welcome"])
def new_node_2(name):
    welcome = f"Hello, {name}"
    print(welcome)

    # you'll find data in the `data/` folder form here.
    # you can read the data by adding a node like:
    # df = pd.read_csv("data/atlas_rewards_visa.csv")
    # or use polars if you wish
    # click outside one of the nodes on the graph to see the
    # graph inspector, where you can import globals such as:
    # import pandas as pd
    return {"welcome": welcome}

# Rowcall graph
new_node_2.depends_on(start.output("name"))
