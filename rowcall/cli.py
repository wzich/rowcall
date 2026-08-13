"""Public Python CLI for Rowcall documents."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

from rowcall.document import ParseResult, load_document
from rowcall.runtime import run_document


USAGE = """Usage:
  rowcall <folder-or-document.py>
  rowcall open <folder-or-document.py> [--python <path>]
  rowcall new <folder-or-document.py> [--open] [--python <path>]
  rowcall validate <folder-or-document.py> [--json]
  rowcall run <folder-or-document.py> [--to <node-id-or-function-name>] [--json|--json=summary] [--trace|--trace=summary]
  rowcall run <folder-or-document.py> [--to <node-id-or-function-name>] --outputs-only

Folders resolve to graph.py inside the folder.
Opening commands delegate to the full Rowcall launcher.
"""

LAUNCHER_COMMANDS = {
    "doctor",
    "example",
    "help",
    "new",
    "open",
    "reset-env",
    "update",
}


@dataclass(frozen=True)
class CliOptions:
    command: str
    document_path: str
    json_mode: str = "none"
    trace_mode: str = "none"
    outputs_only: bool = False
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

    if not args:
        out.write(USAGE)
        return 0

    if should_delegate_to_launcher(args):
        return run_full_launcher(args, stdout=out, stderr=err)

    if "--help" in args or "-h" in args:
        out.write(USAGE)
        return 0

    try:
        options = parse_cli_options(args)
    except CliUsageError as exc:
        json_requested = any(
            arg == "--outputs-only" or arg == "--json" or arg.startswith("--json=")
            for arg in args
        )
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


def should_delegate_to_launcher(args: list[str]) -> bool:
    if not args:
        return False
    first = args[0]
    if first in LAUNCHER_COMMANDS or first in {"--version", "-V"}:
        return True
    return not first.startswith("-") and first not in {"run", "validate"}


def run_full_launcher(
    args: list[str], *, stdout: TextIO, stderr: TextIO
) -> int:
    invocation = find_full_launcher_invocation()
    if invocation is None:
        stderr.write(
            "The full Rowcall launcher is required to open the UI.\n\n"
            "Install it from https://rowcall.io, or run this command "
            "from a Rowcall source checkout with Deno installed.\n"
        )
        return 1

    command = [*invocation, *args]
    if stdout is sys.stdout and stderr is sys.stderr:
        return subprocess.run(command, check=False).returncode

    completed = subprocess.run(command, check=False, capture_output=True, text=True)
    stdout.write(completed.stdout)
    stderr.write(completed.stderr)
    return completed.returncode


def find_full_launcher_invocation() -> list[str] | None:
    override = os.environ.get("ROWCALL_LAUNCHER")
    if override:
        return [override]

    source_root = Path(__file__).resolve().parents[1]
    source_launcher = source_root / "launcher.ts"
    deno = shutil.which("deno")
    if source_launcher.is_file() and deno:
        return [
            deno,
            "run",
            "--allow-read",
            "--allow-write",
            "--allow-net",
            "--allow-run",
            "--allow-env",
            str(source_launcher),
        ]

    current_command = Path(sys.argv[0]).resolve()
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        if not directory:
            continue
        candidate = Path(directory) / "rowcall"
        if not candidate.is_file() or not os.access(candidate, os.X_OK):
            continue
        try:
            if candidate.resolve() == current_command:
                continue
        except OSError:
            continue
        if is_python_cli_wrapper(candidate):
            continue
        return [str(candidate)]
    return None


def is_python_cli_wrapper(path: Path) -> bool:
    try:
        prefix = path.read_bytes()[:4096]
    except OSError:
        return False
    return b"rowcall.cli" in prefix


def parse_cli_options(args: list[str]) -> CliOptions:
    if not args:
        raise CliUsageError("Missing command. Use `validate` or `run`.")

    command = args[0]
    if command not in {"validate", "run"}:
        raise CliUsageError(f"Unknown command: {command}")

    positionals: list[str] = []
    json_mode = "none"
    trace_mode = "none"
    outputs_only = False
    target: str | None = None
    index = 1
    while index < len(args):
        arg = args[index]
        if arg == "--json":
            json_mode = "full"
        elif arg.startswith("--json="):
            value = arg.split("=", 1)[1]
            if value not in {"full", "summary"}:
                raise CliUsageError("Invalid value for --json. Use `full` or `summary`.")
            json_mode = value
        elif arg == "--trace":
            trace_mode = "full"
        elif arg.startswith("--trace="):
            value = arg.split("=", 1)[1]
            if value not in {"full", "summary"}:
                raise CliUsageError("Invalid value for --trace. Use `full` or `summary`.")
            trace_mode = value
        elif arg == "--outputs-only":
            outputs_only = True
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
    if command == "validate" and trace_mode != "none":
        raise CliUsageError("`validate` does not accept --trace.")
    if command == "validate" and outputs_only:
        raise CliUsageError("`validate` does not accept --outputs-only.")
    if outputs_only and json_mode == "summary":
        raise CliUsageError("Use either --outputs-only or --json=summary, not both.")
    if outputs_only and trace_mode != "none":
        raise CliUsageError("`--outputs-only` does not accept --trace.")
    if trace_mode == "summary" and json_mode == "none":
        raise CliUsageError("`--trace=summary` requires --json or --json=summary.")

    return CliOptions(
        command=command,
        document_path=document_path,
        json_mode=json_mode,
        trace_mode=trace_mode,
        outputs_only=outputs_only,
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

    if options.json_mode != "none":
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
            "trace": [] if options.trace_mode != "none" else None,
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
                trace=options.trace_mode != "none",
            )
    except OSError as exc:
        response = {
            "ok": False,
            "runType": "run_to_node" if options.target else "run_graph",
            "finalNodeIds": [],
            "executedNodeIds": [],
            "resultsByNode": {},
            "finalOutputsByNode": {},
            "trace": [] if options.trace_mode != "none" else None,
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
            "trace": [] if options.trace_mode != "none" else None,
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

    if options.outputs_only:
        write_json(outputs_only_payload(payload), stdout)
    elif options.json_mode == "summary":
        write_json(summary_payload(payload, trace_mode=options.trace_mode), stdout)
    elif options.json_mode == "full":
        if options.trace_mode == "summary":
            payload["response"] = {
                **response,
                "trace": summarize_trace(response.get("trace")),
            }
        write_json(payload, stdout)
    else:
        write_run_summary(payload, stdout=stdout, stderr=stderr)

    return 0 if payload["ok"] else 1


COMPACT_TEXT_LIMIT = 1_000
COMPACT_JSON_VALUE_BYTE_LIMIT = 16_000
COMPACT_TABLE_ROWS = 5
COMPACT_TABLE_COLUMNS = 10
COMPACT_COLLECTION_ITEMS = 20


def truncate_compact_text(value: Any, limit: int = COMPACT_TEXT_LIMIT) -> str:
    text = str(value)
    if len(text) <= limit:
        return text
    return text[:limit] + "...<truncated>"


def compact_error(value: Any) -> Any:
    if not isinstance(value, dict):
        return truncate_compact_text(value)
    compact: dict[str, Any] = {}
    for key, item in value.items():
        if isinstance(item, str):
            compact[key] = truncate_compact_text(item, 2_000)
        elif isinstance(item, list):
            compact[key] = [
                compact_error(entry)
                for entry in item[:COMPACT_COLLECTION_ITEMS]
            ]
            if len(item) > COMPACT_COLLECTION_ITEMS:
                compact[f"{key}Truncated"] = True
        elif isinstance(item, dict):
            compact[key] = compact_error(item)
        elif item is None or isinstance(item, (bool, int, float)):
            compact[key] = item
        else:
            compact[key] = truncate_compact_text(item)
    return compact


def compact_preview(preview: Any) -> Any:
    if not isinstance(preview, dict):
        return preview

    compact = {
        key: preview[key]
        for key in ("name", "type")
        if key in preview
    }
    if "repr" in preview:
        compact["repr"] = truncate_compact_text(preview["repr"], 500)
    if "summary" in preview:
        compact["summary"] = truncate_compact_text(preview["summary"])
    if "text" in preview:
        compact["text"] = truncate_compact_text(preview["text"])
    if "warning" in preview:
        compact["warning"] = truncate_compact_text(preview["warning"])

    if "jsonValue" in preview:
        encoded = json.dumps(
            preview["jsonValue"],
            ensure_ascii=False,
            allow_nan=False,
            default=str,
        ).encode("utf-8")
        if len(encoded) <= COMPACT_JSON_VALUE_BYTE_LIMIT:
            compact["jsonValue"] = preview["jsonValue"]
        else:
            compact["jsonValueOmitted"] = {
                "reason": "compact_output_limit",
                "sizeBytes": len(encoded),
                "limitBytes": COMPACT_JSON_VALUE_BYTE_LIMIT,
            }

    table = preview.get("table")
    if isinstance(table, dict):
        columns = table.get("columns")
        rows = table.get("rows")
        compact_table = {
            key: table[key]
            for key in ("rowCount", "columnCount")
            if key in table
        }
        if isinstance(columns, list):
            compact_table["columns"] = columns[:COMPACT_TABLE_COLUMNS]
        if isinstance(rows, list):
            compact_table["rows"] = [
                row[:COMPACT_TABLE_COLUMNS] if isinstance(row, list) else row
                for row in rows[:COMPACT_TABLE_ROWS]
            ]
        if isinstance(table.get("index"), list):
            compact_table["index"] = table["index"][:COMPACT_TABLE_ROWS]
        compact_table["truncated"] = bool(table.get("truncated")) or (
            isinstance(columns, list) and len(columns) > COMPACT_TABLE_COLUMNS
        ) or (isinstance(rows, list) and len(rows) > COMPACT_TABLE_ROWS)
        compact["table"] = compact_table

    image = preview.get("image")
    if isinstance(image, dict):
        compact["image"] = {
            key: image[key]
            for key in ("mimeType", "width", "height", "sizeBytes")
            if key in image
        }
        compact["image"]["dataOmitted"] = True

    return compact


def compact_outputs(outputs_by_node: Any) -> dict[str, Any]:
    if not isinstance(outputs_by_node, dict):
        return {}
    return {
        str(node_id): {
            str(name): compact_preview(preview)
            for name, preview in outputs.items()
        }
        for node_id, outputs in outputs_by_node.items()
        if isinstance(outputs, dict)
    }


def summarize_trace(trace: Any) -> list[dict[str, Any]] | None:
    if trace is None:
        return None
    if not isinstance(trace, list):
        return []
    summary = []
    for entry in trace:
        if not isinstance(entry, dict):
            continue
        item = {
            key: entry[key]
            for key in ("index", "nodeId", "dependsOn", "ok")
            if key in entry
        }
        warnings = entry.get("warnings")
        if isinstance(warnings, list) and warnings:
            item["warnings"] = [
                truncate_compact_text(warning)
                for warning in warnings[:COMPACT_COLLECTION_ITEMS]
            ]
        if entry.get("error") is not None:
            item["error"] = compact_error(entry["error"])
        summary.append(item)
    return summary


def summary_payload(payload: dict[str, Any], *, trace_mode: str) -> dict[str, Any]:
    response = payload["response"]
    results = response.get("resultsByNode")
    node_summaries = []
    if isinstance(results, dict):
        for node_id in response.get("executedNodeIds") or []:
            result = results.get(node_id)
            if not isinstance(result, dict):
                continue
            node_summary: dict[str, Any] = {
                "nodeId": node_id,
                "ok": bool(result.get("ok")),
            }
            for stream_name in ("stdout", "stderr"):
                stream_value = result.get(stream_name)
                if stream_value:
                    node_summary[stream_name] = truncate_compact_text(stream_value)
            warnings = result.get("warnings")
            if isinstance(warnings, list) and warnings:
                node_summary["warnings"] = [
                    truncate_compact_text(warning)
                    for warning in warnings[:COMPACT_COLLECTION_ITEMS]
                ]
            if result.get("error") is not None:
                node_summary["error"] = compact_error(result["error"])
            views = result.get("views")
            if isinstance(views, dict) and views:
                node_summary["views"] = {
                    str(name): compact_preview(preview)
                    for name, preview in views.items()
                }
            node_summaries.append(node_summary)

    compact_response: dict[str, Any] = {
        key: response[key]
        for key in (
            "ok",
            "runType",
            "targetNodeId",
            "finalNodeIds",
            "executedNodeIds",
        )
        if key in response
    }
    compact_response["nodes"] = node_summaries
    compact_response["finalOutputsByNode"] = compact_outputs(
        response.get("finalOutputsByNode")
    )
    if trace_mode != "none":
        compact_response["trace"] = (
            summarize_trace(response.get("trace"))
            if trace_mode == "summary"
            else response.get("trace")
        )
    if response.get("error") is not None:
        compact_response["error"] = compact_error(response["error"])

    result = {
        key: payload[key]
        for key in ("ok", "command", "documentPath", "target")
        if key in payload
    }
    result["response"] = compact_response
    return result


def outputs_only_payload(payload: dict[str, Any]) -> dict[str, Any]:
    response = payload["response"]
    result = {
        key: payload[key]
        for key in ("ok", "command", "documentPath", "target")
        if key in payload
    }
    result["outputsByNode"] = compact_outputs(response.get("finalOutputsByNode"))
    if response.get("error") is not None:
        result["error"] = compact_error(response["error"])
    return result


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
                "views": list(node.views),
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

    results_by_node = response.get("resultsByNode") or {}
    rendered_views: list[tuple[str, dict[str, Any]]] = []
    for node_id in executed_node_ids:
        result = results_by_node.get(node_id)
        views = result.get("views") if isinstance(result, dict) else None
        if isinstance(views, dict) and views:
            rendered_views.append((node_id, views))
    if rendered_views:
        stdout.write("Views:\n")
        for node_id, views in rendered_views:
            stdout.write(f"- {node_id}:\n")
            for name, preview in views.items():
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

    if kind == "validation_error":
        stream.write(f"{kind}: {message}\n")
        issues = error.get("issues")
        if isinstance(issues, list):
            for issue in issues:
                if not isinstance(issue, dict):
                    continue
                issue_kind = str(issue.get("kind") or "validation_issue")
                issue_path = issue.get("path")
                location = f" ({issue_path})" if issue_path else ""
                issue_message = str(
                    issue.get("message") or "Unknown validation issue"
                )
                stream.write(f"- {issue_kind}{location}: {issue_message}\n")
    elif kind == "missing_module":
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
        stream.write("\nRun Rowcall with a Python environment that has this package installed.\n")
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
        image = preview.get("image")
        if isinstance(image, dict):
            width = image.get("width", "?")
            height = image.get("height", "?")
            size_bytes = image.get("sizeBytes", "?")
            mime_type = image.get("mimeType", "image/png")
            return f"<{mime_type} {width}x{height}, {size_bytes} bytes; image data omitted>"
        if "jsonValue" in preview:
            return json.dumps(preview["jsonValue"], ensure_ascii=False)
        if "summary" in preview:
            return str(preview["summary"])
        if "text" in preview:
            return str(preview["text"])
    return json.dumps(preview, ensure_ascii=False, default=str)


def write_json(value: dict[str, Any], stream: TextIO) -> None:
    stream.write(
        json.dumps(
            omit_image_data(value),
            indent=2,
            ensure_ascii=False,
            default=str,
        )
    )
    stream.write("\n")


def omit_image_data(value: Any) -> Any:
    """Return a CLI-safe copy with image payloads replaced by metadata."""
    if isinstance(value, list):
        return [omit_image_data(item) for item in value]
    if not isinstance(value, dict):
        return value

    is_value_preview = all(
        isinstance(value.get(key), str)
        for key in ("name", "type", "repr")
    )
    result: dict[str, Any] = {}
    for key, item in value.items():
        if key == "jsonValue":
            # This is user-owned JSON. It must remain byte-for-byte equivalent
            # even when it resembles Rowcall's image transport shape.
            result[key] = item
        elif key == "image" and is_value_preview and _is_png_image_payload(item):
            result[key] = {
                image_key: image_value
                for image_key, image_value in item.items()
                if image_key != "dataBase64"
            }
            result[key]["dataOmitted"] = True
        else:
            result[key] = omit_image_data(item)
    return result


def _is_png_image_payload(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and value.get("mimeType") == "image/png"
        and isinstance(value.get("dataBase64"), str)
        and all(key in value for key in ("width", "height", "sizeBytes"))
    )


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
                f"Rowcall folder does not contain graph.py: {candidate}"
            )
        return document_path

    if candidate.exists() and not candidate.is_file():
        raise ValueError(f"Rowcall path is not a file or directory: {candidate}")

    if candidate.suffix != ".py":
        raise ValueError(
            "Rowcall document path must be a .py file or a folder containing graph.py."
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
