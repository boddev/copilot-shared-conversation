import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { atomicJson, command, readJson, redactText, sessionKey } from "../extensions/archive/core.mjs";

const [sdkDirectory, cliLoader, privateRepo] = process.argv.slice(2);
if (!sdkDirectory || !cliLoader) throw new Error("Usage: node test/runtime-smoke.mjs ABSOLUTE_SDK_DIRECTORY ABSOLUTE_CLI_NPM_LOADER");
const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(path.join(sdkDirectory, "index.js")));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "archive-runtime-smoke-"));
const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: process.execPath, args: [cliLoader],
        env: { ...process.env, COPILOT_HOME: path.join(root, "copilot"), COPILOT_ARCHIVE_HOME: path.join(root, "archive"), COPILOT_AUTO_UPDATE: "false" } }),
});
let session;
const permissionHandler = async (request) => ({
    kind: request.kind === "extension-permission-access" &&
        request.extensionName === "plugin:conversation-archive:archive" &&
        request.capabilities?.every((capability) => capability === "register hooks")
        ? "approve-once" : "reject",
});
async function ready(session) {
    let extensions, archive;
    const deadline = Date.now() + 15000;
    do {
        extensions = await session.rpc.extensions.list();
        archive = extensions.extensions.find((e) => e.name === "conversation-archive:archive");
        if (archive && archive.status !== "starting") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.ok(archive, `Archive extension not discovered: ${JSON.stringify(extensions)}`);
    assert.equal(archive.status, "running", JSON.stringify(archive));
    return archive;
}
try {
    await client.start();
    session = await client.createSession({
        workingDirectory: root, requestExtensions: true, pluginDirectories: [plugin],
        onPermissionRequest: permissionHandler,
    });
    const archive = await ready(session);
    let events = await session.getEvents();
    const warningDeadline = Date.now() + 5000;
    while (!JSON.stringify(events).includes("Not configured") && Date.now() < warningDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        events = await session.getEvents();
    }
    assert.ok(JSON.stringify(events).includes("Not configured"), "Expected fail-closed setup warning.");
    await assert.rejects(fs.access(path.join(root, "archive", "pending")));
    await session.disconnect();

    await atomicJson(path.join(root, "archive", "config.json"), { version: 1,
        destination: { repo: "synthetic-owner/synthetic-archive", remote: "https://github.com/synthetic-owner/synthetic-archive.git" } });
    const requests = [];
    const options = {
        workingDirectory: root, requestExtensions: true, pluginDirectories: [plugin],
        onPermissionRequest: permissionHandler,
        onElicitationRequest: async (request) => { requests.push(request); return { action: "decline" }; },
    };
    session = await client.createSession(options);
    await ready(session);
    assert.equal(session.capabilities.ui?.elicitation, true);
    const statePath = path.join(root, "archive", "consent", `${sessionKey(session.sessionId)}.json`);
    const deadline = Date.now() + 5000;
    let configuredEvents = await session.getEvents();
    while (!JSON.stringify(configuredEvents).includes("Startup failed closed") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        configuredEvents = await session.getEvents();
    }
    assert.ok(JSON.stringify(configuredEvents).includes("Startup failed closed"), "Non-repository workspace must fail closed.");
    assert.equal(requests.length, 0, "Startup must not ask for per-conversation consent.");
    assert.equal(await readJson(statePath, null), null);
    await assert.rejects(fs.access(path.join(root, "archive", "pending")));
    const id = session.sessionId;
    await session.disconnect();
    session = await client.resumeSession(id, options);
    await session.rpc.extensions.reload();
    await ready(session);
    assert.equal(requests.length, 0, "Resume/reload must not prompt.");
    await assert.rejects(fs.access(path.join(root, "archive", "pending")));
    let privateSessionActivated = false;
    if (privateRepo) {
        if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(privateRepo)) throw new Error("Optional private repository must be owner/repo.");
        await session.disconnect();
        const workingDirectory = path.join(root, "synthetic-private-work");
        await fs.mkdir(workingDirectory);
        await command("git", ["init", "--quiet"], workingDirectory);
        await command("git", ["remote", "add", "origin", `https://github.com/${privateRepo}.git`], workingDirectory);
        await fs.writeFile(path.join(workingDirectory, "existing-synthetic.txt"), "Existing synthetic file must only be fingerprinted.");
        await atomicJson(path.join(root, "archive", "config.json"), { version: 1,
            destination: { repo: privateRepo, remote: `https://github.com/${privateRepo}.git` } });
        session = await client.createSession({ ...options, workingDirectory });
        await ready(session);
        const statePath = path.join(root, "archive", "consent", `${sessionKey(session.sessionId)}.json`);
        const deadline = Date.now() + 15000;
        let state = await readJson(statePath, null);
        while (!state && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            state = await readJson(statePath, null);
        }
        assert.ok(state?.accepted && state.automatic, "Real runtime must automatically activate a new verified-private session.");
        assert.equal(state.repository.toLowerCase(), privateRepo.toLowerCase());
        assert.ok(Object.keys(state.baseline).some((file) => file.endsWith("existing-synthetic.txt")));
        assert.equal(requests.length, 0);
        await assert.rejects(fs.access(path.join(root, "archive", "pending")));
        privateSessionActivated = true;
    }
    console.log(JSON.stringify({ sdk: sdkDirectory, runtimeVersion: events.find((e) => e.type === "session.start")?.data.copilotVersion,
        pluginLoaded: true, extension: archive.name, status: archive.status, failClosedWithoutSetup: true,
        automaticStartupConsentRequests: requests.length, unverifiedWorkspaceDisabled: true,
        resumedWithoutPrompt: true, privateSessionActivated, modelPromptsSent: 0, uploads: 0 }));
} catch (error) {
    if (session) {
        console.error(redactText(JSON.stringify(await session.getEvents())));
        async function logs(directory) {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                const file = path.join(directory, entry.name);
                if (entry.isDirectory()) await logs(file);
                else if (entry.name.endsWith(".log")) console.error(redactText((await fs.readFile(file, "utf8")).slice(-8000)));
            }
        }
        await logs(root);
    }
    throw error;
} finally {
    if (session) await session.disconnect();
    await client.stop();
    await fs.rm(root, { recursive: true, force: true });
}
