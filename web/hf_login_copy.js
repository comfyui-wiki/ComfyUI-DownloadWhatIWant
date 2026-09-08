import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAMES = new Set(["DownloadWhatIWant", "DownloadWhatIWantNode"]);
const STATUS_PATH = "/downloadwhatiwant/hf_auth/status";
const START_PATH = "/downloadwhatiwant/hf_auth/start";
const CANCEL_PATH = "/downloadwhatiwant/hf_auth/cancel";

const panels = new Set();
let pollTimer = null;

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

async function readJson(path, options = {}) {
  const response = await api.fetchApi(path, options);
  if (!response.ok) {
    throw new Error(`Hugging Face login request failed (${response.status})`);
  }
  return response.json();
}

function applyAll(state) {
  for (const panel of panels) {
    panel.apply(state);
  }
  if (state?.status === "waiting") {
    startPolling();
  } else {
    stopPolling();
  }
}

function startPolling() {
  if (pollTimer) {
    return;
  }
  pollTimer = setInterval(async () => {
    try {
      applyAll(await readJson(STATUS_PATH));
    } catch (_error) {
      // Keep the last good state if the server is briefly unreachable.
    }
  }, 2000);
}

function stopPolling() {
  if (!pollTimer) {
    return;
  }
  clearInterval(pollTimer);
  pollTimer = null;
}

function createLoginPanel() {
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

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:6px;align-items:center;";
  const loginButton = document.createElement("button");
  loginButton.type = "button";
  loginButton.textContent = "Hugging Face Login";
  loginButton.style.cssText = "padding:4px 8px;cursor:pointer;";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  cancelButton.style.cssText = "padding:4px 8px;cursor:pointer;";
  cancelButton.hidden = true;
  actions.append(loginButton, cancelButton);

  const status = document.createElement("div");
  status.style.cssText = "font-size:11px;opacity:0.85;line-height:1.35;";
  status.textContent = "Checking Hugging Face login status...";

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
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = label;
    }, 1200);
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

  loginButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    loginButton.disabled = true;
    try {
      const force = loginButton.dataset.force === "1";
      applyAll(await readJson(START_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force_relogin: force }),
      }));
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      loginButton.disabled = false;
    }
  });
  cancelButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    cancelButton.disabled = true;
    try {
      applyAll(await readJson(CANCEL_PATH, { method: "POST" }));
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      cancelButton.disabled = false;
    }
  });

  root.append(actions, status, codeRow.row, urlRow.row);
  stopGraphSteal(root);
  stopGraphSteal(loginButton);
  stopGraphSteal(cancelButton);

  const panel = {
    root,
    apply(state) {
      const waiting = state?.status === "waiting";
      const loggedIn = state?.status === "success";
      status.textContent = state?.message || (
        waiting
          ? "Copy the code or URL, then authorize in your browser."
          : "Click Hugging Face Login to authorize gated downloads."
      );
      loginButton.textContent = loggedIn ? "HF Relogin" : "Hugging Face Login";
      loginButton.dataset.force = loggedIn || waiting ? "1" : "0";
      loginButton.disabled = waiting;
      cancelButton.hidden = !waiting;
      if (waiting) {
        codeRow.input.value = state.user_code || "";
        urlRow.input.value = state.url || "";
      } else if (state?.status !== "error") {
        codeRow.input.value = "";
        urlRow.input.value = "";
      }
    },
  };
  return panel;
}

app.registerExtension({
  name: "downloadwhatiwant.hf_login_copy",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_NAMES.has(nodeData?.name) && nodeData?.display_name !== "DownloadWhatIWant") {
      return;
    }
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      const panel = createLoginPanel();
      panels.add(panel);
      this.addDOMWidget("hf_login", "div", panel.root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 132,
      });
      if (Array.isArray(this.size)) {
        this.size = [Math.max(this.size[0] || 0, 380), Math.max(this.size[1] || 0, 220)];
      }
      readJson(`${STATUS_PATH}?refresh=1`).then(applyAll).catch((error) => {
        panel.apply({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return result;
    };
  },
});
