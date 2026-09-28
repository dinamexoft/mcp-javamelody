#!/usr/bin/env node
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { parse as parseToml } from 'smol-toml';

const USAGE = `Usage: mcp-javamelody --config-file <path/to/config.toml>

Config file format (TOML), one [[servers]] entry per monitored microservice:

  [[servers]]
  name = "microservice1"
  url = "http://localhost:8080/microservice1/monitoring"
  user = "monitor"
  password = "secret"

  [[servers]]
  name = "microservice2"
  url = "http://localhost:8080/microservice2/monitoring"
  user = "monitor"
  password = "secret"

Required per entry:
  name      unique identifier, passed as the "server" argument to tools
  url       JavaMelody monitoring URL (http:// or https://)

Optional per entry (fall back to a top-level default of the same name):
  user, password  basic auth credentials
  insecure        accept self-signed https certificates (default false)
  timeout_ms      request timeout in ms (default 30000)

See config.example.toml for a full example.`;

function fail(message) {
  console.error(`[Config error] ${message}\n\n${USAGE}`);
  process.exit(1);
}

// Support `mcp-javamelody --config-file path/to/config.toml` for global/npm-link installs.
const configFileFlagIndex = process.argv.findIndex(
  (arg) => arg === '--config-file' || arg.startsWith('--config-file=')
);
let configFilePath;
if (configFileFlagIndex !== -1) {
  const flag = process.argv[configFileFlagIndex];
  configFilePath = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : process.argv[configFileFlagIndex + 1];
}
configFilePath ||= process.env.CONFIG_FILE;
if (!configFilePath) {
  fail('Missing required --config-file <path/to/config.toml>');
}
const CONFIG_FILE = path.resolve(process.cwd(), configFilePath);

function loadServers() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (e) {
    fail(`Could not read config file "${CONFIG_FILE}": ${e.message}`);
  }

  let doc;
  try {
    doc = parseToml(raw);
  } catch (e) {
    fail(`Failed to parse "${CONFIG_FILE}" as TOML: ${e.message}`);
  }

  const entries = Array.isArray(doc.servers) ? doc.servers : [];
  if (entries.length === 0) {
    fail(`No [[servers]] entries found in "${CONFIG_FILE}"`);
  }

  const servers = new Map();
  let anyInsecure = false;
  entries.forEach((entry, i) => {
    const label = entry?.name ? `"${entry.name}"` : `#${i + 1}`;
    if (!entry.name || typeof entry.name !== 'string') {
      fail(`[[servers]] entry ${label} needs a "name" (string)`);
    }
    if (servers.has(entry.name)) {
      fail(`Duplicate server name "${entry.name}"`);
    }
    if (!entry.url || typeof entry.url !== 'string') {
      fail(`Server ${label}: "url" is required`);
    }
    const url = entry.url.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) {
      fail(`Server ${label}: "url" must start with http:// or https:// (got "${entry.url}")`);
    }
    if (entry.user !== undefined && typeof entry.user !== 'string') {
      fail(`Server ${label}: "user" must be a string`);
    }
    if (entry.password !== undefined && typeof entry.password !== 'string') {
      fail(`Server ${label}: "password" must be a string`);
    }
    const insecure = entry.insecure ?? doc.insecure ?? false;
    if (insecure) anyInsecure = true;
    const timeoutMs = entry.timeout_ms ?? doc.timeout_ms ?? 30000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      fail(`Server ${label}: "timeout_ms" must be a positive number`);
    }
    servers.set(entry.name, {
      name: entry.name,
      url,
      user: entry.user,
      password: entry.password,
      insecure,
      timeoutMs,
    });
  });

  if (anyInsecure) {
    // Scoped to this process only; Node's built-in fetch has no per-request option.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  return servers;
}

const SERVERS = loadServers();
const SERVER_NAMES = [...SERVERS.keys()];

function getServer(name) {
  if (!name) throw new Error(`"server" is required. Available: ${SERVER_NAMES.join(', ')}`);
  const server = SERVERS.get(name);
  if (!server) throw new Error(`Unknown server "${name}". Available: ${SERVER_NAMES.join(', ')}`);
  return server;
}

const DATE_PATTERN = 'yyyy-MM-dd';

// Snapshot sections: always the live state, no date range.
// Not exposed: the default report (all counters + JVM), part=jvm and part=currentRequests embed JavaInformations,
// and part=jndi serializes an IOException when there is no JNDI context. On Java 16+ XStream can't reflect into
// java.util.Collections$EmptyList / java.lang.Throwable without --add-opens, so JavaMelody logs a WARN and the
// response is cut off mid-JSON.
const PARTS = {
  connections: 'Currently open JDBC connections with the stack trace of where each was opened (connection leak hunting).',
  threads: 'All JVM threads with state, CPU time and stack traces (deadlocks, blocked or busy threads).',
  mbeans: 'JMX MBeans tree with attributes (connection pools, Tomcat, Hibernate, JVM memory/runtime, etc. internals).',
  processes: 'OS processes on the host (ps / tasklist output).',
};
const NO_DATE_PARTS = Object.keys(PARTS);

// Per-request aggregates for a period: hits, mean/max time, CPU, errors, grouped by request.
const COUNTERS = {
  http: 'HTTP requests per URL: hits, mean/max/total duration, CPU time, system error %, mean response size, child SQL hits/time.',
  sql: 'SQL statements: hits, mean/max/total duration, system error %. Use to find slow or most frequent queries.',
  spring: 'Spring bean method calls (@Service/@Repository etc.): hits, mean/max duration, CPU, errors, child SQL.',
  error: 'HTTP system errors (5xx responses and uncaught exceptions) grouped by URL/exception, with counts.',
  log: 'Application log messages at WARN/ERROR level grouped by message, with counts and stack traces.',
};
const COUNTER_NAMES = Object.keys(COUNTERS);

const INSTRUCTIONS = `JavaMelody monitoring of one or more Java web applications (read-only).
- This MCP server bundles multiple microservices. Every tool except list_servers requires a "server" argument. Call list_servers first to see the available names.
- Historical tools (get_counter_stats, get_database_stats) require startDate and endDate in ${DATE_PATTERN} (inclusive). Keep ranges short: today, a day or a week.
- For "what is slow / failing" questions start with get_counter_stats (counter=http, sql, spring, error or log); it is the most granular source.
- Durations are in milliseconds.
- get_part returns the live state right now (threads, open connections, MBeans, OS processes), no dates.
- Database reports: call list_database_requests first to see which report names/indexes exist, then get_database_stats.`;

function validateDateRange(args) {
  const { startDate, endDate } = args || {};
  for (const [name, value] of [['startDate', startDate], ['endDate', endDate]]) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`${name} is required in ${DATE_PATTERN} format`);
    }
    const d = new Date(value + 'T00:00:00Z');
    if (isNaN(d) || d.toISOString().slice(0, 10) !== value) {
      throw new Error(`${name} is not a valid date: ${value}`);
    }
  }
  if (startDate > endDate) throw new Error('startDate must not be after endDate');
  return {
    startDate,
    endDate,
    period: `${startDate}|${endDate}`,
    pattern: DATE_PATTERN,
  };
}

async function fetchJson(server, params) {
  const url = new URL(server.url);
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const headers = { Accept: 'application/json' };
  if (server.user) {
    headers.Authorization =
      'Basic ' + Buffer.from(`${server.user}:${server.password || ''}`).toString('base64');
  }

  console.error(`[HTTP] [${server.name}] GET ${url.pathname}${url.search}`);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(server.timeoutMs) });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Response is not JSON: ${body.slice(0, 500)}`);
  }
}

// Database request names depend on the JDBC driver (postgresql.*, mysql.*, oracle.* ...),
// so they are looked up from the server once and cached, per microservice.
const databaseRequestNamesByServer = new Map();

async function getDatabaseRequestNames(server) {
  if (!databaseRequestNamesByServer.has(server.name)) {
    const data = await fetchJson(server, { part: 'database' });
    databaseRequestNamesByServer.set(server.name, Array.isArray(data?.requestNames) ? data.requestNames : []);
  }
  return databaseRequestNamesByServer.get(server.name);
}

async function resolveDatabaseRequest(server, request) {
  if (request === undefined || request === null || request === '') return 0;
  if (Number.isInteger(request) || /^\d+$/.test(String(request))) return Number(request);

  const names = await getDatabaseRequestNames(server);
  const wanted = String(request).toLowerCase();
  const index = names.findIndex((n) => {
    const name = n.toLowerCase();
    return name === wanted || name.endsWith('.' + wanted);
  });
  if (index < 0) {
    throw new Error(`Unknown database request "${request}". Available: ${names.join(', ')}`);
  }
  return index;
}

const SERVER_PROPS = {
  server: { type: 'string', enum: SERVER_NAMES, description: 'Which microservice to query (see list_servers)' },
};

const DATE_RANGE_PROPS = {
  startDate: { type: 'string', description: `Start date (${DATE_PATTERN}), inclusive` },
  endDate: { type: 'string', description: `End date (${DATE_PATTERN}), inclusive` },
};

const describeOptions = (map) =>
  Object.entries(map).map(([k, v]) => `- ${k}: ${v}`).join('\n');

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: 'list_servers',
    description: 'List the microservices this MCP server is configured for. Call this first to get valid "server" values for the other tools.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ_ONLY,
  },
  {
    name: 'get_counter_stats',
    description:
      'Main, most granular statistics: per-request aggregates for a date range, one row per ' +
      'URL / SQL statement / Spring method / error / log message. Counters:\n' +
      describeOptions(COUNTERS),
    inputSchema: {
      type: 'object',
      properties: {
        ...SERVER_PROPS,
        counter: { type: 'string', enum: COUNTER_NAMES, description: 'Which counter to report' },
        ...DATE_RANGE_PROPS,
      },
      required: ['server', 'counter', 'startDate', 'endDate'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'list_database_requests',
    description:
      'List the database report names available on the server with their indexes ' +
      '(e.g. 0 = postgresql.pg_stat_activity, 1 = postgresql.pg_locks). Names depend on the DB vendor. ' +
      'Call before get_database_stats.',
    inputSchema: { type: 'object', properties: { ...SERVER_PROPS }, required: ['server'] },
    annotations: READ_ONLY,
  },
  {
    name: 'get_database_stats',
    description:
      'Database report from the monitored DB for a date range, e.g. pg_stat_activity (sessions), ' +
      'pg_locks, pg_stat_user_tables (seq/index scans, dead tuples), pg_stat_user_indexes (index usage), ' +
      'pg_settings. "request" is an index or name from list_database_requests ' +
      '(e.g. 2, "pg_database" or "postgresql.pg_database"); defaults to 0.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SERVER_PROPS,
        request: { type: ['integer', 'string'], description: 'Report index or name' },
        ...DATE_RANGE_PROPS,
      },
      required: ['server', 'startDate', 'endDate'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'get_part',
    description: 'Live snapshot of the application right now (no date range). Parts:\n' + describeOptions(PARTS),
    inputSchema: {
      type: 'object',
      properties: {
        ...SERVER_PROPS,
        part: { type: 'string', enum: NO_DATE_PARTS, description: 'Which section to fetch' },
      },
      required: ['server', 'part'],
    },
    annotations: READ_ONLY,
  },
];

async function callTool(name, args = {}) {
  if (name === 'list_servers') {
    return [...SERVERS.values()].map((s) => ({ name: s.name, url: s.url }));
  }

  const server = getServer(args.server);
  switch (name) {
    case 'get_counter_stats': {
      if (!COUNTER_NAMES.includes(args.counter)) {
        throw new Error(`counter must be one of: ${COUNTER_NAMES.join(', ')}`);
      }
      const range = validateDateRange(args);
      return fetchJson(server, { part: 'counterSummaryPerClass', counter: args.counter, ...range });
    }
    case 'list_database_requests': {
      const names = await getDatabaseRequestNames(server);
      return names.map((n, index) => ({ index, name: n }));
    }
    case 'get_database_stats': {
      const range = validateDateRange(args);
      const request = await resolveDatabaseRequest(server, args.request);
      return fetchJson(server, { part: 'database', request, ...range });
    }
    case 'get_part':
      if (!NO_DATE_PARTS.includes(args.part)) {
        throw new Error(`part must be one of: ${NO_DATE_PARTS.join(', ')}`);
      }
      return fetchJson(server, { part: args.part });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleRequest(request) {
  const { id, method, params } = request;

  if (id === undefined) {
    console.error(`[Notify] ${method}`);
    return;
  }

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'javamelody', version: '1.1.0' },
          instructions: INSTRUCTIONS,
        },
      });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      try {
        const result = await callTool(params.name, params.arguments);
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
        });
      } catch (e) {
        // Tool failures are reported as tool results so the model can see and correct them.
        send({
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: e.message }] },
        });
      }
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -1, message: e.message } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    handleRequest(JSON.parse(line));
  } catch (e) {
    console.error('[Parse error]', e.message);
  }
});

process.on('SIGINT', () => process.exit(0));

console.error(`[Ready] JavaMelody MCP server ready — servers: ${SERVER_NAMES.join(', ')}`);
