import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { ArchiveStore, artifactApproval, atomicJson, command, hash, readJson, redactText, sessionKey, snapshot } from "../extensions/archive/core.mjs";

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
    while (!JSON.stringify(events).includes("Startup failed closed") && Date.now() < warningDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        events = await session.getEvents();
    }
    assert.ok(JSON.stringify(events).includes("Startup failed closed"), "A non-repository workspace must fail closed even without configuration.");
    await assert.rejects(fs.access(path.join(root, "archive", "pending")));
    await session.disconnect();

    await atomicJson(path.join(root, "archive", "config.json"), { version: 1,
        destination: { repo: "synthetic-owner/synthetic-archive", remote: "https://github.com/synthetic-owner/synthetic-archive.git" } });
    const requests = [];
    let loadRequested = false;
    const restoredDirectory = path.join(root, "restored-from-archive-load");
    const options = {
        workingDirectory: root, requestExtensions: true, pluginDirectories: [plugin],
        onPermissionRequest: permissionHandler,
        onElicitationRequest: async (request) => {
            requests.push(request);
            if (!loadRequested) return { action: "decline" };
            const fields = request.requestedSchema?.properties;
            if (fields?.selection?.enum) return { action: "accept", content: { selection: fields.selection.enum[0] } };
            if (fields?.value?.type === "string") return { action: "accept", content: { value: restoredDirectory } };
            throw new Error("Unexpected synthetic archive-load elicitation schema.");
        },
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
    await session.disconnect();
    await fs.unlink(path.join(root, "archive", "config.json"));
    const workingDirectory = path.join(root, "synthetic-private-work");
    await fs.mkdir(workingDirectory);
    await fs.writeFile(path.join(workingDirectory, "existing-synthetic.txt"), "Existing synthetic file must only be fingerprinted.");
    const remote = path.join(root, "synthetic.git");
    await command("git", ["init", "--bare", "--quiet", remote]);
    const config = { version: 1, destination: { remote, branch: "main", localTest: true } };
    const storeRoot = path.join(root, "synthetic-store");
    const legacy = new ArchiveStore(storeRoot, { ...config, destination: { ...config.destination, branch: "archive" } }, { localTest: true });
    const report = path.join(root, "synthetic-report.bin");
    const reportBytes = Buffer.from([0, 255, 17, 81, 13]);
    await fs.writeFile(report, reportBytes);
    const capture = await snapshot("previous-synthetic", [
        { id: "synthetic-request", type: "user.message", data: { content: "Synthetic previous conversation for startup picker" } },
    ], [await artifactApproval(report)]);
    await legacy.publish(sessionKey("previous-synthetic"), capture);
    const seed = path.join(root, "main-documents");
    await fs.mkdir(path.join(seed, "conversations"), { recursive: true });
    await command("git", ["init", "--quiet", "--initial-branch=main"], seed);
    await fs.writeFile(path.join(seed, "conversations", "2026-01-01-synthetic-export.md"), "# Human-readable document, not a recorded checkpoint");
    await command("git", ["add", "--all"], seed);
    await command("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@localhost", "commit", "--quiet", "-m", "Seed main document"], seed);
    await command("git", ["push", "--quiet", remote, "main"], seed);
    const originalRefs = (await command("git", ["ls-remote", "--heads", remote])).stdout;
    const syntheticPlugin = path.join(root, "synthetic-picker-plugin");
    await fs.mkdir(syntheticPlugin);
    await fs.copyFile(path.join(plugin, "plugin.json"), path.join(syntheticPlugin, "plugin.json"));
    await fs.cp(path.join(plugin, "extensions"), path.join(syntheticPlugin, "extensions"), { recursive: true });
    // Keep the actual controller and SDK UI; replace only external visibility/storage dependencies.
    await fs.writeFile(path.join(syntheticPlugin, "extensions", "archive", "extension.mjs"),
        `import { joinSession } from "@github/copilot-sdk/extension";
import { startExtension } from "./controller.mjs";
import { ArchiveStore } from "./core.mjs";
await startExtension(joinSession, {
    resolveRepository: async () => (${JSON.stringify({ directory: workingDirectory, repo: "synthetic/private-work", private: true })}),
    verifyDestination: async () => {},
    store: new ArchiveStore(${JSON.stringify(storeRoot)}, ${JSON.stringify(config)}, { localTest: true }),
});\n`);
    const pickerOptions = { ...options, workingDirectory, pluginDirectories: [syntheticPlugin] };
    session = await client.createSession(pickerOptions);
    await ready(session);
    const pickerDeadline = Date.now() + 15000;
    while (!requests.length && Date.now() < pickerDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requests.length, 1, "The real SDK host must request one automatic conversation selection.");
    assert.match(JSON.stringify(requests[0]), /Synthetic previous conversation for startup picker/);
    assert.match(JSON.stringify(requests[0]), /Start fresh/);
    const privateState = await readJson(path.join(root, "archive", "consent", `${sessionKey(session.sessionId)}.json`));
    assert.ok(privateState.accepted && privateState.automatic);
    assert.equal(privateState.repository, "synthetic/private-work");
    await assert.rejects(fs.access(path.join(root, "archive", "config.json")));
    await assert.rejects(fs.access(path.join(root, "archive", "pending")));
    const pickerId = session.sessionId;
    await session.disconnect();
    session = await client.resumeSession(pickerId, pickerOptions);
    await session.rpc.extensions.reload();
    await ready(session);
    assert.equal(requests.length, 1, "Resume/reload must not show the picker again.");
    loadRequested = true;
    const loaded = await session.rpc.commands.execute({ commandName: "archive-load", args: "" });
    assert.equal(loaded.error, undefined);
    assert.equal(requests.length, 3, "Explicit archive-load must ask only for a saved conversation and a local restore folder.");
    assert.match(JSON.stringify(requests[1]), /archive/);
    assert.deepEqual(await fs.readFile(path.join(restoredDirectory, "history.jsonl")), capture.files.get("history.jsonl"));
    const manifest = await readJson(path.join(restoredDirectory, "manifest.json"));
    assert.equal(hash(await fs.readFile(path.join(restoredDirectory, ...manifest.artifacts[0].file.split("/")))), hash(reportBytes));
    assert.equal((await command("git", ["ls-remote", "--heads", remote])).stdout, originalRefs);
    await assert.rejects(fs.access(path.join(root, "archive", "pending")));
    console.log(JSON.stringify({ sdk: sdkDirectory, runtimeVersion: events.find((e) => e.type === "session.start")?.data.copilotVersion,
        pluginLoaded: true, extension: archive.name, status: archive.status, unverifiedWorkspaceDisabled: true,
        automaticStartupConsentRequests: 0, automaticConversationPickerRequests: 1,
        syntheticPickerDeclined: true, resumedWithoutRepeatedPicker: true, syntheticPrivateSessionActivated: true,
        archiveLoadCommandExecuted: true, mixedMainDocumentsAndLegacyArchive: true,
        actualHistoryAndArtifactHashesVerified: true, remoteBranchesUnchanged: true,
        externalVisibilityAndStorage: "synthetic local fixtures", modelPromptsSent: 0, githubUploads: 0 }));
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
