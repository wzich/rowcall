import contextlib
import io
import json
import sys
import traceback


def make_error_result(message: str, stdout: str = "", stderr: str = "") -> dict:
    return {
        "ok": False,
        "stdout": stdout,
        "stderr": stderr,
        "outputs": {},
        "error": message,
    }


def run_node(payload: dict) -> dict:
    code = payload.get("code")
    output_names = payload.get("outputs")
    inputs = payload.get("inputs", {})

    if not isinstance(code, str):
        return make_error_result("Payload field 'code' must be a string")
    if not isinstance(output_names, list) or not all(
        isinstance(name, str) for name in output_names
    ):
        return make_error_result(
            "Payload field 'outputs' must be an array of strings"
        )
    if not isinstance(inputs, dict):
        return make_error_result("Payload field 'inputs' must be an object")

    scope = dict(inputs)
    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()

    try:
        with contextlib.redirect_stdout(stdout_buffer):
            with contextlib.redirect_stderr(stderr_buffer):
                exec(code, scope, scope)
    except Exception as exc:
        stderr_text = stderr_buffer.getvalue() + traceback.format_exc()
        return make_error_result(str(exc), stdout_buffer.getvalue(), stderr_text)

    outputs = {}
    for name in output_names:
        if name not in scope:
            return make_error_result(
                f"Declared output '{name}' was not defined by node code",
                stdout_buffer.getvalue(),
                stderr_buffer.getvalue(),
            )
        outputs[name] = scope[name]

    try:
        json.dumps(outputs)
    except TypeError as exc:
        return make_error_result(
            f"Declared outputs are not JSON-serializable: {exc}",
            stdout_buffer.getvalue(),
            stderr_buffer.getvalue(),
        )

    return {
        "ok": True,
        "stdout": stdout_buffer.getvalue(),
        "stderr": stderr_buffer.getvalue(),
        "outputs": outputs,
    }


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        result = make_error_result(f"Failed to decode JSON payload: {exc}")
        json.dump(result, sys.stdout)
        sys.stdout.write("\n")
        return 1

    if not isinstance(payload, dict):
        result = make_error_result("Top-level payload must be a JSON object")
        json.dump(result, sys.stdout)
        sys.stdout.write("\n")
        return 1

    result = run_node(payload)
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
