import { mutationOptions } from "@tanstack/react-query";
import {
  type RunExecutionRequest,
  runGraph,
  type RunGraphRequest,
  runNode,
  runToNode,
} from "../api/execution.ts";

export type RunExecutionMutationRequest = RunExecutionRequest & {
  sourceValue: string;
  abortController: AbortController;
};

export type RunGraphMutationRequest = RunGraphRequest & {
  sourceValue: string;
  abortController: AbortController;
};

export function runNodeMutationOptions() {
  return mutationOptions({
    mutationFn: (
      {
        sourceValue: _sourceValue,
        abortController: _abortController,
        ...request
      }: RunExecutionMutationRequest,
    ) => runNode(request),
  });
}

export function runToNodeMutationOptions() {
  return mutationOptions({
    mutationFn: (
      {
        sourceValue: _sourceValue,
        abortController: _abortController,
        ...request
      }: RunExecutionMutationRequest,
    ) => runToNode(request),
  });
}

export function runGraphMutationOptions() {
  return mutationOptions({
    mutationFn: (
      {
        sourceValue: _sourceValue,
        abortController: _abortController,
        ...request
      }: RunGraphMutationRequest,
    ) => runGraph(request),
  });
}
