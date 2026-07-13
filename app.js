/* OpenAB Setup Wizard — prototype
 * Renders a form from SCHEMA (schema.js), keeps state, and live-renders:
 *   - config.toml     (secrets as named refs in [secrets.refs] or ${ENV_VAR})
 *   - secret artifact (.env / docker / K8s Secret — placeholders only)
 *   - run instructions
 * Fully client-side. No network calls.
 *
 * Secret model:
 *   [secrets.refs]
 *   github_token = "aws-sm://oab#OAB_BX_GITHUB_PAT_RO"
 *
 *   [discord]
 *   bot_token = "secret://github_token"   <- dragged from the palette
 *   # or the plain-env alternative:
 *   bot_token = "${DISCORD_BOT_TOKEN}"    <- "literal default" button
 */

"use strict";

// ---------------------------------------------------------------- state

const state = {
  lang: localStorage.getItem("oab-wizard-lang") || "zh",
  botName: "my-openab-bot",
  platforms: {}, // id -> { enabled: bool, values: { key -> value } }
  agent: { preset: "default", command: "", args: "", working_dir: "", env: [] },
  pool: {},
  deployTarget: "k8s",
  // named secret refs: name -> source URI (aws-sm:// or exec://)
  secretRefs: [],
};

// platforms + feature sections (e.g. [stt]) share the same machinery
const SECTIONS = [...SCHEMA.platforms, ...(SCHEMA.features || [])];

for (const p of SECTIONS) {
  const values = {};
  for (const f of p.fields) values[f.key] = defaultValue(f);
  state.platforms[p.id] = { enabled: p.id === "discord", values };
}
for (const f of SCHEMA.pool) state.pool[f.key] = f.default;

function defaultValue(f) {
  switch (f.type) {
    // secret: mode "env" (plain ${VAR}) or "ref" (named [secrets.refs] entry)
    case "secret": return { use: !!f.required, mode: "env", env: f.env, ref: null };
    case "bool": return f.default ?? false;
    case "enum": return f.default ?? optValue(f.options[0]);
    case "number": return f.default ?? 0;
    case "list": return [];
    default: return f.default ?? "";
  }
}

// ---------------------------------------------------------------- i18n helpers

function T(s) {
  if (s == null) return "";
  if (typeof s === "string") return s;
  return s[state.lang] ?? s.en;
}

function S(key) {
  return UI_STRINGS[state.lang]?.[key] ?? UI_STRINGS.en[key] ?? key;
}

function optValue(o) { return typeof o === "string" ? o : o.value; }
function optLabel(o) { return typeof o === "string" ? o : T(o.label); }

// ---------------------------------------------------------------- dom helpers

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

function titleCase(key) {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function tomlString(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tomlValue(v) {
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlString).join(", ")}]`;
  return tomlString(v);
}

// ref names are TOML bare keys: lower snake_case
function sanitizeRefName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
}

function findRef(name) {
  return state.secretRefs.find((r) => r.name === name);
}

// ${secrets.<name>} interpolation — the one ref syntax, used in secret
// fields and inside [agent] env values alike
const SECRET_INTERP = /\$\{secrets\.([a-z0-9_]+)\}/g;
const secretInterp = (name) => `\${secrets.${name}}`;

function agentEnvRefNames() {
  const names = [];
  for (const r of state.agent.env) {
    for (const m of String(r.value).matchAll(SECRET_INTERP)) names.push(m[1]);
  }
  return names;
}

// ---------------------------------------------------------------- secret collection

// Walk enabled secret fields; classify what each deployment needs.
function collectSecretNeeds() {
  const envVars = [];   // { env, from, help } — need a real env var delivered
  const smRefs = [];    // { name, source } — aws-sm://, fetched at runtime
  const execRefs = [];  // { name, source } — exec://, resolved by a script in the image
  const seenEnv = new Set();
  const seenRef = new Set();

  const pushEnv = (env, from, help = "") => {
    if (seenEnv.has(env)) return;
    seenEnv.add(env);
    envVars.push({ env, from, help });
  };

  const classifyRef = (r) => {
    if (seenRef.has(r.name)) return;
    seenRef.add(r.name);
    if (r.source.startsWith("aws-sm://")) smRefs.push(r);
    else execRefs.push(r);
  };

  for (const p of SECTIONS) {
    if (!state.platforms[p.id].enabled) continue;
    for (const f of p.fields) {
      if (f.type !== "secret") continue;
      const v = state.platforms[p.id].values[f.key];
      if (!(f.required || v.use)) continue;
      if (v.mode === "env") {
        pushEnv(v.env, T(p.label), T(f.help) || "");
      } else {
        const r = findRef(v.ref);
        if (r) classifyRef(r);
      }
    }
  }

  const preset = SCHEMA.agents.find((a) => a.id === state.agent.preset);
  for (const k of preset?.envKeys || []) pushEnv(k, `agent (${T(preset.label)})`);

  // refs interpolated inside [agent] env values
  for (const n of agentEnvRefNames()) {
    const r = findRef(n);
    if (r) classifyRef(r);
  }

  return { envVars, smRefs, execRefs };
}

// refs actually used by enabled fields (for the [secrets.refs] section)
function usedRefs() {
  const used = new Map();
  for (const p of SECTIONS) {
    if (!state.platforms[p.id].enabled) continue;
    for (const f of p.fields) {
      if (f.type !== "secret") continue;
      const v = state.platforms[p.id].values[f.key];
      if ((f.required || v.use) && v.mode === "ref") {
        const r = findRef(v.ref);
        if (r) used.set(r.name, r.source);
      }
    }
  }
  for (const n of agentEnvRefNames()) {
    const r = findRef(n);
    if (r) used.set(r.name, r.source);
  }
  return used;
}

// ---------------------------------------------------------------- TOML generation

function generateToml() {
  const lines = [];
  lines.push(`# Generated by oab-wizard — https://github.com/openabdev/openab`);
  lines.push(`# Sensitive values use named refs from [secrets.refs] (\${secrets.<name>})`);
  lines.push(`# or plain \${ENV_VAR} expansion. No credential values live in this file.`);
  lines.push("");

  // [secrets.refs] — only refs actually used
  const refs = usedRefs();
  if (refs.size > 0) {
    lines.push("[secrets.refs]");
    for (const [name, source] of refs) lines.push(`${name} = ${tomlString(source)}`);
    lines.push("");
  }

  let anyPlatform = false;
  for (const p of SECTIONS) {
    const ps = state.platforms[p.id];
    if (!ps.enabled) continue;
    if (!p.feature) anyPlatform = true;
    lines.push(`[${p.id}]`);
    if (p.emitEnabled) lines.push("enabled = true");
    for (const f of p.fields) {
      const v = ps.values[f.key];
      if (f.type === "secret") {
        if (!(f.required || v.use)) continue;
        if (v.mode === "ref" && findRef(v.ref)) {
          lines.push(`${f.key} = "${secretInterp(v.ref)}"`);
        } else {
          lines.push(`${f.key} = "\${${v.env}}"`);
        }
        continue;
      }
      if (f.type === "list") {
        if (v.length > 0) lines.push(`${f.key} = ${tomlValue(v)}`);
        continue;
      }
      if (f.default !== undefined && v === f.default) continue;
      if (v === "" || v === null) continue;
      lines.push(`${f.key} = ${tomlValue(v)}`);
    }
    lines.push("");
  }

  if (!anyPlatform) {
    lines.push("# ⚠ No platform enabled — enable at least one adapter above.");
    lines.push("");
  }

  // [agent] — emitted when the user picks a backend and/or defines env vars;
  // "auto-detect" with no env omits the section (the docker image decides)
  const preset = SCHEMA.agents.find((a) => a.id === state.agent.preset);
  const envRows = state.agent.env.filter((r) => r.key.trim());
  if (state.agent.preset !== "default" || envRows.length > 0) {
    lines.push("[agent]");
    if (state.agent.preset !== "default") {
      const cmd = state.agent.preset === "custom" ? state.agent.command : preset.command;
      const args = state.agent.preset === "custom"
        ? state.agent.args.split(/\s+/).filter(Boolean)
        : preset.args;
      const wd = state.agent.preset === "custom" ? state.agent.working_dir : preset.working_dir;
      lines.push(`command = ${tomlString(cmd || "kiro-cli")}`);
      if (args.length) lines.push(`args = ${tomlValue(args)}`);
      if (wd) lines.push(`working_dir = ${tomlString(wd)}`);
    }
    // env: preset keys first, user rows override/extend
    const envMap = new Map();
    if (state.agent.preset !== "default") {
      for (const k of preset?.envKeys || []) envMap.set(k, `\${${k}}`);
    }
    for (const r of envRows) envMap.set(r.key.trim(), String(r.value));
    if (envMap.size > 0) {
      const pairs = [...envMap].map(([k, val]) => `${k} = ${tomlString(val)}`).join(", ");
      lines.push(`env = { ${pairs} }`);
    }
    if (preset?.note && state.agent.preset !== "default") lines.push(`# ${preset.note}`);
    lines.push("");
  }

  // [pool] — only if non-default
  const poolLines = [];
  for (const f of SCHEMA.pool) {
    if (state.pool[f.key] !== f.default) poolLines.push(`${f.key} = ${state.pool[f.key]}`);
  }
  if (poolLines.length) lines.push("[pool]", ...poolLines, "");

  return lines.join("\n");
}

// ---------------------------------------------------------------- secret artifacts

function generateSecrets() {
  const { envVars, smRefs, execRefs } = collectSecretNeeds();
  if (envVars.length === 0 && smRefs.length === 0 && execRefs.length === 0) {
    return "# No secrets required by the current configuration.\n";
  }
  const name = state.botName || "my-openab-bot";
  const lines = [];

  if (smRefs.length > 0) {
    lines.push("# ── AWS Secrets Manager refs — resolved by openab at boot ──");
    lines.push("# Nothing to deliver as env vars; grant the runtime identity");
    lines.push("# (task role / IRSA / instance profile) secretsmanager:GetSecretValue on:");
    for (const r of smRefs) lines.push(`#   ${r.name}  ->  ${r.source}`);
    lines.push("");
  }
  if (execRefs.length > 0) {
    lines.push("# ── exec:// refs — resolved by running a script at boot ──");
    lines.push("# The script must exist inside the container image / runtime:");
    for (const r of execRefs) lines.push(`#   ${r.name}  ->  ${r.source}`);
    lines.push("");
  }

  if (envVars.length === 0) {
    lines.push("# No environment variables needed — all secrets are runtime refs.");
    return lines.join("\n");
  }

  if (state.deployTarget === "ecsctl") {
    lines.push("# Store env-delivered secrets in AWS Secrets Manager, one per variable");
    lines.push("# (referenced from service.yaml's `secrets:` map — see the run tab):");
    lines.push("");
    for (const e of envVars) {
      lines.push(`# ${e.from}${e.help ? " — " + e.help : ""}`);
      lines.push(`aws secretsmanager create-secret --name ${name}/${e.env} \\`);
      lines.push(`  --secret-string 'CHANGE_ME'`);
      lines.push("");
    }
    lines.push("# Tip: prefer aws-sm:// refs in [secrets.refs] instead — then openab");
    lines.push("# resolves them at runtime and no ECS secrets plumbing is needed at all.");
    return lines.join("\n");
  }

  if (state.deployTarget === "docker") {
    lines.push("# Fill a local .env file (never commit it), then:");
    lines.push("");
    lines.push(`docker run -d --name ${name} \\`);
    lines.push("  --env-file .env \\");
    lines.push(`  -v ./config.toml:/etc/openab/config.toml:ro \\`);
    lines.push("  ghcr.io/openabdev/openab:latest");
    lines.push("");
    lines.push("# .env contents:");
    for (const e of envVars) lines.push(`#   ${e.env}=...`);
    return lines.join("\n");
  }

  // k8s
  lines.push("# Kubernetes Secret — create it out-of-band so secret values never");
  lines.push("# enter Helm values (the chart mounts it via agents.<name>.envFrom).");
  lines.push("#");
  lines.push("# Option A (recommended): create directly, nothing touches disk:");
  lines.push("#");
  lines.push(`#   kubectl create secret generic ${name}-secrets \\`);
  for (const e of envVars) lines.push(`#     --from-literal=${e.env}=CHANGE_ME \\`);
  lines[lines.length - 1] = lines[lines.length - 1].replace(/ \\$/, "");
  lines.push("#");
  lines.push("# Option B: apply this manifest (fill values first, do NOT commit):");
  lines.push("");
  lines.push("apiVersion: v1");
  lines.push("kind: Secret");
  lines.push("metadata:");
  lines.push(`  name: ${name}-secrets`);
  lines.push("stringData:");
  for (const e of envVars) lines.push(`  ${e.env}: CHANGE_ME`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- run instructions

function generateRun() {
  const name = state.botName || "my-openab-bot";
  const t = state.deployTarget;
  const { envVars, smRefs } = collectSecretNeeds();
  const needEnv = envVars.length > 0;

  if (t === "ecsctl") {
    const lines = [
      "# ecsctl — declarative ECS Fargate deploy (https://github.com/oablab/ecsctl)",
      "# Config is fetched at boot via configUrl (openab run -c <url>) — the",
      "# platform-agnostic path; no ConfigMap/volume plumbing.",
      "",
      "# 1. Upload config.toml to S3:",
      `aws s3 cp ./config.toml s3://YOUR_BUCKET/${name}/config.toml`,
      "",
      "# 2. service.yaml:",
      "apiVersion: ecsctl/v1",
      "kind: Service",
      "metadata:",
      `  name: ${name}`,
      "  cluster: YOUR_CLUSTER",
      "spec:",
      "  image: ghcr.io/openabdev/openab:latest",
      '  cpu: "1024"',
      '  memory: "2048"',
      "  capacity: FARGATE_SPOT",
      "  execEnabled: true",
      `  logGroup: /ecs/${name}`,
      '  command: ["openab", "run", "-c", "s3://YOUR_BUCKET/' + name + '/config.toml"]',
      "  taskRoleArn: arn:aws:iam::ACCOUNT_ID:role/YOUR_TASK_ROLE",
    ];
    if (needEnv) {
      lines.push("  secrets:  # ECS injects these as env vars at task start");
      for (const e of envVars) {
        lines.push(`    ${e.env}: arn:aws:secretsmanager:REGION:ACCOUNT_ID:secret:${name}/${e.env}`);
      }
    }
    if (smRefs.length > 0) {
      lines.push("  # aws-sm:// refs resolve at runtime via the task role — grant it");
      lines.push("  # secretsmanager:GetSecretValue on:");
      for (const r of smRefs) lines.push(`  #   ${r.source}`);
    }
    lines.push("");
    lines.push("# 3. Deploy:");
    lines.push("ecsctl apply -f service.yaml --wait");
    lines.push("");
    lines.push("# Logs / shell:");
    lines.push(`ecsctl log ${name} -n 50`);
    lines.push(`ecsctl exec ${name} /bin/bash`);
    lines.push("");
    lines.push("# Config changes: update the S3 object, then restart:");
    lines.push(`#   aws s3 cp ./config.toml s3://YOUR_BUCKET/${name}/config.toml`);
    lines.push(`#   ecsctl restart ${name}`);
    return lines.join("\n");
  }

  if (t === "docker") {
    const lines = ["# 1. Save config.toml in the current directory"];
    if (needEnv) lines.push("# 2. Create .env with real values (secrets tab)");
    lines.push(`# ${needEnv ? 3 : 2}. Run:`);
    lines.push(`docker run -d --name ${name} \\`);
    if (needEnv) lines.push("  --env-file .env \\");
    if (smRefs.length > 0) {
      lines.push("  -v ~/.aws:/home/agent/.aws:ro \\  # or task-role/env AWS credentials");
    }
    lines.push("  -v ./config.toml:/etc/openab/config.toml:ro \\");
    lines.push("  ghcr.io/openabdev/openab:latest");
    lines.push("");
    lines.push("# Logs:");
    lines.push(`docker logs -f ${name}`);
    return lines.join("\n");
  }

  // k8s
  const lines = [];
  let step = 1;
  if (needEnv) lines.push(`# ${step++}. Create the Secret (secrets tab, Option A)`);
  lines.push(`# ${step++}. Save config.toml locally (Download button), then install —`);
  lines.push("#    the chart takes your config.toml verbatim via configToml:");
  lines.push("helm repo add openab https://openabdev.github.io/openab");
  lines.push("helm repo update");
  lines.push("");
  const helmLines = [
    `helm install ${name} openab/openab \\`,
    "  --set-file agents.main.configToml=./config.toml",
  ];
  if (needEnv) {
    helmLines[1] += " \\";
    helmLines.push(`  --set agents.main.envFrom[0].secretRef.name=${name}-secrets`);
  }
  if (smRefs.length > 0) {
    helmLines[helmLines.length - 1] += " \\";
    helmLines.push("  --set serviceAccountName=openab  # SA with IRSA/Pod Identity granting");
    helmLines.push("                                   # secretsmanager:GetSecretValue (aws-sm:// refs)");
  }
  lines.push(...helmLines);
  lines.push("");
  lines.push("# Logs:");
  lines.push(`kubectl logs -f deploy/${name}-openab-main`);
  lines.push("");
  lines.push("# Config changes: edit config.toml, then");
  lines.push(`#   helm upgrade ${name} openab/openab --reuse-values \\`);
  lines.push("#     --set-file agents.main.configToml=./config.toml");
  return lines.join("\n");
}

// ---------------------------------------------------------------- chrome (header)

function renderChrome() {
  document.getElementById("app-title").textContent = S("title");
  const tag = document.getElementById("tagline");
  tag.textContent = "";
  tag.append(
    S("tagline_1"), el("code", {}, "config.toml"),
    S("tagline_2"), el("strong", {}, S("tagline_3")),
    S("tagline_4"), el("code", {}, "${secrets.…}"),
    S("tagline_5"),
  );
  for (const b of document.querySelectorAll(".lang-btn")) {
    b.classList.toggle("active", b.dataset.lang === state.lang);
  }
  document.getElementById("copy-btn").textContent = S("copy");
  document.getElementById("download-btn").textContent = S("download");
  document.documentElement.lang = state.lang === "zh" ? "zh-Hant" : "en";
}

// ---------------------------------------------------------------- form rendering

function keyHint(key) {
  return el("code", { class: "key-hint" }, key);
}

function renderSecretPalette() {
  const chips = el("div", { class: "chip-row" },
    state.secretRefs.length === 0 ? el("p", { class: "help" }, S("noRefs")) : null,
    ...state.secretRefs.map((r) =>
      el("span", {
        class: "chip", draggable: "true", title: r.source,
        ondragstart: (e) => {
          e.dataTransfer.setData("text/plain", r.name);
          e.dataTransfer.effectAllowed = "copy";
        },
      },
        el("span", { class: "chip-name" }, r.name),
        el("span", { class: "chip-eq" }, "="),
        el("span", { class: "chip-src" }, r.source),
        el("button", {
          class: "chip-x", title: S("clear"),
          onclick: () => {
            state.secretRefs = state.secretRefs.filter((x) => x.name !== r.name);
            // fields using this ref revert to plain-env mode
            for (const p of SECTIONS)
              for (const f of p.fields) {
                if (f.type !== "secret") continue;
                const v = state.platforms[p.id].values[f.key];
                if (v.mode === "ref" && v.ref === r.name) {
                  v.mode = "env"; v.ref = null;
                  if (!f.required) v.use = false;
                }
              }
            renderForm(); refresh();
          },
        }, "×"),
      ),
    ),
  );

  const nameInput = el("input", {
    type: "text", class: "ref-input name", placeholder: "github_token",
    spellcheck: "false",
    onkeydown: (e) => { if (e.key === "Enter") addRef(); },
  });
  const srcInput = el("input", {
    type: "text", class: "ref-input src", placeholder: "aws-sm://oab#GITHUB_TOKEN",
    spellcheck: "false",
    oninput: (e) => e.target.classList.remove("invalid"),
    onkeydown: (e) => { if (e.key === "Enter") addRef(); },
  });

  const addRef = () => {
    const name = sanitizeRefName(nameInput.value);
    const source = srcInput.value.trim();
    // openab supports exactly two providers (openab-core/src/secrets.rs)
    const valid = source.startsWith("aws-sm://") || source.startsWith("exec://");
    if (!name || !source || !valid || findRef(name)) {
      if (source && !valid) srcInput.classList.add("invalid");
      return;
    }
    state.secretRefs.push({ name, source });
    nameInput.value = ""; srcInput.value = "";
    addingRef = false;
    renderForm(); refresh();
  };

  // key = value inputs appear only after clicking "Add a new entry"
  const addArea = addingRef
    ? el("div", { class: "ref-add" },
        nameInput,
        el("span", { class: "env-prefix" }, "="),
        srcInput,
        el("button", { class: "add-btn", onclick: addRef }, S("add")),
        el("button", {
          class: "icon-btn danger", title: S("cancel"), "aria-label": S("cancel"),
          onclick: () => { addingRef = false; renderForm(); },
        }, "×"),
      )
    : el("button", {
        class: "add-btn", onclick: () => { addingRef = true; renderForm(); },
      }, S("addEntry"));

  return el("div", { class: "palette" },
    el("p", { class: "help" }, S("secretRefsHelp")),
    chips,
    addArea,
    addingRef ? el("p", { class: "help" }, S("refSchemes")) : null,
  );
}

// accordion: id of the single expanded section (null = all collapsed)
let expandedSection = null;

function accordion(id, titleNodes, body) {
  const open = expandedSection === id;
  const head = el("div", {
    class: "section-head", role: "button", tabindex: "0",
    "aria-expanded": String(open),
    onclick: () => { expandedSection = open ? null : id; renderForm(); },
    onkeydown: (e) => {
      if (e.key === "Enter" || e.key === " ") { expandedSection = open ? null : id; renderForm(); }
    },
  },
    el("span", { class: "chev" }, open ? "▾" : "▸"),
    ...titleNodes,
  );
  return el("div", { class: "section" + (open ? " open" : "") },
    head,
    open ? el("div", { class: "section-body" }, body) : null,
  );
}

function renderForm() {
  const root = document.getElementById("form-root");
  root.textContent = "";

  // Basics: bot name + deploy target
  root.append(accordion("general", [el("span", { class: "section-title" }, S("general"))],
    el("div", {},
      el("div", { class: "field" },
        el("label", {}, S("botName")),
        el("input", {
          type: "text", value: state.botName,
          oninput: (e) => { state.botName = e.target.value.trim(); refresh(); },
        }),
        el("p", { class: "help" }, S("botNameHelp")),
      ),
      el("div", { class: "field" },
        el("label", {}, S("deployTarget")),
        el("div", { class: "radio-row" },
          ...SCHEMA.deployTargets.map((t) =>
            el("label", { class: "radio" },
              el("input", {
                type: "radio", name: "deploy", value: t.id,
                ...(state.deployTarget === t.id ? { checked: "" } : {}),
                onchange: () => { state.deployTarget = t.id; refresh(); },
              }),
              T(t.label),
            ),
          ),
        ),
      ),
    ),
  ));

  // Secret refs palette
  root.append(accordion("refs",
    [el("span", { class: "section-title" }, S("secretRefs")),
     el("span", { class: "count-badge" }, String(state.secretRefs.length))],
    renderSecretPalette()));

  // Platforms + feature sections
  for (const p of SECTIONS) {
    const ps = state.platforms[p.id];
    const body = el("div", {});
    for (const f of p.fields) body.append(renderField(p, f));

    root.append(accordion(p.id,
      [el("label", { class: "toggle", onclick: (e) => e.stopPropagation() },
        el("input", {
          type: "checkbox", ...(ps.enabled ? { checked: "" } : {}),
          onchange: (e) => {
            ps.enabled = e.target.checked;
            if (ps.enabled) expandedSection = p.id; // enabling opens the section
            renderForm(); refresh();
          },
        }),
       ),
       el("span", { class: "section-title" + (ps.enabled ? "" : " off") }, T(p.label))],
      body));
  }

  // Agent
  const preset = SCHEMA.agents.find((a) => a.id === state.agent.preset);
  const agentBody = el("div", {},
    el("div", { class: "field" },
      el("label", {}, S("agentBackend")),
      el("select", {
        onchange: (e) => { state.agent.preset = e.target.value; renderForm(); refresh(); },
      }, ...SCHEMA.agents.map((a) =>
        el("option", { value: a.id, ...(a.id === state.agent.preset ? { selected: "" } : {}) }, T(a.label)),
      )),
      preset?.note ? el("p", { class: "help" }, preset.note) : null,
    ),
  );
  if (state.agent.preset === "custom") {
    agentBody.append(
      labeledInput(S("command"), el("input", {
        type: "text", value: state.agent.command, placeholder: "my-agent",
        oninput: (e) => { state.agent.command = e.target.value; refresh(); },
      })),
      labeledInput(S("argsLabel"), el("input", {
        type: "text", value: state.agent.args, placeholder: "acp --flag",
        oninput: (e) => { state.agent.args = e.target.value; refresh(); },
      })),
      labeledInput(S("workingDir"), el("input", {
        type: "text", value: state.agent.working_dir, placeholder: "/home/agent",
        oninput: (e) => { state.agent.working_dir = e.target.value; refresh(); },
      })),
    );
  }
  agentBody.append(renderAgentEnv());
  root.append(accordion("agent", [el("span", { class: "section-title" }, S("agent"))], agentBody));

  // Pool
  const poolBody = el("div", {});
  for (const f of SCHEMA.pool) {
    poolBody.append(el("div", { class: "field" },
      el("label", {}, T(f.label) || titleCase(f.key), keyHint(f.key)),
      el("input", {
        type: "number", value: state.pool[f.key], min: "0",
        oninput: (e) => { state.pool[f.key] = Number(e.target.value); refresh(); },
      }),
    ));
  }
  root.append(accordion("pool", [el("span", { class: "section-title" }, S("pool"))], poolBody));
}

function labeledInput(label, input) {
  return el("div", { class: "field" }, el("label", {}, label), input);
}

// transient UI state: secret fields currently in "edit" mode (picker visible)
const editingFields = new Set();
// transient UI state: whether the palette's add-entry inputs are visible
let addingRef = false;

function renderAgentEnv() {
  const rows = el("div", { class: "env-rows" },
    ...state.agent.env.map((row, i) => {
      const valInput = el("input", {
        type: "text", class: "env-val", value: row.value,
        placeholder: state.lang === "zh" ? "值，或拖入密鑰參照" : "value, or drop a secret ref",
        spellcheck: "false",
        oninput: (e) => { row.value = e.target.value; refresh(); },
        ondragover: (e) => { e.preventDefault(); valInput.classList.add("dragover"); },
        ondragleave: () => valInput.classList.remove("dragover"),
        ondrop: (e) => {
          e.preventDefault();
          const name = e.dataTransfer.getData("text/plain");
          if (!findRef(name)) return;
          row.value = secretInterp(name);
          renderForm(); refresh();
        },
      });
      return el("div", { class: "env-row" },
        el("input", {
          type: "text", class: "env-key", value: row.key, placeholder: "KEY",
          spellcheck: "false",
          oninput: (e) => { row.key = e.target.value; refresh(); },
        }),
        el("span", { class: "env-prefix" }, "="),
        valInput,
        el("select", {
          class: "env-ref-pick", title: S("insertRef"),
          onchange: (e) => {
            if (!e.target.value) return;
            row.value = secretInterp(e.target.value);
            renderForm(); refresh();
          },
        },
          el("option", { value: "" }, "🔑"),
          ...state.secretRefs.map((r) => el("option", { value: r.name }, r.name)),
        ),
        el("button", {
          class: "icon-btn danger", title: S("clear"), "aria-label": S("clear"),
          onclick: () => { state.agent.env.splice(i, 1); renderForm(); refresh(); },
        }, "×"),
      );
    }),
  );

  return el("div", { class: "field" },
    el("label", {}, S("agentEnv"), keyHint("env")),
    rows,
    el("button", {
      class: "add-btn", onclick: () => { state.agent.env.push({ key: "", value: "" }); renderForm(); refresh(); },
    }, S("addVar")),
    el("p", { class: "help" }, S("agentEnvHelp")),
  );
}

function renderField(platform, f) {
  const ps = state.platforms[platform.id];
  const label = T(f.label) || titleCase(f.key);
  const set = (v) => { ps.values[f.key] = v; refresh(); };

  let control;
  switch (f.type) {
    case "secret": {
      // never a value input — a drop zone that only accepts a named secret ref
      // (dragged from the palette) or the field's literal ${ENV_VAR} default.
      const v = ps.values[f.key];
      const assigned = f.required || v.use;
      const fieldId = `${platform.id}.${f.key}`;
      const editing = editingFields.has(fieldId);
      const showPicker = !assigned || editing;

      const zone = el("div", {
        class: "dropzone" + (assigned ? " filled" : ""),
        ondragover: (e) => { e.preventDefault(); zone.classList.add("dragover"); },
        ondragleave: () => zone.classList.remove("dragover"),
        ondrop: (e) => {
          e.preventDefault();
          const name = e.dataTransfer.getData("text/plain");
          if (!findRef(name)) return; // only palette refs accepted
          v.mode = "ref"; v.ref = name; v.use = true;
          editingFields.delete(fieldId);
          renderForm(); refresh();
        },
      });

      if (assigned) {
        const display = v.mode === "ref" && findRef(v.ref)
          ? el("span", { class: "chip in-field", title: findRef(v.ref).source },
              el("span", { class: "chip-name" }, v.ref),
              el("span", { class: "chip-eq" }, "="),
              el("span", { class: "chip-src" }, findRef(v.ref).source))
          : el("span", { class: "chip in-field env" }, `\${${v.env}}`);
        zone.append(
          display,
          el("span", { class: "zone-actions" },
            el("button", {
              class: "icon-btn", title: S("edit"), "aria-label": S("edit"),
              onclick: () => {
                if (editing) editingFields.delete(fieldId);
                else editingFields.add(fieldId);
                renderForm(); refresh();
              },
            }, "✎"),
            el("button", {
              class: "icon-btn danger", title: S("clear"), "aria-label": S("clear"),
              onclick: () => {
                if (f.required) { v.mode = "env"; v.env = f.env; v.ref = null; }
                else { v.use = false; v.mode = "env"; v.ref = null; }
                editingFields.delete(fieldId);
                renderForm(); refresh();
              },
            }, "×"),
          ),
        );
      } else {
        zone.append(el("span", { class: "drop-hint" }, S("dropHint")));
      }

      // picker — visible only while editing or when the field is empty
      let picker = null;
      if (showPicker) {
        const curVal = !assigned ? "__unset__" : (v.mode === "ref" ? `ref:${v.ref}` : "__env__");
        picker = el("select", {
          class: "ref-picker",
          onchange: (e) => {
            const val = e.target.value;
            if (val === "__unset__") { v.use = false; v.mode = "env"; v.ref = null; }
            else if (val === "__env__") { v.mode = "env"; v.env = f.env; v.ref = null; v.use = true; }
            else { v.mode = "ref"; v.ref = val.slice(4); v.use = true; }
            editingFields.delete(fieldId);
            renderForm(); refresh();
          },
        },
          f.required ? null : el("option", { value: "__unset__", ...(curVal === "__unset__" ? { selected: "" } : {}) }, S("pickerUnset")),
          el("option", { value: "__env__", ...(curVal === "__env__" ? { selected: "" } : {}) }, `\${${f.env}}`),
          ...state.secretRefs.map((r) =>
            el("option", { value: `ref:${r.name}`, ...(curVal === `ref:${r.name}` ? { selected: "" } : {}) },
              `${r.name} — ${r.source}`)),
        );
      }

      return el("div", { class: "field secret" },
        el("label", {}, label, el("span", { class: "lock" }, " 🔒"), keyHint(f.key),
          f.required ? el("span", { class: "badge required" }, S("required")) : null),
        el("div", { class: "secret-assign" }, zone, picker),
        f.help ? el("p", { class: "help" }, T(f.help)) : null,
      );
    }
    case "bool":
      control = el("label", { class: "toggle" },
        el("input", {
          type: "checkbox", ...(ps.values[f.key] ? { checked: "" } : {}),
          onchange: (e) => set(e.target.checked),
        }),
        ` ${S("yes")}`,
      );
      break;
    case "enum":
      control = el("select", { onchange: (e) => set(e.target.value) },
        ...f.options.map((o) => {
          const value = optValue(o);
          return el("option", { value, ...(ps.values[f.key] === value ? { selected: "" } : {}) },
            optLabel(o));
        }));
      break;
    case "number":
      control = el("input", {
        type: "number", value: ps.values[f.key], min: "0",
        oninput: (e) => set(Number(e.target.value)),
      });
      break;
    case "list":
      control = el("input", {
        type: "text", value: ps.values[f.key].join(", "),
        placeholder: state.lang === "zh" ? "以逗號分隔" : "comma-separated",
        oninput: (e) => set(e.target.value.split(",").map((s) => s.trim()).filter(Boolean)),
      });
      break;
    default:
      control = el("input", {
        type: "text", value: ps.values[f.key], placeholder: f.default || "",
        oninput: (e) => set(e.target.value),
      });
  }

  return el("div", { class: "field" },
    el("label", {}, label, keyHint(f.key)),
    control,
    f.help ? el("p", { class: "help" }, T(f.help)) : null,
  );
}

// ---------------------------------------------------------------- preview + tabs

let activeTab = "config";

const FILENAMES = { config: "config.toml", secrets: null, run: "run.txt" };

function secretFilename() {
  return { ecsctl: "create-secrets.sh", docker: "docker-run.sh", k8s: "secret.yaml" }[state.deployTarget];
}

function currentContent() {
  if (activeTab === "config") return generateToml();
  if (activeTab === "secrets") return generateSecrets();
  return generateRun();
}

// ---------------------------------------------------------------- syntax highlighting

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// strings, with ${...} interpolations highlighted inside
function tokString(raw) {
  const inner = escapeHtml(raw).replace(/\$\{[^}]*\}/g, (m) => `<span class="tok-interp">${m}</span>`);
  return `<span class="tok-string">${inner}</span>`;
}

// non-string value fragment: booleans, numbers, inline-table keys, trailing comments
function tokPlain(raw) {
  const hash = raw.indexOf("#");
  const code = hash >= 0 ? raw.slice(0, hash) : raw;
  const comment = hash >= 0 ? `<span class="tok-comment">${escapeHtml(raw.slice(hash))}</span>` : "";
  // single pass — emitted spans are never re-scanned
  const highlighted = escapeHtml(code).replace(
    /\b(?:true|false)\b|\b\d+\b|[A-Za-z_][A-Za-z0-9_]*(?=\s*=)/g,
    (m) => {
      if (m === "true" || m === "false") return `<span class="tok-bool">${m}</span>`;
      if (/^\d+$/.test(m)) return `<span class="tok-num">${m}</span>`;
      return `<span class="tok-key">${m}</span>`;
    },
  );
  return highlighted + comment;
}

function tokValue(s) {
  let out = "", last = 0;
  const re = /"[^"]*"/g;
  let m;
  while ((m = re.exec(s))) {
    out += tokPlain(s.slice(last, m.index));
    out += tokString(m[0]);
    last = m.index + m[0].length;
  }
  return out + tokPlain(s.slice(last));
}

function highlightToml(src) {
  return src.split("\n").map((line) => {
    if (/^\s*#/.test(line)) return `<span class="tok-comment">${escapeHtml(line)}</span>`;
    if (/^\s*\[[^\]]*\]\s*$/.test(line)) return `<span class="tok-section">${escapeHtml(line)}</span>`;
    const kv = line.match(/^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)(.*)$/);
    if (kv) {
      return escapeHtml(kv[1])
        + `<span class="tok-key">${escapeHtml(kv[2])}</span>`
        + escapeHtml(kv[3])
        + tokValue(kv[4]);
    }
    return escapeHtml(line);
  }).join("\n");
}

// lighter treatment for shell/yaml tabs: comments + strings only
function highlightPlain(src) {
  return src.split("\n").map((line) => {
    if (/^\s*#/.test(line)) return `<span class="tok-comment">${escapeHtml(line)}</span>`;
    return tokValue(line);
  }).join("\n");
}

function refresh() {
  const code = document.querySelector("#preview code");
  const content = currentContent();
  code.innerHTML = activeTab === "config" ? highlightToml(content) : highlightPlain(content);
  const label = state.deployTarget === "ecsctl" ? "aws-sm"
    : state.deployTarget === "docker" ? "docker env" : "k8s secret";
  document.getElementById("secrets-tab-btn").textContent = `secrets (${label})`;
}

function setLang(lang) {
  state.lang = lang;
  localStorage.setItem("oab-wizard-lang", lang);
  renderChrome();
  renderForm();
  refresh();
}

function setupTabs() {
  document.getElementById("preview-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    activeTab = btn.dataset.tab;
    for (const t of document.querySelectorAll(".tab")) {
      const on = t === btn;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", String(on));
    }
    refresh();
  });

  document.getElementById("lang-switch").addEventListener("click", (e) => {
    const btn = e.target.closest(".lang-btn");
    if (btn) setLang(btn.dataset.lang);
  });

  document.getElementById("copy-btn").addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(currentContent());
    e.target.textContent = S("copied");
    setTimeout(() => (e.target.textContent = S("copy")), 1200);
  });

  document.getElementById("download-btn").addEventListener("click", () => {
    const name = activeTab === "secrets" ? secretFilename() : FILENAMES[activeTab];
    const blob = new Blob([currentContent()], { type: "text/plain" });
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

// ---------------------------------------------------------------- boot

renderChrome();
renderForm();
setupTabs();
refresh();
