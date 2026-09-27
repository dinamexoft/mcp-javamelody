# mcp-javamelody

An MCP (Model Context Protocol) server that gives **read-only** access to [JavaMelody](https://github.com/javamelody/javamelody)
monitoring data for one or more Java web applications — HTTP/SQL/Spring counters, JVM info, thread dumps, database
reports — straight from the agent, no manual dashboard digging. Only `format=json` GET requests against JavaMelody's
own `monitoring` endpoint are made; nothing is ever written back to the monitored app.

## How it works

- `server.js` — the MCP server. Reads a TOML config file listing your microservices (name, URL, optional basic-auth
  credentials), then exposes tools that call each one's JavaMelody `?format=json` endpoint over plain HTTP(S).
- One server process covers **all** microservices in your config — pass a `server` argument to pick which one a tool
  call targets. Call `list_servers` first to see the valid names.

This tool is installed once and configured **per project** (one config file + one agent config entry per project,
or one per environment if you want them separate). See [Running multiple projects in parallel](#running-multiple-projects-in-parallel)
at the end.

## 1. Prerequisite: JavaMelody must be enabled on the app, with JSON export

The target application needs the JavaMelody monitoring servlet/filter already installed and reachable, e.g.
`http://your-host:8080/your-app/monitoring`. If it's protected with basic auth (recommended), have the
username/password handy — see JavaMelody's own docs for enabling it and securing the endpoint.

JavaMelody's `?format=json` export (used by every tool in this server) requires [XStream](https://x-stream.github.io/)
on the monitored app's classpath — it's an optional dependency JavaMelody doesn't bundle by default. Add it to the
app's own `pom.xml`:

```xml
<dependency>
    <groupId>com.thoughtworks.xstream</groupId>
    <artifactId>xstream</artifactId>
    <version>1.4.21</version>
</dependency>
```

Without it, `?format=json` requests fail even though the regular HTML monitoring page works fine.

## 2. Client install

Requires Node.js 20+.

**Windows / Linux / macOS — same steps:**

Installs the `mcp-javamelody` command globally

```bash
npm install -g mcp-javamelody
```

Copy [`config.example.toml`](config.example.toml) to a config file for the project, e.g. `config.myproject.toml`:

```toml
[[servers]]
name = "microservice1"
url = "http://localhost:8080/microservice1/monitoring"
user = "monitor"
password = "change-me"

[[servers]]
name = "microservice2"
url = "http://localhost:8080/microservice2/monitoring"
user = "monitor"
password = "change-me"

# Optional, top-level defaults applied to every server unless overridden per-server below.
# insecure = true       # accept self-signed https certificates
# timeout_ms = 30000    # request timeout (ms), default 30000
```

Each `[[servers]]` entry is one JavaMelody-monitored microservice, selected by `name` when calling a tool. `user`/
`password` are optional (omit for an unprotected endpoint). Keep this file out of any git repo if it holds real
credentials — `.gitignore` already excludes `config*.toml` other than the example.

Sanity-check it works before wiring it with the agent:

```bash
mcp-javamelody --config-file /path/to/config.myproject.toml
```

It should print `[Ready] JavaMelody MCP server ready — servers: ...` to stderr and then sit waiting for input —
`Ctrl+C` to stop.

## 3. Add it to Claude

Edit your Claude Desktop / Claude Code MCP config (create the file if it doesn't exist):

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

The same block on every OS — only the `--config-file` path syntax differs:

**Windows:**

```json
{
  "mcpServers": {
    "myproject-javamelody": {
      "command": "mcp-javamelody",
      "args": [
        "--config-file",
        "C:\\Users\\you\\config.myproject.toml"
      ]
    }
  }
}
```

**Linux / macOS:**

```json
{
  "mcpServers": {
    "myproject-javamelody": {
      "command": "mcp-javamelody",
      "args": [
        "--config-file",
        "/home/you/config.myproject.toml"
      ]
    }
  }
}
```

Restart Claude. You should see tools like `list_servers`, `get_counter_stats`, `get_statistics`, `get_part`,
`list_database_requests` and `get_database_stats` available under `myproject-javamelody`.

<sub>Prefer running from a local checkout instead of a global installation? `git clone` the repo, `npm install`, then
use `"command": "node"` with `"args": ["/path/to/server.js", "--config-file", "/path/to/config.toml"]` — both
invocation styles read the same config file.</sub>

## Available tools

- `list_servers` — list the configured microservices. Call first to get valid `server` values.
- `get_counter_stats` — per-request aggregates for a date range: hits, mean/max/total duration, errors, one row per
  URL / SQL statement / Spring method / error / log message. The most granular way to find what's slow or failing.
- `get_statistics` — full overview for a date range: all counters plus JVM info in one response.
- `get_part` — live snapshot right now, no date range: JVM/host info, open JDBC connections, current requests, all
  threads, JMX MBeans, OS processes, JNDI tree.
- `list_database_requests` — list the database report names/indexes available (depends on the JDBC driver), call
  before `get_database_stats`.
- `get_database_stats` — a database report for a date range, e.g. `pg_stat_activity`, `pg_locks`,
  `pg_stat_user_tables`, `pg_settings`.

## Running multiple projects in parallel

The whole setup above is designed to be repeated per project or environment, side by side, without collisions:

- **Config files**: `config.<project>.toml` or `config.<project>-<environment>.toml`, one per agent config entry
  (remember to gitignore it if it holds real credentials).
- **Claude config**: one `mcpServers` entry per project/environment (`myproject-javamelody`, `myproject-uat-javamelody`,
  ...), each pointing at its own `--config-file`.
- A single config file can also list multiple microservices under one entry (see `[[servers]]` above) if they belong
  to the same project and should share one agent config entry — pick between them with the `server` tool argument.

## Security notes

- Only `GET ?format=json` requests are made against JavaMelody's own monitoring endpoint — no write capability exists
  in this server.
- Never commit config files containing real basic-auth credentials.
- Use `insecure = true` only for self-signed certificates you trust (e.g. internal networks) — it disables TLS
  certificate verification for the whole process.
