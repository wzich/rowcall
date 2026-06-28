"""Public Python CLI for Nodebook documents."""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

from nodebook.document import ParseResult, load_document
from nodebook.runtime import run_document


USAGE = """Usage:
  nodebook validate <folder-or-document.py> [--json]
  nodebook run <folder-or-document.py> [--to <node-id-or-function-name>] [--json] [--trace]

Folders resolve to graph.py inside the folder.
"""


@dataclass(frozen=True)
class CliOptions:
    command: str
    document_path: str
    json: bool = False
    trace: bool = False
    target: str | None = None


class CliUsageError(Exception):
    """Raised for command-line usage errors."""


def main(
    argv: list[str] | None = None,
    *,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    out = sys.stdout if stdout is None else stdout
    err = sys.stderr if stderr is None else stderr

    if "--help" in args or "-h" in args:
        out.write(USAGE)
        return 0

    try:
        options = parse_cli_options(args)
    except CliUsageError as exc:
        json_requested = "--json" in args
        command, document_path = partial_command_and_path(args)
        if json_requested:
            write_json(
                {
                    "ok": False,
                    "command": command,
                    "documentPath": document_path,
                    "error": {"kind": "usage_error", "message": str(exc)},
                },
                out,
            )
        else:
            err.write(f"{exc}\n\n{USAGE}")
        return 2

    if options.command == "validate":
        return handle_validate(options, stdout=out, stderr=err)
    if options.command == "run":
        return handle_run(options, stdout=out, stderr=err)

    raise AssertionError(f"Unhandled command: {options.command}")


def parse_cli_options(args: list[str]) -> CliOptions:
    if not args:
        raise CliUsageError("Missing command. Use `validate` or `run`.")

    command = args[0]
    if command not in {"validate", "run"}:
        raise CliUsageError(f"Unknown command: {command}")

    positionals: list[str] = []
    json_output = False
    trace = False
    target: str | None = None
    index = 1
    while index < len(args):
        arg = args[index]
        if arg == "--json":
            json_output = True
        elif arg == "--trace":
            trace = True
        elif arg == "--to":
            index += 1
            if index >= len(args) or args[index].startswith("-"):
                raise CliUsageError("Invalid value for --to.")
            target = args[index]
        elif arg.startswith("--to="):
            value = arg.split("=", 1)[1]
            if not value:
                raise CliUsageError("Invalid value for --to.")
            target = value
        elif arg.startswith("-"):
            raise CliUsageError(f"Unknown option: {arg}")
        else:
            positionals.append(arg)
        index += 1

    if len(positionals) == 0:
        raise CliUsageError(f"Missing document path for {command}.")
    if len(positionals) > 1:
        raise CliUsageError(f"Unexpected extra argument: {' '.join(positionals[1:])}")

    document_path = positionals[0]
    if command == "validate" and target is not None:
        raise CliUsageError("`validate` does not accept --to.")
    if command == "validate" and trace:
        raise CliUsageError("`validate` does not accept --trace.")

    return CliOptions(
        command=command,
        document_path=document_path,
        json=json_output,
        trace=trace,
        target=target,
    )


def handle_validate(options: CliOptions, *, stdout: TextIO, stderr: TextIO) -> int:
    try:
        resolved_document_path = resolve_document_input_path(options.document_path)
    except (OSError, ValueError) as exc:
        resolved_document_path = Path(options.document_path).expanduser()
        result = None
        error = {"kind": "load_error", "message": str(exc)}
    else:
        result = None
        error = None

    document_path = resolve_display_path(str(resolved_document_path))
    try:
        if error is None:
            result = load_document(str(resolved_document_path))
    except OSError as exc:
        result = None
        error = {"kind": "load_error", "message": str(exc)}

    if options.json:
        payload: dict[str, Any] = {
            "ok": bool(result and result.ok),
            "command": "validate",
            "documentPath": document_path,
        }
        if result and result.ok and result.document is not None:
            payload["summary"] = document_summary(result)
        elif result is not None:
            payload["issues"] = [issue.to_dict() for issue in result.issues]
        else:
            payload["error"] = error
        write_json(payload, stdout)
        return 0 if payload["ok"] else 1

    if result and result.ok:
        stdout.write(f"OK {document_path}\n")
        stdout.write(format_document_summary(result) + "\n")
        return 0

    stderr.write(f"Validation failed: {document_path}\n")
    if result is not None:
        write_issues(result, stderr)
    elif error is not None:
        stderr.write(f"- {error['kind']}: {error['message']}\n")
    return 1


def handle_run(options: CliOptions, *, stdout: TextIO, stderr: TextIO) -> int:
    try:
        resolved_document_path = resolve_document_input_path(options.document_path)
    except (OSError, ValueError) as exc:
        resolved_document_path = Path(options.document_path).expanduser()
        response = {
            "ok": False,
            "runType": "run_to_node" if options.target else "run_graph",
            "finalNodeIds": [],
            "executedNodeIds": [],
            "resultsByNode": {},
            "finalOutputsByNode": {},
            "trace": [] if options.trace else None,
            "error": {"kind": "load_error", "message": str(exc)},
        }
    else:
        response = None

    document_path = resolve_display_path(str(resolved_document_path))
    try:
        if response is None:
            response = run_document(
                str(resolved_document_path),
                target=options.target,
                trace=options.trace,
            )
    except OSError as exc:
        response = {
            "ok": False,
            "runType": "run_to_node" if options.target else "run_graph",
            "finalNodeIds": [],
            "executedNodeIds": [],
            "resultsByNode": {},
            "finalOutputsByNode": {},
            "trace": [] if options.trace else None,
            "error": {"kind": "load_error", "message": str(exc)},
        }
    except Exception as exc:
        response = {
            "ok": False,
            "runType": "run_to_node" if options.target else "run_graph",
            "finalNodeIds": [],
            "executedNodeIds": [],
            "resultsByNode": {},
            "finalOutputsByNode": {},
            "trace": [] if options.trace else None,
            "error": {"kind": "execution_error", "message": str(exc)},
        }

    payload: dict[str, Any] = {
        "ok": bool(response.get("ok")),
        "command": "run",
        "documentPath": document_path,
        "response": response,
    }
    if options.target is not None:
        payload["target"] = {"requested": options.target, "nodeId": response.get("targetNodeId")}

    if options.json:
        write_json(payload, stdout)
    else:
        write_run_summary(payload, stdout=stdout, stderr=stderr)

    return 0 if payload["ok"] else 1


def document_summary(result: ParseResult) -> dict[str, Any]:
    assert result.document is not None
    return {
        "nodeCount": len(result.document.nodes),
        "edgeCount": len(result.document.edges),
        "nodes": [
            {
                "id": node.id,
                "functionName": node.function_name,
                "outputs": list(node.outputs),
            }
            for node in result.document.nodes
        ],
    }


def format_document_summary(result: ParseResult) -> str:
    assert result.document is not None
    return f"{len(result.document.nodes)} nodes, {len(result.document.edges)} edges"


def write_issues(result: ParseResult, stream: TextIO) -> None:
    for issue in result.issues:
        issue_path = f" ({issue.path})" if issue.path else ""
        stream.write(f"- {issue.kind}{issue_path}: {issue.message}\n")


def write_run_summary(payload: dict[str, Any], *, stdout: TextIO, stderr: TextIO) -> None:
    response = payload["response"]
    target = payload.get("target")
    run_label = f"target {target['requested']}" if target else "document"
    summary_stream = stdout if payload["ok"] else stderr
    summary_stream.write(f"{'OK' if payload['ok'] else 'FAILED'} run {run_label}\n")

    executed_node_ids = response.get("executedNodeIds") or []
    if executed_node_ids:
        summary_stream.write(f"Executed: {' -> '.join(executed_node_ids)}\n")

    final_outputs = response.get("finalOutputsByNode") or {}
    if final_outputs:
        stdout.write("Final outputs:\n")
        for node_id, outputs in final_outputs.items():
            stdout.write(f"- {node_id}:\n")
            for name, preview in outputs.items():
                stdout.write(f"  {name}: {format_preview(preview)}\n")

    error = response.get("error")
    if error:
        write_run_error(
            error,
            document_path=str(payload.get("documentPath") or ""),
            show_trace=response.get("trace") is not None,
            stream=stderr,
        )


def write_run_error(
    error: Any,
    *,
    document_path: str,
    show_trace: bool,
    stream: TextIO,
) -> None:
    if not isinstance(error, dict):
        stream.write(f"error: {error}\n")
        return

    kind = str(error.get("kind") or "error")
    message = str(error.get("message") or "Unknown error")

    if kind == "missing_module":
        missing_module = str(error.get("missingModule") or "unknown")
        phase = error.get("phase")
        node_id = error.get("nodeId")
        if phase == "document_globals":
            stream.write(
                f"Missing Python package while loading document globals: {missing_module}\n"
            )
        elif node_id:
            stream.write(f"Missing Python package while running node {node_id}: {missing_module}\n")
        else:
            stream.write(f"Missing Python package: {missing_module}\n")

        python_executable = error.get("pythonExecutable")
        if python_executable:
            stream.write(f"Python used: {python_executable}\n")
        if document_path:
            stream.write(f"Document: {document_path}\n")
        if node_id:
            stream.write(f"Node: {node_id}\n")
        stream.write("\nRun Nodebook with a Python environment that has this package installed.\n")
    else:
        stream.write(f"{kind}: {message}\n")
        python_executable = error.get("pythonExecutable")
        if python_executable:
            stream.write(f"Python used: {python_executable}\n")

    stderr_text = error.get("stderr")
    if show_trace and isinstance(stderr_text, str) and stderr_text:
        stream.write("\nTraceback:\n")
        stream.write(stderr_text)
        if not stderr_text.endswith("\n"):
            stream.write("\n")


def format_preview(preview: Any) -> str:
    if isinstance(preview, dict):
        if "jsonValue" in preview:
            return json.dumps(preview["jsonValue"], ensure_ascii=False)
        if "summary" in preview:
            return str(preview["summary"])
        if "text" in preview:
            return str(preview["text"])
    return json.dumps(preview, ensure_ascii=False, default=str)


def write_json(value: dict[str, Any], stream: TextIO) -> None:
    stream.write(json.dumps(value, indent=2, ensure_ascii=False, default=str))
    stream.write("\n")


def resolve_display_path(path: str) -> str:
    try:
        return str(Path(path).expanduser().resolve())
    except OSError:
        return path


def resolve_document_input_path(path: str) -> Path:
    candidate = Path(path).expanduser()
    if candidate.is_dir():
        document_path = candidate / "graph.py"
        if not document_path.is_file():
            raise FileNotFoundError(
                f"Nodebook folder does not contain graph.py: {candidate}"
            )
        return document_path

    if candidate.exists() and not candidate.is_file():
        raise ValueError(f"Nodebook path is not a file or directory: {candidate}")

    if candidate.suffix != ".py":
        raise ValueError(
            "Nodebook document path must be a .py file or a folder containing graph.py."
        )

    return candidate


def partial_command_and_path(args: list[str]) -> tuple[str | None, str | None]:
    command = args[0] if args and not args[0].startswith("-") else None
    document_path = None
    for arg in args[1:]:
        if not arg.startswith("-"):
            document_path = arg
            break
    return command, document_path


if __name__ == "__main__":
    raise SystemExit(main())
