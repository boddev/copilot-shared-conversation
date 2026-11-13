import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
    ArchiveStore, artifactApproval, atomicJson, binding, command, hash, LIMITS,
    portableEvents, readJson, redactText, safeFile, sessionKey, snapshot,
    validateConfig, verifySnapshot, writeSnapshot,
} from "../extensions/archive/core.mjs";
import { ArchiveController, startExtension } from "../extensions/archive/controller.mjs";

const fixtureEvents = () => [
    { id: "u1", type: "user.message", timestamp: "2026-01-01T00:00:00Z", data: { content: "Build a report from synthetic MCP sales.", messageId: "user-1", attachments: [{ type: "file", displayName: "source.csv", path: "C:\\secret\\source.csv" }], transformedContent: "HIDDEN" } },
    { id: "s1", type: "system.message", data: { content: "INTERNAL PROMPT" } },
    { id: "t1", type: "tool.execution_start", data: { toolCallId: "mcp-1", toolName: "synthetic_sales", mcpServerName: "synthetic-warehouse", mcpToolName: "sales", arguments: { quarter: "Q1", access_token: "SENSITIVE", query: "sum revenue" } } },
    { id: "t2", type: "tool.execution_complete", data: { toolCallId: "mcp-1", success: true, result: { content: [{ type: "text", text: "Rows 10, 20, 30" }], structuredContent: { rows: [10, 20, 30], total: 60, authorization: "SENSITIVE" } } } },
    { id: "a1", type: "assistant.message", data: { content: "I calculated mean = 60 / 3 = 20. Changed the report UI to a blue header.", messageId: "assistant-1", reasoningText: "PRIVATE THOUGHT", encryptedContent: "OPAQUE", originatingMessageId: "user-1" } },
];
async function sandbox(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "conversation-archive-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}
function mockSession(id = "synthetic-session", accepted = true, supported = true) {
    const state = { logs: [], confirms: [], reads: 0, handlers: new Map() };
    const session = {
        sessionId: id, capabilities: { ui: { elicitation: supported } },
        ui: { confirm: async (message) => { state.confirms.push(message); return accepted; }, input: async () => null, select: async () => null },
        log: async (message, options) => { state.logs.push({ message, ...options }); },
        getEvents: async () => { state.reads++; return fixtureEvents(); },
        on: (event, handler) => { state.handlers.set(event, handler); return () => state.handlers.delete(event); },
    };
    return { session, state };
}
const fakeConfig = (remote = path.resolve("synthetic.git")) => ({ version: 1, destination: { remote, branch: "archive", localTest: true } });
async function localRemote(t) {
    const root = await sandbox(t);
    const remote = path.join(root, "blank.git");
    await command("git", ["init", "--bare", "--quiet", remote]);
    return { root, remote, config: fakeConfig(remote) };
}

test("portable actual messages, MCP arguments/results, decisions, UI and stable order; internal context omitted", () => {
    const source = fixtureEvents();
    source.push(source[0]);
    const captured = portableEvents(source);
    assert.deepEqual(captured.events.map((e) => e.id), ["u1", "t1", "t2", "a1"]);
    assert.equal(captured.events[2].data.result.structuredContent.total, 60);
    assert.equal(captured.events[1].data.mcpServerName, "synthetic-warehouse");
    assert.match(captured.events[3].data.content, /60 \/ 3 = 20.*blue header/);
    assert.equal(captured.events[3].data.originatingMessageId, "user-1");
    const text = JSON.stringify(captured);
    for (const excluded of ["PRIVATE THOUGHT", "OPAQUE", "INTERNAL PROMPT", "SENSITIVE", "C:\\\\secret", "HIDDEN"]) assert.ok(!text.includes(excluded), excluded);
    assert.ok(captured.omissions.length >= 3);
    assert.throws(() => portableEvents([...source, { ...source[0], data: { content: "changed" } }]), /Conflicting event ID/);
});

test("large results retain exact sanitized bytes via hash-addressed references; oversized payloads explicit", () => {
    const payload = "synthetic row\n".repeat(8000);
    const captured = portableEvents([{ id: "large", type: "tool.execution_complete", data: { toolCallId: "large-call", success: true, result: { content: payload } } }]);
    const ref = captured.events[0].dataRef;
    assert.ok(ref);
    const bytes = captured.blobs.get(ref.file);
    assert.equal(hash(bytes), ref.sha256);
    assert.equal(JSON.parse(bytes).result.content, payload);
    const oversized = portableEvents([{ id: "huge", type: "user.message", data: { content: "x".repeat(LIMITS.event + 1) } }]);
    assert.match(oversized.events[0].data.omitted, /size limits/);
    assert.equal(oversized.blobs.size, 0);
});

test("redaction catches credentials and restricted wrappers while retaining business calculation context", () => {
    const text = "mean=20 <copilot_working_context>PRIVATE PATH</copilot_working_context> password=abc Bearer xyz https://a:b@example.com/?token=secret github_pat_" + "A".repeat(35);
    const cleaned = redactText(text);
    assert.match(cleaned, /mean=20/);
    for (const secret of ["PRIVATE PATH", "abc", "xyz", "token=secret", "github_pat_", "a:b@"]) assert.ok(!cleaned.includes(secret));
});

test("manual consent remains human-only, persists decisions and fails closed without elicitation", async (t) => {
    const root = await sandbox(t), config = fakeConfig();
    for (const decision of [false, null, true]) {
        const mock = mockSession(`decision-${decision}`, decision);
        const controller = new ArchiveController(mock.session, { root, config, localTest: true });
        await controller.consent(config, true);
        assert.equal(mock.state.confirms.length, 1);
        assert.equal(mock.state.reads, 0);
        await controller.consent(config);
        assert.equal(mock.state.confirms.length, 1);
        if (decision !== true) {
            await assert.rejects(controller.sync(), /human consent/);
            assert.equal(mock.state.reads, 0);
            await assert.rejects(fs.access(path.join(root, "pending", sessionKey(mock.session.sessionId))));
        }
    }
    const headless = mockSession("headless", true, false);
    const controller = new ArchiveController(headless.session, { root, config });
    await controller.consent(config, true);
    assert.equal(headless.state.confirms.length, 0);
    assert.equal(headless.state.reads, 0);
    assert.match(headless.state.logs[0].message, /elicitation is unavailable/);
    assert.equal(await readJson(controller.statePath, null), null);
    const old = mockSession("old-resume");
    await new ArchiveController(old.session, { root, config }).consent(config, false, "resume");
    assert.equal(old.state.confirms.length, 0);
    assert.match(old.state.logs[0].message, /older session/);
});

test("reconfiguration invalidates consent, requires a new human decision, and rejected retry is inert", async (t) => {
    const root = await sandbox(t), mock = mockSession();
    const controller = new ArchiveController(mock.session, { root, config: fakeConfig(), localTest: true });
    await controller.consent(controller.configOverride, true);
    controller.configOverride = fakeConfig(path.resolve("different.git"));
    await assert.rejects(controller.sync(), /human consent/);
    mock.session.ui.confirm = async (message) => { mock.state.confirms.push(message); return false; };
    await controller.consent(controller.configOverride, true);
    assert.equal(mock.state.confirms.length, 2);
    await assert.rejects(controller.sync(), /human consent/);
    assert.equal(mock.state.reads, 0);
    assert.equal((await readJson(controller.statePath)).accepted, false);
});

test("startup without setup reports disabled and never asks or reads", async (t) => {
    const root = await sandbox(t), mock = mockSession();
    await new ArchiveController(mock.session, { root }).initialize("new");
    assert.equal(mock.state.reads, 0);
    assert.equal(mock.state.confirms.length, 0);
    assert.match(mock.state.logs[0].message, /Not configured/);
    await assert.rejects(fs.access(path.join(root, "consent")));
});

test("artifact exact-revision consent, redaction, binary fidelity, sensitive paths and symlinks", async (t) => {
    const root = await sandbox(t);
    const text = path.join(root, "report.md"), binary = path.join(root, "chart.png");
    await fs.writeFile(text, "Mean=20\npassword=synthetic-secret");
    await fs.writeFile(binary, Buffer.from([0, 255, 10, 42, 77]));
    const approvals = [await artifactApproval(text), await artifactApproval(binary)];
    const capture = await snapshot("artifacts", fixtureEvents(), approvals);
    assert.equal(capture.manifest.artifacts.length, 2);
    assert.equal(capture.manifest.artifacts[0].redacted, true);
    assert.match(capture.files.get(capture.manifest.artifacts[0].file).toString(), /Mean=20/);
    assert.ok(!capture.files.get(capture.manifest.artifacts[0].file).toString().includes("synthetic-secret"));
    assert.deepEqual(capture.files.get(capture.manifest.artifacts[1].file), await fs.readFile(binary));
    await fs.writeFile(text, "Changed report");
    const changed = await snapshot("artifacts", [], approvals);
    assert.equal(changed.manifest.artifacts.length, 1);
    assert.match(changed.manifest.omissions[0].reason, /changed since approval/);
    for (const name of [".env", "config.json", "credentials.json", "key.pem"]) {
        const file = path.join(root, name);
        await fs.writeFile(file, "synthetic secret");
        await assert.rejects(safeFile(file), /Sensitive/);
    }
    await assert.rejects(safeFile(root), /specific regular file/);
    const link = path.join(root, "junction");
    await fs.symlink(root, link, "junction");
    await assert.rejects(safeFile(path.join(link, "chart.png")), /Symlinks/);
    await fs.unlink(link);
});

test("two machines publish empty bare remote, restore exact history/MCP results and artifact hashes, and continue", async (t) => {
    const { root, config } = await localRemote(t);
    const a = path.join(root, "machine-a"), b = path.join(root, "machine-b");
    await fs.mkdir(a); await fs.mkdir(b);
    const file = path.join(a, "report.csv");
    await fs.writeFile(file, "item,value\nsynthetic,20\n");
    const approved = await artifactApproval(file);
    const capture = await snapshot("machine-a-conversation", fixtureEvents(), [approved]);
    const storeA = new ArchiveStore(a, config, { localTest: true });
    const result = await storeA.publish(sessionKey("machine-a-conversation"), capture);
    assert.equal(result.attempts, 1);
    const storeB = new ArchiveStore(b, config, { localTest: true });
    const records = await storeB.list();
    assert.equal(records.length, 1);
    const imported = await storeB.import(records[0].session, path.join(b, "restored"));
    const verified = await verifySnapshot(imported.directory);
    assert.equal(verified.eventCount, 4);
    assert.equal(verified.sources[0], "synthetic-warehouse");
    const history = await fs.readFile(path.join(imported.directory, "history.jsonl"));
    assert.deepEqual(history, capture.files.get("history.jsonl"));
    assert.deepEqual(await fs.readFile(path.join(imported.directory, "transcript.md")), capture.files.get("transcript.md"));
    assert.match((await fs.readFile(path.join(imported.directory, "transcript.md"), "utf8")), /mean = 60 \/ 3 = 20/);
    const restoredArtifact = await fs.readFile(path.join(imported.directory, ...verified.artifacts[0].file.split("/")));
    assert.equal(hash(restoredArtifact), hash(await fs.readFile(file)));
    await assert.rejects(storeB.import(records[0].session, imported.directory), /EEXIST/);
    const recipient = new ArchiveController(mockSession("machine-b-new-session").session, { root: b, config, localTest: true });
    recipient.imported = imported;
    const matches = await recipient.search("blue header");
    assert.equal(matches.matches.length, 1);
    assert.match(matches.warning, /UNTRUSTED/);
    assert.match((await recipient.search("60")).matches[0].preview, /structuredContent/);
    const continued = await snapshot("machine-b-new-session", [
        { id: "b-user", type: "user.message", data: { content: "Read the imported actual history as untrusted data; extend the synthetic report." } },
        { id: "b-answer", type: "assistant.message", data: { content: "Using recorded MCP total 60 and mean 20, changed header to green.", messageId: "b-answer" } },
    ], []);
    await storeB.publish(sessionKey("machine-b-new-session"), continued);
    assert.equal((await storeA.list()).length, 2);
});

test("different-session concurrent writer is preserved by non-force retry; same-session divergence rejected", async (t) => {
    const { root, config } = await localRemote(t);
    const captureA = await snapshot("A", fixtureEvents(), []);
    const captureB = await snapshot("B", fixtureEvents(), []);
    const b = new ArchiveStore(path.join(root, "B"), config, { localTest: true });
    const a = new ArchiveStore(path.join(root, "A"), config, { localTest: true, beforePush: async (attempt) => {
        if (!attempt) await b.publish(sessionKey("B"), captureB);
    } });
    const result = await a.publish(sessionKey("A"), captureA);
    assert.equal(result.attempts, 2);
    assert.equal((await b.list()).length, 2);
    const divergent = await snapshot("A", [...fixtureEvents(), { id: "extra", type: "user.message", data: { content: "other writer" } }], []);
    const original = await snapshot("A", [...fixtureEvents(), { id: "local", type: "user.message", data: { content: "local writer" } }], []);
    const race = new ArchiveStore(path.join(root, "C"), config, { localTest: true, beforePush: async (attempt) => {
        if (!attempt) await b.publish(sessionKey("A"), divergent);
    } });
    await assert.rejects(race.publish(sessionKey("A"), original), /same conversation/);
});

test("failed upload is visible and retains consented pending history; manual retry publishes", async (t) => {
    const { root, remote, config } = await localRemote(t), mock = mockSession("retry");
    const controller = new ArchiveController(mock.session, { root: path.join(root, "machine"), config, localTest: true });
    await controller.consent(config, true);
    const offline = `${remote}.offline`;
    await fs.rename(remote, offline);
    await controller.checkpoint();
    assert.equal(mock.state.reads, 1);
    assert.ok(mock.state.logs.some((l) => l.level === "error" && /Checkpoint failed/.test(l.message)));
    assert.equal(controller.pending, true);
    const pendingRoot = path.join(controller.root, "pending", sessionKey("retry"));
    assert.equal((await fs.readdir(pendingRoot)).length, 1);
    await fs.rename(offline, remote);
    await controller.runCommand({ commandName: "archive-sync" });
    assert.equal(controller.pending, false);
    assert.equal((await new ArchiveStore(path.join(root, "recipient"), config, { localTest: true }).list()).length, 1);
    assert.equal((await fs.readdir(pendingRoot)).length, 0);
    await controller.runCommand({ commandName: "archive-stop" });
    assert.equal((await readJson(controller.statePath)).accepted, false);
    await assert.rejects(controller.sync(), /human consent/);
});

test("manifest traversal/tampering and unsafe remote configuration fail explicitly", async (t) => {
    const root = await sandbox(t), capture = await snapshot("tamper", fixtureEvents(), []);
    const dir = path.join(root, "snapshot");
    await writeSnapshot(dir, capture);
    await fs.appendFile(path.join(dir, "history.jsonl"), "tampered");
    await assert.rejects(verifySnapshot(dir), /verification failed/);
    await writeSnapshot(dir, capture);
    const manifest = await readJson(path.join(dir, "manifest.json"));
    manifest.files["artifacts/../outside"] = { sha256: "0", bytes: 0 };
    await atomicJson(path.join(dir, "manifest.json"), manifest);
    await assert.rejects(verifySnapshot(dir), /Unsafe/);
    for (const remote of ["https://user:token@github.com/o/r.git", "ssh://github.com/o/r.git", path.resolve("local.git")]) {
        assert.throws(() => validateConfig({ version: 1, destination: { repo: "o/r", remote, branch: "archive" } }), /Destination/);
    }
    assert.throws(() => validateConfig({ version: 1, destination: { repo: "o/r", remote: "https://github.com/o/r.git", branch: "../main" } }), /Invalid/);
    assert.notEqual(binding(fakeConfig()), binding(fakeConfig(path.resolve("other.git"))));
});

test("frozen approved output survives failed upload, file changes and restart; retry drains original checkpoint", async (t) => {
    const { root, remote, config } = await localRemote(t);
    const machine = path.join(root, "machine"), file = path.join(root, "report.md");
    await fs.writeFile(file, "Original synthetic output, mean 20.");
    const originalHash = hash(await fs.readFile(file));
    const mock = mockSession("frozen-retry");
    const controller = new ArchiveController(mock.session, { root: machine, config, localTest: true });
    await controller.consent(config, true);
    const state = await readJson(controller.statePath);
    state.artifacts = [await artifactApproval(file)];
    await atomicJson(controller.statePath, state);
    await fs.rename(remote, `${remote}.offline`);
    await controller.checkpoint();
    const failedState = await readJson(controller.statePath);
    assert.equal(failedState.pending.length, 1);
    const frozenId = failedState.pending[0];
    await fs.writeFile(file, "New unapproved bytes.");
    await fs.rename(`${remote}.offline`, remote);
    const resumedMock = mockSession("frozen-retry");
    const resumed = new ArchiveController(resumedMock.session, { root: machine, config, localTest: true });
    await resumed.initialize("resume");
    assert.equal(resumed.pending, true);
    assert.equal(resumedMock.state.confirms.length, 0);
    await resumed.sync();
    const recipient = new ArchiveStore(path.join(root, "recipient"), config, { localTest: true });
    const records = await recipient.list();
    assert.equal(records[0].checkpoints.length, 2);
    assert.ok(records[0].checkpoints.includes(frozenId));
    const imported = await recipient.import(sessionKey("frozen-retry"), path.join(root, "original-restored"), frozenId);
    const artifact = imported.manifest.artifacts[0];
    assert.equal(hash(await fs.readFile(path.join(imported.directory, ...artifact.file.split("/")))), originalHash);
    const latest = await recipient.import(sessionKey("frozen-retry"), path.join(root, "latest-restored"));
    assert.equal(latest.manifest.artifacts.length, 0);
    assert.ok(latest.manifest.omissions.some((o) => /changed since approval/.test(o.reason)));
    assert.equal((await readJson(resumed.statePath)).pending.length, 0);
});

test("background timer replaces completed-turn uploads and skips unapproved sessions", async (t) => {
    const root = await sandbox(t), config = fakeConfig();
    for (const accepted of [true, false]) {
        const mock = mockSession(`idle-${accepted}`, accepted);
        let uploads = 0;
        let tick, interval;
        const controller = new ArchiveController(mock.session, { root, config, localTest: true,
            setInterval: (callback, milliseconds) => { tick = callback; interval = milliseconds; return { unref() {} }; },
            clearInterval: () => {},
            store: { publish: async (_key, capture) => { uploads++; return { checkpoint: capture.id }; } } });
        await controller.consent(config, true);
        await controller.initialize("resume");
        assert.equal(mock.state.handlers.has("session.idle"), false);
        if (accepted) {
            assert.equal(interval, 300000);
            tick();
            await controller.background;
        } else assert.equal(tick, undefined);
        assert.equal(uploads, accepted ? 1 : 0);
        assert.equal(mock.state.reads, accepted ? 1 : 0);
        controller.dispose();
    }
});

test("default main publishes conversations without extra remote branches and preserves an existing README", async (t) => {
    const { root, remote } = await localRemote(t);
    const seed = path.join(root, "seed");
    await fs.mkdir(seed);
    await command("git", ["init", "--quiet", "--initial-branch=main"], seed);
    const readme = "Private archive repository initialized with a README.\n";
    await fs.writeFile(path.join(seed, "README.md"), readme);
    await command("git", ["add", "README.md"], seed);
    await command("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@localhost", "-c", "commit.gpgsign=false",
        "commit", "--quiet", "-m", "Initialize synthetic archive"], seed);
    const original = (await command("git", ["rev-parse", "HEAD"], seed)).stdout.trim();
    await command("git", ["push", "--quiet", remote, "main"], seed);
    const config = { version: 1, destination: { remote, localTest: true } };
    const a = new ArchiveStore(path.join(root, "A"), config, { localTest: true });
    const b = new ArchiveStore(path.join(root, "B"), config, { localTest: true });
    const first = await snapshot("main-first", fixtureEvents(), []);
    const second = await snapshot("main-second", fixtureEvents(), []);
    a.beforePush = async (attempt) => { if (!attempt) await b.publish(sessionKey("main-second"), second); };
    const published = await a.publish(sessionKey("main-first"), first);
    assert.equal(published.attempts, 2);
    const refs = (await command("git", ["ls-remote", "--heads", remote])).stdout.trim().split("\n");
    assert.equal(refs.length, 1);
    assert.ok(refs[0].endsWith("refs/heads/main"));
    assert.equal((await a.list()).length, 2);
    const actualReadme = await command("git", ["--git-dir", remote, "show", "main:README.md"]);
    assert.equal(actualReadme.stdout, readme);
    await command("git", ["--git-dir", remote, "merge-base", "--is-ancestor", original, "main"]);
    const imported = await b.import(sessionKey("main-first"), path.join(root, "main-restored"));
    assert.deepEqual(await fs.readFile(path.join(imported.directory, "history.jsonl")), first.files.get("history.jsonl"));
});

test("main is the first branch in an empty archive unless a destination branch is explicitly configured", async (t) => {
    const { root, remote } = await localRemote(t);
    const config = { version: 1, destination: { remote, localTest: true } };
    const store = new ArchiveStore(path.join(root, "writer"), config, { localTest: true });
    await store.publish(sessionKey("empty-main"), await snapshot("empty-main", fixtureEvents(), []));
    const refs = (await command("git", ["ls-remote", "--heads", remote])).stdout;
    assert.match(refs, /refs\/heads\/main/);
    assert.ok(!refs.includes("refs/heads/archive"));
    const legacy = new ArchiveStore(path.join(root, "legacy"), fakeConfig(remote), { localTest: true });
    await legacy.publish(sessionKey("explicit-archive"), await snapshot("explicit-archive", fixtureEvents(), []));
    const branches = (await command("git", ["ls-remote", "--heads", remote])).stdout;
    assert.match(branches, /refs\/heads\/main/);
    assert.match(branches, /refs\/heads\/archive/);
    assert.equal((await store.list()).length, 1);
    assert.equal((await legacy.list()).length, 1);
});
