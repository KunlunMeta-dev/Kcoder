import { createStunLifecycleCommand } from './stun-lifecycle.mjs';

const ACTIONS = new Set(['install', 'upgrade', 'status', 'cleanup']);

export function parseRelayDeployArgs(args = []) {
  let action = 'install';
  let actionSeen = false;
  const options = { adoptExisting: false, purgeData: false, dryRun: false };

  for (const arg of args) {
    if (ACTIONS.has(arg)) {
      if (actionSeen) throw new Error('Specify one Relay deployment action');
      action = arg;
      actionSeen = true;
      continue;
    }
    if (arg === '--adopt-existing') {
      if (options.adoptExisting) throw new Error('Duplicate --adopt-existing');
      options.adoptExisting = true;
      continue;
    }
    if (arg === '--purge-data') {
      if (options.purgeData) throw new Error('Duplicate --purge-data');
      options.purgeData = true;
      continue;
    }
    if (arg === '--dry-run') {
      if (options.dryRun) throw new Error('Duplicate --dry-run');
      options.dryRun = true;
      continue;
    }
    throw new Error(`Unknown Relay deployment argument: ${arg}`);
  }

  if (options.adoptExisting && !['install', 'upgrade'].includes(action)) {
    throw new Error('--adopt-existing is only valid with install or upgrade');
  }
  if (options.purgeData && action !== 'cleanup') {
    throw new Error('--purge-data is only valid with cleanup');
  }
  if (options.dryRun && !['install', 'upgrade'].includes(action)) {
    throw new Error('--dry-run is only valid with install or upgrade');
  }
  return { action, ...options };
}

function shellQuote(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid remote command argument');
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function lifecycleCommand(script, action, args = [], { privileged = true } = {}) {
  const prefix = privileged ? 'sudo -n bash' : 'bash';
  return `${prefix} ${shellQuote(script)} ${[action, ...args].map(shellQuote).join(' ')}`;
}

function rootStunCommand({ action, scriptPath, port, adoptExisting = false }) {
  return createStunLifecycleCommand({ action, scriptPath, port, adoptExisting })
    .replace(/^sudo -n /, '');
}

function emitResult(action, component, state) {
  return shellQuote(JSON.stringify({ action, component, state }));
}

function runPair(first, second, {
  firstNotRunComponent = 'stun',
  secondNotRunComponent = 'relay',
  stopAfterFirstFailure = false,
} = {}) {
  const lines = [
    'set +e',
    `_first_output=$(${first})`,
    '_first_status=$?',
    stopAfterFirstFailure
      ? `if [ "$_first_status" -eq 0 ]; then _second_output=$(${second}); _second_status=$?; else _second_output=${emitResult('not-run', secondNotRunComponent, 'not-run')}; _second_status=$_first_status; fi`
      : `_second_output=$(${second})\n_second_status=$?`,
    'printf \'%s\\n\' "$_first_output"',
    'printf \'%s\\n\' "$_second_output"',
    'if [ "$_first_status" -eq 2 ] || [ "$_second_status" -eq 2 ]; then exit 2; fi',
    'if [ "$_first_status" -eq 3 ] || [ "$_second_status" -eq 3 ]; then exit 3; fi',
    'if [ "$_first_status" -ne 0 ] || [ "$_second_status" -ne 0 ]; then exit 4; fi',
    'exit 0',
  ];
  return lines.join('\n');
}

const DEFAULT_LIFECYCLE_LOCK = '/run/kcoder-relay-deploy.lock';

function lockLifecycleCommand(command, lockPath, { testNamespace = false } = {}) {
  const lockDirectory = lockPath.slice(0, lockPath.lastIndexOf('/'));
  const ownerCheck = testNamespace
    ? '[[ "$(stat -c %u -- "$lock")" == "$(id -u)" && "$(stat -c %h -- "$lock")" == 1 ]]'
    : '[[ "$(stat -c %u -- "$lock")" == 0 && "$(stat -c %h -- "$lock")" == 1 ]]';
  const parentChecks = testNamespace
    ? [
      `namespace=${shellQuote(lockDirectory.slice(0, lockDirectory.lastIndexOf('/')))}`,
      `lock_directory=${shellQuote(lockDirectory)}`,
      '[[ -d "$namespace" && ! -L "$namespace" && "$(realpath -e -- "$namespace")" == "$namespace" ]] || { printf "Unsafe Relay deployment lock directory\\n" >&2; exit 3; }',
      '[[ "$(stat -c %u -- "$namespace")" == "$(id -u)" && "$(stat -c %a -- "$namespace")" == 700 ]] || { printf "Unsafe Relay deployment lock directory ownership or mode\\n" >&2; exit 3; }',
      '[[ -d "$lock_directory" && ! -L "$lock_directory" && "$(realpath -e -- "$lock_directory")" == "$lock_directory" ]] || { printf "Unsafe Relay deployment lock directory\\n" >&2; exit 3; }',
      '[[ "$(stat -c %u -- "$lock_directory")" == "$(id -u)" && "$(stat -c %a -- "$lock_directory")" == 700 ]] || { printf "Unsafe Relay deployment lock directory ownership or mode\\n" >&2; exit 3; }',
    ]
    : [
      `lock_directory=${shellQuote(lockDirectory)}`,
      '[[ -d "$lock_directory" && ! -L "$lock_directory" && "$(realpath -e -- "$lock_directory")" == "$lock_directory" && "$(stat -c %u -- "$lock_directory")" == 0 ]] || { printf "Unsafe Relay deployment lock directory\\n" >&2; exit 3; }',
    ];
  const wrapper = [
    'set -Eeuo pipefail',
    'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
    'export PATH',
    `lock=${shellQuote(lockPath)}`,
    ...parentChecks,
    'if [[ -L "$lock" ]]; then printf "Unsafe Relay deployment lock\\n" >&2; exit 3; fi',
    'if [[ ! -e "$lock" ]]; then (umask 077; set -o noclobber; : > "$lock") 2>/dev/null || true; fi',
    '[[ -f "$lock" && ! -L "$lock" ]] || { printf "Unsafe Relay deployment lock\\n" >&2; exit 3; }',
    `${ownerCheck} || { printf "Unsafe Relay deployment lock ownership\\n" >&2; exit 3; }`,
    '[[ "$(stat -c %a -- "$lock")" == 600 ]] || { printf "Unsafe Relay deployment lock mode\\n" >&2; exit 3; }',
    'script=$(printf %s "$1" | base64 --decode)',
    'flock --exclusive "$lock" bash -c "$script" --',
  ].join('; ');
  const encodedCommand = Buffer.from(command, 'utf8').toString('base64');
  return `sudo -n bash -c ${shellQuote(wrapper)} -- ${shellQuote(encodedCommand)}`;
}

export function createRelayLifecycleRemoteCommand({
  action,
  stageDir,
  port,
  adoptExisting = false,
  purgeData = false,
  testNamespace,
} = {}) {
  if (!ACTIONS.has(action)) throw new Error('Invalid Relay lifecycle action');
  if (adoptExisting && !['install', 'upgrade'].includes(action)) throw new Error('Invalid adoption action');
  if (purgeData && action !== 'cleanup') throw new Error('Invalid purge action');
  if (typeof stageDir !== 'string' || !/^\/var\/tmp\/kcoder-relay-deploy-[a-f0-9]{16,64}$/.test(stageDir)) {
    throw new Error('Every lifecycle action requires a private staging directory');
  }

  const writeAction = ['install', 'upgrade'].includes(action);
  let lockPath = DEFAULT_LIFECYCLE_LOCK;
  if (testNamespace !== undefined) {
    if (typeof testNamespace !== 'string' || !/^\/tmp\/kcoder-relay-cli-test-[a-f0-9]{24}$/.test(testNamespace)) {
      throw new Error('Invalid internal lifecycle test namespace');
    }
    lockPath = `${testNamespace}/run/kcoder-relay-deploy.lock`;
  }
  if (writeAction) {
    if (!Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65535) {
      throw new Error('A valid STUN port is required for install or upgrade');
    }
  } else if (port !== undefined) {
    throw new Error('Status and cleanup read the deployed port from the owner receipt');
  }

  const relayScript = `${stageDir}/deploy/relay-host.sh`;
  const stunScript = `${stageDir}/deploy/stun-host.sh`;
  const prepareArgs = ['prepare', '--stage-dir', stageDir];
  if (!writeAction) prepareArgs.push('--check-only');
  const prepareCommand = lifecycleCommand(relayScript, 'prepare', prepareArgs.slice(1));
  const prepareFailure = [
    'set +e',
    prepareCommand,
    '_prepare_status=$?',
    'if [ "$_prepare_status" -ne 0 ]; then',
    `  printf '%s\\n' ${emitResult(action, 'stun', 'not-run')}`,
    `  printf '%s\\n' ${emitResult(action, 'relay', 'not-run')}`,
    '  exit "$_prepare_status"',
    'fi',
  ];

  const relayArgs = ['--stage-dir', stageDir];
  if (adoptExisting) relayArgs.push('--adopt-existing');
  if (purgeData) relayArgs.push('--purge-data');
  const relayCommand = lifecycleCommand(relayScript, action, relayArgs);

  if (action === 'status') {
    return [...prepareFailure, lockLifecycleCommand(runPair(
      rootStunCommand({ action: 'status', scriptPath: stunScript }),
      lifecycleCommand(relayScript, 'status', ['--stage-dir', stageDir], { privileged: false }),
    ), lockPath, { testNamespace: Boolean(testNamespace) })].join('\n');
  }

  if (action === 'cleanup') {
    const preflight = [
      'set +e',
      `_stun_preflight=$(${rootStunCommand({ action: 'status', scriptPath: stunScript })})`,
      '_stun_preflight_status=$?',
      `_relay_preflight=$(bash ${shellQuote(relayScript)} status --stage-dir ${shellQuote(stageDir)})`,
      '_relay_preflight_status=$?',
      'if [ "$_stun_preflight_status" -ne 0 ] || [ "$_relay_preflight_status" -ne 0 ]; then',
      '  printf \'%s\\n\' "$_stun_preflight"',
      '  printf \'%s\\n\' "$_relay_preflight"',
      '  if [ "$_stun_preflight_status" -eq 3 ] || [ "$_relay_preflight_status" -eq 3 ]; then exit 3; fi',
      '  exit 4',
      'fi',
    ];
    const cleanupPair = runPair(
      rootStunCommand({ action, scriptPath: stunScript }),
      lifecycleCommand(relayScript, action, relayArgs, { privileged: false }),
      { stopAfterFirstFailure: true },
    );
    return [...prepareFailure, lockLifecycleCommand([...preflight, cleanupPair].join('\n'), lockPath, { testNamespace: Boolean(testNamespace) })].join('\n');
  }

  const actionPair = runPair(
    rootStunCommand({ action, scriptPath: stunScript, port: Number(port), adoptExisting }),
    lifecycleCommand(relayScript, action, relayArgs, { privileged: false }),
    { stopAfterFirstFailure: true },
  );
  return [...prepareFailure, lockLifecycleCommand(actionPair, lockPath, { testNamespace: Boolean(testNamespace) })].join('\n');
}

export function createRelayDeploymentCliDryRun({ target, deployment, action }) {
  if (typeof target !== 'string' || !deployment || !ACTIONS.has(action)) {
    throw new Error('Relay dry-run summary requires a target, plan, and action');
  }
  const stun = deployment.stun;
  if (!stun || typeof stun.publicUrl !== 'string' || !Number.isInteger(Number(stun.port))) {
    throw new Error('Relay deployment plan is missing canonical STUN settings');
  }
  return {
    mode: 'DRY_RUN',
    action,
    target,
    publicUrl: deployment.canonicalPublicUrl || deployment.publicUrl,
    gateways: deployment.gateways,
    stun: {
      mode: stun.mode,
      publicUrl: stun.publicUrl,
      protocol: stun.protocol,
      port: Number(stun.port),
      unit: stun.unitName,
      configPath: stun.configPath,
    },
    managedServices: ['kcoder-relay.service', stun.unitName],
    registrationStore: 'preserved by cleanup unless --purge-data is set',
    credentials: 'staged mode 0600 and removed after install',
    deploymentPerformed: false,
  };
}

const VALID_STATES = {
  status: new Set(['active', 'absent', 'resources-removed']),
  install: new Set(['active']),
  upgrade: new Set(['active']),
  cleanup: new Set(['resources-removed', 'absent']),
};

export function combineRelayLifecycleResults({ action, stun, relay, purgeData = false, remoteStatus = 0 }) {
  if (!ACTIONS.has(action) || !stun || !relay || typeof stun !== 'object' || typeof relay !== 'object') {
    throw new Error('Remote lifecycle did not return both Relay and STUN results');
  }
  if (stun.component !== 'stun' || relay.component !== 'relay') {
    throw new Error('Remote lifecycle returned an unexpected component');
  }
  const success = remoteStatus === 0
    && VALID_STATES[action].has(stun.state)
    && VALID_STATES[action].has(relay.state)
    && !(action === 'status' && (stun.healthy === false || relay.healthy === false));
  return {
    action,
    relay,
    stun,
    success,
    registrationStore: {
      state: relay.registrationStore?.state || (action === 'cleanup' && purgeData ? 'purged' : 'unknown'),
      retained: action !== 'cleanup' || !purgeData,
      purged: action === 'cleanup' && purgeData,
    },
  };
}
