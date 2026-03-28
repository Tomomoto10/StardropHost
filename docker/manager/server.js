// ===========================================
// StardropHost | docker/manager/server.js
// ===========================================
// Sidecar service with Docker socket access.
// Handles container lifecycle operations that
// the web panel cannot do from inside the
// main container.
// ===========================================

const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const PORT        = parseInt(process.env.MANAGER_PORT || '18700', 10);
const PROJECT_DIR = process.env.PROJECT_DIR || '/workspace';
const COMPOSE_FILE = process.env.COMPOSE_FILE || `${PROJECT_DIR}/docker-compose.yml`;

const DEFAULT_ENV_FILE = `${PROJECT_DIR}/.env`;
const RUNTIME_ENV_FILE = `${PROJECT_DIR}/data/panel/runtime.env`;

const ALLOWED_SERVICES = new Set(['stardrop-server']);

const SERVICE_CONTAINERS = {
  'stardrop-server': 'stardrop',
};

const PLAYIT_IMAGE = 'ghcr.io/playit-cloud/playit-agent:0.17';

function getPlayitContainerName() {
  const env = { ...parseEnvFile(DEFAULT_ENV_FILE), ...parseEnvFile(RUNTIME_ENV_FILE) };
  const prefix = process.env.CONTAINER_PREFIX || env.CONTAINER_PREFIX || 'stardrop';
  return `${prefix}-playit`;
}

// -- Helpers --

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!body) { resolve({}); return; }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function parseEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const env = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
    }
    return env;
  } catch {
    return {};
  }
}

function buildComposeEnv() {
  return {
    ...process.env,
    ...parseEnvFile(DEFAULT_ENV_FILE),
    ...parseEnvFile(RUNTIME_ENV_FILE),
  };
}

// -- Actions --

function recreateService(service) {
  const env = buildComposeEnv();
  const containerName = SERVICE_CONTAINERS[service];
  const command = [
    containerName ? `docker rm -f ${containerName} >/dev/null 2>&1 || true` : '',
    `docker compose -f ${COMPOSE_FILE} --project-directory ${PROJECT_DIR} up -d --no-deps ${service}`,
  ].filter(Boolean).join(' && ');

  const child = spawn('sh', ['-lc', command], {
    cwd: PROJECT_DIR,
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function stopService(service) {
  const env = buildComposeEnv();
  const containerName = SERVICE_CONTAINERS[service];
  const command = `docker stop ${containerName} >/dev/null 2>&1 || true`;

  const child = spawn('sh', ['-lc', command], {
    cwd: PROJECT_DIR,
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function startService(service) {
  const env = buildComposeEnv();
  const command = `docker compose -f ${COMPOSE_FILE} --project-directory ${PROJECT_DIR} up -d --no-deps ${service}`;

  const child = spawn('sh', ['-lc', command], {
    cwd: PROJECT_DIR,
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function startPlayit(secretKey) {
  // Remove any existing playit container, then start a fresh one with the key as the CLI arg.
  // The key is passed as a positional argument — never stored to disk.
  const name = getPlayitContainerName();
  const command = [
    `docker rm -f ${name} >/dev/null 2>&1 || true`,
    `docker run -d --name ${name} --network host --restart unless-stopped ${PLAYIT_IMAGE} "${secretKey}"`,
  ].join(' && ');

  const child = spawn('sh', ['-lc', command], {
    cwd: PROJECT_DIR,
    env: buildComposeEnv(),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function stopPlayit() {
  const name = getPlayitContainerName();
  const command = `docker rm -f ${name} >/dev/null 2>&1 || true`;

  const child = spawn('sh', ['-lc', command], {
    cwd: PROJECT_DIR,
    env: buildComposeEnv(),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function getPlayitStatus() {
  const name = getPlayitContainerName();
  return new Promise((resolve) => {
    const child = spawn('docker', ['inspect', '--format', '{{.State.Status}}', name], {
      cwd: PROJECT_DIR,
      env: buildComposeEnv(),
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', (code) => {
      const status = out.trim();
      resolve({
        running: code === 0 && status === 'running',
        containerStatus: code === 0 ? status : 'not found',
      });
    });
    child.on('error', () => resolve({ running: false, containerStatus: 'error' }));
  });
}

function updateServer() {
  const env = buildComposeEnv();

  // Spawn a one-off Alpine container that runs update.sh on the host project dir.
  // Because this container is outside the compose project, it is unaffected when
  // docker compose up -d later restarts the manager or any other service.
  // The Docker socket gives it full access to rebuild and restart all containers.
  const command = [
    'docker run --rm',
    '-v /var/run/docker.sock:/var/run/docker.sock',
    `-v ${PROJECT_DIR}:${PROJECT_DIR}`,
    `-w ${PROJECT_DIR}`,
    'alpine',
    `sh -c "apk add -q git bash docker-cli docker-cli-compose && git config --global --add safe.directory ${PROJECT_DIR} && bash update.sh"`,
  ].join(' ');

  const child = spawn('sh', ['-lc', command], {
    cwd: PROJECT_DIR,
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

// -- Routes --

const server = http.createServer(async (req, res) => {

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Recreate (full stop + start with fresh container)
  if (req.method === 'POST' && req.url === '/recreate') {
    try {
      const body = await readJson(req);
      const service = body?.service ? String(body.service) : 'stardrop-server';
      if (!ALLOWED_SERVICES.has(service)) {
        sendJson(res, 400, { error: 'Unsupported service' });
        return;
      }
      recreateService(service);
      sendJson(res, 202, { success: true, service, action: 'recreate' });
    } catch (error) {
      sendJson(res, 500, { error: error.message || 'Failed to schedule recreate' });
    }
    return;
  }

  // Stop
  if (req.method === 'POST' && req.url === '/stop') {
    try {
      const body = await readJson(req);
      const service = body?.service ? String(body.service) : 'stardrop-server';
      if (!ALLOWED_SERVICES.has(service)) {
        sendJson(res, 400, { error: 'Unsupported service' });
        return;
      }
      stopService(service);
      sendJson(res, 202, { success: true, service, action: 'stop' });
    } catch (error) {
      sendJson(res, 500, { error: error.message || 'Failed to schedule stop' });
    }
    return;
  }

  // Start
  if (req.method === 'POST' && req.url === '/start') {
    try {
      const body = await readJson(req);
      const service = body?.service ? String(body.service) : 'stardrop-server';
      if (!ALLOWED_SERVICES.has(service)) {
        sendJson(res, 400, { error: 'Unsupported service' });
        return;
      }
      startService(service);
      sendJson(res, 202, { success: true, service, action: 'start' });
    } catch (error) {
      sendJson(res, 500, { error: error.message || 'Failed to schedule start' });
    }
    return;
  }

  // Update (pull latest image and restart)
  if (req.method === 'POST' && req.url === '/update') {
    try {
      updateServer();
      sendJson(res, 202, { success: true, action: 'update' });
    } catch (error) {
      sendJson(res, 500, { error: error.message || 'Failed to schedule update' });
    }
    return;
  }

  // Playit status
  if (req.method === 'GET' && req.url === '/playit/status') {
    try {
      const status = await getPlayitStatus();
      sendJson(res, 200, status);
    } catch (error) {
      sendJson(res, 500, { error: error.message || 'Failed to get playit status' });
    }
    return;
  }

  // Playit start (accepts secretKey in body)
  if (req.method === 'POST' && req.url === '/playit/start') {
    try {
      const body = await readJson(req);
      const secretKey = body?.secretKey ? String(body.secretKey).trim() : '';
      if (!secretKey) {
        sendJson(res, 400, { error: 'secretKey is required' });
        return;
      }
      startPlayit(secretKey);
      sendJson(res, 202, { success: true, action: 'playit-start' });
    } catch (error) {
      sendJson(res, 500, { error: error.message || 'Failed to start playit' });
    }
    return;
  }

  // Playit stop
  if (req.method === 'POST' && req.url === '/playit/stop') {
    try {
      stopPlayit();
      sendJson(res, 202, { success: true, action: 'playit-stop' });
    } catch (error) {
      sendJson(res, 500, { error: error.message || 'Failed to stop playit' });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[StardropHost Manager] Listening on http://0.0.0.0:${PORT}`);
});