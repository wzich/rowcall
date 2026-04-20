const graphInput = document.querySelector("#graph-json");
const inspectButton = document.querySelector("#inspect");
const nodeSelect = document.querySelector("#node-id");
const inputsInput = document.querySelector("#inputs-json");
const traceInput = document.querySelector("#trace");
const runNodeButton = document.querySelector("#run-node");
const runToNodeButton = document.querySelector("#run-to-node");
const runGraphButton = document.querySelector("#run-graph");
const summaryEl = document.querySelector("#summary");
const nodesEl = document.querySelector("#nodes");
const edgesEl = document.querySelector("#edges");
const nodeDetailEl = document.querySelector("#node-detail");
const finalOutputsEl = document.querySelector("#final-outputs");
const traceOutputEl = document.querySelector("#trace-output");
const resultEl = document.querySelector("#result");

const state = {
  graph: null,
  nodeDetails: [],
  summary: null,
};

inspectButton.addEventListener("click", async () => {
  const response = await fetch("/inspect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: {
        type: "text",
        text: graphInput.value,
      },
    }),
  });

  const data = await response.json();
  renderRawJson(data);

  if (!data.ok) {
    return;
  }

  state.graph = data.graph;
  state.nodeDetails = data.nodeDetails;
  state.summary = data.summary;

  renderGraph(data);
  renderNodeOptions(data.graph.nodes);
  renderSelectedNode();
});

nodeSelect.addEventListener("change", () => {
  renderSelectedNode();
});

runNodeButton.addEventListener("click", async () => {
  await runGraphEndpoint("/run-node", { nodeId: nodeSelect.value });
});

runToNodeButton.addEventListener("click", async () => {
  await runGraphEndpoint("/run-to-node", { nodeId: nodeSelect.value });
});

runGraphButton.addEventListener("click", async () => {
  await runGraphEndpoint("/run-graph");
});

async function runGraphEndpoint(path, extraBody = {}) {
  if (!state.graph) {
    renderRawJson({ ok: false, error: { message: "Inspect a graph first." } });
    return;
  }

  let inputs;
  try {
    inputs = JSON.parse(inputsInput.value || "{}");
  } catch {
    renderRawJson({
      ok: false,
      error: { message: "Inputs must be valid JSON." },
    });
    return;
  }

  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      graph: state.graph,
      inputs,
      trace: traceInput.checked,
      ...extraBody,
    }),
  });

  const data = await response.json();
  renderRawJson(data);
  renderRunResult(data);
}

function renderGraph(data) {
  summaryEl.classList.remove("muted");
  summaryEl.textContent =
    `${data.summary.nodeCount} nodes, ${data.summary.edgeCount} edges. ` +
    `Sources: ${data.summary.sourceNodeIds.join(", ") || "none"}. ` +
    `Sinks: ${data.summary.sinkNodeIds.join(", ") || "none"}.`;

  nodesEl.textContent = "";
  for (const node of data.graph.nodes) {
    const detail = data.nodeDetails.find((item) => item.id === node.id);
    const item = document.createElement("li");
    item.textContent = `${node.id} -> outputs: ${
      node.outputs.join(", ") || "none"
    }`;
    if (detail?.isSourceNode) item.append(label("source"));
    if (detail?.isSinkNode) item.append(label("sink"));
    nodesEl.append(item);
  }

  edgesEl.textContent = "";
  for (const edge of data.graph.edges) {
    const item = document.createElement("li");
    item.textContent = `${edge.fromNode} -> ${edge.toNode}`;
    edgesEl.append(item);
  }
}

function renderNodeOptions(nodes) {
  nodeSelect.textContent = "";

  for (const node of nodes) {
    const option = document.createElement("option");
    option.value = node.id;
    option.textContent = node.id;
    nodeSelect.append(option);
  }
}

function renderSelectedNode() {
  if (!state.graph) return;

  const node = state.graph.nodes.find((item) => item.id === nodeSelect.value);
  const detail = state.nodeDetails.find((item) => item.id === nodeSelect.value);
  nodeDetailEl.textContent = "";
  nodeDetailEl.classList.remove("muted");

  if (!node) {
    nodeDetailEl.textContent = "No node selected.";
    return;
  }

  nodeDetailEl.append(
    field("ID", node.id),
    field("Outputs", node.outputs.join(", ") || "none"),
    field("Upstream", detail?.upstreamDependencies?.join(", ") || "none"),
    field("Downstream", detail?.downstreamDependencies?.join(", ") || "none"),
  );

  const code = document.createElement("pre");
  code.textContent = node.code;
  nodeDetailEl.append(code);
}

function renderRunResult(data) {
  if (data.finalOutputsByNode) {
    finalOutputsEl.textContent = JSON.stringify(
      data.finalOutputsByNode,
      null,
      2,
    );
  }

  traceOutputEl.textContent = "";
  if (!data.trace) {
    traceOutputEl.classList.add("muted");
    traceOutputEl.textContent = "Trace was not enabled for this run.";
    return;
  }

  traceOutputEl.classList.remove("muted");
  for (const step of data.trace) {
    const section = document.createElement("section");
    section.className = "trace-step";
    section.append(
      field(
        "Step",
        `${step.index}: ${step.nodeId} (${step.ok ? "ok" : "failed"})`,
      ),
      field("Depends on", step.dependsOn.join(", ") || "none"),
      field("Stdout", step.stdout || "(empty)"),
      field("Stderr", step.stderr || "(empty)"),
      field("Error", step.error || "(none)"),
    );

    const outputs = document.createElement("pre");
    outputs.textContent = JSON.stringify(step.outputs, null, 2);
    section.append(outputs);
    traceOutputEl.append(section);
  }
}

function field(name, value) {
  const wrapper = document.createElement("div");
  wrapper.className = "field";

  const label = document.createElement("strong");
  label.textContent = `${name}: `;

  const text = document.createElement("span");
  text.textContent = value;

  wrapper.append(label, text);
  return wrapper;
}

function label(text) {
  const item = document.createElement("span");
  item.className = "tag";
  item.textContent = text;
  return item;
}

function renderRawJson(value) {
  resultEl.textContent = JSON.stringify(value, null, 2);
}
