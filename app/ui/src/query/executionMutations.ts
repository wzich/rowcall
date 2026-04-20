import { mutationOptions } from "@tanstack/react-query";
import {
  type RunExecutionRequest,
  runNode,
  runToNode,
} from "../api/execution.ts";

export type RunExecutionMutationRequest = RunExecutionRequest & {
  sourceValue: string;
};

export function runNodeMutationOptions() {
  return mutationOptions({
    mutationFn: (
      { sourceValue: _sourceValue, ...request }: RunExecutionMutationRequest,
    ) => runNode(request),
  });
}

export function runToNodeMutationOptions() {
  return mutationOptions({
    mutationFn: (
      { sourceValue: _sourceValue, ...request }: RunExecutionMutationRequest,
    ) => runToNode(request),
  });
}
