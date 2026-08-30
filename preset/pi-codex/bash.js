/**
 * pi-codex - Non-blocking shell for the Pi coding agent.
 *
 * Registers a `bash` tool that overrides Pi's built-in bash with Codex-style
 * unified-exec behaviour, plus a `bash_io` companion for polling/input.
 *
 *   bash     - spawn a command, wait up to yield_time_ms (default 2s) for
 *              output, then return. If the process is still running, returns
 *              a session_id so the model can poll or interact.
 *   bash_io  - write to a running process's stdin (or send Ctrl-C), collect
 *              output for yield_time_ms, then return.
 *
 * Registering a tool named "bash" overrides Pi's built-in synchronous bash:
 * short commands return full output directly; long-running commands return
 * early with a session_id instead of blocking the agent.
 *
 * Installation:
 *   Copy or symlink this directory to:
 *     .pi/extensions/pi-codex/      (project-local)
 *     ~/.pi/agent/extensions/pi-codex/  (global)
 *
 *   Or install the npm package:
 *     npm install pi-codex
 *   and add to your project's .pi/extensions/ directory.
 *
 * Design notes:
 * - Uses pipe-based stdio (no PTY dependency). Sufficient for builds, tests,
 *   servers, and most non-TUI long-running tasks.
 * - A rolling head+tail buffer caps retained output per process.
 * - Processes survive across tool calls within a session. They are killed on
 *   session shutdown.
 * - AbortSignal from the agent does NOT kill background processes — the model
 *   may re-poll after interruption.
 */
import { spawn } from "node:child_process";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MIN_YIELD_MS = 250;
const MAX_YIELD_MS = 30_000;
const DEFAULT_EXEC_YIELD_MS = 2_000;
const MIN_POLL_YIELD_MS = 5_000;
const HEAD_BYTES = 4 * 1024; // keep first 4 KiB
const TAIL_BYTES = 252 * 1024; // keep last 252 KiB (total: 256 KiB)
const CTRL_C = "\x03";
const POST_WRITE_DELAY_MS = 100;
// ---------------------------------------------------------------------------
// Rolling head+tail buffer
// ---------------------------------------------------------------------------
class RollingBuffer {
    head = [];
    tail = [];
    headBytes = 0;
    tailBytes = 0;
    totalBytes = 0;
    append(data) {
        this.totalBytes += data.length;
        this.tail.push(data);
        this.tailBytes += data.length;
        // Trim tail to stay within budget.
        while (this.tailBytes > TAIL_BYTES && this.tail.length > 1) {
            const dropped = this.tail.shift();
            this.tailBytes -= dropped.length;
        }
        // Accumulate head until the threshold is reached.
        if (this.headBytes < HEAD_BYTES) {
            const remaining = HEAD_BYTES - this.headBytes;
            if (data.length <= remaining) {
                this.head.push(data);
                this.headBytes += data.length;
            }
            else {
                this.head.push(data.subarray(0, remaining));
                this.headBytes = HEAD_BYTES;
            }
        }
    }
    get hasOmission() {
        return this.totalBytes > this.headBytes + this.tailBytes;
    }
    get omittedBytes() {
        return Math.max(0, this.totalBytes - this.headBytes - this.tailBytes);
    }
    toSnapshot() {
        // Without omission the tail alone already holds the full history —
        // prepending the head would duplicate the overlapping bytes.
        if (!this.hasOmission) {
            return Buffer.concat(this.tail).toString("utf-8");
        }
        const parts = [...this.head];
        parts.push(Buffer.from(`\n... ${this.omittedBytes} bytes omitted ...\n\n`));
        parts.push(...this.tail);
        return Buffer.concat(parts).toString("utf-8");
    }
    reset() {
        this.head = [];
        this.tail = [];
        this.headBytes = 0;
        this.tailBytes = 0;
        this.totalBytes = 0;
    }
}
function killProcessTree(pid) {
    if (process.platform === "win32") {
        try {
            spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
                stdio: "ignore",
                detached: true,
                windowsHide: true,
            });
        }
        catch {
            // Process may have already exited.
        }
    }
    else {
        try {
            process.kill(-pid, "SIGKILL");
        }
        catch {
            try {
                process.kill(pid, "SIGKILL");
            }
            catch {
                // Process may have already exited.
            }
        }
    }
}
// ---------------------------------------------------------------------------
// Process manager
// ---------------------------------------------------------------------------
class BackgroundProcessManager {
    processes = new Map();
    nextId = 1;
    spawn(command, cwd, env) {
        const id = this.nextId++;
        const shellConfig = getShellConfig();
        const commandFromStdin = shellConfig.commandTransport === "stdin";
        const args = commandFromStdin ? shellConfig.args : [...shellConfig.args, command];
        const child = spawn(shellConfig.shell, args, {
            cwd,
            detached: process.platform !== "win32",
            env: { ...env, NO_COLOR: "1", TERM: "dumb" },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        // Swallow async stdin errors (e.g. EPIPE when the process closes stdin
        // early); writeStdin() reports synchronous write failures to the caller.
        child.stdin?.on("error", () => { });
        if (commandFromStdin) {
            child.stdin?.end(command);
        }
        let resolveSettled;
        const settled = new Promise((resolve) => {
            resolveSettled = resolve;
        });
        const mp = {
            id,
            child,
            command,
            cwd,
            startedAt: Date.now(),
            buffer: new RollingBuffer(),
            deltaBuffer: new RollingBuffer(),
            exitCode: null,
            exited: false,
            settled,
        };
        const onData = (data) => {
            mp.buffer.append(data);
            mp.deltaBuffer.append(data);
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.once("exit", (code) => {
            mp.exited = true;
            mp.exitCode = code;
        });
        // Wake pollers once stdio is drained so no trailing output is lost.
        child.once("close", () => resolveSettled());
        // Spawn-level failures (e.g. shell binary missing) surface as an "error"
        // event — without a listener Node raises an uncaught exception.
        child.once("error", (err) => {
            mp.exited = true;
            const message = Buffer.from(`\n[process error] ${err.message}\n`);
            mp.buffer.append(message);
            mp.deltaBuffer.append(message);
            resolveSettled();
        });
        this.processes.set(id, mp);
        return mp;
    }
    get(id) {
        return this.processes.get(id);
    }
    writeStdin(id, data) {
        const mp = this.processes.get(id);
        if (!mp)
            return { ok: false, error: `No process with session_id ${id}` };
        if (mp.exited)
            return { ok: false, error: `Process ${id} has already exited` };
        if (!mp.child.stdin || mp.child.stdin.destroyed) {
            return { ok: false, error: `Process ${id} stdin is not available` };
        }
        if (data === CTRL_C) {
            try {
                mp.child.kill("SIGINT");
            }
            catch {
                return { ok: false, error: `Failed to send SIGINT to process ${id}` };
            }
        }
        else {
            try {
                mp.child.stdin.write(data);
            }
            catch (err) {
                return { ok: false, error: `Failed to write to process ${id}: ${err}` };
            }
        }
        return { ok: true };
    }
    /**
     * Collect incremental output for {@link yieldMs} milliseconds, then return
     * the delta accumulated since the last poll. Resets the delta buffer.
     */
    async poll(id, yieldMs) {
        const mp = this.processes.get(id);
        if (!mp) {
            return {
                output: `Process ${id} not found (it may have been cleaned up)`,
                exited: true,
                exitCode: null,
            };
        }
        // Return as soon as the process exits rather than waiting out the
        // full yield window.
        if (!mp.exited) {
            await Promise.race([sleep(yieldMs), mp.settled]);
        }
        const delta = mp.deltaBuffer.toSnapshot();
        mp.deltaBuffer.reset();
        return { output: delta, exited: mp.exited, exitCode: mp.exitCode };
    }
    kill(id) {
        const mp = this.processes.get(id);
        if (!mp)
            return false;
        if (!mp.exited && mp.child.pid) {
            killProcessTree(mp.child.pid);
        }
        this.remove(id);
        return true;
    }
    remove(id) {
        this.processes.delete(id);
    }
    /** Kill and clear all tracked processes (called on session shutdown). */
    cleanup() {
        for (const mp of Array.from(this.processes.values())) {
            if (!mp.exited && mp.child.pid) {
                killProcessTree(mp.child.pid);
            }
        }
        this.processes.clear();
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function clampYield(ms, min = MIN_YIELD_MS) {
    return Math.max(min, Math.min(ms, MAX_YIELD_MS));
}
function formatResult(params) {
    const parts = [];
    if (params.command) {
        parts.push(`$ ${params.command}`);
    }
    if (params.output.trim()) {
        parts.push(params.output);
    }
    else {
        parts.push("(no new output)");
    }
    parts.push("");
    if (params.exited) {
        const code = params.exitCode;
        if (code === 0) {
            parts.push("Process exited successfully (code 0).");
        }
        else if (code === null) {
            parts.push("Process exited (no exit code captured).");
        }
        else {
            parts.push(`Process exited with code ${code}.`);
        }
        parts.push("No further interaction is possible. Do not call bash_io for this session.");
    }
    else if (params.sessionId !== null) {
        parts.push(`Process is still running (session_id: ${params.sessionId}).`);
        parts.push(`Call bash_io with session_id ${params.sessionId} to poll for more output (leave chars empty) or to send input.`);
    }
    parts.push(`Wall time: ${(params.wallMs / 1000).toFixed(1)}s`);
    return parts.join("\n");
}
// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
export default function piCodexExtension(pi) {
    const manager = new BackgroundProcessManager();
    // Kill all background processes when the session ends.
    pi.on("session_shutdown", async () => {
        manager.cleanup();
    });
    // -------------------------------------------------------------------------
    // Tool: bash
    // -------------------------------------------------------------------------
    pi.registerTool({
        name: "bash",
        label: "Bash",
        description: `Execute a bash command in the current working directory. Spawns the command and waits up to yield_time_ms (default 2s) for output, then returns. If the command finishes within the wait, returns the full output and exit code. If the command is still running after the wait, returns the output collected so far plus a session_id - use bash_io with that session_id to poll for more output, send input, or interrupt. This is the primary shell tool; use it for all commands including ls, grep, find, builds, tests, and dev servers.`,
        parameters: Type.Object({
            command: Type.String({ description: "Bash command to execute" }),
            yield_time_ms: Type.Optional(Type.Integer({
                description: `Milliseconds to wait for output before returning (default: ${DEFAULT_EXEC_YIELD_MS}, range: ${MIN_YIELD_MS}-${MAX_YIELD_MS}). If the command is still running after this time, it continues in the background and a session_id is returned for bash_io.`,
            })),
        }),
        promptSnippet: "bash(command, yield_time_ms?): run any shell command; long-running ones return session_id for bash_io",
        promptGuidelines: [
            "`bash` runs all shell commands. Short commands finish within yield_time_ms (default 2s) and return full output directly.",
            "For commands still running after the wait, `bash` returns a `session_id` - poll it via `bash_io` (empty chars) or raise yield_time_ms for commands that need more time to produce output.",
            "Poll a running process by calling `bash_io` with an empty `chars` string and the `session_id`.",
            "Send input or Ctrl-C to a running process via `bash_io` with `chars` set to the input text or `\\u0003` for Ctrl-C.",
            "After a process exits (exit code returned), do NOT call `bash_io` for that `session_id` again.",
        ],
        async execute(_toolCallId, params, _signal, onUpdate, ctx) {
            const command = params.command;
            const yieldMs = params.yield_time_ms ? clampYield(params.yield_time_ms) : DEFAULT_EXEC_YIELD_MS;
            const cwd = ctx.cwd;
            const start = Date.now();
            let mp;
            try {
                mp = manager.spawn(command, cwd, process.env);
            }
            catch (err) {
                throw new Error(`Failed to spawn command: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (onUpdate) {
                onUpdate({
                    content: [{ type: "text", text: `$ ${command}\n(spawning background process...)` }],
                    details: { command, sessionId: mp.id, spawning: true },
                });
            }
            const { output, exited, exitCode } = await manager.poll(mp.id, yieldMs);
            const wallMs = Date.now() - start;
            // If process exited, remove it from the store.
            if (exited) {
                manager.remove(mp.id);
            }
            const text = formatResult({
                output,
                exited,
                exitCode,
                sessionId: exited ? null : mp.id,
                command,
                wallMs,
            });
            const details = { command, sessionId: exited ? null : mp.id, exited, exitCode: exited ? exitCode : null };
            if (onUpdate) {
                onUpdate({ content: [{ type: "text", text }], details });
            }
            return { content: [{ type: "text", text }], details };
        },
    });
    // -------------------------------------------------------------------------
    // Tool: bash_io
    // -------------------------------------------------------------------------
    pi.registerTool({
        name: "bash_io",
        label: "Interact with Background Process",
        description: `Interact with a background process started by bash. Can write text to the process's stdin, send Ctrl-C (use "\\u0003" as chars), or poll for new output (leave chars empty). Always waits yield_time_ms (default 5s) to collect output before returning. Use this to monitor long-running tasks, respond to prompts, or send additional commands.`,
        parameters: Type.Object({
            session_id: Type.Integer({
                description: "The session_id returned by bash for the running process.",
            }),
            chars: Type.Optional(Type.String({
                description: `Text to write to the process's stdin. Use "\\u0003" (Ctrl-C) to interrupt. Leave empty to just poll for output (no write). Defaults to empty.`,
            })),
            yield_time_ms: Type.Optional(Type.Integer({
                description: `Milliseconds to wait for output after writing/polling (default: ${MIN_POLL_YIELD_MS}, range: ${MIN_YIELD_MS}-${MAX_YIELD_MS}).`,
            })),
        }),
        promptSnippet: "bash_io(session_id, chars?, yield_time_ms?): poll or send input to a bash process",
        async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
            const sessionId = params.session_id;
            const chars = params.chars ?? "";
            const yieldMs = params.yield_time_ms
                ? clampYield(params.yield_time_ms, chars ? MIN_YIELD_MS : MIN_POLL_YIELD_MS)
                : MIN_POLL_YIELD_MS;
            const start = Date.now();
            const mp = manager.get(sessionId);
            if (!mp) {
                throw new Error(`No background process with session_id ${sessionId}. The process may have exited and been cleaned up, or the ID is invalid. Use bash to start a new process.`);
            }
            if (onUpdate) {
                const action = chars === "" ? "polling" : chars === CTRL_C ? "interrupting" : "writing to";
                onUpdate({
                    content: [
                        {
                            type: "text",
                            text: `${action} process ${sessionId} ($ ${mp.command})`,
                        },
                    ],
                    details: { sessionId, command: mp.command, action },
                });
            }
            // Write if non-empty.
            if (chars !== "") {
                const result = manager.writeStdin(sessionId, chars);
                if (!result.ok) {
                    throw new Error(result.error ?? "bash_io failed");
                }
                // Brief delay to let the process react to the write.
                await sleep(POST_WRITE_DELAY_MS);
            }
            const { output, exited, exitCode } = await manager.poll(sessionId, yieldMs);
            const wallMs = Date.now() - start;
            // If process exited, remove from store.
            if (exited) {
                manager.remove(sessionId);
            }
            const text = formatResult({
                output,
                exited,
                exitCode,
                sessionId: exited ? null : sessionId,
                wallMs,
            });
            const details = { sessionId: exited ? null : sessionId, exited, exitCode: exited ? exitCode : null };
            if (onUpdate) {
                onUpdate({ content: [{ type: "text", text }], details });
            }
            return { content: [{ type: "text", text }], details };
        },
    });
}
