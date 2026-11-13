import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { atomicJson, readJson, redactText, sessionKey } from "../extensions/archive/core.mjs";

const [sdkDirectory, cliLoader] = process.argv.slice(2);
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
        destination: { repo: "synthetic-owner/synthetic-archive", remote: "https://github.com/synthetic-owner/synthetic-archive.git", branch: "archive" } });
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
    while (!(await readJson(statePath, null)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requests.length, 1, "Expected exactly one automatic startup consent request.");
    assert.match(requests[0].message, /Save this conversation's recorded/);
    assert.match(requests[0].message, /synthetic-owner\/synthetic-archive/);
    assert.equal((await readJson(statePath)).accepted, false);
    await assert.rejects(fs.access(path.join(root, "archive", "pending")));
    const id = session.sessionId;
    await session.disconnect();
    session = await client.resumeSession(id, options);
    await session.rpc.extensions.reload();
    await ready(session);
    assert.equal(requests.length, 1, "Resume/reload must not prompt after a saved decline.");
    await assert.rejects(fs.access(path.join(root, "archive", "pending")));
    console.log(JSON.stringify({ sdk: sdkDirectory, runtimeVersion: events.find((e) => e.type === "session.start")?.data.copilotVersion,
        pluginLoaded: true, extension: archive.name, status: archive.status, failClosedWithoutSetup: true,
        automaticStartupConsentRequests: requests.length, syntheticHumanDecision: "decline",
        resumedWithoutRepeatPrompt: true, modelPromptsSent: 0, uploads: 0 }));
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
