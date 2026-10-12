import {
  defineControlUiPlugin,
  type ControlUiComponentHandle,
  type ControlUiDialogProps,
  type ControlUiView,
} from "openclaw/plugin-sdk/control-ui";
import "./control-ui.css";

type Principal = { kind: "owner" } | { kind: "person"; profileId: string };
type Caller = {
  principal: Principal;
  principalLabel: string;
  ceiling: string[];
  canAdmin: boolean;
  canPair: boolean;
};
type Grant = {
  grantId: string;
  clientName?: string;
  createdAt?: number;
  revokedAt?: number;
  lastUsedAt?: number;
  principal?: Principal;
  principalLabel?: string;
  ceiling?: string[];
};
type Grants = { grants: Grant[]; caller: Caller; relayUrl: string };
type Consent = {
  kind: "oauth" | "link";
  clientName: string;
  redirectHost: string;
  expiresAt: number;
  caller: Caller;
};
type Pairing = { code: string; expiresAt: number; mcpUrl: string };

const READ_WRITE = new Set(["operator.read", "operator.write"]);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  if (className) {
    node.className = className;
  }
  return node;
}

function accessLabel(scopes: readonly string[]) {
  if (scopes.includes("operator.admin")) {
    return "Full access, including administration";
  }
  if (scopes.some((scope) => !READ_WRITE.has(scope))) {
    return "Full role access";
  }
  return scopes.includes("operator.write") ? "Read and write" : "Read only";
}

const mountConnectedApps: ControlUiView = (container, initialContext) => {
  const host = initialContext.host;
  let context = initialContext;
  let snapshot: Grants | undefined;
  let consent: Consent | undefined;
  let requestId = context.props.request ?? "";
  let fullAccess = false;
  let busy = false;
  let error = "";
  let notice = "";
  let generation = 0;
  let available = false;
  let disposed = false;
  let dialog: ControlUiComponentHandle<ControlUiDialogProps> | undefined;
  const page = element("section", undefined, "mcp-connected-apps");
  const overlay = element("div");
  container.append(page, overlay);
  const dates = new Intl.DateTimeFormat(host.locale, { dateStyle: "medium", timeStyle: "short" });
  const canUse = () => host.connection.connected && host.connection.canRead;
  const current = (id: number) =>
    !disposed && !context.signal.aborted && context.presented && canUse() && generation === id;
  const caller = () => consent?.caller ?? snapshot?.caller;
  const chosenCeiling = (full = fullAccess) => {
    const scopes = caller()?.ceiling ?? [];
    return full ? [...scopes] : scopes.filter((scope) => READ_WRITE.has(scope));
  };
  const closeDialog = () => {
    dialog?.dispose();
    dialog = undefined;
  };

  function button(label: string, action: () => void, primary = false) {
    const node = element("button", label, primary ? "btn primary" : "btn");
    node.type = "button";
    node.disabled = busy || !canUse();
    node.addEventListener("click", action);
    return node;
  }

  function field(label: string, value: string) {
    const row = element("div");
    row.append(element("dt", label), element("dd", value));
    return row;
  }

  function accessPicker(
    selectedFull: boolean,
    onChange: (full: boolean) => void,
    groupName = "mcp-relay-consent-access",
  ) {
    const scopes = caller()?.ceiling ?? [];
    const group = element("fieldset", undefined, "mcp-connected-apps__access");
    group.append(element("legend", "App access"));
    const basic = scopes.filter((scope) => READ_WRITE.has(scope));
    const choices = [
      {
        full: false,
        label: accessLabel(basic),
        detail: basic.includes("operator.write")
          ? "Read conversations and send messages within your access."
          : "Read conversations within your access.",
      },
    ];
    if (scopes.some((scope) => !READ_WRITE.has(scope))) {
      choices.push({
        full: true,
        label: "Full role access",
        detail: scopes.includes("operator.admin")
          ? "Includes Gateway administration and approvals. Only allow an app you trust with these actions."
          : "Includes all permissions currently allowed by your role.",
      });
    }
    for (const choice of choices) {
      const label = element("label", undefined, "mcp-connected-apps__choice");
      const input = element("input");
      input.type = "radio";
      input.name = groupName;
      input.value = choice.full ? "full" : "read-write";
      input.checked = selectedFull === choice.full;
      input.disabled = busy;
      input.addEventListener("change", () => {
        onChange(choice.full);
      });
      const copy = element("span");
      copy.append(element("strong", choice.label), element("small", choice.detail));
      label.append(input, copy);
      group.append(label);
    }
    return group;
  }

  async function run(action: (id: number) => Promise<void>) {
    if (busy || !canUse() || !context.presented) {
      return;
    }
    const id = ++generation;
    busy = true;
    error = "";
    notice = "";
    render();
    try {
      await action(id);
    } catch (cause) {
      if (current(id)) {
        error = host.redact(
          cause instanceof Error ? cause.message : "The request failed. Try again.",
        );
      }
    } finally {
      if (current(id)) {
        busy = false;
        render();
      }
    }
  }

  function refresh() {
    closeDialog();
    return run(async (id) => {
      const grants = await host.request<Grants>("mcp-relay.grants", {});
      if (!current(id)) {
        return;
      }
      snapshot = grants;
      consent = undefined;
      if (requestId) {
        const description = await host.request<Consent>("mcp-relay.authorize.describe", {
          requestId,
        });
        if (current(id)) {
          consent = description;
        }
      }
    });
  }

  function showPairing(returnFocusTarget: HTMLElement) {
    let pairingFull = false;
    const content = element("div", undefined, "mcp-connected-apps mcp-connected-apps__dialog");
    let pairing: Pairing | undefined;
    let pairingBusy = false;
    let pairingError = "";
    const draw = () => {
      content.replaceChildren();
      content.append(
        element("h2", "Pair with code"),
        element("p", `Connect an app as ${snapshot?.caller.principalLabel ?? "you"}.`),
      );
      if (pairing) {
        content.append(element("p", "Enter this single-use code on the app’s connection page."));
        content.append(element("code", pairing.code, "mcp-connected-apps__code"));
        content.append(
          element("p", `Expires ${dates.format(pairing.expiresAt)}. Keep this code private.`),
        );
        const url = element("p");
        url.append(element("strong", "MCP URL: "), element("code", pairing.mcpUrl));
        content.append(url);
      } else {
        content.append(
          accessPicker(
            pairingFull,
            (full) => {
              pairingFull = full;
              draw();
            },
            "mcp-relay-pair-access",
          ),
        );
        const create = button(
          pairingBusy ? "Creating code…" : "Create pairing code",
          () => {
            if (pairingBusy || !snapshot?.caller.canPair || !canUse()) {
              return;
            }
            const id = generation;
            const ceiling = chosenCeiling(pairingFull);
            pairingBusy = true;
            pairingError = "";
            draw();
            void host
              .request<Pairing>("mcp-relay.pair", { ceiling })
              .then((result) => {
                if (current(id) && dialog) {
                  pairing = result;
                }
              })
              .catch((cause: unknown) => {
                if (current(id) && dialog) {
                  pairingError = host.redact(
                    cause instanceof Error ? cause.message : "Pairing failed. Try again.",
                  );
                }
              })
              .finally(() => {
                if (current(id) && dialog) {
                  pairingBusy = false;
                  draw();
                }
              });
          },
          true,
        );
        create.disabled = pairingBusy || !chosenCeiling(pairingFull).length;
        content.append(create);
        for (const input of content.querySelectorAll("input")) {
          input.disabled = pairingBusy;
        }
      }
      const dismiss = button(pairing ? "Done" : "Cancel", closeDialog);
      dismiss.disabled = pairingBusy;
      const actions = element("div", undefined, "mcp-connected-apps__actions");
      actions.append(dismiss);
      content.append(actions);
      if (pairingError) {
        const message = element("p", pairingError, "mcp-connected-apps__error");
        message.setAttribute("role", "alert");
        content.append(message);
      }
    };
    draw();
    dialog = host.components.mountDialog(overlay, {
      label: "Pair with code",
      description: `Connect an app as ${snapshot?.caller.principalLabel ?? "you"}.`,
      content,
      returnFocusTarget,
      onCancel: () => {
        if (pairingBusy) {
          return false;
        }
        closeDialog();
        return true;
      },
    });
  }

  function decide(allow: boolean) {
    const approvedRequest = requestId;
    const relayUrl = snapshot?.relayUrl;
    if (!consent || !relayUrl) {
      return;
    }
    const ceiling = chosenCeiling();
    void run(async (id) => {
      const result = await host.request<{ continueUrl: string }>(
        allow ? "mcp-relay.authorize.approve" : "mcp-relay.authorize.deny",
        { requestId: approvedRequest, ...(allow ? { ceiling } : {}) },
      );
      if (!current(id)) {
        return;
      }
      const url = new URL(result.continueUrl);
      if (
        url.origin !== new URL(relayUrl).origin ||
        url.pathname !== "/oauth/continue" ||
        url.username ||
        url.password ||
        url.hash ||
        url.searchParams.get("request") !== approvedRequest
      ) {
        throw new Error(
          "The relay returned an invalid return address. Reopen the app’s connection page.",
        );
      }
      window.location.assign(url.href);
    });
  }

  function render() {
    page.replaceChildren();
    const heading = element("header", undefined, "mcp-connected-apps__header");
    const introduction = element("div");
    introduction.append(
      element("h1", "Connected apps"),
      element("p", "Manage apps connected to your Gateway through the MCP relay."),
    );
    heading.append(
      introduction,
      button("Refresh", () => void refresh()),
    );
    page.append(heading);
    if (!canUse()) {
      page.append(
        element(
          "p",
          host.connection.connected
            ? "Read access is required to view connected apps."
            : "Connect to the Gateway to manage connected apps.",
        ),
      );
      return;
    }
    if (error) {
      const message = element("p", error, "mcp-connected-apps__error");
      message.setAttribute("role", "alert");
      page.append(message);
    }
    const feedback = element(
      "p",
      busy ? "Loading connected apps…" : notice,
      "mcp-connected-apps__feedback",
    );
    feedback.setAttribute("role", "status");
    page.append(feedback);
    if (!snapshot) {
      return;
    }
    if (requestId && consent) {
      const panel = element("section", undefined, "mcp-connected-apps__consent");
      panel.append(
        element(
          "span",
          consent.kind === "link" ? "CONNECT ANOTHER GATEWAY" : "CONNECTION REQUEST",
          "mcp-connected-apps__eyebrow",
        ),
      );
      panel.append(element("h2", `Connect ${consent.clientName}?`));
      const details = element("dl", undefined, "mcp-connected-apps__details");
      details.append(
        field("Approving as", consent.caller.principalLabel),
        field("Returns to", consent.redirectHost),
        field("Request expires", dates.format(consent.expiresAt)),
      );
      panel.append(
        details,
        accessPicker(fullAccess, (full) => {
          fullAccess = full;
        }),
      );
      panel.append(
        element(
          "p",
          "The app can act only within the access you allow and your current Gateway permissions. The relay can see content in transit.",
          "mcp-connected-apps__hint",
        ),
      );
      const actions = element("div", undefined, "mcp-connected-apps__actions");
      const allow = button("Allow", () => decide(true), true);
      allow.disabled = busy || !consent.caller.canPair || !chosenCeiling().length;
      actions.append(
        button("Deny", () => decide(false)),
        allow,
      );
      panel.append(actions);
      if (!consent.caller.canPair) {
        panel.append(
          element(
            "p",
            "Your current Gateway permissions do not allow connecting an app.",
            "mcp-connected-apps__hint",
          ),
        );
      }
      page.append(panel);
    }
    const toolbar = element("div", undefined, "mcp-connected-apps__toolbar");
    toolbar.append(
      element(
        "p",
        snapshot.caller.canAdmin
          ? "All connected apps"
          : `Apps connected as ${snapshot.caller.principalLabel}`,
      ),
    );
    if (snapshot.caller.canPair) {
      const pair = button("Pair with code", () => showPairing(pair), true);
      toolbar.append(pair);
    }
    page.append(toolbar);
    const list = element("div", undefined, "mcp-connected-apps__list");
    if (!snapshot.grants.length) {
      list.append(
        element("h2", "No connected apps yet"),
        element("p", "Sign in with your Gateway from an app, or pair with a single-use code."),
      );
    }
    for (const grant of snapshot.grants) {
      const row = element("article", undefined, "mcp-connected-apps__grant");
      const body = element("div");
      body.append(element("h2", grant.clientName ?? "Revoked app"));
      const own =
        grant.principal?.kind === snapshot.caller.principal.kind &&
        (grant.principal?.kind === "owner" ||
          (snapshot.caller.principal.kind === "person" &&
            grant.principal?.profileId === snapshot.caller.principal.profileId));
      const principalLabel =
        grant.principal?.kind === "owner"
          ? "Gateway owner"
          : (grant.principalLabel ??
            (own
              ? snapshot.caller.principalLabel
              : grant.principal
                ? "Another person"
                : "Unknown principal"));
      body.append(
        element(
          "p",
          grant.ceiling
            ? `${principalLabel} · ${accessLabel(grant.ceiling)}`
            : "Revoked grant; app details unavailable",
          "mcp-connected-apps__hint",
        ),
      );
      const activity =
        grant.revokedAt !== undefined
          ? `Revoked ${dates.format(grant.revokedAt)}`
          : grant.lastUsedAt !== undefined
            ? `Last used ${dates.format(grant.lastUsedAt)}`
            : grant.createdAt !== undefined
              ? `Connected ${dates.format(grant.createdAt)} · Not used yet`
              : "Revoked";
      body.append(element("small", activity));
      row.append(body);
      if (grant.revokedAt !== undefined) {
        row.append(element("span", "Revoked", "mcp-connected-apps__badge"));
      } else if ((own || snapshot.caller.canAdmin) && host.connection.canWrite) {
        row.append(
          button("Revoke", () => {
            void run(async (id) => {
              await host.request("mcp-relay.revoke", { grantId: grant.grantId });
              if (!current(id)) {
                return;
              }
              const result = await host.request<Grants>("mcp-relay.grants", {});
              if (current(id)) {
                snapshot = result;
                notice = `${grant.clientName ?? "App"} revoked. Its MCP and embedded UI access has ended.`;
              }
            });
          }),
        );
      }
      list.append(row);
    }
    page.append(list);
    page.append(
      element(
        "p",
        "Revoking an app ends its MCP access and embedded browser sessions. Reconnect the app to grant access again.",
        "mcp-connected-apps__hint",
      ),
    );
  }

  function sync() {
    const nextRequest = context.props.request ?? "";
    const next = canUse() && context.presented && !context.signal.aborted;
    if (next !== available || nextRequest !== requestId) {
      available = next;
      requestId = nextRequest;
      generation += 1;
      busy = false;
      snapshot = undefined;
      consent = undefined;
      fullAccess = false;
      error = "";
      notice = "";
      closeDialog();
      if (next) {
        void refresh();
        return;
      }
    }
    render();
  }
  const unsubscribe = host.subscribe(sync);
  sync();
  return {
    update(next) {
      context = next;
      sync();
    },
    dispose() {
      disposed = true;
      generation += 1;
      closeDialog();
      unsubscribe();
      page.remove();
      overlay.remove();
    },
  };
};

export default defineControlUiPlugin({
  id: "mcp-relay",
  activate(host) {
    return host.ui.registerPage({
      id: "connected-apps",
      label: "Connected apps",
      mount: mountConnectedApps,
    });
  },
});
