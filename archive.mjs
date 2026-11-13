import path from "node:path";
import { parseArgs } from "node:util";
import { ArchiveStore, atomicJson, defaultRoot, loadConfig, redactText, validateConfig, verifyDestination } from "./extensions/archive/core.mjs";

async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: { repo: { type: "string" }, root: { type: "string" }, branch: { type: "string" }, to: { type: "string" }, checkpoint: { type: "string" } },
    });
    const [action, id] = positionals;
    const root = path.resolve(values.root || defaultRoot());
    if (action === "configure") {
        const config = validateConfig({ version: 1, destination: { repo: values.repo, remote: `https://github.com/${values.repo}.git`, branch: values.branch } });
        await verifyDestination(config);
        await atomicJson(path.join(root, "config.json"), config);
        console.log(`Configured ${config.destination.repo} (${config.destination.branch}) at ${root}. No history read or uploaded. Restart/new conversation required for automatic consent.`);
    } else if (action === "list" || action === "import") {
        const config = await loadConfig(root);
        if (!config) throw new Error("Run configure --repo OWNER/REPO first.");
        const store = new ArchiveStore(root, config);
        if (action === "list") console.log(JSON.stringify(await store.list(), null, 2));
        else {
            if (!values.to || !path.isAbsolute(values.to)) throw new Error("import requires --to ABSOLUTE_NEW_DIRECTORY; parent must exist.");
            const imported = await store.import(id, values.to, values.checkpoint);
            console.log(`Imported UNTRUSTED DATA. Start a NEW Copilot session and read ${imported.entryPoint}. MCP authentication is your own.`);
        }
    } else {
        console.log("Usage:\n  node archive.mjs configure --repo OWNER/REPO [--branch main] [--root PATH]\n  node archive.mjs list [--root PATH]\n  node archive.mjs import SESSION_KEY --to ABSOLUTE_NEW_DIRECTORY [--checkpoint HASH] [--root PATH]\nThe destination branch defaults to main; --branch is an optional explicit override.\nThere is deliberately no command-line history exporter or agent-callable consent tool.");
        if (action) throw new Error("Unknown action.");
    }
}
main().catch((error) => { console.error(redactText(error.message)); process.exitCode = 1; });
