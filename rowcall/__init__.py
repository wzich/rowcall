"""Minimal Python API for Rowcall-authored documents.

This package intentionally keeps the Python-side contract small. The Rowcall
canvas and server parse the source file, but generated documents should also be
ordinary importable Python modules.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any, TypeVar


FunctionT = TypeVar("FunctionT", bound=Callable[..., Any])


class RowcallNodeError(TypeError):
    """Raised when node metadata is declared with an unsupported shape."""


def node(
    *,
    id: str,
    outputs: Iterable[str],
) -> Callable[[FunctionT], FunctionT]:
    """Mark a function as a Rowcall node.

    ``outputs`` names values that may flow downstream. The decorator attaches
    metadata and returns the original function without changing call semantics.
    """

    if not isinstance(id, str):
        raise RowcallNodeError("node id must be a string")

    if isinstance(outputs, (str, bytes)):
        raise RowcallNodeError("node outputs must be an iterable of strings")

    output_names = list(outputs)
    if not all(isinstance(name, str) for name in output_names):
        raise RowcallNodeError("node outputs must be an iterable of strings")

    def decorate(function: FunctionT) -> FunctionT:
        setattr(function, "__rowcall_id__", id)
        setattr(function, "__rowcall_outputs__", output_names)
        setattr(function, "__rowcall_dependencies__", [])
        setattr(function, "depends_on", _depends_on_for(function))
        return function

    return decorate


def _depends_on_for(function: FunctionT) -> Callable[..., FunctionT]:
    def depends_on(*upstream_nodes: Callable[..., Any]) -> FunctionT:
        dependencies = list(getattr(function, "__rowcall_dependencies__", []))
        dependencies.extend(upstream_nodes)
        setattr(function, "__rowcall_dependencies__", dependencies)
        return function

    return depends_on


__all__ = ["RowcallNodeError", "node"]
