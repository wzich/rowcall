"""Minimal Python API for Rowcall-authored documents.

This package intentionally keeps the Python-side contract small. The Rowcall
canvas and server parse the source file, but generated documents should also be
ordinary importable Python modules.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, TypeVar


FunctionT = TypeVar("FunctionT", bound=Callable[..., Any])


class RowcallNodeError(TypeError):
    """Raised when node metadata is declared with an unsupported shape."""


@dataclass(frozen=True)
class OutputReference:
    """A stable named value routed from one Rowcall node."""

    node: Callable[..., Any]
    name: str


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
        setattr(function, "output", _output_for(function))
        setattr(function, "depends_on", _depends_on_for(function))
        return function

    return decorate


def _depends_on_for(function: FunctionT) -> Callable[..., FunctionT]:
    def depends_on(
        *upstream_outputs: OutputReference,
        **aliased_inputs: OutputReference,
    ) -> FunctionT:
        references = [*upstream_outputs, *aliased_inputs.values()]
        if not all(isinstance(reference, OutputReference) for reference in references):
            raise RowcallNodeError(
                "depends_on values must be node.output(name) references"
            )
        dependencies = list(getattr(function, "__rowcall_dependencies__", []))
        dependencies.extend((reference.name, reference) for reference in upstream_outputs)
        dependencies.extend(aliased_inputs.items())
        setattr(function, "__rowcall_dependencies__", dependencies)
        return function

    return depends_on


def _output_for(function: FunctionT) -> Callable[[str], OutputReference]:
    def output(name: str) -> OutputReference:
        if not isinstance(name, str):
            raise RowcallNodeError("output name must be a string")
        return OutputReference(node=function, name=name)

    return output


__all__ = ["OutputReference", "RowcallNodeError", "node"]
