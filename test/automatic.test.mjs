import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ArchiveController, startExtension } from "../extensions/archive/controller.mjs";
import { changedOutputs, githubRepository, outputRoots, scanOutputs, workingRepository } from "../extensions/archive/automatic.mjs";
import { ArchiveStore, atomicJson, command, hash, readJson, sessionKey } from "../extensions/archive/core.mjs";

async function fixture(t, visibility = true) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "archive-automatic-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, "workspace"), state = path.join(root, "state");
    const workspacePath = path.join(root, "session-state", "synthetic");
    await fs.mkdir(directory); await fs.mkdir(path.join(workspacePath, "files"), { recursive: true });
    const repository = { directory, repo: "synthetic/private-work", private: visibility };
    const remote = path.join(root, "remote.git");
    await command("git", ["init", "--bare", "--quiet", remote]);
    const config = { version: 1, destination: { remote, branch: "archive", localTest: true } };
    const logs = [], prompts = [];
    let tick, clears = 0, events = [{ id: "u", type: "user.message", data: { content: "Generate a synthetic report." } }];
    const session = { sessionId: "automatic-synthetic", workspacePath, capabilities: { ui: { elicitation: false } },
        ui: { confirm: async (message) => { prompts.push(message); throw new Error("Automatic mode must never prompt"); } },
        log: async (message, options) => logs.push({ message, ...options }), getEvents: async () => events, on: () => {} };
    const options = { root: state, config, localTest: true, workingDirectory: directory, resolveRepository: async () => repository,
        setInterval: (callback, ms) => { assert.equal(ms, 300000); tick = callback; return { unref() {} }; },
        clearInterval: () => { clears++; } };
    const controller = new ArchiveController(session, options);
    t.after(() => controller.dispose());
    return { root, directory, workspacePath, state, config, repository, session, controller, options, logs, prompts,
        tick: () => tick?.(), scheduled: () => !!tick, clears: () => clears, setEvents: (value) => { events = value; } };
}

test("new private session automatically activates headlessly without prompts or immediate upload", async (t) => {
    const f = await fixture(t);
    await f.controller.initialize("new");
    const state = await readJson(f.controller.statePath);
    assert.equal(state.accepted, true);
    assert.equal(state.automatic, "private-workspace-outputs-v1");
    assert.equal(f.scheduled(), true);
    assert.equal(f.prompts.length, 0);
    assert.equal(f.logs.length, 0);
    await assert.rejects(fs.access(path.join(f.state, "pending")));
    assert.deepEqual(await new ArchiveStore(f.state, f.config, { localTest: true }).list(), []);
});

test("public and unverified working repos never automatically approve or schedule", async (t) => {
    for (const mode of ["public", "unverified"]) {
        const f = await fixture(t, false);
        if (mode === "unverified") f.controller.resolveRepository = async () => { throw new Error("privacy check unavailable"); };
        await f.controller.initialize("new");
        assert.equal(await readJson(f.controller.statePath, null), null);
        assert.equal(f.scheduled(), false);
        assert.equal(f.prompts.length, 0);
        assert.ok(f.logs.some((entry) => /not private|privacy check unavailable/.test(entry.message)));
    }
});

test("auto outputs include new/modified workspace and session binaries; unchanged, credentials and symlinks are excluded", async (t) => {
    const f = await fixture(t);
    const unchanged = path.join(f.directory, "existing.txt"), modified = path.join(f.directory, "changed.html");
    await fs.writeFile(unchanged, "Do not upload unchanged source.");
    await fs.writeFile(modified, "Old report.");
    await f.controller.initialize("new");
    await fs.writeFile(modified, "New report: mean 20, blue header.");
    await fs.writeFile(path.join(f.directory, "new.md"), "password=synthetic-secret\nVisible summary");
    await fs.writeFile(path.join(f.directory, ".env"), "SECRET=not-exported");
    await fs.writeFile(path.join(f.directory, "config.json"), '{"token":"not-exported"}');
    const bytes = Buffer.from([0, 255, 13, 37, 81]);
    await fs.writeFile(path.join(f.workspacePath, "files", "chart.png"), bytes);
    const link = path.join(f.directory, "junction");
    await fs.symlink(path.join(f.workspacePath, "files"), link, "junction");
    await f.controller.sync();
    await fs.unlink(link);
    const store = new ArchiveStore(path.join(f.root, "recipient"), f.config, { localTest: true });
    const imported = await store.import(sessionKey(f.session.sessionId), path.join(f.root, "restored"));
    const names = imported.manifest.artifacts.map((artifact) => artifact.source).sort();
    assert.deepEqual(names, ["session-files/chart.png", "workspace/changed.html", "workspace/new.md"]);
    for (const artifact of imported.manifest.artifacts) {
        assert.equal(artifact.automatic, true);
        const actual = await fs.readFile(path.join(imported.directory, ...artifact.file.split("/")));
        assert.equal(hash(actual), artifact.sha256);
        if (artifact.name === "chart.png") assert.equal(hash(actual), hash(bytes));
        if (artifact.name === "new.md") assert.ok(!actual.toString().includes("synthetic-secret"));
    }
    assert.ok(imported.manifest.omissions.some((o) => /Symlink/.test(o.reason)));
});

test("timer runs asynchronously, skips overlapping ticks, suppresses success chatter and clears on shutdown", async (t) => {
    const f = await fixture(t);
    let calls = 0, release;
    const pending = new Promise((resolve) => { release = resolve; });
    f.controller.storeOverride = { publish: async (_key, capture) => { calls++; await pending; return { checkpoint: capture.id }; } };
    await f.controller.initialize("new");
    assert.equal(f.tick(), undefined);
    f.tick();
    assert.ok(f.controller.background);
    release();
    await f.controller.background;
    assert.equal(calls, 1);
    assert.equal(f.logs.length, 0);
    f.controller.dispose();
    assert.equal(f.clears(), 1);
});

test("resume preserves startup baseline, opt-out and five-minute scheduling; missing resume baseline fails closed", async (t) => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.directory, "existing.txt"), "existing");
    await f.controller.initialize("new");
    const baseline = (await readJson(f.controller.statePath)).baseline;
    await fs.writeFile(path.join(f.directory, "new.txt"), "Created before restart");
    f.controller.dispose();
    const resumed = new ArchiveController(f.session, f.options);
    await resumed.initialize("resume");
    assert.deepEqual((await readJson(resumed.statePath)).baseline, baseline);
    await resumed.runCommand({ commandName: "archive-stop" });
    await resumed.initialize("resume");
    assert.equal((await readJson(resumed.statePath)).accepted, false);
    assert.equal(resumed.timer, null);
    resumed.dispose();
    await fs.unlink(f.controller.statePath);
    await f.controller.initialize("resume");
    assert.equal(await readJson(f.controller.statePath, null), null);
    assert.equal(f.controller.timer, null);
});

test("privacy/scope/config changes stop automatic publishing and never redirect frozen history", async (t) => {
    const f = await fixture(t);
    await f.controller.initialize("new");
    f.repository.private = false;
    await assert.rejects(f.controller.sync(), /no longer private/);
    assert.equal(f.controller.timer, null);
    f.repository.private = true;
    f.repository.repo = "synthetic/other-private";
    await assert.rejects(f.controller.sync(), /scope changed/);
    f.repository.repo = "synthetic/private-work";
    f.controller.configOverride = { ...f.config, destination: { ...f.config.destination, branch: "other" } };
    await f.controller.initialize("resume");
    assert.equal(f.controller.timer, null);
    await assert.rejects(f.controller.sync(), /consent/);
    await assert.rejects(fs.access(path.join(f.state, "pending")));
});

test("failed scheduled publish stays visible and retries frozen automatic artifacts after source changes", async (t) => {
    const f = await fixture(t);
    await f.controller.initialize("new");
    const file = path.join(f.directory, "report.html");
    await fs.writeFile(file, "Original automatically captured revision");
    const originalHash = hash(await fs.readFile(file));
    await fs.rename(f.config.destination.remote, `${f.config.destination.remote}.offline`);
    f.tick(); await f.controller.background;
    const frozen = (await readJson(f.controller.statePath)).pending[0];
    assert.ok(frozen);
    assert.ok(f.logs.some((l) => l.level === "error" && /Checkpoint failed/.test(l.message)));
    await fs.writeFile(file, "Latest automatically captured revision");
    await fs.rename(`${f.config.destination.remote}.offline`, f.config.destination.remote);
    f.tick(); await f.controller.background;
    const store = new ArchiveStore(path.join(f.root, "recipient"), f.config, { localTest: true });
    const imported = await store.import(sessionKey(f.session.sessionId), path.join(f.root, "original"), frozen);
    assert.equal(imported.manifest.artifacts[0].sha256, originalHash);
    const latest = await store.import(sessionKey(f.session.sessionId), path.join(f.root, "latest"));
    assert.equal(latest.manifest.artifacts[0].sha256, hash(await fs.readFile(file)));
    assert.equal((await readJson(f.controller.statePath)).pending.length, 0);
});

test("working repo lookup binds explicit origin identity and rejects public, spoofed or credentialed origins", async () => {
    assert.equal(githubRepository("git@github.com:synthetic/work.git"), "synthetic/work");
    assert.equal(githubRepository("https://github.com/synthetic/work.git"), "synthetic/work");
    for (const remote of ["https://token@github.com/o/r.git", "https://github.com.evil/o/r", "https://elsewhere/o/r"]) assert.throws(() => githubRepository(remote));
    const calls = [];
    const directory = path.resolve("synthetic");
    const result = await workingRepository(directory, async (executable, args) => {
        calls.push([executable, args]);
        return { stdout: executable === "gh" ? '{"nameWithOwner":"synthetic/work","visibility":"PRIVATE"}' : args[0] === "rev-parse" ? directory : "git@github.com:synthetic/work.git" };
    });
    assert.equal(result.private, true);
    assert.deepEqual(calls[2], ["gh", ["repo", "view", "synthetic/work", "--json", "nameWithOwner,visibility"]]);
});

test("startup hook passes working directory and registers shutdown cleanup without idle uploads", async (t) => {
    const f = await fixture(t);
    const handlers = new Map();
    f.session.on = (name, handler) => handlers.set(name, handler);
    let registered;
    const controller = await startExtension(async (options) => {
        registered = options;
        await options.hooks.onSessionStart({ source: "new", workingDirectory: f.directory });
        return f.session;
    }, f.options);
    assert.equal(controller.workingDirectory, f.directory);
    assert.equal(f.prompts.length, 0);
    assert.equal(handlers.has("session.idle"), false);
    handlers.get("session.shutdown")();
    assert.equal(controller.timer, null);
    assert.equal(registered.tools.some((tool) => /consent|sync|export/.test(tool.name)), false);
});

test("timestamp-only touches are not captured as generated or modified content", async (t) => {
    const f = await fixture(t);
    const file = path.join(f.directory, "unchanged.txt");
    await fs.writeFile(file, "Unchanged content");
    const roots = outputRoots(f.repository, f.workspacePath);
    const before = await scanOutputs(roots, f.state);
    await fs.utimes(file, new Date("2030-01-01"), new Date("2030-01-01"));
    const outputs = await changedOutputs(roots, before.files, f.state);
    assert.deepEqual(outputs.approvals, []);
});

test("nested session-state never exports other sessions but current session files remain in scope", async (t) => {
    const f = await fixture(t);
    f.session.workspacePath = path.join(f.directory, "session-state", "current");
    const current = path.join(f.session.workspacePath, "files");
    const other = path.join(f.directory, "session-state", "other", "files");
    await fs.mkdir(current, { recursive: true }); await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "private.txt"), "Other session not in scope");
    await fs.writeFile(path.join(f.session.workspacePath, "events.jsonl"), "Internal runtime history");
    await f.controller.initialize("new");
    await fs.writeFile(path.join(current, "report.html"), "Current generated report");
    const state = await readJson(f.controller.statePath);
    assert.equal(state.roots.length, 2);
    const outputs = await changedOutputs(state.roots, state.baseline, f.state);
    assert.deepEqual(outputs.approvals.map((a) => a.source), ["session-files/report.html"]);
    assert.equal(Object.keys(state.baseline).some((file) => file.includes(`${path.sep}other${path.sep}`)), false);
    await f.controller.sync();
    const store = new ArchiveStore(path.join(f.root, "recipient"), f.config, { localTest: true });
    const imported = await store.import(sessionKey(f.session.sessionId), path.join(f.root, "restored"));
    assert.deepEqual(imported.manifest.artifacts.map((a) => a.source), ["session-files/report.html"]);
});

test("common credential/config variants are excluded without dropping ordinary report files", async (t) => {
    const f = await fixture(t);
    await f.controller.initialize("new");
    const sensitive = ["secrets.json", "tokens.json", "auth.json", "appsettings.json",
        "appsettings.Development.json", "secrets.local.yaml", "auth-cache.json", ".secrets",
        "application.config", "service.config.json", "config.toml", "settings.local.json"];
    for (const name of sensitive) await fs.writeFile(path.join(f.directory, name), '{"token":"SYNTHETIC-CREDENTIAL-FIXTURE"}');
    await fs.writeFile(path.join(f.directory, "auth-report.html"), "Ordinary generated report");
    await fs.writeFile(path.join(f.directory, "backlog-report.html"), '{"token":"SYNTHETIC-CREDENTIAL-FIXTURE","total":20}');
    const state = await readJson(f.controller.statePath);
    const outputs = await changedOutputs(state.roots, state.baseline, f.state);
    assert.deepEqual(outputs.approvals.map((a) => a.name).sort(), ["auth-report.html", "backlog-report.html"]);
    await f.controller.sync();
    const store = new ArchiveStore(path.join(f.root, "recipient"), f.config, { localTest: true });
    const imported = await store.import(sessionKey(f.session.sessionId), path.join(f.root, "restored"));
    for (const artifact of imported.manifest.artifacts) {
        const content = await fs.readFile(path.join(imported.directory, ...artifact.file.split("/")), "utf8");
        assert.ok(!content.includes("SYNTHETIC-CREDENTIAL-FIXTURE"));
    }
});

test("repository defaults need no machine configuration; explicit capture settings remain unchanged", async (t) => {
    const f = await fixture(t);
    f.controller.configOverride = undefined;
    const inferred = await f.controller.settings();
    assert.deepEqual(inferred.destination, { repo: f.repository.repo,
        remote: `https://github.com/${f.repository.repo}.git`, branch: "main" });
    await assert.rejects(fs.access(path.join(f.state, "config.json")));
    const configured = { version: 1, destination: {
        repo: "synthetic/explicit-archive", remote: "https://github.com/synthetic/explicit-archive.git", branch: "legacy" } };
    await atomicJson(path.join(f.state, "config.json"), configured);
    assert.deepEqual(await f.controller.settings(), configured);
    assert.deepEqual(await f.controller.readerSettings(), inferred, "Loading uses the current repository, not a different machine-wide target.");
    const sameRepository = { ...inferred, destination: { ...inferred.destination, branch: "legacy" } };
    await atomicJson(path.join(f.state, "config.json"), sameRepository);
    assert.deepEqual(await f.controller.readerSettings(), sameRepository, "An explicit branch override for this repository remains supported.");
    f.repository.private = false;
    await assert.rejects(f.controller.readerSettings(), /not private/);
});

test("new machine automatically offers repository conversations and restores actual context and artifacts without destination setup", async (t) => {
    const f = await fixture(t);
    const report = path.join(f.directory, "report.html");
    await fs.writeFile(report, "Mean 20; blue header");
    await f.controller.initialize("new");
    // Generate a changed output and record the actual synthetic MCP result.
    await fs.writeFile(report, "Mean = 60 / 3 = 20; blue header");
    f.setEvents([
        { id: "request", type: "user.message", data: { content: "Generate a blue sales report" } },
        { id: "mcp", type: "tool.execution_complete", data: { toolCallId: "sales", success: true,
            result: { structuredContent: { rows: [10, 20, 30], total: 60 } } } },
    ]);
    await f.controller.sync();
    f.controller.dispose();
    const store = new ArchiveStore(path.join(f.root, "recipient-store"), f.config, { localTest: true });
    let lists = 0, selects = 0, inputs = 0;
    const recipientRoot = path.join(f.root, "machine-b"), destination = path.join(f.root, "restored-on-b");
    const recipient = new ArchiveController({ ...f.session, sessionId: "new-machine-session",
        capabilities: { ui: { elicitation: true } },
        ui: {
            select: async (_message, choices) => { selects++; assert.match(choices[0], /Generate a blue sales report/); return choices[0]; },
            input: async (message) => { inputs++; assert.match(message, /local restore folder/); return destination; },
        },
    }, { ...f.options, root: recipientRoot, config: undefined,
        verifyDestination: async (config) => { assert.equal(config.destination.repo, f.repository.repo); assert.equal(config.destination.branch, "main"); },
        store: { list: async () => { lists++; return store.list(); }, import: (...args) => store.import(...args) } });
    t.after(() => recipient.dispose());
    await recipient.initialize("new");
    assert.equal(selects, 1);
    assert.equal(inputs, 1, "Only the safe local restore folder is requested, never archive configuration.");
    assert.equal(lists, 1);
    await assert.rejects(fs.access(path.join(recipientRoot, "config.json")));
    await assert.rejects(fs.access(path.join(recipientRoot, "pending")));
    const restored = recipient.imported;
    assert.equal(restored.manifest.eventCount, 2);
    const history = await fs.readFile(path.join(destination, "history.jsonl"), "utf8");
    assert.match(history, /Generate a blue sales report/);
    assert.match(history, /"total":60/);
    const artifact = restored.manifest.artifacts[0];
    assert.equal(hash(await fs.readFile(path.join(destination, ...artifact.file.split("/")))), hash(await fs.readFile(report)));
    assert.equal((await recipient.search("total")).matches.length, 1);
    await recipient.initialize("startup");
    await recipient.initialize("resume");
    assert.equal(selects, 1, "Reload/resume must not repeat the startup picker.");
    assert.equal(lists, 1);
});

test("startup picker cancellation, fresh choice and empty archives never import or export history", async (t) => {
    for (const mode of ["cancel", "fresh", "empty"]) {
        const f = await fixture(t);
        f.session.capabilities.ui.elicitation = true;
        let selects = 0, imports = 0;
        f.session.ui.select = async (_message, choices) => { selects++; return mode === "fresh" ? choices.at(-1) : null; };
        f.controller.storeOverride = {
            list: async () => mode === "empty" ? [] : [{ session: "a".repeat(64), eventCount: 1, checkpoint: "b".repeat(64), checkpoints: ["b".repeat(64)] }],
            import: async () => { imports++; },
        };
        await f.controller.initialize("new");
        assert.equal(selects, mode === "empty" ? 0 : 1);
        assert.equal(imports, 0);
        assert.equal(f.controller.imported, null);
        await assert.rejects(fs.access(path.join(f.state, "pending")));
        await f.controller.initialize("startup");
        assert.equal(selects, mode === "empty" ? 0 : 1);
    }
});

test("repository discovery fails closed for public/unverified origins and surfaces list failures for retry", async (t) => {
    for (const mode of ["public", "unverified", "offline"]) {
        const f = await fixture(t);
        f.controller.configOverride = undefined;
        f.session.capabilities.ui.elicitation = true;
        let reads = 0;
        f.controller.verifyDestination = async () => {};
        f.controller.storeOverride = { list: async () => { reads++; throw new Error("synthetic archive offline"); } };
        if (mode === "public") f.repository.private = false;
        if (mode === "unverified") f.controller.resolveRepository = async () => { throw new Error("synthetic origin unavailable"); };
        await f.controller.initialize("new");
        assert.equal(reads, mode === "offline" ? 1 : 0);
        assert.ok(f.logs.some((entry) => entry.level === "error" && /Archive discovery failed/.test(entry.message)));
        await assert.rejects(fs.access(path.join(f.state, "imports")));
        await assert.rejects(fs.access(path.join(f.state, "pending")));
        if (mode === "offline") {
            f.controller.storeOverride.list = async () => { reads++; return []; };
            await f.controller.runCommand({ commandName: "archive-load" });
            assert.equal(reads, 2, "Manual load retries a failed startup listing.");
        }
    }
});

test("repository archive trees are not recaptured as new generated outputs after a pull", async (t) => {
    const f = await fixture(t);
    await f.controller.initialize("new");
    const checkpoint = path.join(f.directory, "conversations", "a".repeat(64), "checkpoints");
    await fs.mkdir(checkpoint, { recursive: true });
    await fs.writeFile(path.join(checkpoint, "history.jsonl"), "Other conversation, not this session's output");
    await fs.writeFile(path.join(f.directory, "report.html"), "New report");
    const state = await readJson(f.controller.statePath);
    const outputs = await changedOutputs(state.roots, state.baseline, f.state);
    assert.deepEqual(outputs.approvals.map((a) => a.source), ["workspace/report.html"]);
});
