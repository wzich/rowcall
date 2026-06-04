"""Minimal Python API for Nodebook-authored documents.

This package intentionally keeps the Python-side contract small. The Nodebook
canvas and server parse the source file, but generated documents should also be
ordinary importable Python modules.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any, TypeVar


FunctionT = TypeVar("FunctionT", bound=Callable[..., Any])


class NodebookNodeError(TypeError):
    """Raised when node metadata is declared with an unsupported shape."""


def node(*, id: str, outputs: Iterable[str]) -> Callable[[FunctionT], FunctionT]:
    """Mark a function as a Nodebook node.

    The decorator attaches simple metadata and returns the original function.
    It does not wrap execution or change call semantics.
    """

    if not isinstance(id, str):
        raise NodebookNodeError("node id must be a string")

    if isinstance(outputs, (str, bytes)):
        raise NodebookNodeError("node outputs must be an iterable of strings")

    output_names = list(outputs)
    if not all(isinstance(name, str) for name in output_names):
        raise NodebookNodeError("node outputs must be an iterable of strings")

    def decorate(function: FunctionT) -> FunctionT:
        setattr(function, "__nodebook_id__", id)
        setattr(function, "__nodebook_outputs__", output_names)
        setattr(function, "__nodebook_dependencies__", [])
        setattr(function, "depends_on", _depends_on_for(function))
        return function

    return decorate


def _depends_on_for(function: FunctionT) -> Callable[..., FunctionT]:
    def depends_on(*upstream_nodes: Callable[..., Any]) -> FunctionT:
        dependencies = list(getattr(function, "__nodebook_dependencies__", []))
        dependencies.extend(upstream_nodes)
        setattr(function, "__nodebook_dependencies__", dependencies)
        return function

    return depends_on


__all__ = ["NodebookNodeError", "node"]
