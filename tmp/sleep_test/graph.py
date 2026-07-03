from nodebook import node
# Nodebook documents are normal Python files.
# Nodes declare outputs; depends_on declares graph edges.
# Run: nodebook validate . && nodebook run . --json
# Help: nodebook help format

import time

@node(id="n_load", outputs=["message"])
def load_message():
    message = "hello from Nodebook"
    return {"message": message}


@node(id="n_shout", outputs=["shouted"])
def shout_message(message):
    time.sleep(10)
    shouted = message.upper()
    return {"shouted": shouted}


shout_message.depends_on(load_message)
