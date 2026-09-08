import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAMES = new Set(["HuggingFaceLogin", "HuggingFaceLoginNode"]);
const EVENT_NAME = "downloadwhatiwant.hf_login";

function stopGraphSteal(el) {
  for (const type of ["pointerdown", "mousedown", "touchstart", "wheel"]) {
    el.addEventListener(type, (event) => event.stopPropagation());
  }
}

function copyText(text) {
  if (!text) {
    return Promise.resolve(false);
  }
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  }
  return Promise.resolve(false);
}

function createLoginPanel(node) {
  const root = document.createElement("div");
  root.className = "dwiw-hf-login";
  root.style.cssText = [
    "display:flex",
    "flex-direction:column",
    "gap:6px",
    "padding:4px 2px 2px",
    "width:100%",
    "box-sizing:border-box",
    "user-select:text",
    "pointer-events:auto",
  ].join(";");

  const status = document.createElement("div");
  status.style.cssText = "font-size:11px;opacity:0.85;line-height:1.35;";
  status.textContent = "Run this node to get a copyable Hugging Face device code.";

  const makeRow = (placeholder) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;align-items:center;";
    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.style.cssText = [
      "flex:1",
      "min-width:0",
      "font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
      "padding:4px 6px",
      "user-select:text",
      "cursor:text",
    ].join(";");
    const button = document.createElement("button");
    button.type = "button";
    button.style.cssText = "flex:none;padding:4px 8px;cursor:pointer;";
    row.append(input, button);
    stopGraphSteal(input);
    stopGraphSteal(button);
    return { row, input, button };
  };

  const codeRow = makeRow("Device code");
  codeRow.button.textContent = "Copy code";
  const urlRow = makeRow("https://huggingface.co/login/device");
  urlRow.button.textContent = "Copy URL";

  const setCopied = (button, label) => {
    const previous = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = label;
    }, 1200);
    return previous;
  };

  codeRow.button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (await copyText(codeRow.input.value)) {
      setCopied(codeRow.button, "Copy code");
    }
  });
  urlRow.button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (await copyText(urlRow.input.value)) {
      setCopied(urlRow.button, "Copy URL");
    }
  });
  codeRow.input.addEventListener("focus", () => codeRow.input.select());
  urlRow.input.addEventListener("focus", () => urlRow.input.select());

  root.append(status, codeRow.row, urlRow.row);
  stopGraphSteal(root);

  node._dwiwHfLogin = {
    apply(detail) {
      status.textContent = detail.status || (
        detail.waiting
          ? "Copy the code or URL, then authorize in your browser."
          : "Hugging Face login finished."
      );
      if (detail.waiting) {
        codeRow.input.value = detail.user_code || "";
        urlRow.input.value = detail.url || "";
      }
    },
  };
  return root;
}

function findNode(nodeId) {
  const graph = app.graph;
  if (!graph) {
    return null;
  }
  return (
    graph.getNodeById?.(nodeId) ||
    graph.getNodeById?.(Number(nodeId)) ||
    graph._nodes?.find((node) => String(node.id) === String(nodeId)) ||
    null
  );
}

app.registerExtension({
  name: "downloadwhatiwant.hf_login_copy",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_NAMES.has(nodeData?.name) && nodeData?.display_name !== "HuggingFace Login") {
      return;
    }
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      const panel = createLoginPanel(this);
      this.addDOMWidget("hf_login_copy", "div", panel, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 108,
      });
      if (Array.isArray(this.size)) {
        this.size = [Math.max(this.size[0] || 0, 360), Math.max(this.size[1] || 0, 180)];
      }
      return result;
    };
  },
  setup() {
    api.addEventListener(EVENT_NAME, (event) => {
      const detail = event.detail || {};
      const node = findNode(detail.node);
      node?._dwiwHfLogin?.apply(detail);
    });
  },
});
