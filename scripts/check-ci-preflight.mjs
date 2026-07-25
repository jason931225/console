#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dotSlashBootstrap = "tools/buck/install_dotslash.sh";
const reindeerToolchainLock = "third-party/rust/reindeer/upstream.lock";
const reindeerToolchainSource = `source ${reindeerToolchainLock}`;
const reindeerToolchainInstall = 'rustup toolchain install "$REINDEER_TOOLCHAIN" --profile minimal';
const strictShellMode = "set -euo pipefail";
const reindeerToolchainOverride = /^(?:export\s+)?REINDEER_TOOLCHAIN\s*=/;
const ciPreflightTestCommand = "node --test scripts/check-ci-preflight.test.mjs";
const consoleRouteInventoryTestCommand = "node --test scripts/console/route-inventory.test.mjs";
const consoleTruthLedgerTestCommand = "node --test scripts/console/validate-console-truth-ledger.test.mjs";
const consoleFanoutPlannerTestCommand = "node --test scripts/console/plan-fanout.test.mjs";
const buckPostgresEnvironmentTestCommand = "tools/buck/run_test_with_postgres_env.test.sh";
const buckPostgresHarnessTestCommand = "tools/buck/test_needs_postgres.test.sh";
const consoleIntegrationTipEnv = "CONSOLE_INTEGRATION_TIP_SHA: ${{ github.sha }}";
const supportDomainUnitCommand = "tools/buck2 test //backend/crates/support/domain:mnt-support-domain-unit";
const postgresDomainReachabilityCommands = [
  "tools/buck/test_needs_postgres.sh --num-threads=1 \\",
  "//backend/crates/dispatch/adapter-postgres:mnt-dispatch-adapter-postgres-itest-p1_dispatch \\",
  "//backend/crates/attendance/adapter-postgres:mnt-attendance-adapter-postgres-itest-cancel_substitution \\",
  "//backend/crates/attendance/adapter-postgres:mnt-attendance-adapter-postgres-itest-concurrency",
];
const requiredPreflightCommands = [
  "tools/buck/preflight.sh",
  "npm run check:foundation-gates",
  "npm run check:console-truth-ledger",
  ciPreflightTestCommand,
  consoleRouteInventoryTestCommand,
  consoleTruthLedgerTestCommand,
  consoleFanoutPlannerTestCommand,
  buckPostgresEnvironmentTestCommand,
  buckPostgresHarnessTestCommand,
  "npm run check:ci-preflight",
  "npm run check:root-workspaces",
  "npm run test:root-workspaces",
  "npm run check:package-lock",
  "cargo metadata --manifest-path backend/Cargo.toml --locked --format-version=1 >/dev/null",
];
const protectedJobs = [
  "backend",
  "dev-up-smoke",
  "api-clients",
  "web",
  "api-contract",
  "kubernetes-manifests",
  "swift-client",
  "mobile-parity",
  "android-app",
  "android-instrumented",
  "ios-app",
  "browser-e2e",
  "generated-face-authority",
  "support-domain-unit",
  "postgres-domain-reachability",
];

function triggerPathEntries(workflow, trigger) {
  const match = workflow.match(new RegExp(`^  ${trigger}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:|^permissions:)`, "m"));
  const paths = match?.[1].match(/^    paths:\n((?:      - "[^"]+"\n)+)/m);
  return paths ? [...paths[1].matchAll(/^      - "([^"]+)"$/gm)].map((entry) => entry[1]) : [];
}

function jobBlock(workflow, job) {
  const jobs = workflow.slice(workflow.indexOf("jobs:\n") + "jobs:\n".length);
  const match = jobs.match(new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:|(?![\\s\\S]))`, "m"));
  return match?.[1] ?? null;
}

function needsPreflight(block) {
  const value = block.match(/^    needs:\s*(.+)$/m)?.[1]?.trim();
  if (!value) return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1).split(",").map((job) => job.trim()).includes("preflight");
  }
  return value === "preflight";
}

function stepBlocks(block) {
  const steps = block.match(/^    steps:\n([\s\S]*)$/m)?.[1] ?? "";
  return steps.split(/^      - /m).slice(1);
}

function runScalar(step) {
  return step.match(/^        run: ([^\n]+)$/m)?.[1]?.trim();
}

function isUnconditional(step) {
  return !/^        (?:if|continue-on-error):/m.test(step);
}

function multilineRunCommands(step) {
  const run = step.match(/^        run: \|\n((?:          [^\n]*(?:\n|$))*)/m)?.[1] ?? "";
  return run
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function hasEnvironment(step, entry) {
  return step.includes(`        env:\n          ${entry}\n`);
}

function requireUnconditionalRun(steps, command, job, failures) {
  const matchingSteps = steps.filter((step) => runScalar(step) === command);
  if (matchingSteps.length === 0) {
    failures.push(`${job} must run ${command}`);
  } else if (matchingSteps.some((step) => !isUnconditional(step))) {
    failures.push(`${job} must run ${command} unconditionally without if or continue-on-error`);
  }
}

function requireUnconditionalMultilineRun(steps, commands, job, failures) {
  const matchingSteps = steps.filter((step) => multilineRunCommands(step).join("\n") === commands.join("\n"));
  if (matchingSteps.length === 0) {
    failures.push(`${job} must run the locked PostgreSQL reachability targets`);
  } else if (matchingSteps.some((step) => !isUnconditional(step))) {
    failures.push(`${job} must run the locked PostgreSQL reachability targets unconditionally without if or continue-on-error`);
  }
}

function runCommand(step) {
  const scalar = runScalar(step);
  return scalar && scalar !== "|" ? scalar : (multilineRunCommands(step).join("\n") || null);
}

function requireOnlyLockedRuns(steps, commands, job, failures) {
  const actual = steps.map(runCommand).filter(Boolean);
  if (actual.length !== commands.length || actual.some((command, index) => command !== commands[index])) {
    failures.push(`${job} must contain only the locked ordered Buck2 run steps`);
  }
}

function stepName(step) {
  return step.match(/^name: ([^\n]+)$/m)?.[1] ?? null;
}

function hasOnlyExpectedCondition(step, expectedIf) {
  const conditions = [...step.matchAll(/^        if: ([^\n]+)$/gm)].map((match) => match[1]);
  return (expectedIf === null
    ? conditions.length === 0
    : conditions.length === 1 && conditions[0] === expectedIf)
    && !/^        continue-on-error:/m.test(step);
}

function requireOrderedStepContracts(steps, contracts, job, failures) {
  const indexes = [];
  for (const contract of contracts) {
    const matches = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => stepName(step) === contract.name);
    if (matches.length !== 1
      || (contract.run !== undefined && runCommand(matches[0]?.step) !== contract.run)
      || !hasOnlyExpectedCondition(matches[0]?.step ?? "", contract.if)) {
      failures.push(`${job} must preserve the locked fail-fast step multiset and failure semantics`);
      indexes.push(-1);
    } else {
      indexes.push(matches[0].index);
    }
  }
  if (indexes.some((index) => index < 0) || indexes.some((index, position) => position > 0 && index <= indexes[position - 1])) {
    failures.push(`${job} must preserve the locked fail-fast step order`);
  }
  return indexes;
}

const apiContractCaptureName = "Capture Buck2-built app for contract test";
const apiContractCaptureCommands = [
  "set -euo pipefail",
  'mnt_app_bin="${GITHUB_WORKSPACE}/.tmp/buck2/api-contract/mnt-app"',
  'test -x "${mnt_app_bin}"',
  "printf 'MNT_APP_BIN=%s\\n' \"${mnt_app_bin}\" >> \"${GITHUB_ENV}\"",
];
const apiContractAllowedSteps = [
  "name: Checkout\n        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7",
  "name: Install pinned DotSlash runtime\n        run: tools/buck/install_dotslash.sh",
  "name: Free runner disk for API contract\n        uses: ./.github/actions/free-runner-disk",
  "name: Install Rust toolchain (pinned via rust-toolchain.toml)\n        uses: dtolnay/rust-toolchain@29eef336d9b2848a0b548edc03f92a220660cdb8 # stable\n        with:\n          toolchain: \"1.96.0\"",
  "name: Cache Rust dependencies + build artifacts\n        uses: Swatinem/rust-cache@c19371144df3bb44fab255c43d04cbc2ab54d1c4 # v2.9.1\n        with:\n          workspaces: backend",
  "name: Set up Node.js\n        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0\n        with:\n          node-version: \"24\"\n          cache: npm",
  "name: Install client tooling\n        run: npm ci",
  "name: OpenAPI app-served drift gate\n        if: ${{ !cancelled() }}\n        run: npm run check:openapi-app",
  `name: ${apiContractCaptureName}
        if: \${{ !cancelled() }}
        shell: bash
        run: |
          set -euo pipefail
          # check:openapi-app is the sole Buck2 producer for this handoff.
          mnt_app_bin="\${GITHUB_WORKSPACE}/.tmp/buck2/api-contract/mnt-app"
          test -x "\${mnt_app_bin}"
          printf 'MNT_APP_BIN=%s\\n' "\${mnt_app_bin}" >> "\${GITHUB_ENV}"`,
  "name: Employee import replay contract\n        if: ${{ !cancelled() }}\n        run: npm run test:employee-import-contract",
  "name: Ontology write precondition contract\n        if: ${{ !cancelled() }}\n        run: npm run test:ontology-write-precondition",
  "name: Generated TypeScript client round-trip\n        if: ${{ !cancelled() }}\n        run: npm run test:contract",
];

function hasOnlyAllowedApiContractSteps(steps) {
  return steps.length === apiContractAllowedSteps.length
    && steps.every((step, index) => step.trimEnd() === apiContractAllowedSteps[index]);
}

function isDesignatedApiContractCapture(step) {
  if (!step.startsWith(`name: ${apiContractCaptureName}\n`)) return false;
  return multilineRunCommands(step).filter((line) => !line.startsWith("#")).join("\n")
    === apiContractCaptureCommands.join("\n");
}

function requireReindeerToolchainBefore(steps, command, failures) {
  const commandIndex = steps.findIndex((step) => runScalar(step) === command);
  const toolchainIndex = steps.findIndex((step) => multilineRunCommands(step).includes(reindeerToolchainInstall));
  if (toolchainIndex < 0) {
    failures.push("generated-face-authority must install the lock-pinned Reindeer Rust toolchain before full generated-face closure");
    return;
  }
  const commands = multilineRunCommands(steps[toolchainIndex]);
  const strictModeIndex = commands.indexOf(strictShellMode);
  const sourceIndex = commands.indexOf(reindeerToolchainSource);
  const installIndex = commands.indexOf(reindeerToolchainInstall);
  if (sourceIndex < 0) {
    failures.push(`generated-face-authority must source ${reindeerToolchainLock} before installing the Reindeer Rust toolchain`);
  } else if (strictModeIndex < 0 || strictModeIndex > sourceIndex) {
    failures.push(`generated-face-authority must enable strict shell mode before sourcing ${reindeerToolchainLock}`);
  } else if (sourceIndex > installIndex) {
    failures.push(`generated-face-authority must source ${reindeerToolchainLock} before installing the Reindeer Rust toolchain`);
  }
  if (commands.some((entry) => reindeerToolchainOverride.test(entry))) {
    failures.push(`generated-face-authority must not override REINDEER_TOOLCHAIN after sourcing ${reindeerToolchainLock}`);
  }
  if (!isUnconditional(steps[toolchainIndex])) {
    failures.push("generated-face-authority must install the Reindeer Rust toolchain unconditionally");
  }
  if (commandIndex >= 0 && toolchainIndex > commandIndex) {
    failures.push("generated-face-authority must install the lock-pinned Reindeer Rust toolchain before full generated-face closure");
  }
}

function requirePreflightRustToolchainBefore(steps, failures) {
  const setupIndex = steps.findIndex((step) =>
    step.startsWith("name: Install Rust toolchain for Cargo.lock consistency\n"),
  );
  if (setupIndex < 0) {
    failures.push("preflight must install the pinned Rust toolchain before Cargo-dependent CI preflight tests");
    return;
  }
  if (!isUnconditional(steps[setupIndex])) {
    failures.push("preflight must install the pinned Rust toolchain unconditionally");
    return;
  }
  for (const command of [
    ciPreflightTestCommand,
    "cargo metadata --manifest-path backend/Cargo.toml --locked --format-version=1 >/dev/null",
  ]) {
    const commandIndex = steps.findIndex((step) => runScalar(step) === command);
    if (commandIndex >= 0 && setupIndex > commandIndex) {
      failures.push(`preflight must install the pinned Rust toolchain before ${command}`);
    }
  }
}

function requireDotSlashBefore(steps, command, job, failures) {
  const commandIndex = steps.findIndex((step) => runScalar(step) === command);
  const dotSlashIndex = steps.findIndex((step) => runScalar(step) === dotSlashBootstrap);
  if (dotSlashIndex < 0) {
    failures.push(`${job} must install pinned DotSlash before Buck2`);
  } else if (!isUnconditional(steps[dotSlashIndex])) {
    failures.push(`${job} must install DotSlash unconditionally`);
  } else if (commandIndex >= 0 && dotSlashIndex > commandIndex) {
    failures.push(`${job} must install DotSlash before ${command}`);
  }
}

function requireEffectiveDotSlashBootstrap(block, job, failures) {
  const workingDirectory = block.match(/^    defaults:\n      run:\n        working-directory: ([^\n]+)$/m)?.[1]?.trim();
  const bootstrap = workingDirectory === "backend" ? `../${dotSlashBootstrap}` : dotSlashBootstrap;
  const steps = stepBlocks(block);
  const bootstrapIndex = steps.findIndex((step) => runScalar(step) === bootstrap);
  if (bootstrapIndex < 0) {
    failures.push(`${job} must install pinned DotSlash from ${bootstrap}`);
    return;
  }
  const firstBuckInvocation = steps.findIndex((step, index) => {
    const run = runScalar(step);
    const command = run === "|" ? multilineRunCommands(step).join("\n") : run ?? "";
    return index !== bootstrapIndex
      && (
        /(?:^|[^A-Za-z0-9_])tools\/buck(?:2|\/)/.test(command)
        || /\bdotslash\b/i.test(command)
        || /(?:^|[\s;&|])node\s+scripts\/dev-up\.mjs\s+bootstrap(?:\s|$)/m.test(command)
      );
  });
  if (firstBuckInvocation >= 0 && bootstrapIndex > firstBuckInvocation) {
    failures.push(`${job} must install pinned DotSlash before its first Buck invocation`);
  }
}

export function evaluateCiPreflight(workflow) {
  const failures = [];
  for (const trigger of ["push", "pull_request"]) {
    if (!triggerPathEntries(workflow, trigger).includes("toolchains/**")) {
      failures.push(`${trigger} must include toolchains/** in CI path filters`);
    }
    if (!triggerPathEntries(workflow, trigger).includes("docs/program/**")) {
      failures.push(`${trigger} must include docs/program/** in CI path filters`);
    }
  }

  const preflight = jobBlock(workflow, "preflight");
  if (!preflight) {
    failures.push("CI must define a preflight job before expensive jobs");
    return { failures };
  }

  const preflightSteps = stepBlocks(preflight);
  if (/^    if:/m.test(preflight)) {
    failures.push("preflight must not define job-level if");
  }
  if (/^    continue-on-error:/m.test(preflight)) {
    failures.push("preflight must not define job-level continue-on-error");
  }
  const checkout = preflightSteps.find((step) => step.startsWith("name: Checkout\n"));
  if (!checkout || !/^        with:\n(?:          [^\n]+\n)*          fetch-depth: 0$/m.test(checkout)) {
    failures.push("preflight checkout must fetch full history with fetch-depth: 0");
  }
  requireDotSlashBefore(preflightSteps, "tools/buck/preflight.sh", "preflight", failures);
  requirePreflightRustToolchainBefore(preflightSteps, failures);
  for (const command of requiredPreflightCommands) {
    requireUnconditionalRun(preflightSteps, command, "preflight", failures);
  }
  for (const command of ["npm run check:console-truth-ledger", consoleTruthLedgerTestCommand, consoleFanoutPlannerTestCommand]) {
    const step = preflightSteps.find((candidate) => runScalar(candidate) === command);
    if (!step || !hasEnvironment(step, consoleIntegrationTipEnv)) {
      failures.push(`preflight must pass ${consoleIntegrationTipEnv} to ${command}`);
    }
  }

  const supportDomainUnit = jobBlock(workflow, "support-domain-unit");
  if (supportDomainUnit) {
    const steps = stepBlocks(supportDomainUnit);
    requireUnconditionalRun(steps, supportDomainUnitCommand, "support-domain-unit", failures);
    requireOnlyLockedRuns(steps, [dotSlashBootstrap, supportDomainUnitCommand], "support-domain-unit", failures);
  }

  const postgresDomainReachability = jobBlock(workflow, "postgres-domain-reachability");
  if (postgresDomainReachability) {
    const steps = stepBlocks(postgresDomainReachability);
    requireUnconditionalMultilineRun(
      steps,
      postgresDomainReachabilityCommands,
      "postgres-domain-reachability",
      failures,
    );
    requireOnlyLockedRuns(
      steps,
      [dotSlashBootstrap, postgresDomainReachabilityCommands.join("\n")],
      "postgres-domain-reachability",
      failures,
    );
  }

  const backend = jobBlock(workflow, "backend");
  if (backend) {
    const steps = stepBlocks(backend);
    const failFastIf = null;
    const pr473ContractTestCommand = "python3 scripts/check-pr473-migration-operational.test.py -v";
    if (steps.some((step) => step.includes("if: ${{ !cancelled() }}"))) {
      failures.push("backend must not use !cancelled() on protected fail-fast steps");
    }
    const sourceGateContracts = [
      ["Layer-boundary gate", "cargo run -p mnt-gate-layer-boundary"],
      ["Audit-coverage gate", "cargo run -p mnt-gate-audit-coverage"],
      ["Migration-safety gate", "cargo run -p mnt-gate-migration-safety"],
      ["Tenant-isolation gate", "cargo run -p mnt-gate-tenant-isolation"],
      ["PII-no-logs gate", "cargo run -p mnt-gate-pii-no-logs"],
      ["RLS-arming gate", "cargo run -p mnt-gate-rls-arming"],
      ["Dev-auth-absence gate", "cargo run -p mnt-gate-dev-auth-absence"],
      ["IaC tier-discipline gate", "cargo run -p mnt-gate-iac-tier"],
    ];
    const gateIndexes = requireOrderedStepContracts(
      steps,
      [
        ["clippy -D warnings", "SQLX_OFFLINE=true cargo clippy --all-targets -- -D warnings"],
        ...sourceGateContracts,
        ["PR 473 migration operational contract tests", pr473ContractTestCommand],
        ["Reconcile portable PostgreSQL role topology", undefined],
        ["PR 473 migration operational gate", "npm run check:pr473-migration-operational"],
        ["Boot smoke — migrate + serve + /readyz", undefined],
      ].map(([name, run]) => ({ name, run, if: failFastIf })),
      "backend",
      failures,
    );
    if (gateIndexes[1] !== gateIndexes[0] + 1) {
      failures.push("backend must run source-only gates immediately after clippy");
    }
    requireOrderedStepContracts(
      steps,
      [
        { name: "Buck2 mnt-app unit suite", run: "env -u DATABASE_URL tools/buck2 test //backend/app:mnt-app-unit", if: failFastIf },
        {
          name: "Buck2 mnt-app inline PostgreSQL suites",
          run: [
            "tools/buck/test_needs_postgres.sh \\",
            "//backend/app:mnt-app-itest-inline-postgres \\",
            "//backend/app:mnt-app-itest-dev_auth_persona_guard_feature",
          ].join("\n"),
          if: failFastIf,
        },
      ],
      "backend",
      failures,
    );
  }

  const devUpSmoke = jobBlock(workflow, "dev-up-smoke");
  if (devUpSmoke) {
    requireOrderedStepContracts(
      stepBlocks(devUpSmoke),
      [
        { name: "dev-up compose contract unit test", run: "node --test scripts/dev-up-compose.test.mjs", if: null },
        { name: "Install pinned DotSlash runtime", run: dotSlashBootstrap, if: null },
        { name: "Free runner disk for Rust backend", run: null, if: null },
        { name: "Install Rust toolchain (pinned via rust-toolchain.toml)", run: null, if: null },
      ],
      "dev-up-smoke",
      failures,
    );
  }

  const fullGeneratedFaces = jobBlock(workflow, "generated-face-authority");
  if (fullGeneratedFaces) {
    const fullGeneratedFaceSteps = stepBlocks(fullGeneratedFaces);
    const fullGeneratedFaceCommand = "tools/buck/preflight.sh --full-generated-faces";
    const matchingFullGateSteps = fullGeneratedFaceSteps.filter((step) => runScalar(step) === fullGeneratedFaceCommand);
    if (matchingFullGateSteps.length === 0) {
      failures.push("generated-face-authority must run the complete generated-face closure");
    } else if (matchingFullGateSteps.some((step) => !isUnconditional(step))) {
      failures.push("generated-face-authority must run the complete generated-face closure unconditionally");
    }
    requireDotSlashBefore(
      fullGeneratedFaceSteps,
      fullGeneratedFaceCommand,
      "generated-face-authority",
      failures,
    );
    requireReindeerToolchainBefore(fullGeneratedFaceSteps, fullGeneratedFaceCommand, failures);
  }

  const apiContract = jobBlock(workflow, "api-contract");
  if (apiContract) {
    const apiContractSteps = stepBlocks(apiContract);
    if (!hasOnlyAllowedApiContractSteps(apiContractSteps)) {
      failures.push("api-contract must contain only the approved ordered steps");
    }
    requireDotSlashBefore(
      apiContractSteps,
      "npm run check:openapi-app",
      "api-contract",
      failures,
    );
    const openApiGateIndexes = apiContractSteps
      .map((step, index) => (runScalar(step) === "npm run check:openapi-app" ? index : -1))
      .filter((index) => index >= 0);
    if (openApiGateIndexes.length !== 1) {
      failures.push("api-contract must run exactly one npm run check:openapi-app producer");
    }
    const jobOrStepAppBinaryOverride = /^ {6,}MNT_APP_BIN\s*:/m.test(apiContract);
    const captureStepIndexes = apiContractSteps
      .map((step, index) => (step.startsWith(`name: ${apiContractCaptureName}\n`) ? index : -1))
      .filter((index) => index >= 0);
    const captureStepIndex = captureStepIndexes[0] ?? -1;
    const captureIsDesignated = captureStepIndexes.length === 1 && isDesignatedApiContractCapture(apiContractSteps[captureStepIndex]);
    const nonCaptureSteps = apiContractSteps.filter((_, index) => index !== captureStepIndex);
    const shellAppBinaryOverride = nonCaptureSteps.some((step) => step.includes("MNT_APP_BIN"));
    const cargoTargetAppBinaryOverride = apiContract.split(/\r?\n/).some((line) =>
      !line.trimStart().startsWith("#") && line.includes("MNT_APP_BIN:") && (line.includes("backend/target") || line.includes("CARGO_TARGET_DIR")),
    );
    if (jobOrStepAppBinaryOverride || shellAppBinaryOverride) {
      failures.push("api-contract must not override the captured MNT_APP_BIN");
    }
    if (cargoTargetAppBinaryOverride) {
      failures.push("api-contract must not use a Cargo target path for MNT_APP_BIN");
    }
    if (!captureIsDesignated) {
      failures.push("api-contract capture must use the designated verified command grammar");
    }
    if (nonCaptureSteps.some((step) => step.includes("GITHUB_ENV"))) {
      failures.push("api-contract may reference GITHUB_ENV only in the designated capture step");
    }

    const openApiGateIndex = openApiGateIndexes[0] ?? -1;
    const contractTestIndex = apiContractSteps.findIndex((step) => runScalar(step) === "npm run test:contract");
    if (
      openApiGateIndex < 0
      || contractTestIndex < 0
      || captureStepIndex < openApiGateIndex
      || captureStepIndex > contractTestIndex
    ) {
      failures.push("api-contract must capture the Buck2-built mnt-app path for npm run test:contract");
    }
  }

  for (const job of ["backend", "dev-up-smoke"]) {
    const block = jobBlock(workflow, job);
    if (block) requireEffectiveDotSlashBootstrap(block, job, failures);
  }

  for (const job of protectedJobs) {
    const block = jobBlock(workflow, job);
    if (!block) {
      failures.push(`CI must define protected job ${job}`);
    } else if (!needsPreflight(block)) {
      failures.push(`${job} must need preflight`);
    } else if (/^    if:/m.test(block)) {
      failures.push(`${job} must not define job-level if`);
    }
  }

  return { failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { failures } = evaluateCiPreflight(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"));
  if (failures.length > 0) {
    console.error("CI preflight contract failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("CI preflight contract passed.");
}
