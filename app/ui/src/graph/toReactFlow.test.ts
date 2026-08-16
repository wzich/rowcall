import { assertEquals } from "@std/assert";
import { toReactFlowGraph } from "./toReactFlow.ts";

Deno.test("React Flow edges originate from named output handles", () => {
  const graph = toReactFlowGraph({
    nodes: [
      {
        id: "split",
        code: "train = []\ntest = []",
        outputs: ["train", "test"],
      },
      { id: "fit", code: "model = None", outputs: ["model"] },
    ],
    edges: [
      {
        fromNode: "split",
        fromOutput: "train",
        toNode: "fit",
        toInput: "training_data",
      },
    ],
  });

  assertEquals(graph.edges[0].sourceHandle, "train");
  assertEquals(graph.edges[0].targetHandle, "node-input");
  assertEquals(graph.nodes[1].data.inputs, [{ name: "training_data" }]);
});
