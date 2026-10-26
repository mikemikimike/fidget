
import assert from "node:assert/strict";
import { test } from "node:test";

test("exported showError creates retry button that invokes onRetry callback", async () => {
  const { showError } = await import("../src/settings.js");

  const panelChildren = [];
  const buttonChildren = [];

  const mockPanel = {
    replaceChildren: () => {
      panelChildren.length = 0;
    },
    appendChild(node) {
      panelChildren.push(node);
    },
  };

  const mockFooter = { replaceChildren: () => {}, style: {} };

  const mockDocument = {
    querySelector(selector) {
      if (selector === '[role="tabpanel"]') return mockPanel;
      return null;
    },
    getElementById(id) {
      if (id === "set-footer") return mockFooter;
      return null;
    },
    createElement(tag) {
      const element = {
        tagName: tag.toUpperCase(),
        textContent: "",
        className: "",
        style: { cssText: "", marginBottom: "" },
        type: "",
        children: buttonChildren,
        appendChild(child) {
          buttonChildren.push(child);
        },
        addEventListener(event, handler) {
          if (event === "click") {
            element._clickHandler = handler;
          }
        },
      };
      return element;
    },
  };

  globalThis.document = mockDocument;

  let retryCalled = false;
  showError("Could not load settings", () => {
    retryCalled = true;
  });

  delete globalThis.document;

  assert.ok(panelChildren.length > 0, "Should append error to panel");
  const errorDiv = panelChildren[0];
  assert.equal(errorDiv.tagName, "DIV", "Exported showError creates DIV wrapper");
  assert.equal(errorDiv.className, "set-error", "Should have set-error class");

  const retryButton = buttonChildren.find((el) => el.tagName === "BUTTON");
  assert.ok(retryButton, "Should create a retry button");
  assert.equal(retryButton.textContent, "Retry", "Button should say 'Retry'");
  assert.equal(retryButton.type, "button", "Button type should be 'button'");

  assert.equal(retryCalled, false, "Retry not called yet");
  if (retryButton._clickHandler) {
    retryButton._clickHandler();
  }
  assert.equal(retryCalled, true, "Clicking retry button should invoke onRetry callback");

  // Exported showError does not set the panel role to alert, and it builds a
  // retry button. The timeout path uses a bare paragraph and no retry, so a
  // shared renderer would hide which function ran.
});

test("__TAURI__ appears mid-poll after some failed attempts (Windows race)", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"], now: 0 });

  const eventListeners = [];
  const mockPanel = {
    setAttribute: () => {},
    querySelector: () => null,
    firstChild: null,
    removeChild: () => {},
  };

  const mockDocument = {
    querySelector(selector) {
      if (selector === '[role="tabpanel"]') return mockPanel;
      if (selector === '[role="tablist"]') return null;
      return null;
    },
    getElementById: () => null,
    addEventListener(event, handler) {
      eventListeners.push({ event, handler });
    },
    documentElement: {
      dataset: {},
      classList: { add() {}, remove() {} },
    },
  };

  const mockWindow = {
    __TAURI__: undefined, // Initially undefined
    document: mockDocument,
    addEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  };

  globalThis.window = mockWindow;
  globalThis.document = mockDocument;

  const timestamp = Date.now();
  await import(`../src/settings.js?t=${timestamp}`);

  assert.equal(eventListeners.length, 0, "Should not initialize when __TAURI__ is missing");

  t.mock.timers.tick(1000);
  assert.equal(eventListeners.length, 0, "Should still not initialize after failed polls");

  // WebView2 injects `__TAURI__` after the page has already polled.
  mockWindow.__TAURI__ = {
    core: { invoke: async () => ({ form: { tabs: [] }, view: {}, reveal: null }) },
    event: { listen: async () => () => {} },
    webviewWindow: {
      getCurrentWebviewWindow: () => ({
        label: "settings",
        startDragging: () => {},
        close: () => {},
      }),
    },
  };

  t.mock.timers.tick(100);

  delete globalThis.window;
  delete globalThis.document;

  assert.ok(
    eventListeners.length > 0,
    "Should initialize after __TAURI__ appears mid-poll (Windows race condition)",
  );
  assert.ok(
    eventListeners.some((l) => l.event === "mousedown"),
    "Should register mousedown listener after delayed init",
  );
  assert.ok(
    eventListeners.some((l) => l.event === "keydown"),
    "Should register keydown listeners after delayed init",
  );
});

test("initializeWithTauri registers event listeners when __TAURI__ present", async (t) => {

  const eventListeners = [];
  const mockPanel = {
    setAttribute: () => {},
    querySelector: () => null,
    firstChild: null,
    removeChild: () => {},
  };

  const mockDocument = {
    querySelector(selector) {
      if (selector === '[role="tabpanel"]') return mockPanel;
      if (selector === '[role="tablist"]') return null; // No tabs = simpler test
      return null;
    },
    getElementById: () => null,
    addEventListener(event, handler) {
      eventListeners.push({ event, handler });
    },
    documentElement: {
      dataset: {},
      classList: { add() {}, remove() {} },
    },
  };

  const invokeResults = [];
  const mockWindow = {
    __TAURI__: {
      core: {
        invoke: async (cmd) => {
          invokeResults.push(cmd);
          return { form: { tabs: [] }, view: {}, reveal: null };
        },
      },
      event: { listen: async () => () => {} },
      webviewWindow: {
        getCurrentWebviewWindow: () => ({
          label: "settings",
          startDragging: () => {},
          close: () => {},
        }),
      },
    },
    document: mockDocument,
    addEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  };

  globalThis.window = mockWindow;
  globalThis.document = mockDocument;

  const timestamp = Date.now();
  const { controls } = await import(`../src/settings.js?t=${timestamp}`);

  delete globalThis.window;
  delete globalThis.document;

  assert.ok(
    eventListeners.some((l) => l.event === "mousedown"),
    "Should register mousedown for alt-drag when __TAURI__ is available",
  );

  assert.ok(
    eventListeners.some((l) => l.event === "keydown"),
    "Should register keydown for Escape/Enter when __TAURI__ is available",
  );

  assert.equal(typeof controls, "function", "Should export controls function from settings.js");
});

test("showTauriTimeoutError sets role=alert and shows no-retry message", async (t) => {

  t.mock.timers.enable({ apis: ["setInterval"], now: 0 });

  const setAttributeCalls = [];
  const panelChildren = [];

  const mockPanel = {
    setAttribute(attr, value) {
      setAttributeCalls.push({ attr, value });
    },
    firstChild: null,
    removeChild: () => {},
    appendChild(child) {
      panelChildren.push(child);
    },
    querySelector: () => null,
    style: {},
  };

  const mockDocument = {
    querySelector(selector) {
      if (selector === '[role="tabpanel"]') return mockPanel;
      if (selector === '[role="tablist"]') return null;
      return null;
    },
    getElementById: () => null,
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        textContent: "",
        style: {},
      };
    },
    addEventListener: () => {},
    documentElement: {
      dataset: {},
      classList: { add() {}, remove() {} },
    },
  };

  const mockWindow = {
    __TAURI__: undefined, // Never becomes available
    document: mockDocument,
    addEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  };

  globalThis.window = mockWindow;
  globalThis.document = mockDocument;

  const timestamp = Date.now();
  await import(`../src/settings.js?t=${timestamp}`);

  t.mock.timers.tick(5000);

  delete globalThis.window;
  delete globalThis.document;

  assert.ok(
    setAttributeCalls.some((c) => c.attr === "role" && c.value === "alert"),
    "Timeout error should set panel role=alert (different from exported showError)",
  );

  assert.ok(panelChildren.length > 0, "Should append timeout error message");

  const errorText = panelChildren.find((el) => el.tagName === "P");
  assert.ok(errorText, "Should create <p> element for error");
  assert.ok(
    errorText.textContent.includes("Tauri API is not available"),
    "Should explain what's missing",
  );
  assert.ok(
    errorText.textContent.includes("restart"),
    "Should suggest recovery action",
  );

  // The timeout path has no retry button, unlike exported showError. A retry
  // here would mean the wrong function ran.
});
