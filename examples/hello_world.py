from rowcall import node


@node(id="n_load", outputs=["message"])
def read_message():
    message = "hello"
    return {"message": message}


@node(id="n_shout", outputs=["message"])
def shout_message(message):
    message = message.upper() + "!"
    return {"message": message}


# Rowcall graph
shout_message.depends_on(read_message)
